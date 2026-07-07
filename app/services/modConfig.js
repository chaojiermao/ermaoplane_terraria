const fs = require('fs-extra');
const path = require('path');
const { PATHS } = require('../utils/paths');

class ModConfigService {
  constructor(stateService) {
    this.state = stateService;
  }

  _checkMode() {
    if (this.state.get('currentMode') !== 'tmodloader') {
      throw new Error('纯净模式下该功能不可用');
    }
  }

  async list() {
    this._checkMode();
    await fs.ensureDir(PATHS.MODCONFIGS_DIR);
    const names = await fs.readdir(PATHS.MODCONFIGS_DIR);
    const items = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      try {
        const filePath = await this._resolveConfigPath(name, false);
        const stat = await fs.stat(filePath);
        const raw = await fs.readFile(filePath, 'utf8');
        let validJson = true;
        try { JSON.parse(raw); } catch (e) { validJson = false; }
        items.push({
          fileName: name,
          modName: this._modName(name),
          scope: this._scope(name),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          validJson,
        });
      } catch (e) { /* skip unsafe */ }
    }
    items.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return { dir: PATHS.MODCONFIGS_DIR, items };
  }

  async read(fileName) {
    this._checkMode();
    const filePath = await this._resolveConfigPath(fileName, false);
    const raw = await fs.readFile(filePath, 'utf8');
    const json = JSON.parse(raw);
    return {
      fileName,
      modName: this._modName(fileName),
      scope: this._scope(fileName),
      raw: JSON.stringify(json, null, 2),
      json,
      schema: this._inferSchema(json),
      needRestart: true,
      backups: await this.backups(fileName),
    };
  }

  validate(fileName, raw) {
    this._validateFileName(fileName);
    try {
      JSON.parse(raw);
      return { valid: true, errors: [] };
    } catch (e) {
      const position = this._extractPosition(e.message);
      return { valid: false, errors: [{ message: e.message, position }] };
    }
  }

  format(fileName, raw) {
    this._validateFileName(fileName);
    const json = JSON.parse(raw);
    return { raw: JSON.stringify(json, null, 2), schema: this._inferSchema(json) };
  }

  async save(fileName, raw) {
    this._checkMode();
    const filePath = await this._resolveConfigPath(fileName, true);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const err = new Error(`JSON 格式错误：${e.message}`);
      err.data = { valid: false, errors: [{ message: e.message, position: this._extractPosition(e.message) }] };
      throw err;
    }

    const backupFile = await this.backup(fileName);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
    JSON.parse(await fs.readFile(tmpPath, 'utf8'));
    await fs.rename(tmpPath, filePath);
    await this._log(`SAVE ${fileName} backup=${backupFile || '-'}`);
    return { fileName, backupFile, needRestart: true };
  }

  async backup(fileName) {
    this._checkMode();
    const filePath = await this._resolveConfigPath(fileName, false);
    if (!await fs.pathExists(filePath)) return null;
    await fs.ensureDir(PATHS.BACKUPS_MODCONFIGS);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `${fileName}.${stamp}.bak`;
    await fs.copy(filePath, path.join(PATHS.BACKUPS_MODCONFIGS, backupFile));
    await this._log(`BACKUP ${fileName} -> ${backupFile}`);
    return backupFile;
  }

  async backups(fileName) {
    this._validateFileName(fileName);
    await fs.ensureDir(PATHS.BACKUPS_MODCONFIGS);
    const prefix = `${fileName}.`;
    const names = await fs.readdir(PATHS.BACKUPS_MODCONFIGS);
    const items = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue;
      const p = path.join(PATHS.BACKUPS_MODCONFIGS, name);
      const stat = await fs.stat(p);
      items.push({ backupFile: name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    return items.sort((a, b) => b.backupFile.localeCompare(a.backupFile));
  }

  async restore(fileName, backupFile) {
    this._checkMode();
    const filePath = await this._resolveConfigPath(fileName, true);
    const backupPath = await this._resolveBackupPath(fileName, backupFile);
    const currentBackup = await this.backup(fileName);
    await fs.copy(backupPath, filePath, { overwrite: true });
    await this._log(`RESTORE ${fileName} from=${backupFile} currentBackup=${currentBackup || '-'}`);
    return { fileName, backupFile, currentBackup, needRestart: true };
  }

  _validateFileName(fileName) {
    if (typeof fileName !== 'string') throw new Error('文件名无效');
    if (!/^[a-zA-Z0-9_. -]+\.json$/.test(fileName)) throw new Error('只允许编辑 .json 配置文件');
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) throw new Error('配置文件名非法');
    return fileName;
  }

  _validateBackupFile(fileName, backupFile) {
    if (typeof backupFile !== 'string') throw new Error('备份文件名无效');
    if (backupFile.includes('..') || backupFile.includes('/') || backupFile.includes('\\')) throw new Error('备份文件名非法');
    if (!backupFile.startsWith(`${fileName}.`) || !backupFile.endsWith('.bak')) throw new Error('备份文件不匹配');
    return backupFile;
  }

  async _resolveConfigPath(fileName, allowMissing) {
    this._validateFileName(fileName);
    await fs.ensureDir(PATHS.MODCONFIGS_DIR);
    const baseReal = await fs.realpath(PATHS.MODCONFIGS_DIR);
    const target = path.resolve(PATHS.MODCONFIGS_DIR, fileName);
    if (!target.startsWith(baseReal + path.sep)) throw new Error('非法路径');
    if (!allowMissing && !await fs.pathExists(target)) throw new Error('配置文件不存在');
    if (await fs.pathExists(target)) {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('不允许编辑符号链接配置文件');
    }
    return target;
  }

  async _resolveBackupPath(fileName, backupFile) {
    this._validateFileName(fileName);
    this._validateBackupFile(fileName, backupFile);
    await fs.ensureDir(PATHS.BACKUPS_MODCONFIGS);
    const baseReal = await fs.realpath(PATHS.BACKUPS_MODCONFIGS);
    const target = path.resolve(PATHS.BACKUPS_MODCONFIGS, backupFile);
    if (!target.startsWith(baseReal + path.sep)) throw new Error('非法路径');
    if (!await fs.pathExists(target)) throw new Error('备份不存在');
    return target;
  }

  _inferSchema(value, base = '') {
    if (Array.isArray(value)) {
      return { path: base, type: 'array', widget: 'array', label: this._label(base), itemType: this._arrayType(value) };
    }
    if (value && typeof value === 'object') {
      const children = {};
      for (const [key, child] of Object.entries(value)) {
        const childPath = base ? `${base}.${key}` : key;
        children[childPath] = this._inferSchema(child, childPath);
      }
      return base ? { path: base, type: 'object', widget: 'group', label: this._label(base), children } : children;
    }
    const type = value === null ? 'null' : typeof value;
    return { path: base, type, widget: this._widget(type), label: this._label(base) };
  }

  _arrayType(arr) {
    const types = [...new Set(arr.map(v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v))];
    return types.length === 1 ? types[0] : 'mixed';
  }

  _widget(type) {
    if (type === 'boolean') return 'switch';
    if (type === 'number') return 'number';
    if (type === 'string') return 'text';
    return 'json';
  }

  _label(p) {
    return p ? p.split('.').pop() : 'root';
  }

  _modName(fileName) {
    return fileName.replace(/_(Server|Client)?Config\.json$/i, '').replace(/Config\.json$/i, '').replace(/\.json$/i, '');
  }

  _scope(fileName) {
    if (/server/i.test(fileName)) return 'server';
    if (/client/i.test(fileName)) return 'client';
    return 'unknown';
  }

  _extractPosition(message) {
    const m = String(message).match(/position\s+(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  async _log(line) {
    await fs.ensureDir(PATHS.LOGS);
    await fs.appendFile(PATHS.MODCONFIG_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  }
}

module.exports = ModConfigService;
