const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { PATHS, getCurrentRuntimeDir, getServerConfigPath, getServersDir } = require('../utils/paths');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  RESTARTING: 'restarting',
  CRASHED: 'crashed',
  ERROR: 'error',
};

class GameProcessService {
  constructor(stateService, consoleService, configService, playerProbe, parser, wizard) {
    this.stateService = stateService;
    this.console = consoleService;
    this.config = configService;
    this._probe = playerProbe;
    this._parser = parser;
    this._wizard = wizard;
    this._process = null;
    this._status = STATUS.STOPPED;
    this._stopping = false;
    this._listeningTimer = null;
    this._broadcastTimer = null;
    this._lastStartMode = null;
  }

  getStatus() { return this._status; }
  isRunning() { return this._status === STATUS.RUNNING; }
  getPid() { return this._process ? this._process.pid : null; }

  async start() {
    if (this._process) throw new Error('服务器已在运行中');

    const mode = this.stateService.get('currentMode');
    this._lastStartMode = mode;
    this._setStatus(STATUS.STARTING);
    this.console.write(`正在启动${mode === 'tmodloader' ? ' TModLoader' : ' 纯净'}服务器...`, 'system');

    try {
      if (mode === 'tmodloader') {
        await this._startTModLoader();
      } else {
        await this._startVanilla();
      }
    } catch (e) {
      this._setStatus(STATUS.ERROR);
      this.console.write(`启动失败: ${e.message}`, 'error');
      logger.error('GameProcessService', 'Start failed', e.stack || e.message);
      this._cleanup();
      throw e;
    }
  }

  async _startVanilla() {
    const mode = 'vanilla';
    const runtimeDir = getCurrentRuntimeDir(mode);
    const resolved = await this._resolveRuntimeDir(runtimeDir);
    const configPath = getServerConfigPath(mode);
    const binaryPath = await this._findFirstFile(resolved, [
      'TerrariaServer', 'TerrariaServer.bin', 'TerrariaServer.bin.x86_64', 'TerrariaServer.exe',
    ], 10);

    if (!binaryPath) throw new Error('vanilla 服务端未安装，请先更新版本');
    if (!await fs.pathExists(configPath)) await fs.writeFile(configPath, this.config.getDefaultConfig(mode));
    try { await fs.chmod(binaryPath, 0o755); } catch (e) { /* ignore */ }

    const cfg = await this._getRuntimeConfig(mode);
    const args = [];
    if (cfg.worldPath && await fs.pathExists(cfg.worldPath) && !(await fs.stat(cfg.worldPath)).isDirectory()) {
      args.push('-world', cfg.worldPath);
    }
    if (cfg.worldName) args.push('-worldname', cfg.worldName);
    args.push('-autocreate', '2');
    if (cfg.maxPlayers > 0) args.push('-maxplayers', String(cfg.maxPlayers));
    args.push('-port', String(cfg.port));
    if (cfg.password) args.push('-pass', cfg.password);
    if (cfg.motd) args.push('-motd', cfg.motd);
    args.push('-language', cfg.language);
    args.push('-difficulty', String(cfg.difficulty));
    args.push('-secure', '1');

    logger.info('GameProcessService', `[VANILLA_START_ENTRY] ${binaryPath}`);
    logger.info('GameProcessService', `[VANILLA_START_CWD] ${path.dirname(binaryPath)}`);
    this.console.write(`启动参数: maxPlayers=${cfg.maxPlayers} port=${cfg.port} world=${cfg.worldName}`, 'system');

    this._spawnServer(binaryPath, args, {
      cwd: path.dirname(binaryPath),
      env: this._buildEnv(mode),
      mode,
      maxPlayers: cfg.maxPlayers,
      port: cfg.port,
      worldName: cfg.worldName,
      rawLogPath: PATHS.VANILLA_PLAYER_RAW_LOG,
    });
  }

  async _startTModLoader() {
    const mode = 'tmodloader';
    const runtimeRoot = PATHS.RUNTIME_TMODLOADER;
    const runtimeDir = await this._resolveTmodRuntimeDir();
    const configPath = getServerConfigPath(mode);
    await fs.ensureDir(PATHS.WORLDS_TMODLOADER);
    await fs.ensureDir(PATHS.MODS_DIR);
    await fs.ensureDir(path.dirname(configPath));
    if (!await fs.pathExists(configPath)) await fs.writeFile(configPath, this.config.getDefaultConfig(mode));

    const cfg = await this._getRuntimeConfig(mode);
    await this._syncConfigFile(configPath, {
      ...cfg,
      worldPath: cfg.worldPath || PATHS.WORLDS_TMODLOADER,
    });

    const entry = await this._detectTmodEntry(runtimeDir, runtimeRoot);
    if (!entry) throw new Error('tmodloader 服务端未安装，请先更新版本');

    let command;
    let args;
    if (entry.name === 'start-tModLoaderServer.sh') {
      command = 'bash';
      args = ['./start-tModLoaderServer.sh'];
    } else if (entry.name === 'manage-tModLoaderServer.sh') {
      command = 'bash';
      args = ['./manage-tModLoaderServer.sh', 'start'];
    } else {
      command = `./${entry.name}`;
      args = [];
    }

    logger.info('GameProcessService', `[TMOD_START_ENTRY] ${command} ${args.join(' ')}`);
    logger.info('GameProcessService', `[TMOD_START_CWD] ${entry.cwd}`);
    logger.info('GameProcessService', `[TMOD_START_HOME] ${PATHS.ROOT}`);
    this.console.write(`[TMOD_START_ENTRY] ${command} ${args.join(' ')}`, 'system');
    this.console.write(`[TMOD_START_CWD] ${entry.cwd}`, 'system');
    this.console.write(`启动参数: maxPlayers=${cfg.maxPlayers} port=${cfg.port} world=${cfg.worldName}`, 'system');

    this._spawnServer(command, args, {
      cwd: entry.cwd,
      env: this._buildEnv(mode),
      mode,
      maxPlayers: cfg.maxPlayers || 8,
      port: cfg.port,
      worldName: cfg.worldName,
      rawLogPath: PATHS.TMOD_PLAYER_RAW_LOG,
    });
  }

  _spawnServer(command, args, options) {
    this.stateService.setMultiple({
      serverStatus: STATUS.STARTING,
      currentWorld: options.worldName || null,
      serverPid: null,
      detectedPort: null,
    });

    this.stateService.set('lastServerConfig', {
      mode: options.mode,
      maxPlayers: options.maxPlayers,
      port: options.port,
      worldName: options.worldName,
    });

    this._process = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });

    this.stateService.setMultiple({ serverPid: this._process.pid, serverStatus: STATUS.STARTING });
    logger.info('GameProcessService', `[${options.mode === 'tmodloader' ? 'TMOD' : 'VANILLA'}_PID] ${this._process.pid}`);

    this._probe.resetForMode(options.mode, options.rawLogPath);
    this._probe.setRuntimeMaxPlayers(options.maxPlayers || 8);
    if (this._wizard) {
      this._probe.addChunkConsumer((chunk) => this._wizard.feed(chunk));
    }
    this._probe.bind(this._process, { mode: options.mode });

    if (options.mode === 'tmodloader') {
      const autoEnter = () => {
        if (this._process && this._process.stdin && this._process.stdin.writable && this._status === STATUS.STARTING) {
          logger.info('GameProcessService', '[TMOD_STDIN] auto-enter');
          this._process.stdin.write('\n');
        }
      };
      setTimeout(autoEnter, 800);
      setTimeout(autoEnter, 2500);
    }

    if (this._wizard) {
      this._wizard.bindProcess(this._process);
      this._wizard.bindGameService(this);
      this._wizard.reset();
    }

    this._process.on('error', (err) => {
      logger.error('GameProcessService', 'Process error', err.message);
      this.console.write(`进程错误: ${err.message}`, 'error');
      this._setStatus(STATUS.ERROR);
      this._cleanup();
    });

    this._process.on('exit', (code, signal) => {
      logger.info('GameProcessService', `[${options.mode === 'tmodloader' ? 'TMOD' : 'VANILLA'}_EXIT] code=${code} signal=${signal}`);
      this.console.write(`服务器进程已退出 (code: ${code}, signal: ${signal})`, 'system');
      this._probe.clear();
      this._probe.destroy();
      this._setStatus(this._stopping || code === 0 ? STATUS.STOPPED : STATUS.CRASHED);
      this._cleanup();
    });

    this._probe.onceListening((port) => {
      if (this._status !== STATUS.STARTING) return;
      logger.info('GameProcessService', `[${options.mode === 'tmodloader' ? 'TMOD' : 'VANILLA'}_STATUS] running port=${port}`);
      this.stateService.setMultiple({ detectedPort: port, serverStatus: STATUS.RUNNING });
      this._status = STATUS.RUNNING;
      this._startBroadcast();
      this.console.write('服务器已成功启动，正在监听端口。', 'info');
    });

    this._listeningTimer = setTimeout(() => {
      if (this._status === STATUS.STARTING) {
        this.console.write('警告: 未检测到服务端监听端口，仍保持启动中，请查看控制台日志', 'warn');
      }
    }, 120000);
  }

  async stop(force = false) {
    if (!this._process) throw new Error('服务器未运行');

    this._stopping = true;
    this._setStatus(STATUS.STOPPING);
    this.console.write(force ? '正在强制停止服务器...' : '正在安全停止服务器...', 'system');

    try {
      if (force) {
        this._process.kill('SIGKILL');
      } else {
        this._sendCommand('save');
        await this._delay(1500);
        this._sendCommand('exit');
        const exited = await this._waitForExit(15000);
        if (!exited && this._process && !this._process.killed) this._process.kill('SIGTERM');
      }
    } catch (e) {
      logger.error('GameProcessService', 'Stop failed', e.message);
      if (this._process && !this._process.killed) this._process.kill('SIGKILL');
    }

    this._cleanup();
    this._setStatus(STATUS.STOPPED);
    this._stopping = false;
  }

  async restart() {
    if (!this._process) throw new Error('服务器未运行');
    this._setStatus(STATUS.RESTARTING);
    this.console.write('正在安全重启服务器...', 'system');
    await this.stop(false);
    await this._delay(5000);
    await this.start();
  }

  async save() {
    if (!this._process) throw new Error('服务器未运行');
    this._sendCommand('save');
    this.console.write('正在保存世界...', 'system');
  }

  sendCommand(command) {
    if (!this._process) throw new Error('服务器未运行');
    const cmd = command == null ? '' : String(command);
    this._sendCommand(cmd);
    this.console.write(`> ${cmd}`, 'system');
  }

  kick(name) {
    const safeName = this._sanitizePlayerName(name);
    this.sendCommand(`kick ${safeName}`);
    return { message: '踢出命令已发送，等待服务器确认' };
  }

  ban(name) {
    const safeName = this._sanitizePlayerName(name);
    this.sendCommand(`ban ${safeName}`);
    return { message: '封禁命令已发送，等待服务器确认' };
  }

  _sendCommand(cmd) {
    if (this._process && this._process.stdin.writable) {
      const mode = this.stateService.get('currentMode');
      if (mode === 'tmodloader') logger.info('GameProcessService', `[TMOD_STDIN] ${cmd}`);
      this._process.stdin.write(`${cmd}\n`);
    }
  }

  async _resolveRuntimeDir(runtimeDir) {
    if (await fs.pathExists(runtimeDir)) {
      const target = await fs.readlink(runtimeDir).catch(() => runtimeDir);
      if (await fs.pathExists(target)) return target;
    }
    const versionsDir = path.join(path.dirname(runtimeDir), 'versions');
    const versions = await this._listDirectories(versionsDir);
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length) return path.join(versionsDir, versions[0]);
    return runtimeDir;
  }

  async _resolveTmodRuntimeDir() {
    const current = await this._resolveRuntimeDir(getCurrentRuntimeDir('tmodloader'));
    if (await fs.pathExists(current)) return current;
    return PATHS.RUNTIME_TMODLOADER;
  }

  async _detectTmodEntry(preferredDir, runtimeRoot) {
    const dirs = [];
    if (preferredDir) dirs.push(preferredDir);
    const versionsDir = path.join(runtimeRoot, 'versions');
    const versions = await this._listDirectories(versionsDir);
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) dirs.push(path.join(versionsDir, v));
    dirs.push(runtimeRoot);

    const seen = new Set();
    for (const dir of dirs) {
      const cwd = path.resolve(dir);
      if (seen.has(cwd) || !await fs.pathExists(cwd)) continue;
      seen.add(cwd);
      for (const name of ['start-tModLoaderServer.sh', 'manage-tModLoaderServer.sh', 'tModLoaderServer']) {
        const p = path.join(cwd, name);
        if (await fs.pathExists(p)) return { cwd, name, path: p };
      }
    }
    return null;
  }

  async _findFirstFile(dir, names, maxDepth = 5) {
    try {
      const walk = async (current, depth) => {
        if (depth > maxDepth) return null;
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isFile() && names.includes(entry.name)) return full;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const found = await walk(path.join(current, entry.name), depth + 1);
            if (found) return found;
          }
        }
        return null;
      };
      return await walk(dir, 0);
    } catch (e) {
      return null;
    }
  }

  async _listDirectories(dir) {
    const result = [];
    const entries = await fs.readdir(dir).catch(() => []);
    for (const name of entries) {
      const full = path.join(dir, name);
      try { if ((await fs.stat(full)).isDirectory()) result.push(name); } catch (e) { /* ignore */ }
    }
    return result;
  }

  async _getRuntimeConfig(mode) {
    let cfg = this.stateService.getServerConfig ? this.stateService.getServerConfig(mode) : {};
    if (!cfg || Object.keys(cfg).length === 0) {
      cfg = { worldPath: '', worldName: '', maxPlayers: '', port: '7777', password: '', motd: '', difficulty: '1', language: 'zh-Hans' };
      this.stateService.saveServerConfig(mode, cfg);
    }
    return {
      ...cfg,
      worldPath: cfg.worldPath || '',
      worldName: cfg.worldName || '',
      maxPlayers: parseInt(cfg.maxPlayers || '', 10) || 0,
      port: parseInt(cfg.port || '7777', 10),
      password: cfg.password || '',
      motd: cfg.motd || '',
      difficulty: parseInt(cfg.difficulty || '1', 10),
      language: cfg.language || 'zh-Hans',
    };
  }

  _buildEnv(mode) {
    const env = {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      LANGUAGE: 'en_US',
      TERM: 'xterm',
    };
    if (mode === 'tmodloader') {
      env.HOME = PATHS.ROOT;
      env.LANG = 'zh_CN.UTF-8';
      env.LANGUAGE = 'zh_CN:zh';
      env.LC_MESSAGES = 'zh_CN.UTF-8';
      delete env.LC_ALL;
    }
    return env;
  }

  async _syncConfigFile(configPath, cfg) {
    let content = '';
    try { content = await fs.readFile(configPath, 'utf8'); } catch (e) { content = ''; }
    const lines = content.split('\n').filter(Boolean);
    const setValue = (key, val) => {
      const idx = lines.findIndex(l => l.match(new RegExp(`^${key}\\s*=`, 'i')));
      if (idx >= 0) lines[idx] = `${key}=${val}`;
      else lines.push(`${key}=${val}`);
    };
    if (cfg.maxPlayers) setValue('maxplayers', cfg.maxPlayers);
    if (cfg.port) setValue('port', cfg.port);
    if (cfg.worldName) setValue('worldname', cfg.worldName);
    if (cfg.password !== undefined) setValue('password', cfg.password || '');
    if (cfg.motd) setValue('motd', cfg.motd);
    if (cfg.difficulty) setValue('difficulty', cfg.difficulty);
    if (cfg.language) setValue('language', cfg.language);
    if (cfg.worldPath) setValue('worldpath', cfg.worldPath);
    await fs.writeFile(configPath, `${lines.join('\n')}\n`);
  }

  _sanitizePlayerName(name) {
    const safe = String(name || '').replace(/[\x00-\x1F\x7F"';|`\\]/g, '').trim();
    if (!safe) throw new Error('无效玩家名');
    return safe;
  }

  _setStatus(status) {
    const oldStatus = this._status;
    this._status = status;
    this.stateService.set('serverStatus', status);
    if (status === STATUS.RUNNING && oldStatus !== STATUS.RUNNING) this._startBroadcast();
    if ([STATUS.STOPPED, STATUS.ERROR, STATUS.CRASHED].includes(status)) this._stopBroadcast();
  }

  _startBroadcast() {
    this._stopBroadcast();
    const config = this.stateService.getBroadcastConfig();
    if (!config || !config.text) return;
    const intervalMs = (parseInt(config.interval, 10) || 10) * 60 * 1000;
    this.console.write(`轮播公告已启动，间隔 ${config.interval} 分钟`, 'system');
    this._broadcastTimer = setInterval(() => {
      if (!this._process || this._process.killed) return this._stopBroadcast();
      try { this._process.stdin.write(`say [服务器公告]${config.text}\n`); } catch (e) { this._stopBroadcast(); }
    }, intervalMs);
  }

  _stopBroadcast() {
    if (this._broadcastTimer) clearInterval(this._broadcastTimer);
    this._broadcastTimer = null;
  }

  _restartBroadcast() {
    if (this._status === STATUS.RUNNING) this._startBroadcast();
  }

  _cleanup() {
    if (this._listeningTimer) clearTimeout(this._listeningTimer);
    this._listeningTimer = null;
    this._stopBroadcast();
    if (this._wizard) this._wizard.reset();
    this._process = null;
    this.stateService.set('serverPid', null);
  }

  _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  _waitForExit(timeout) {
    return new Promise((resolve) => {
      if (!this._process || this._process.killed) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeout);
      this._process.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
  }
}

module.exports = { GameProcessService, STATUS };
