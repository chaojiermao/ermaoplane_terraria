const logger = require('../utils/logger');
const fs = require('fs-extra');
const path = require('path');
const { PATHS, getServersDir, getCurrentRuntimeDir } = require('../utils/paths');

class ModeService {
  constructor(stateService, gameService, consoleService, configService, backupService) {
    this.stateService = stateService;
    this.gameService = gameService;
    this.console = consoleService;
    this.config = configService;
    this.backup = backupService;
  }

  getCurrentMode() {
    return this.stateService.get('currentMode');
  }

  async switch(mode) {
    if (mode !== 'vanilla' && mode !== 'tmodloader') {
      throw new Error('无效模式，必须是 vanilla 或 tmodloader');
    }

    const currentMode = this.stateService.get('currentMode');
    if (currentMode === mode) {
      return { message: `当前已是${mode === 'tmodloader' ? 'TModLoader' : '纯净'}模式` };
    }

    const status = this.gameService.getStatus();
    if (status === 'updating') {
      throw new Error('正在更新中，请稍后再试');
    }

    this.console.write(`正在切换到 ${mode === 'tmodloader' ? 'TModLoader' : '纯净服'} 模式...`, 'system');

    if (this.gameService.isRunning()) {
      this.console.write('正在停止服务器以切换模式...', 'system');
      await this.gameService.stop();
    }

    const backupId = await this.backup.create(currentMode, 'before_mode_switch');
    this.console.write(`切换前已创建备份: ${backupId}`, 'system');

    this.stateService.set('currentMode', mode);
    this.console.write(`已切换到 ${mode === 'tmodloader' ? 'TModLoader' : '纯净服'} 模式`, 'system');

    const runtimeDir = getCurrentRuntimeDir(mode);
    let runtimeReady = false;
    try {
      const resolved = await fs.readlink(runtimeDir).catch(() => runtimeDir);
      if (mode === 'tmodloader') {
        runtimeReady = await fs.pathExists(path.join(resolved, 'start-tModLoaderServer.sh')) ||
                       await fs.pathExists(path.join(resolved, 'manage-tModLoaderServer.sh')) ||
                       await fs.pathExists(path.join(resolved, 'tModLoaderServer'));
      } else {
        runtimeReady = await fs.pathExists(path.join(resolved, 'TerrariaServer')) ||
                       await fs.pathExists(path.join(resolved, 'TerrariaServer.bin.x86_64'));
      }
    } catch (e) { /* ignore */ }

    return {
      message: `已切换到${mode === 'tmodloader' ? 'TModLoader' : '纯净服'}模式`,
      mode,
      runtimeReady,
      backupId,
      warning: mode === 'vanilla' ? '切换回纯净服后，包含模组内容的世界可能无法正常加载。' : null,
    };
  }

  /**
   * 模式切换 + 清理旧模式服务器内容（避免冲突）
   */
  async switchClean(mode) {
    if (mode !== 'vanilla' && mode !== 'tmodloader') {
      throw new Error('无效模式，必须是 vanilla 或 tmodloader');
    }

    const currentMode = this.stateService.get('currentMode');
    if (currentMode === mode) {
      return { message: `当前已是${mode === 'tmodloader' ? 'TModLoader' : '纯净'}模式` };
    }

    const status = this.gameService.getStatus();
    if (status === 'updating') {
      throw new Error('正在更新中，请稍后再试');
    }

    this.console.write(`正在切换到 ${mode === 'tmodloader' ? 'TModLoader' : '纯净服'} 模式（清理旧内容）...`, 'system');

    // 1. Stop server if running
    if (this.gameService.isRunning()) {
      this.console.write('正在停止服务器...', 'system');
      await this.gameService.stop();
    }

    // 2. Backup old mode
    const backupId = await this.backup.create(currentMode, 'before_mode_switch_clean');
    this.console.write(`已创建备份: ${backupId}`, 'system');

    // 3. Delete old mode server content to avoid conflicts
    const oldServersDir = getServersDir(currentMode);
    this.console.write(`正在清理 ${currentMode} 模式的服务器内容...`, 'system');
    try {
      // Keep Worlds directory but clean everything else for a fresh start
      const worldsDir = path.join(oldServersDir, 'Worlds');
      const configPath = path.join(oldServersDir, 'serverconfig.txt');

      // Read current world list before cleanup
      let worlds = [];
      try {
        if (await fs.pathExists(worldsDir)) {
          worlds = await fs.readdir(worldsDir);
          worlds = worlds.filter(f => f.endsWith('.wld'));
        }
      } catch (e) { /* ignore */ }

      // Remove and recreate servers directory (keep Worlds if we want to)
      // Actually, let's just remove the config and logs, keep worlds for possible re-import
      const logsDir = path.join(oldServersDir, 'Logs');
      await fs.remove(logsDir).catch(() => {});
      await fs.remove(configPath).catch(() => {});
      await fs.ensureDir(logsDir);

      this.console.write(`已清理 ${currentMode} 旧配置和日志`, 'system');
      if (worlds.length > 0) {
        this.console.write(`保留了 ${worlds.length} 个世界文件在 Worlds 目录`, 'system');
      }
    } catch (e) {
      logger.warn('ModeService', 'Cleanup error', e.message);
    }

    // 4. Create default config for new mode
    const newServersDir = getServersDir(mode);
    await fs.ensureDir(newServersDir);
    await fs.ensureDir(path.join(newServersDir, 'Logs'));

    if (mode === 'tmodloader') {
      await fs.ensureDir(PATHS.WORLDS_TMODLOADER);
      await fs.ensureDir(PATHS.MODS_DIR);
    } else {
      await fs.ensureDir(PATHS.WORLDS_VANILLA);
    }

    // Write default config
    const configPath = path.join(newServersDir, 'serverconfig.txt');
    const defaultConfig = this.config.getDefaultConfig(mode);
    await fs.writeFile(configPath, defaultConfig, 'utf8');
    this.console.write(`已创建 ${mode} 模式的默认配置`, 'system');

    // 5. Switch mode
    this.stateService.set('currentMode', mode);
    this.stateService.set('currentWorld', null);
    this.console.write(`已切换到 ${mode === 'tmodloader' ? 'TModLoader' : '纯净服'} 模式（全新配置）`, 'system');

    return {
      message: `已切换到${mode === 'tmodloader' ? 'TModLoader' : '纯净服'}模式（已清理旧配置）`,
      mode,
      backupId,
      warning: mode === 'vanilla' ? '已清理 TModLoader 配置，请重新配置纯净服参数。' : null,
      cleaned: true,
    };
  }
}

module.exports = ModeService;
