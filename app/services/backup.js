const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { PATHS, getBackupsDir, getServersDir, getServerConfigPath } = require('../utils/paths');

class BackupService {
  constructor(stateService, consoleService) {
    this.stateService = stateService;
    this.console = consoleService;
  }

  async create(mode, reason = 'manual') {
    const backupsDir = getBackupsDir(mode);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupId = `backup_${mode}_${timestamp}`;
    const backupDir = path.join(backupsDir, backupId);

    await fs.ensureDir(backupDir);

    const serversDir = getServersDir(mode);
    const configPath = getServerConfigPath(mode);

    // Create manifest
    const manifest = {
      id: backupId,
      mode,
      createdAt: new Date().toISOString(),
      reason,
      world: this.stateService.get('currentWorld'),
      vanillaVersion: this.stateService.get('vanillaVersion'),
      tmodloaderVersion: this.stateService.get('tmodloaderVersion'),
    };

    // Backup Worlds
    const worldsDir = path.join(serversDir, 'Worlds');
    if (await fs.pathExists(worldsDir)) {
      await fs.copy(worldsDir, path.join(backupDir, 'Worlds'));
    }

    // Backup config
    if (await fs.pathExists(configPath)) {
      await fs.copy(configPath, path.join(backupDir, 'serverconfig.txt'));
    }

    // Backup Mods (tmodloader only)
    if (mode === 'tmodloader') {
      const modsDir = path.join(serversDir, 'Mods');
      if (await fs.pathExists(modsDir)) {
        await fs.copy(modsDir, path.join(backupDir, 'Mods'));
      }
    }

    // Backup state
    const state = this.stateService.getAllState();
    await fs.writeJson(path.join(backupDir, 'state.json'), state, { spaces: 2 });

    // Write manifest
    await fs.writeJson(path.join(backupDir, 'manifest.json'), manifest, { spaces: 2 });

    logger.info('BackupService', `Backup created: ${backupId}`, { mode, reason });
    this.console.write(`备份已创建: ${backupId}`, 'info');

    return backupId;
  }

  async list(mode) {
    const backupsDir = getBackupsDir(mode);
    await fs.ensureDir(backupsDir);

    const entries = await fs.readdir(backupsDir);
    const backups = [];

    for (const entry of entries) {
      const manifestPath = path.join(backupsDir, entry, 'manifest.json');
      try {
        if (await fs.pathExists(manifestPath)) {
          const manifest = await fs.readJson(manifestPath);
          backups.push(manifest);
        } else {
          backups.push({
            id: entry,
            mode,
            createdAt: null,
            reason: 'unknown',
            world: null,
          });
        }
      } catch (e) {
        // skip invalid entries
      }
    }

    // Sort by creation date descending
    backups.sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return b.createdAt.localeCompare(a.createdAt);
    });

    return backups;
  }

  async restore(mode, backupId) {
    const backupsDir = getBackupsDir(mode);
    const backupDir = path.join(backupsDir, backupId);

    if (!await fs.pathExists(backupDir)) {
      throw new Error(`备份不存在: ${backupId}`);
    }

    // Check manifest
    const manifestPath = path.join(backupDir, 'manifest.json');
    if (await fs.pathExists(manifestPath)) {
      const manifest = await fs.readJson(manifestPath);
      if (manifest.mode !== mode) {
        throw new Error(`备份模式不匹配: ${manifest.mode} !== ${mode}`);
      }
    }

    this.console.write(`正在恢复备份: ${backupId}`, 'system');

    // Create current state backup before restore
    await this.create(mode, 'before_restore');

    const serversDir = getServersDir(mode);
    const configPath = getServerConfigPath(mode);

    // Restore Worlds
    const backupWorlds = path.join(backupDir, 'Worlds');
    if (await fs.pathExists(backupWorlds)) {
      const worldsDir = path.join(serversDir, 'Worlds');
      await fs.emptyDir(worldsDir);
      await fs.copy(backupWorlds, worldsDir);
    }

    // Restore config
    const backupConfig = path.join(backupDir, 'serverconfig.txt');
    if (await fs.pathExists(backupConfig)) {
      await fs.copy(backupConfig, configPath);
    }

    // Restore Mods (tmodloader only)
    if (mode === 'tmodloader') {
      const backupMods = path.join(backupDir, 'Mods');
      if (await fs.pathExists(backupMods)) {
        const modsDir = path.join(serversDir, 'Mods');
        await fs.emptyDir(modsDir);
        await fs.copy(backupMods, modsDir);
      }
    }

    // Restore state
    const backupState = path.join(backupDir, 'state.json');
    if (await fs.pathExists(backupState)) {
      const state = await fs.readJson(backupState);
      this.stateService.setMultiple(state);
    }

    this.console.write(`备份已恢复: ${backupId}`, 'info');
    logger.info('BackupService', `Backup restored: ${backupId}`, { mode });

    return { success: true, backupId };
  }

  async delete(mode, backupId) {
    const backupsDir = getBackupsDir(mode);
    const backupDir = path.join(backupsDir, backupId);

    if (!await fs.pathExists(backupDir)) {
      throw new Error(`备份不存在: ${backupId}`);
    }

    await fs.remove(backupDir);
    logger.info('BackupService', `Backup deleted: ${backupId}`, { mode });
    return { success: true };
  }

  async cleanup(mode, keepCount = 10) {
    const backups = await this.list(mode);
    if (backups.length <= keepCount) return { deleted: 0 };

    const toDelete = backups.slice(keepCount);
    for (const backup of toDelete) {
      await this.delete(mode, backup.id);
    }

    logger.info('BackupService', `Cleaned up ${toDelete.length} old backups`, { mode });
    return { deleted: toDelete.length };
  }
}

module.exports = BackupService;
