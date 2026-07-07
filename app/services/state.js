const fs = require('fs-extra');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

const DEFAULT_STATE = {
  initialized: false,
  currentMode: 'vanilla',
  serverStatus: 'stopped',
  currentWorld: null,
  vanillaVersion: null,
  tmodloaderVersion: null,
  serverPid: null,
  updatedAt: null,
  // 广播公告配置
  broadcastConfig: {
    text: '',
    interval: 10,
  },
  // 服务器运行配置（按模式区分）
  serverConfigs: {
    vanilla: {
      worldPath: '/opt/erpanel-terraria/.local/share/Terraria/Worlds',
      worldName: '',
      maxPlayers: '',
      port: '7777',
      password: '',
      motd: '',
      difficulty: '1',
      language: 'zh-Hans',
    },
    tmodloader: {
      worldPath: '/opt/erpanel-terraria/.local/share/Terraria/tModLoader/Worlds',
      worldName: '',
      maxPlayers: '',
      port: '7777',
      password: '',
      motd: '',
      difficulty: '1',
      language: 'zh-Hans',
    },
  },
};

class PanelStateService {
  constructor() {
    this.state = { ...DEFAULT_STATE };
    this._listeners = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(PATHS.STATE_FILE)) {
        const saved = fs.readJsonSync(PATHS.STATE_FILE);
        this.state = { ...DEFAULT_STATE, ...saved };
        logger.info('PanelStateService', 'State loaded', { mode: this.state.currentMode, status: this.state.serverStatus });
      }
    } catch (e) {
      logger.warn('PanelStateService', 'Failed to load state, using defaults', e.message);
    }
  }

  _save() {
    try {
      this.state.updatedAt = new Date().toISOString();
      fs.writeJsonSync(PATHS.STATE_FILE, this.state, { spaces: 2 });
    } catch (e) {
      logger.error('PanelStateService', 'Failed to save state', e.message);
    }
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  _notify() {
    const snapshot = this.getPublicState();
    this._listeners.forEach(fn => fn(snapshot));
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    this.state[key] = value;
    this._save();
    this._notify();
  }

  setMultiple(updates) {
    Object.assign(this.state, updates);
    this._save();
    this._notify();
  }

  /**
   * 获取指定模式的服务器运行配置
   */
  getServerConfig(mode) {
    const configs = this.state.serverConfigs || {};
    return configs[mode] || configs.vanilla || {};
  }

  /**
   * 保存指定模式的服务器运行配置
   */
  saveServerConfig(mode, form) {
    if (!this.state.serverConfigs) this.state.serverConfigs = {};
    if (!this.state.serverConfigs[mode]) this.state.serverConfigs[mode] = {};
    Object.assign(this.state.serverConfigs[mode], form);
    this._save();
    this._notify();
  }

  /**
   * 获取广播公告配置
   */
  getBroadcastConfig() {
    return this.state.broadcastConfig || { text: '', interval: 10 };
  }

  /**
   * 保存广播公告配置
   */
  saveBroadcastConfig(config) {
    this.state.broadcastConfig = { text: config.text || '', interval: parseInt(config.interval, 10) || 10 };
    this._save();
    this._notify();
  }

  getPublicState() {
    return {
      initialized: this.state.initialized,
      currentMode: this.state.currentMode,
      serverStatus: this.state.serverStatus,
      serverPid: this.state.serverPid,
      detectedPort: this.state.detectedPort,
      currentWorld: this.state.currentWorld,
      vanillaVersion: this.state.vanillaVersion,
      tmodloaderVersion: this.state.tmodloaderVersion,
    };
  }

  getAllState() {
    return { ...this.state };
  }
}

module.exports = PanelStateService;
