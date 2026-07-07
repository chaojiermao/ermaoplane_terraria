const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

const RAW_LOG = path.join(PATHS.LOGS, 'wizard-state.log');

/**
 * WorldCreationWizardService - 交互式创建世界状态机
 * 
 * 检测服务端输出中的创建世界 prompt，推送 wizard.prompt
 * 用户通过按钮选择后，后端发送对应数字/文本到 stdin
 */
class WorldCreationWizardService {
  constructor() {
    this._state = 'idle';        // idle | choose_world_action | choose_size | choose_difficulty | choose_evil | enter_world_name | enter_seed | creating_world | running
    this._listeners = [];
    this._rawBuffer = '';        // 最近 5000 字符的原始 buffer
    this._lastFlush = Date.now();
    this._gameService = null;
  }

  get state() { return this._state; }

  /**
   * 注册状态变化监听器
   */
  onChange(fn) {
    this._listeners.push(fn);
  }

  /**
   * 喂入原始 chunk（每收到 stdout chunk 调用一次）
   */
  feed(chunk, isPartial = false) {
    if (!chunk || !chunk.trim()) return;
    const text = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 维护 rawBuffer（最多 5000 字符）
    this._rawBuffer += text;
    if (this._rawBuffer.length > 5000) {
      this._rawBuffer = this._rawBuffer.slice(-5000);
    }
    this._lastFlush = Date.now();

    // 检测 prompt 状态（只有在 idle 或等待用户输入状态时才检测）
    if (this._state === 'idle' || 
        this._state === 'choose_world_action' || 
        this._state === 'choose_size' || 
        this._state === 'choose_difficulty' || 
        this._state === 'choose_evil' ||
        this._state === 'enter_world_name' ||
        this._state === 'enter_seed') {
      this._detectPrompt(text);
    }
  }

  /**
   * 重置状态
   */
  reset() {
    this._state = 'idle';
    this._rawBuffer = '';
  }

  /**
   * 绑定游戏服务（通过 gameService 发送命令）
   */
  bindGameService(gameService) {
    this._gameService = gameService;
  }

  /**
   * 发送命令到进程（由外部调用）
   */
  sendCommand(input) {
    if (!this._gameService) return;
    try {
      this._gameService.sendCommand(input || '');
      this._appendRawLog(`[WIZARD_CMD] state=${this._state} input=${input}`);
    } catch (e) {
      logger.warn('WorldCreationWizard', 'Send command failed', e.message);
    }
  }

  bindProcess(processRef) {
    this._process = processRef;
  }

  // ========== 内部方法 ==========

  _detectPrompt(text) {
    const buf = this._rawBuffer;

    // 检测: 选择世界操作 (n = New World, d = Delete)
    if (/n\s+New\s+World/i.test(buf) && /d\s+Delete\s+World/i.test(buf)) {
      this._transition('choose_world_action', {
        title: '选择操作',
        options: [
          { value: 'n', label: '新建世界' },
          { value: 'd', label: '删除世界' },
        ]
      });
      return;
    }

    // 检测: 选择世界大小
    if (/\b1\s+Small\b/i.test(buf) && /\b2\s+Medium\b/i.test(buf) && /\b3\s+Large\b/i.test(buf)) {
      this._transition('choose_size', {
        title: '选择世界大小',
        options: [
          { value: '1', label: '小世界' },
          { value: '2', label: '中世界' },
          { value: '3', label: '大世界' },
        ]
      });
      return;
    }

    // 检测: 选择难度
    if (/\b1\s+Classic\b/i.test(buf) && /\b2\s+Expert\b/i.test(buf) && /\b3\s+Master\b/i.test(buf)) {
      this._transition('choose_difficulty', {
        title: '选择难度',
        options: [
          { value: '1', label: '经典' },
          { value: '2', label: '专家' },
          { value: '3', label: '大师' },
        ]
      });
      if (/\b4\s+Journey\b/i.test(buf)) {
        this._notifyOptionsAppend({ value: '4', label: '旅行' });
      }
      return;
    }

    // 检测: 选择世界邪恶
    const hasEvilTitle = /Choose world evil|选择世界邪恶|世界邪恶/i.test(buf);
    const hasRandom = /\b1\s+Random\b|随机/i.test(buf);
    const hasCorrupt = /\b2\s+Corrupt\b|腐化/i.test(buf);
    const hasCrimson = /\b3\s+Crimson\b|猩红/i.test(buf);
    
    if (hasEvilTitle || (hasRandom && (hasCorrupt || hasCrimson))) {
      this._transition('choose_evil', {
        title: '选择世界邪恶',
        options: [
          { value: '1', label: '随机' },
          { value: '2', label: '腐化' },
          { value: '3', label: '猩红' },
        ]
      });
      return;
    }

    // 检测: 输入世界名称
    if (/输入世界名称|Enter world name|输入种子/i.test(buf) && this._state !== 'enter_world_name' && this._state !== 'enter_seed') {
      if (/输入种子|Enter seed|seed/i.test(buf) && /世界名称|world name/i.test(buf)) {
        // 同时检测到两个
      } else if (/种子|seed/i.test(buf) || /留空则随机/i.test(buf)) {
        this._transition('enter_seed', {
          title: '输入种子（留空则随机）',
          options: []
        });
      } else if (/世界名称|world name/i.test(buf)) {
        this._transition('enter_world_name', {
          title: '输入世界名称',
          options: []
        });
      }
      return;
    }

    // 检测: 正在创建世界
    if (/生成世界|Creating world|正在生成/i.test(buf) && /[\d.]+%/i.test(buf)) {
      this._transition('creating_world', {
        title: '正在生成世界...',
        options: []
      });
      return;
    }

    // 检测: Listening on port（创建完毕）
    if (/(?:listening\s+on\s+port|正在侦听端口|侦听端口)/i.test(buf)) {
      this._transition('running', {
        title: '服务器运行中',
        options: []
      });
      return;
    }
  }

  _transition(newState, promptData) {
    if (this._state === newState) return;
    const oldState = this._state;
    this._state = newState;
    this._appendRawLog(`[WIZARD] ${oldState} -> ${newState}`);
    logger.info('WorldCreationWizard', `State: ${oldState} -> ${newState}`);

    // 通知监听器
    for (const fn of this._listeners) {
      try {
        fn({ type: 'wizard.prompt', data: { state: newState, ...promptData } });
      } catch (e) { /* ignore */ }
    }
  }

  _notifyOptionsAppend(extraOption) {
    for (const fn of this._listeners) {
      try {
        fn({ type: 'wizard.options_append', data: { option: extraOption } });
      } catch (e) { /* ignore */ }
    }
  }

  _appendRawLog(line) {
    fs.appendFile(RAW_LOG, `[${new Date().toISOString()}] ${line}\n`).catch(() => {});
  }
}

module.exports = WorldCreationWizardService;
