const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { getWorldsDir } = require('../utils/paths');

class WorldService {
  constructor(stateService, consoleService, backupService, gameService) {
    this.stateService = stateService;
    this.console = consoleService;
    this.backup = backupService;
    this.gameService = gameService;
  }

  async list(mode) {
    const worldsDir = getWorldsDir(mode);
    await fs.ensureDir(worldsDir);

    const files = await fs.readdir(worldsDir);
    const worlds = [];

    for (const file of files) {
      if (file.endsWith('.wld')) {
        const stat = await fs.stat(path.join(worldsDir, file));
        worlds.push({
          name: file,
          size: stat.size,
          sizeFormatted: this._formatSize(stat.size),
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }

    return worlds;
  }

  async info(mode, worldName) {
    const worldsDir = getWorldsDir(mode);
    const worldPath = path.join(worldsDir, worldName);

    if (!await fs.pathExists(worldPath)) {
      throw new Error(`世界文件不存在: ${worldName}`);
    }

    const stat = await fs.stat(worldPath);
    return {
      name: worldName,
      path: worldPath,
      size: stat.size,
      sizeFormatted: this._formatSize(stat.size),
      modifiedAt: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
    };
  }

  async switchWorld(mode, worldName) {
    const worldsDir = getWorldsDir(mode);
    const worldPath = path.join(worldsDir, worldName);

    if (!await fs.pathExists(worldPath)) {
      throw new Error(`世界文件不存在: ${worldName}`);
    }

    const { getServerConfigPath } = require('../utils/paths');
    const configPath = getServerConfigPath(mode);

    // Update config
    let config = '';
    try {
      config = await fs.readFile(configPath, 'utf8');
    } catch (e) {
      config = '';
    }

    // Replace or add world line
    const lines = config.split('\n');
    let found = false;
    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') return line;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0 && trimmed.substring(0, eqIdx).trim() === 'world') {
        found = true;
        return `world=${worldPath}`;
      }
      return line;
    });

    if (!found) {
      newLines.push(`world=${worldPath}`);
    }

    await fs.writeFile(configPath, newLines.join('\n'), 'utf8');
    this.stateService.set('currentWorld', worldName);

    this.console.write(`已切换到世界: ${worldName}`, 'system');

    return {
      message: `已切换到世界: ${worldName}，重启服务器后生效`,
      world: worldName,
      needsRestart: this.gameService.isRunning(),
    };
  }

  async delete(mode, worldName) {
    const worldsDir = getWorldsDir(mode);
    const worldPath = path.join(worldsDir, worldName);

    if (!await fs.pathExists(worldPath)) {
      throw new Error(`世界文件不存在: ${worldName}`);
    }

    // Force backup before delete
    await this.backup.create(mode, 'before_world_delete');

    await fs.remove(worldPath);
    this.console.write(`世界已删除: ${worldName}`, 'system');
    logger.info('WorldService', `World deleted: ${worldName}`, { mode });

    return { success: true };
  }

  async handleUpload(mode, uploadId, fileName, chunks) {
    const worldsDir = getWorldsDir(mode);
    await fs.ensureDir(worldsDir);

    // Combine chunks
    const tempPath = path.join(worldsDir, `.upload_${uploadId}_${fileName}`);
    const writeStream = fs.createWriteStream(tempPath);

    for (const chunk of chunks) {
      const buffer = Buffer.from(chunk, 'base64');
      writeStream.write(buffer);
    }

    return new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on('finish', async () => {
        // Rename to final
        const finalPath = path.join(worldsDir, fileName);
        await fs.move(tempPath, finalPath, { overwrite: true });
        this.console.write(`世界上传完成: ${fileName}`, 'info');
        resolve({ success: true, name: fileName });
      });
      writeStream.on('error', reject);
    });
  }

  async download(mode, worldName) {
    const worldsDir = getWorldsDir(mode);
    const worldPath = path.join(worldsDir, worldName);

    if (!await fs.pathExists(worldPath)) {
      throw new Error(`世界文件不存在: ${worldName}`);
    }

    const data = await fs.readFile(worldPath);
    return {
      name: worldName,
      data: data.toString('base64'),
    };
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

module.exports = WorldService;
