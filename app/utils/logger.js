const fs = require('fs-extra');
const path = require('path');
const { PATHS } = require('./paths');

const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

let currentLevel = process.env.LOG_LEVEL || 'INFO';

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function writeLog(level, module, message, extra) {
  if (levels[level] > (levels[currentLevel] || 2)) return;

  const line = `[${formatTime()}] [${level.padEnd(5)}] [${module}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;

  // Console output
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);

  // Write to file (async, non-blocking)
  fs.appendFile(PATHS.PANEL_LOG, line + '\n').catch(() => {});
  if (level === 'ERROR') {
    fs.appendFile(PATHS.ERROR_LOG, line + '\n').catch(() => {});
  }
}

const logger = {
  setLevel(level) { currentLevel = level; },
  error: (module, msg, extra) => writeLog('ERROR', module, msg, extra),
  warn: (module, msg, extra) => writeLog('WARN', module, msg, extra),
  info: (module, msg, extra) => writeLog('INFO', module, msg, extra),
  debug: (module, msg, extra) => writeLog('DEBUG', module, msg, extra),
};

module.exports = logger;
