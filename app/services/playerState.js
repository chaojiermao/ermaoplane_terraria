const logger = require('../utils/logger');

/**
 * 维护在线玩家状态缓存
 * 支持玩家加入/离开事件 + playing命令解析
 */
class PlayerStateService {
  constructor() {
    this._players = new Map();     // playerName -> playerObject
    this._count = 0;
    this._maxPlayers = 20;
    this._updatedAt = null;
    this._listeners = [];           // 状态变化监听器
    this._intervalTimer = null;     // playing 轮询定时器
    this._gameProcess = null;       // 游戏进程引用
    this._parser = null;            // 解析器引用
    this._staleCount = 0;           // 解析失败计数
  }

  /**
   * 设置游戏进程和解析器引用
   */
  bind(gameProcess, parser) {
    this._gameProcess = gameProcess;
    this._parser = parser;
  }

  /**
   * 启动 playing 轮询
   */
  startPolling() {
    if (this._intervalTimer) return;
    // 每8秒轮询一次
    this._intervalTimer = setInterval(() => this._pollPlaying(), 8000);
    logger.info('PlayerStateService', 'Playing polling started');
  }

  /**
   * 停止轮询
   */
  stopPolling() {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
    logger.info('PlayerStateService', 'Playing polling stopped');
  }

  /**
   * 清理所有玩家状态（服务器停止时）
   */
  clear() {
    this._players.clear();
    this._count = 0;
    this._updatedAt = new Date().toISOString();
    this._staleCount = 0;
    this._notifyListeners();
  }

  /**
   * 处理控制台事件
   */
  handleEvent(event) {
    if (!event) return;

    switch (event.type) {
      case 'join':
        this._onPlayerJoin(event.playerName);
        break;
      case 'leave':
        this._onPlayerLeave(event.playerName);
        break;
      case 'server_stop':
        this.clear();
        break;
    }
  }

  /**
   * 获取当前玩家状态
   */
  getState() {
    const players = [];
    this._players.forEach(p => players.push({
      name: p.name,
      joinedAt: p.joinedAt,
      onlineSeconds: p.joinedAt ? Math.round((Date.now() - new Date(p.joinedAt).getTime()) / 1000) : 0,
      source: p.source || 'console',
    }));

    return {
      count: this._count,
      maxPlayers: this._maxPlayers,
      players,
      updatedAt: this._updatedAt,
      stale: this._staleCount >= 3,
    };
  }

  /**
   * 设置最大玩家数（从配置读取）
   */
  setMaxPlayers(max) {
    this._maxPlayers = parseInt(max, 10) || 20;
  }

  /**
   * 注册状态变化监听器
   */
  onChange(fn) {
    this._listeners.push(fn);
  }

  // ---- 内部方法 ----

  _onPlayerJoin(name) {
    if (!name) return;
    const key = name.toLowerCase();
    if (!this._players.has(key)) {
      this._players.set(key, {
        name,
        joinedAt: new Date().toISOString(),
        source: 'console',
      });
      this._count = this._players.size;
      this._updatedAt = new Date().toISOString();
      this._staleCount = 0;
      logger.debug('PlayerStateService', `Player joined: ${name} (total: ${this._count})`);
      this._notifyListeners();
    }
  }

  _onPlayerLeave(name) {
    if (!name) return;
    const key = name.toLowerCase();
    if (this._players.has(key)) {
      this._players.delete(key);
      this._count = this._players.size;
      this._updatedAt = new Date().toISOString();
      this._staleCount = 0;
      logger.debug('PlayerStateService', `Player left: ${name} (total: ${this._count})`);
      this._notifyListeners();
    }
  }

  async _pollPlaying() {
    if (!this._gameProcess || !this._parser) return;

    try {
      // 向服务器发送 playing 命令
      this._gameProcess.sendCommand('playing');
    } catch (e) {
      // 忽略发送错误（服务器可能未运行）
    }
  }

  /**
   * 处理 playing 命令的输出解析结果
   */
  applyPlayingResult(result) {
    if (!result || !result.players) return;

    // 用 playing 结果作为权威数据更新
    const resultNames = new Set(result.players.map(n => n.toLowerCase()));
    const currentNames = new Set([...this._players.keys()].map(n => n.toLowerCase()));

    // 移除不在 playing 列表中的玩家
    for (const [key, player] of this._players) {
      if (!resultNames.has(player.name.toLowerCase())) {
        this._players.delete(key);
      }
    }

    // 添加 playing 列表中的新玩家
    for (const name of result.players) {
      const key = name.toLowerCase();
      if (!this._players.has(key)) {
        this._players.set(key, {
          name,
          joinedAt: new Date().toISOString(),
          source: 'playing',
        });
      }
    }

    this._count = this._players.size;
    if (result.maxPlayers > 0) {
      this._maxPlayers = result.maxPlayers;
    }
    this._updatedAt = new Date().toISOString();
    this._staleCount = 0;
    this._notifyListeners();
  }

  _notifyListeners() {
    const state = this.getState();
    this._listeners.forEach(fn => {
      try { fn(state); } catch (e) { /* ignore */ }
    });
  }
}

module.exports = PlayerStateService;
