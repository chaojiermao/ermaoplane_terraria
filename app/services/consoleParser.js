const logger = require('../utils/logger');

/**
 * 解析泰拉瑞亚服务器控制台输出，提取玩家、事件等信息
 * 支持多语言（中英日韩）和不同版本
 */
class ConsoleParser {
  constructor() {
    this._logCount = 0;
    this._buffer = '';           // 半行缓存
    this._lineListeners = [];    // 行消费者
  }

  /**
   * 注册行消费者
   */
  onLine(fn) {
    this._lineListeners.push(fn);
  }

  /**
   * 喂入原始 chunk（支持 \n、\r 混合）
   * 替换 readline，避免交互式 CLI 输出顺序错乱
   */
  feed(chunk) {
    if (!chunk) return;
    // 统一换行为 \n
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this._buffer += normalized;

    // 拆出完整行
    const parts = this._buffer.split('\n');
    // 最后一个可能是未完成的行，保留到 buffer
    this._buffer = parts.pop() || '';

    for (const rawLine of parts) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      // 通知行消费者
      for (const fn of this._lineListeners) {
        try { fn(trimmed, rawLine); } catch (e) { /* ignore */ }
      }

      // 内部解析
      const event = this.parse(trimmed);
      if (event) {
        for (const fn of this._lineListeners) {
          try { fn('__event__', event); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  /**
   * 获取未完成的 partial prompt
   */
  getPartial() {
    return this._buffer.trim();
  }

  /**
   * 解析控制台输出行，返回事件对象
   * @param {string} line - 控制台输出行
   * @returns {object|null} - { type: 'join'|'leave'|'info'|null, playerName, raw }
   */
  parse(line) {
    if (!line || !line.trim()) return null;

    // 跳过 [STDERR] 前缀
    const clean = line.replace(/^\[STDERR\]\s*/, '').trim();
    if (!clean) return null;

    // 移除可能的时间戳前缀
    const content = clean.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').trim();

    // === 玩家加入检测（中文优先，英文兜底） ===
    const joinPatterns = [
      // 中文紧凑格式: "awa已加入。" 或 "awa已加入"
      /^(.+?)已加入[。.]?$/,
      // 中文新格式: "awa 已加入" 或 "awa 已加入。"
      /^(.+?)\s+已加入[。.]?$/,
      // 中文
      /^(.+?)加入了(?:游戏|服务器|群组)?！?$/,
      /^(.+?)已?加入(?:游戏|服务器|群组)?！?$/i,
      // 英文
      /^(.+?) has joined\.?$/i,
      /^(.+?) joined(?: the game)?\.?$/i,
      // 日文
      /^(.+?)が参加しました\.?$/,
      /^(.+?) がログインしました\.?$/,
      // tModLoader 特定格式
      /(.+?)\s+joined\s+the\s+game/i,
    ];

    for (const pattern of joinPatterns) {
      const match = content.match(pattern);
      if (match) {
        const name = this._sanitizePlayerName(match[1]);
        if (name && name.length <= 48 && !this._isSystemText(name)) {
          return { type: 'join', playerName: name, raw: clean };
        }
      }
    }

    // === 玩家离开检测（中文优先，英文兜底） ===
    const leavePatterns = [
      // 中文紧凑格式: "awa已离开。" 或 "awa已离开"
      /^(.+?)已离开[。.]?$/,
      // 中文新格式: "awa 已离开"
      /^(.+?)\s+已离开[。.]?$/,
      // 中文
      /^(.+?)离开[了]?(?:游戏|服务器)?[！!]*$/,
      /^(.+?)已?断开(?:连接)?[！!]*$/,
      // 英文
      /^(.+?) has left\.?$/i,
      /^(.+?) disconnected\.?$/i,
      /^(.+?) has disconnected\.?$/i,
      // 日文
      /^(.+?)が?退出しました\.?$/,
      /^(.+?)が?切断されました\.?$/,
    ];

    for (const pattern of leavePatterns) {
      const match = content.match(pattern);
      if (match) {
        const name = this._sanitizePlayerName(match[1]);
        if (name && name.length <= 48 && !this._isSystemText(name)) {
          return { type: 'leave', playerName: name, raw: clean };
        }
      }
    }

    // === 服务器信息检测 ===
    if (/(?:Server|服务器|サーバー)\s*(?:started|start|启动|起動)/i.test(content)) {
      return { type: 'server_start', raw: clean };
    }
    if (/(?:Server|服务器|サーバー)\s*(?:stopped|exit|关闭|停止|終了)/i.test(content)) {
      return { type: 'server_stop', raw: clean };
    }
    if (/(?:world|世界|ワールド)\s*(?:saved|saving|保存|セーブ)/i.test(content)) {
      return { type: 'world_save', raw: clean };
    }
    // 侦听端口（中文/英文）
    if (/(?:listening\s+on\s+port|正在侦听端口|侦听端口)/i.test(content)) {
      return { type: 'server_listening', raw: clean };
    }

    return null;
  }

  /**
   * 解析 playing 命令的输出结果
   * 输出格式示例：
   * 英文: "Current players: Player1, Player2, ..."
   * 中文: "当前玩家：玩家1，玩家2，..."
   * 
   * @param {string[]} recentLines - 最近的多行输出
   * @returns {object} { players: string[], raw: string }
   */
  parsePlayingOutput(recentLines) {
    const players = [];
    const text = Array.isArray(recentLines) ? recentLines.join('\n') : String(recentLines);
    const lines = Array.isArray(recentLines) ? recentLines : String(recentLines).split('\n');

    let count = 0, max = 0;

    // 格式1: "玩家名 (IP)" —— 新版/中文版格式
    for (const line of lines) {
      const match = line.match(/^\s*(\S+)\s*\([\d.]+:\d+\)/);
      if (match) {
        const name = this._sanitizePlayerName(match[1]);
        if (name && !this._isSystemText(name) && name.length <= 48) {
          players.push(name);
        }
      }
      // 格式2: "N个玩家已连接" 或 "N players connected"
      const cntMatch = line.match(/(\d+)个玩家已连接/);
      const cntEn = line.match(/(\d+)\s+players?\s+connected/i);
      if (cntMatch) count = parseInt(cntMatch[1], 10);
      if (cntEn) count = parseInt(cntEn[1], 10);
    }

    // 如果没有找到任何玩家，继续尝试原有格式
    if (players.length === 0) {
      // 原有格式: "Current players (2/8): Player1, Player2"
      const patterns = [
        /(?:Current\s+players?|Online\s+players?)\s*(?:\((\d+)\/(\d+)\))?\s*:\s*([^\n\r]+)/i,
        /当前玩家\s*(?:[（(](\d+)\/(\d+)[）)])?\s*[：:]\s*([^\n\r]+)/,
        /Players?\s*[：:]\s*([^\n\r]+)/i,
        /There\s+are\s+(\d+)\s+players?\s+online/i,
        /現在のプレイヤー\s*(?:[（(](\d+)\/(\d+)[）)])?\s*[：:]\s*([^\n\r]+)/,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          if (match[1]) count = parseInt(match[1], 10);
          if (match[2]) max = parseInt(match[2], 10);
          let namesText = match[match.length - 1];
          if (namesText) {
            const names = namesText
              .split(/[,，、\s]+/)
              .map(n => this._sanitizePlayerName(n.trim()))
              .filter(n => n && n.length > 0 && n.length <= 48 && !this._isSystemText(n));
            players.push(...names);
          }
          break;
        }
      }

      // 按行解析（某些版本每行一个玩家名）
      if (players.length === 0 && Array.isArray(recentLines)) {
        for (const line of recentLines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('[') && !trimmed.startsWith('Current')
            && !trimmed.includes('player') && !trimmed.includes('玩家')
            && !trimmed.includes(':') && !trimmed.includes('：')
            && trimmed.length <= 48 && trimmed.length > 1) {
            const name = this._sanitizePlayerName(trimmed);
            if (name && !this._isSystemText(name)) {
              players.push(name);
            }
          }
        }
      }
    }

    // 去重
    const unique = [...new Set(players)];

    return {
      players: unique,
      count: count || unique.length,
      maxPlayers: max || 0,
    };
  }

  /**
   * 清理玩家名：移除非法字符，限制长度
   */
  _sanitizePlayerName(name) {
    if (!name) return '';
    // 移除控制字符（换行、回车、制表等）
    let cleaned = name.replace(/[\x00-\x1F\x7F]/g, '');
    // 移除前后空格和引号
    cleaned = cleaned.replace(/^["'']+|["'']+$/g, '');
    // 移除多余空格
    cleaned = cleaned.trim();
    // 限制长度
    if (cleaned.length > 48) cleaned = cleaned.substring(0, 48);
    return cleaned;
  }

  /**
   * 判断是否为系统信息文本（不是玩家名）
   */
  _isSystemText(text) {
    const sysWords = [
      'server', 'online', 'offline', 'players', 'player',
      'current', 'total', 'none', 'no', 'max',
      '服务器', '在线', '离线', '玩家', '当前', '最大',
      'サーバー', 'プレイヤー', 'オンライン',
      'started', 'stopped', 'saved',
    ];
    const lower = text.toLowerCase();
    return sysWords.some(w => lower === w || lower.startsWith(w + ':'));
  }
}

module.exports = ConsoleParser;
