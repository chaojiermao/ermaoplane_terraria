const fs = require('fs-extra');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

class ConsoleService {
  constructor() {
    this._buffer = [];
    this._maxLines = 500;
    this._subscribers = new Set();
    this._loadPersisted();
  }

  _loadPersisted() {
    try {
      if (fs.existsSync(PATHS.CONSOLE_LOG)) {
        const content = fs.readFileSync(PATHS.CONSOLE_LOG, 'utf8');
        const lines = content.trim().split('\n');
        this._buffer = lines.slice(-this._maxLines);
      }
    } catch (e) {
      // ignore
    }
  }

  _persist(line) {
    fs.appendFile(PATHS.CONSOLE_LOG, line + '\n').catch(() => {});
  }

  subscribe(ws) {
    this._subscribers.add(ws);
    // Send history on subscribe
    const history = this._buffer.slice(-100);
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify({
        type: 'console.history',
        data: { lines: history },
      }));
    }
    return () => this._subscribers.delete(ws);
  }

  write(text, type = 'info') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${time}] [${type}] ${text}`;
    this._buffer.push(line);
    if (this._buffer.length > this._maxLines) {
      this._buffer.shift();
    }
    this._persist(line);
    this._broadcast({ type: 'console.log', data: { line, text, time, logType: type } });
    logger.debug('ConsoleService', text);
  }

  writeServerOutput(text) {
    // Parse server output to determine log type
    let type = 'info';
    if (text.includes('joined') || text.includes('加入了')) type = 'join';
    else if (text.includes('Error') || text.includes('错误') || text.includes('ERROR')) type = 'error';
    else if (text.includes('System') || text.includes('系统') || text.includes('初始')) type = 'system';
    else if (text.includes('saved') || text.includes('保存')) type = 'save';
    this.write(text, type);
  }

  clear() {
    this._buffer = [];
    fs.writeFile(PATHS.CONSOLE_LOG, '').catch(() => {});
    this._broadcast({ type: 'console.cleared' });
  }

  getBuffer() {
    return [...this._buffer];
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    this._subscribers.forEach(ws => {
      try {
        if (ws.readyState === 1) ws.send(data);
      } catch (e) {
        this._subscribers.delete(ws);
      }
    });
  }
}

module.exports = ConsoleService;
