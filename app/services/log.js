const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

class LogService {
  constructor() {
    this._logFiles = {
      panel: { path: PATHS.PANEL_LOG, name: '面板日志' },
      console: { path: PATHS.CONSOLE_LOG, name: '控制台日志' },
      error: { path: PATHS.ERROR_LOG, name: '错误日志' },
      update: { path: path.join(PATHS.LOGS, 'update.log'), name: '更新日志' },
    };
  }

  async list() {
    return Object.entries(this._logFiles).map(([key, info]) => ({
      id: key,
      name: info.name,
      path: info.path,
    }));
  }

  async read(logId, lines = 100) {
    const info = this._logFiles[logId];
    if (!info) throw new Error(`日志不存在: ${logId}`);

    if (!await fs.pathExists(info.path)) {
      return { id: logId, lines: [], total: 0 };
    }

    const content = await fs.readFile(info.path, 'utf8');
    const allLines = content.trim().split('\n');
    const tail = allLines.slice(-lines);

    return {
      id: logId,
      name: info.name,
      lines: tail,
      total: allLines.length,
    };
  }

  async tail(logId, count = 50) {
    return this.read(logId, count);
  }
}

module.exports = LogService;
