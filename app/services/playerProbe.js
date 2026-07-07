const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

class PlayerProbeService {
  constructor(parser) {
    this._parser = parser;
    this._players = new Map();
    this._count = 0;
    this._maxPlayers = 20;
    this._updatedAt = null;
    this._staleCount = 0;
    this._listeners = [];
    this._chunkListeners = [];
    this._process = null;
    this._probeTimer = null;
    this._listeningDetected = false;
    this._listeningListeners = [];
    this._playingWindow = false;
    this._playingBuffer = [];
    this._runtimeMaxPlayers = 20;
    this._mode = 'vanilla';
    this._playerRawLog = PATHS.VANILLA_PLAYER_RAW_LOG;
    this._consoleRawLog = PATHS.VANILLA_CONSOLE_RAW_LOG;
    this._parserHooked = false;
    this._hookParser();
  }

  resetForMode(mode, rawLogPath) {
    this.destroy();
    this._mode = mode || 'vanilla';
    this._playerRawLog = rawLogPath || (this._mode === 'tmodloader' ? PATHS.TMOD_PLAYER_RAW_LOG : PATHS.VANILLA_PLAYER_RAW_LOG);
    this._consoleRawLog = this._mode === 'tmodloader' ? PATHS.TMOD_CONSOLE_RAW_LOG : PATHS.VANILLA_CONSOLE_RAW_LOG;
    this._listeningDetected = false;
    this._playingWindow = false;
    this._playingBuffer = [];
    this.clear();
  }

  bind(processRef, options = {}) {
    this._process = processRef;
    if (options.mode) this._mode = options.mode;
    if (!this._process || !this._process.stdout) return;

    this._process.stdout.on('data', (buf) => this._handleChunk('stdout', buf));
    this._process.stderr.on('data', (buf) => this._handleChunk('stderr', buf));
  }

  addChunkConsumer(fn) {
    this._chunkListeners.push(fn);
  }

  setRuntimeMaxPlayers(max) {
    this._runtimeMaxPlayers = max || 8;
    this._maxPlayers = this._runtimeMaxPlayers;
  }

  getState() {
    const players = [];
    this._players.forEach(p => players.push({
      name: p.name,
      joinedAt: p.joinedAt,
      onlineSeconds: p.joinedAt ? Math.round((Date.now() - new Date(p.joinedAt).getTime()) / 1000) : 0,
      source: p.source || `${this._mode}-console`,
    }));

    return {
      mode: this._mode,
      count: this._count,
      maxPlayers: this._runtimeMaxPlayers,
      players,
      updatedAt: this._updatedAt,
      stale: this._staleCount >= 3,
    };
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  onceListening(fn) {
    if (this._listeningDetected) return fn(this._listeningDetected);
    this._listeningListeners.push(fn);
  }

  clear() {
    this._players.clear();
    this._count = 0;
    this._updatedAt = new Date().toISOString();
    this._staleCount = 0;
    this._notifyListenersState();
  }

  destroy() {
    this._stopProbing();
    this._process = null;
    this._listeningListeners = [];
  }

  _hookParser() {
    if (this._parserHooked) return;
    this._parserHooked = true;
    this._parser.onLine((type, data) => {
      if (type !== '__event__') {
        if (this._playingWindow) {
          this._playingBuffer.push(String(data || ''));
          clearTimeout(this._playingCloseTimer);
          this._playingCloseTimer = setTimeout(() => this._closePlayingWindow(), 600);
        }
        const port = this._parseListeningPort(String(data || ''));
        if (port) this._onListening(port);
        return;
      }

      if (!data) return;
      if (data.type === 'join') this._onPlayerJoin(data.playerName);
      if (data.type === 'leave') this._onPlayerLeave(data.playerName);
      if (data.type === 'server_listening') {
        const port = this._parseListeningPort(data.raw) || 7777;
        this._onListening(port);
      }
    });
  }

  _handleChunk(stream, buf) {
    const text = buf.toString('utf8');
    if (!text) return;

    this._broadcastChunk(stream, text);
    this._parser.feed(text);
    this._appendRawLog(`[${stream.toUpperCase()}] ${text.replace(/\n/g, '\\n')}`);

    if (this._mode === 'tmodloader') {
      logger.info('PlayerProbeService', `[TMOD_CONSOLE_RAW] ${text.trim().slice(0, 500)}`);
    }

    const partial = this._parser.getPartial();
    const feedText = partial || text;
    for (const fn of this._chunkListeners) {
      try { fn(feedText, !!partial); } catch (e) { /* ignore */ }
    }
  }

  _broadcastChunk(stream, text) {
    const time = new Date().toISOString();
    this._notifyListeners({ type: 'console.chunk', data: { stream, text, mode: this._mode, time } });
    fs.appendFile(this._consoleRawLog, `[${time}] [${stream.toUpperCase()}] ${text}`).catch(() => {});
  }

  _startProbing() {
    if (this._probeTimer) return;
    this._probeTimer = setInterval(() => {
      if (!this._process || this._process.killed) return this._stopProbing();
      this._playingWindow = true;
      this._playingBuffer = [];
      try {
        this._process.stdin.write('playing\n');
        if (this._mode === 'tmodloader') logger.info('PlayerProbeService', '[TMOD_STDIN] playing');
      } catch (e) {
        this._stopProbing();
      }
    }, 5000);
    logger.info('PlayerProbeService', `${this._mode} playing probe started`);
  }

  _stopProbing() {
    if (this._probeTimer) clearInterval(this._probeTimer);
    this._probeTimer = null;
    if (this._playingCloseTimer) clearTimeout(this._playingCloseTimer);
    this._playingCloseTimer = null;
  }

  _closePlayingWindow() {
    if (!this._playingWindow) return;
    this._playingWindow = false;
    const result = this._parser.parsePlayingOutput(this._playingBuffer);
    if (result && (result.players.length > 0 || result.count === 0)) {
      this._applyResult(result);
      this._staleCount = 0;
    } else {
      this._staleCount++;
      this._appendRawLog(`[PARSE_FAIL] ${JSON.stringify(this._playingBuffer)}`);
      this._updatedAt = new Date().toISOString();
      this._notifyListenersState();
    }
    this._playingBuffer = [];
  }

  _applyResult(result) {
    const resultNames = new Set(result.players.map(n => n.toLowerCase()));
    for (const [key] of this._players) {
      if (!resultNames.has(key)) this._players.delete(key);
    }
    for (const name of result.players) {
      const key = name.toLowerCase();
      if (!this._players.has(key)) {
        this._players.set(key, { name, joinedAt: new Date().toISOString(), source: `${this._mode}-playing` });
      }
    }
    this._count = this._players.size;
    if (result.maxPlayers > 0) this._maxPlayers = result.maxPlayers;
    this._updatedAt = new Date().toISOString();
    if (this._mode === 'tmodloader') {
      logger.info('PlayerProbeService', `[TMOD_PLAYER_STATE] count=${this._count} max=${this._runtimeMaxPlayers} players=${result.players.join(',')}`);
    }
    this._notifyListenersState();
  }

  _onPlayerJoin(name) {
    if (!name) return;
    const key = name.toLowerCase();
    if (!this._players.has(key)) {
      this._players.set(key, { name, joinedAt: new Date().toISOString(), source: `${this._mode}-console` });
      this._count = this._players.size;
      this._updatedAt = new Date().toISOString();
      this._appendRawLog(`[JOIN] ${name}`);
      this._notifyListenersState();
    }
  }

  _onPlayerLeave(name) {
    if (!name) return;
    const key = name.toLowerCase();
    if (this._players.has(key)) {
      this._players.delete(key);
      this._count = this._players.size;
      this._updatedAt = new Date().toISOString();
      this._appendRawLog(`[LEAVE] ${name}`);
      this._notifyListenersState();
    }
  }

  _onListening(port) {
    if (this._listeningDetected) return;
    this._listeningDetected = port;
    this._notifyListeners({ type: 'listening', data: { mode: this._mode, port } });
    for (const fn of this._listeningListeners.splice(0)) {
      try { fn(port); } catch (e) { /* ignore */ }
    }
    this._startProbing();
  }

  _parseListeningPort(line) {
    const en = String(line || '').match(/Listening on port\s*(\d+)/i);
    if (en) return parseInt(en[1], 10);
    const zh = String(line || '').match(/正在侦听端口\s*(\d+)/);
    if (zh) return parseInt(zh[1], 10);
    return null;
  }

  _appendRawLog(line) {
    fs.appendFile(this._playerRawLog, `[${new Date().toISOString()}] ${line}\n`).catch(() => {});
  }

  _notifyListeners(data) {
    for (const fn of this._listeners) {
      try { fn(data); } catch (e) { /* ignore */ }
    }
  }

  _notifyListenersState() {
    this._notifyListeners(this.getState());
  }
}

module.exports = PlayerProbeService;
