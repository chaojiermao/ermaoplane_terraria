const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

class ModService {
  constructor(stateService, consoleService, backupService, downloader) {
    this.stateService = stateService;
    this.console = consoleService;
    this.backup = backupService;
    this.downloader = downloader;
  }

  isEnabled() {
    return this.stateService.get('currentMode') === 'tmodloader';
  }

  async list() {
    if (!this.isEnabled()) {
      throw new Error('当前为纯净服模式，模组管理不可用');
    }

    const modsDir = PATHS.MODS_DIR;
    await fs.ensureDir(modsDir);

    const enabledState = await this._readEnabledState();
    const files = await fs.readdir(modsDir);
    const mods = [];

    for (const file of files) {
      if (!file.toLowerCase().endsWith('.tmod')) continue;
      const stat = await fs.stat(path.join(modsDir, file));
      const modName = path.basename(file, path.extname(file));
      mods.push({
        name: modName,
        fileName: file,
        size: stat.size,
        enabled: this._isModEnabled(enabledState.names, modName),
        source: 'local',
        updatedAt: stat.mtime.toISOString(),
      });
    }

    for (const enabledName of enabledState.names) {
      if (!mods.find(m => this._sameModName(m.name, enabledName))) {
        mods.push({
          name: enabledName,
          fileName: null,
          size: 0,
          enabled: true,
          source: 'enabled.json',
          updatedAt: null,
        });
      }
    }

    return mods.sort((a, b) => a.name.localeCompare(b.name));
  }

  async enable(modName) {
    this._checkEnabled();
    const safeName = this._sanitizeModName(modName);
    const state = await this._readEnabledState();
    if (!this._isModEnabled(state.names, safeName)) {
      state.names.push(safeName);
      await this._writeEnabledState(state);
      this.console.write(`模组已启用: ${safeName}`, 'info');
    }
    return { success: true, enabled: true, modName: safeName };
  }

  async disable(modName) {
    this._checkEnabled();
    const safeName = this._sanitizeModName(modName);
    const state = await this._readEnabledState();
    state.names = state.names.filter(name => !this._sameModName(name, safeName));
    await this._writeEnabledState(state);
    this.console.write(`模组已禁用: ${safeName}`, 'info');
    return { success: true, enabled: false, modName: safeName };
  }

  async delete(modName) {
    this._checkEnabled();
    const safeName = this._sanitizeModName(modName);
    const modsDir = PATHS.MODS_DIR;
    const modPath = path.join(modsDir, `${safeName}.tmod`);

    if (await fs.pathExists(modPath)) {
      await fs.remove(modPath);
    }

    const state = await this._readEnabledState();
    state.names = state.names.filter(name => !this._sameModName(name, safeName));
    await this._writeEnabledState(state);
    this.console.write(`模组已删除: ${safeName}`, 'info');

    return { success: true };
  }

  async startUpload(uploadId, fileName) {
    this._checkEnabled();
    const modsDir = PATHS.MODS_DIR;
    await fs.ensureDir(modsDir);
    const safeFileName = path.basename(fileName || '');
    if (!safeFileName.toLowerCase().endsWith('.tmod')) throw new Error('只能上传 .tmod 文件');
    const tempDir = path.join(PATHS.DATA, 'uploads', uploadId);
    await fs.emptyDir(tempDir);
    return { uploadId, fileName: safeFileName, tempDir };
  }

  async writeUploadChunk(uploadId, index, data) {
    const tempDir = path.join(PATHS.DATA, 'uploads', uploadId);
    if (!await fs.pathExists(tempDir)) throw new Error('上传不存在或已过期');
    await fs.writeFile(path.join(tempDir, `${String(index).padStart(8, '0')}.part`), Buffer.from(data || '', 'base64'));
    return { success: true };
  }

  async finishUpload(uploadState) {
    this._checkEnabled();
    const modsDir = PATHS.MODS_DIR;
    const tempDir = path.join(PATHS.DATA, 'uploads', uploadState.uploadId);
    const finalPath = path.join(modsDir, uploadState.fileName);
    const out = fs.createWriteStream(finalPath);
    const chunks = (await fs.readdir(tempDir)).filter(n => n.endsWith('.part')).sort();
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', resolve);
      (async () => {
        try {
          for (const chunk of chunks) {
            await new Promise((res, rej) => {
              const input = fs.createReadStream(path.join(tempDir, chunk));
              input.on('error', rej);
              input.on('end', res);
              input.pipe(out, { end: false });
            });
          }
          out.end();
        } catch (e) { reject(e); }
      })();
    });
    await fs.remove(tempDir);
    this.console.write(`模组上传完成: ${uploadState.fileName}`, 'info');
    return { success: true, name: uploadState.fileName };
  }

  async updateMods() {
    this._checkEnabled();
    this.console.write('正在更新模组...', 'system');

    await this.backup.create('tmodloader', 'before_mod_update');

    const tmodDir = PATHS.RUNTIME_TMODLOADER;
    const scriptPath = path.join(tmodDir, 'manage-tModLoaderServer.sh');

    if (!await fs.pathExists(scriptPath)) {
      throw new Error('manage-tModLoaderServer.sh 不存在，请先安装 TModLoader');
    }

    await this.downloader.runCommand('bash', [scriptPath, 'install-mods'], tmodDir, (output) => {
      this.console.writeServerOutput(output);
    });

    this.console.write('模组更新完成', 'info');
    return { success: true };
  }

  async installFromPack() {
    return this.updateMods();
  }

  _checkEnabled() {
    if (!this.isEnabled()) {
      throw new Error('当前为纯净服模式，模组管理不可用');
    }
  }

  async _readEnabledState() {
    const state = { names: [], format: 'array' };
    try {
      if (!await fs.pathExists(PATHS.ENABLED_JSON)) return state;
      const raw = await fs.readJson(PATHS.ENABLED_JSON);
      if (Array.isArray(raw)) {
        state.names = raw.map(item => this._normalizeEnabledItem(item)).filter(Boolean);
        return state;
      }
      if (raw && Array.isArray(raw.enabled)) {
        state.format = 'object-enabled';
        state.names = raw.enabled.map(item => this._normalizeEnabledItem(item)).filter(Boolean);
        return state;
      }
      if (raw && Array.isArray(raw.mods)) {
        state.format = 'object-mods';
        state.names = raw.mods.map(item => this._normalizeEnabledItem(item)).filter(Boolean);
      }
    } catch (e) {
      logger.warn('ModService', '读取 enabled.json 失败，按空列表处理', e.message);
    }
    return state;
  }

  async _writeEnabledState(state) {
    const dir = path.dirname(PATHS.ENABLED_JSON);
    await fs.ensureDir(dir);
    await this._tryFixPermissions(dir);
    const names = [...new Map(state.names.map(name => [this._modKey(name), name])).values()].sort((a, b) => a.localeCompare(b));
    let content = names;
    if (state.format === 'object-enabled') content = { enabled: names };
    if (state.format === 'object-mods') content = { mods: names };
    try {
      if (await fs.pathExists(PATHS.ENABLED_JSON)) await this._tryFixPermissions(PATHS.ENABLED_JSON);
      await fs.writeJson(PATHS.ENABLED_JSON, content, { spaces: 2 });
    } catch (e) {
      if (e && e.code === 'EACCES') {
        throw new Error('enabled.json 权限不足，请执行：chown -R $(whoami) /opt/erpanel-terraria/.local/share/Terraria/tModLoader/Mods 或用安装脚本修复权限');
      }
      throw e;
    }
  }

  async _readInstallTxt() {
    try {
      if (await fs.pathExists(PATHS.INSTALL_TXT)) {
        const content = await fs.readFile(PATHS.INSTALL_TXT, 'utf8');
        return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  async _tryFixPermissions(target) {
    try {
      await fs.chmod(target, (await fs.stat(target)).isDirectory() ? 0o775 : 0o664);
    } catch (e) { /* ignore */ }
  }

  _normalizeEnabledItem(item) {
    if (typeof item === 'string') return this._stripTmodExt(item.trim());
    if (item && typeof item === 'object') {
      return this._stripTmodExt(String(item.name || item.mod || item.modName || item.internalName || '').trim());
    }
    return '';
  }

  _sanitizeModName(name) {
    const safe = this._stripTmodExt(String(name || '').replace(/[\x00-\x1F\x7F"';|`\\/]/g, '').trim());
    if (!safe) throw new Error('无效模组名');
    return safe;
  }

  _stripTmodExt(name) {
    return String(name || '').replace(/\.tmod$/i, '').trim();
  }

  _sameModName(a, b) {
    return this._modKey(a) === this._modKey(b);
  }

  _isModEnabled(names, modName) {
    return names.some(name => this._sameModName(name, modName));
  }

  _modKey(name) {
    return this._stripTmodExt(name).toLowerCase();
  }
}

module.exports = ModService;
