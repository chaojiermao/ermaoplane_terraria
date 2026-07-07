const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs-extra');

const logger = require('./utils/logger');
const { PATHS } = require('./utils/paths');

// Services
const { AuthService } = require('./services/auth');
const PanelStateService = require('./services/state');
const ConfigService = require('./services/config');
const ConsoleService = require('./services/console');
const ConsoleParser = require('./services/consoleParser');
const PlayerProbeService = require('./services/playerProbe');
const WorldCreationWizardService = require('./services/wizard');
const { GameProcessService } = require('./services/game');
const ModeService = require('./services/mode');
const VersionService = require('./services/version');
const DownloaderService = require('./services/downloader');
const WorldService = require('./services/world');
const ModService = require('./services/mod');
const ModConfigService = require('./services/modConfig');
const BackupService = require('./services/backup');
const LogService = require('./services/log');
const SystemService = require('./services/system');
const FileService = require('./services/file');

// WebSocket
const WebSocketGateway = require('./ws/gateway');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  logger.info('Server', '========================================');
  logger.info('Server', 'ERPanel_terraria v1.0.0');
  logger.info('Server', '========================================');

  // Ensure required directories exist
  const dirs = [
    PATHS.DATA, PATHS.DOWNLOADS, PATHS.LOGS,
    PATHS.RUNTIME_VANILLA, PATHS.RUNTIME_TMODLOADER,
    PATHS.SERVERS_VANILLA, PATHS.SERVERS_TMODLOADER,
    PATHS.WORLDS_VANILLA, PATHS.WORLDS_TMODLOADER,
    PATHS.MODS_DIR, PATHS.BACKUPS_VANILLA, PATHS.BACKUPS_TMODLOADER,
    path.join(PATHS.RUNTIME_VANILLA, 'versions'),
    path.join(PATHS.RUNTIME_TMODLOADER, 'versions'),
    path.join(PATHS.SERVERS_VANILLA, 'Logs'),
    path.join(PATHS.SERVERS_TMODLOADER, 'Logs'),
  ];

  for (const dir of dirs) {
    await fs.ensureDir(dir);
  }

  // Initialize services
  logger.info('Server', '正在初始化服务...');

  const stateService = new PanelStateService();
  const consoleService = new ConsoleService();
  const authService = new AuthService();
  const configService = new ConfigService(stateService);
  const downloaderService = new DownloaderService();
  const backupService = new BackupService(stateService, consoleService);
  const consoleParser = new ConsoleParser();
  const wizardService = new WorldCreationWizardService();
  const probeService = new PlayerProbeService(consoleParser);
  const gameService = new GameProcessService(stateService, consoleService, configService, probeService, consoleParser, wizardService);
  const modeService = new ModeService(stateService, gameService, consoleService, configService, backupService);
  const versionService = new VersionService(stateService, consoleService, downloaderService, backupService, gameService);
  const worldService = new WorldService(stateService, consoleService, backupService, gameService);
  const modService = new ModService(stateService, consoleService, backupService, downloaderService);
  const modConfigService = new ModConfigService(stateService);
  const logService = new LogService();
  const systemService = new SystemService();
  const fileService = new FileService();

  // Create Express app
  const app = express();

  // Trust proxy for correct IP/host detection
  app.set('trust proxy', true);

  // Parse JSON
  app.use(express.json({ limit: '50mb' }));

  // Static files - serve public directory
  app.use(express.static(PATHS.PUBLIC, {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }));

  // Fallback to index.html for SPA
  app.get('/', (req, res) => {
    res.sendFile(path.join(PATHS.PUBLIC, 'index.html'));
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // HTTP upload endpoint (alternative to WS chunk upload)
  app.post('/upload', async (req, res) => {
    // This would handle multipart file upload
    // For simplicity, we handle this via WS, but endpoint exists
    res.json({ success: false, message: '请使用 WebSocket 分片上传' });
  });

  // Create HTTP server
  const server = http.createServer(app);

  // Create WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Initialize WebSocket gateway
  const gateway = new WebSocketGateway(authService, stateService, gameService, consoleService, modeService,
    versionService, worldService, modService, backupService, configService, logService, systemService, probeService, fileService, wizardService, modConfigService);

  wss.on('connection', (ws, req) => {
    gateway.handleConnection(ws, req);
  });

  // 启动时验证：如果状态记录为 running 但进程已不存在，重置状态
  const savedStatus = stateService.get('serverStatus');
  const savedPid = stateService.get('serverPid');
  if (savedStatus === 'running' || savedStatus === 'starting') {
    if (!savedPid) {
      logger.info('Server', '状态记录为运行中，但无 PID 记录，重置为已停止');
      stateService.set('serverStatus', 'stopped');
      stateService.set('serverPid', null);
    } else {
      try {
        process.kill(savedPid, 0); // 检查进程是否存在（不发送信号）
        logger.info('Server', `检测到已有进程 PID=${savedPid} 在运行`);
      } catch (e) {
        // 进程不存在
        logger.info('Server', `状态记录为运行中，但进程 PID=${savedPid} 已不存在，重置为已停止`);
        stateService.set('serverStatus', 'stopped');
        stateService.set('serverPid', null);
      }
    }
  }

  // Start server
  server.listen(PORT, HOST, () => {
    logger.info('Server', `面板已启动: http://0.0.0.0:${PORT}`);
    logger.info('Server', `WebSocket: ws://0.0.0.0:${PORT}/ws`);

    if (!authService.isInitialized()) {
      logger.info('Server', '首次启动 - 请通过前端页面创建管理员账号');
      consoleService.write('面板首次启动，请创建管理员账号。', 'system');
    }
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info('Server', `收到 ${signal} 信号，正在安全关闭...`);
    consoleService.write('面板正在关闭...', 'system');

    if (gameService.isRunning()) {
      logger.info('Server', '正在停止游戏服务器...');
      await gameService.stop(true);
    }

    wss.close(() => {
      logger.info('Server', 'WebSocket 服务已关闭');
      server.close(() => {
        logger.info('Server', 'HTTP 服务已关闭');
        process.exit(0);
      });
    });

    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error('Server', '未捕获异常', err.message);
    logger.error('Server', err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Server', '未处理的 Promise 拒绝', String(reason));
  });
}

bootstrap().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
