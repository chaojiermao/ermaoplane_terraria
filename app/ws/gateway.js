const logger = require('../utils/logger');
const { ROLES } = require('../services/auth');

class WebSocketGateway {
  constructor(authService, stateService, gameService, consoleService, modeService,
              versionService, worldService, modService, backupService, configService, logService, systemService, playerProbe, fileService, wizardService, modConfigService) {
    this.auth = authService;
    this.state = stateService;
    this.game = gameService;
    this.console = consoleService;
    this.mode = modeService;
    this.version = versionService;
    this.world = worldService;
    this.mod = modService;
    this.backup = backupService;
    this.config = configService;
    this.logService = logService;
    this.system = systemService;
    this._playerState = playerProbe;
    this.file = fileService;
    this._wizard = wizardService;
    this.modConfig = modConfigService;

    this._clients = new Map();
    this._uploadStates = new Map();

    // 订阅玩家状态变化，推送给所有已认证客户端
    this._playerState.onChange((event) => {
      if (event.type === 'console.chunk') {
        this._broadcastAuthenticated({
          type: 'console.chunk',
          data: event.data,
        });
      } else if (event.type === 'listening') {
        this._broadcastAuthenticated({
          type: 'server.listening',
          data: {},
        });
      } else {
        this._broadcastAuthenticated({
          type: 'player.push',
          data: event,
        });
      }
    });

    // 订阅创建世界向导状态变化
    if (this._wizard) {
      this._wizard.onChange((event) => {
        if (event.type === 'wizard.prompt') {
          this._broadcastAuthenticated({
            type: 'wizard.prompt',
            data: event.data,
          });
        } else if (event.type === 'wizard.options_append') {
          this._broadcastAuthenticated({
            type: 'wizard.options_append',
            data: event.data,
          });
        }
      });
    }

    // 订阅面板状态变化
    this.state.onChange((publicState) => {
      this._broadcast({ type: 'status.push', data: publicState });
    });
  }

  handleConnection(ws, req) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const client = { id: clientId, ws, user: null, authenticated: false, subscriptions: new Set() };
    this._clients.set(ws, client);

    logger.info('WebSocketGateway', `Client connected: ${clientId} (total: ${this._clients.size})`);

    ws.on('message', (data) => this._handleMessage(ws, data));
    ws.on('close', () => this._handleDisconnect(ws));
    ws.on('error', (err) => {
      logger.warn('WebSocketGateway', 'Client error', err.message);
      this._handleDisconnect(ws);
    });

    this._send(ws, {
      type: 'ws.connected',
      data: { clientId, initialized: this.auth.isInitialized() },
    });
  }

  _handleMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return this._send(ws, { type: 'error', message: '无效的 JSON 格式' });
    }

    const { id, type, token, payload = {} } = msg;

    if (type === 'auth.init') {
      return this._handleAuthInit(ws, id);
    }
    if (type === 'auth.login') {
      return this._handleLogin(ws, id, payload);
    }
    if (type === 'auth.me') {
      return this._handleAuthMe(ws, id, msg);
    }

    const client = this._clients.get(ws);
    if (!client || !client.authenticated) {
      return this._send(ws, { id, type: type + '.result', success: false, message: '未登录' });
    }

    this._routeMessage(ws, client, id, type, payload);
  }

  _routeMessage(ws, client, id, type, payload) {
    const handler = this._getHandler(type);
    if (!handler) {
      return this._send(ws, { id, type: type + '.result', success: false, message: `未知消息类型: ${type}` });
    }

    const action = this._getActionForType(type);
    if (action && !this.auth.hasPermission(client.user.role, action)) {
      return this._send(ws, { id, type: type + '.result', success: false, message: '权限不足' });
    }

    handler.call(this, ws, client, id, payload).catch(err => {
      logger.warn('WebSocketGateway', `Handler error for ${type}`, err.message);
      this._send(ws, { id, type: type + '.result', success: false, message: err.message });
    });
  }

  _getHandler(type) {
    const handlers = {
      'auth.me':             this._handleAuthMe,
      'auth.logout':         this._handleLogout,
      'auth.changePassword': this._handleChangePassword,
      'status.get':          this._handleStatusGet,
      'server.start':        this._handleServerStart,
      'server.stop':         this._handleServerStop,
      'server.restart':      this._handleServerRestart,
      'server.forceStop':    this._handleServerForceStop,
      'server.save':         this._handleServerSave,
      'server.command':      this._handleServerCommand,
      'console.subscribe':   this._handleConsoleSubscribe,
      'console.command':     this._handleServerCommand,
      'console.clear':       this._handleConsoleClear,
      'wizard.command':      this._handleWizardCommand,
      'wizard.reset':        this._handleWizardReset,
      'mode.get':            this._handleModeGet,
      'mode.switch':         this._handleModeSwitch,
      'mode.switchClean':    this._handleModeSwitchClean,
      'system.status':       this._handleSystemStatus,
      'version.get':         this._handleVersionGet,
      'version.check':       this._handleVersionCheck,
      'version.update':      this._handleVersionUpdate,
      'version.rollback':    this._handleVersionRollback,
      'world.list':          this._handleWorldList,
      'world.info':          this._handleWorldInfo,
      'world.switch':        this._handleWorldSwitch,
      'world.delete':        this._handleWorldDelete,
      'world.upload.start':  this._handleWorldUploadStart,
      'world.upload.chunk':  this._handleWorldUploadChunk,
      'world.upload.finish': this._handleWorldUploadFinish,
      'world.download':      this._handleWorldDownload,
      'player.list':         this._handlePlayerList,
      'player.kick':         this._handlePlayerKick,
      'player.ban':          this._handlePlayerBan,
      'mod.list':            this._handleModList,
      'mod.enable':          this._handleModEnable,
      'mod.disable':         this._handleModDisable,
      'mod.upload.start':    this._handleModUploadStart,
      'mod.upload.chunk':    this._handleModUploadChunk,
      'mod.upload.finish':   this._handleModUploadFinish,
      'mod.delete':          this._handleModDelete,
      'modconfig.list':      this._handleModConfigList,
      'modconfig.read':      this._handleModConfigRead,
      'modconfig.validate':  this._handleModConfigValidate,
      'modconfig.save':      this._handleModConfigSave,
      'modconfig.backup':    this._handleModConfigBackup,
      'modconfig.restore':   this._handleModConfigRestore,
      'modconfig.format':    this._handleModConfigFormat,
      'backup.list':         this._handleBackupList,
      'backup.create':       this._handleBackupCreate,
      'backup.restore':      this._handleBackupRestore,
      'backup.delete':       this._handleBackupDelete,
      'log.list':            this._handleLogList,
      'log.read':            this._handleLogRead,
      'log.tail':            this._handleLogTail,
      'config.get':          this._handleConfigGet,
      'config.save':         this._handleConfigSave,
      'config.rawSave':      this._handleConfigRawSave,
      'file.list':           this._handleFileList,
      'file.read':           this._handleFileRead,
      'file.write':          this._handleFileWrite,
      'file.rename':         this._handleFileRename,
      'file.remove':         this._handleFileRemove,
      'file.mkdir':          this._handleFileMkdir,
      'file.roots':          this._handleFileRoots,
      'file.upload.start':   this._handleFileUploadStart,
      'file.upload.chunk':   this._handleFileUploadChunk,
      'file.upload.finish':  this._handleFileUploadFinish,
      'file.compress':       this._handleFileCompress,
      'file.extract':        this._handleFileExtract,
      'broadcast.get':       this._handleBroadcastGet,
      'broadcast.save':      this._handleBroadcastSave,
    };
    return handlers[type] || null;
  }

  _getActionForType(type) {
    const map = {
      'server.start': 'server.start',
      'server.stop': 'server.stop',
      'server.restart': 'server.restart',
      'server.forceStop': 'server.forceStop',
      'server.save': 'server.save',
      'server.command': 'server.command',
      'mode.switch': 'mode.switch',
      'version.update': 'version.update',
      'version.rollback': 'version.rollback',
      'world.delete': 'world.delete',
      'world.upload.start': 'world.upload',
      'world.upload.chunk': 'world.upload',
      'world.upload.finish': 'world.upload',
      'world.download': 'world.download',
      'world.switch': 'world.switch',
      'mod.upload.start': 'mod.upload',
      'mod.upload.chunk': 'mod.upload',
      'mod.upload.finish': 'mod.upload',
      'mod.delete': 'mod.delete',
      'mod.enable': 'mod.enable',
      'mod.disable': 'mod.disable',
      'modconfig.save': 'mod.enable',
      'modconfig.backup': 'mod.enable',
      'modconfig.restore': 'mod.enable',
      'backup.restore': 'backup.restore',
      'backup.create': 'backup.create',
      'backup.delete': 'backup.delete',
      'config.save': 'config.save',
      'config.rawSave': 'config.save',
      'file.compress': 'file.upload',
      'file.extract': 'file.upload',
      'player.kick': 'player.kick',
      'player.ban': 'player.ban',
    };
    return map[type] || null;
  }

  // ==================== Auth ====================

  async _handleAuthInit(ws, id) {
    this._send(ws, { id, type: 'auth.init.result', success: true, data: {
      initialized: this.auth.isInitialized(),
    }});
  }

  async _handleLogin(ws, id, payload) {
    const { username, password } = payload;
    const ip = ws._socket?.remoteAddress || 'unknown';
    if (!username || !password) {
      return this._send(ws, { id, type: 'auth.login.result', success: false, message: '请输入用户名和密码' });
    }

    if (!this.auth.isInitialized()) {
      const user = await this.auth.createOwner(username, password);
      const result = await this.auth.login(username, password, { ip });
      const client = this._clients.get(ws);
      if (client) { client.user = result.user; client.authenticated = true; }
      this.state.set('initialized', true);
      return this._send(ws, { id, type: 'auth.login.result', success: true, data: result });
    }

    try {
      const result = await this.auth.login(username, password, { ip });
      const client = this._clients.get(ws);
      if (client) { client.user = result.user; client.authenticated = true; }
      this._send(ws, { id, type: 'auth.login.result', success: true, data: result });
    } catch (e) {
      this._send(ws, { id, type: 'auth.login.result', success: false, message: e.message });
    }
  }

  async _handleAuthMe(ws, id, msg) {
    const { token } = msg;
    if (!token) {
      return this._send(ws, { id, type: 'auth.me.result', success: false, message: '未登录' });
    }
    try {
      const user = this.auth.verifyToken(token);
      const client = this._clients.get(ws);
      if (client) {
        client.authenticated = true;
        client.user = user;
      }
      this._send(ws, { id, type: 'auth.me.result', success: true, data: { user } });
    } catch (e) {
      this._send(ws, { id, type: 'auth.me.result', success: false, message: '登录已过期，请重新登录' });
    }
  }

  async _handleLogout(ws, client, id) {
    client.authenticated = false;
    client.user = null;
    this._send(ws, { id, type: 'auth.logout.result', success: true });
  }

  async _handleChangePassword(ws, client, id, payload) {
    try {
      await this.auth.changePassword(client.user.id, payload.oldPassword, payload.newPassword);
      this._send(ws, { id, type: 'auth.changePassword.result', success: true, message: '密码已修改' });
    } catch (e) {
      this._send(ws, { id, type: 'auth.changePassword.result', success: false, message: e.message });
    }
  }

  // ==================== Status ====================

  async _handleStatusGet(ws, client, id) {
    const publicState = this.state.getPublicState();
    const actualStatus = this.game.getStatus();
    const playerState = this._playerState.getState();
    const lastConfig = this.state.get('lastServerConfig') || {};
    this._send(ws, { id, type: 'status.get.result', success: true, data: {
      ...publicState,
      currentMode: this.state.get('currentMode'),
      serverStatus: actualStatus,
      serverPid: this.game.getPid() || this.state.get('serverPid'),
      detectedPort: this.state.get('detectedPort') || lastConfig.port || 7777,
      playerCount: playerState.count,
      maxPlayers: playerState.maxPlayers || lastConfig.maxPlayers || 8,
      currentWorld: this.state.get('currentWorld') || publicState.currentWorld,
      world: this.state.get('currentWorld') || publicState.currentWorld,
    }});
  }

  // ==================== Server Control ====================

  async _handleServerStart(ws, client, id, payload) {
    await this.game.start();
    this._send(ws, { id, type: 'server.start.result', success: true, message: '服务器已启动' });
  }

  async _handleServerStop(ws, client, id) {
    await this.game.stop(false);
    this._send(ws, { id, type: 'server.stop.result', success: true, message: '服务器已停止' });
  }

  async _handleServerRestart(ws, client, id) {
    await this.game.restart();
    this._send(ws, { id, type: 'server.restart.result', success: true, message: '服务器已重启' });
  }

  async _handleServerForceStop(ws, client, id) {
    await this.game.stop(true);
    this._send(ws, { id, type: 'server.forceStop.result', success: true, message: '服务器已强制停止' });
  }

  async _handleServerSave(ws, client, id) {
    await this.game.save();
    this._send(ws, { id, type: 'server.save.result', success: true, message: '世界已保存' });
  }

  async _handleServerCommand(ws, client, id, payload) {
    const { command } = payload;
    // 允许空命令（发送空回车）
    this.game.sendCommand(command || '');
    this._send(ws, { id, type: 'server.command.result', success: true, message: '命令已发送' });
  }

  // ==================== Console ====================

  async _handleConsoleSubscribe(ws, client, id) {
    const unsubscribe = this.console.subscribe(ws);
    client.subscriptions.add(unsubscribe);
    this._send(ws, { id, type: 'console.subscribe.result', success: true });
  }

  async _handleConsoleClear(ws, client, id) {
    this.console.clear();
    this._send(ws, { id, type: 'console.clear.result', success: true });
  }

  // ==================== Wizard ====================

  async _handleWizardCommand(ws, client, id, payload) {
    const { command } = payload;
    if (!this._wizard) {
      return this._send(ws, { id, type: 'wizard.command.result', success: false, message: '向导服务未初始化' });
    }
    this._wizard.sendCommand(command || '');
    this._send(ws, { id, type: 'wizard.command.result', success: true, message: '命令已发送', state: this._wizard.state });
  }

  async _handleWizardReset(ws, client, id) {
    if (!this._wizard) {
      return this._send(ws, { id, type: 'wizard.reset.result', success: false, message: '向导服务未初始化' });
    }
    this._wizard.reset();
    this._send(ws, { id, type: 'wizard.reset.result', success: true, message: '向导已重置' });
  }

  // ==================== Mode ====================

  async _handleModeGet(ws, client, id) {
    const mode = this.mode.getCurrentMode();
    this._send(ws, { id, type: 'mode.get.result', success: true, data: { mode } });
  }

  async _handleModeSwitch(ws, client, id, payload) {
    const result = await this.mode.switch(payload.mode);
    this._send(ws, { id, type: 'mode.switch.result', success: true, data: result });
  }

  async _handleModeSwitchClean(ws, client, id, payload) {
    const result = await this.mode.switchClean(payload.mode);
    this._send(ws, { id, type: 'mode.switchClean.result', success: true, data: result });
  }

  // ==================== System ====================

  async _handleSystemStatus(ws, client, id) {
    const data = await this.system.getStatus();
    this._send(ws, { id, type: 'system.status.result', success: true, data });
  }

  // ==================== Version ====================

  async _handleVersionGet(ws, client, id) {
    const [vanilla, tmod] = await Promise.all([
      this.version.getVanillaVersion(),
      this.version.getTmodVersion(),
    ]);
    this._send(ws, { id, type: 'version.get.result', success: true, data: { vanilla, tmod } });
  }

  async _handleVersionCheck(ws, client, id) {
    const [vanillaRemote, tmodRemote] = await Promise.all([
      this.version.checkVanillaRemote(),
      this.version.checkTmodRemote(),
    ]);
    this._send(ws, { id, type: 'version.check.result', success: true, data: { vanillaRemote, tmodRemote } });
  }

  async _handleVersionUpdate(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const source = payload.source || 'mirror';
    let maxPercent = 0;
    const taskCallback = (progress) => {
      // 进度只增不减，防止回弹
      if (progress.percent > maxPercent) maxPercent = progress.percent;
      this._broadcastAuthenticated({ type: 'task.progress', data: { ...progress, percent: maxPercent } });
    };
    let result;
    if (mode === 'tmodloader') {
      result = await this.version.updateTmod(taskCallback, source);
    } else {
      result = await this.version.updateVanilla(taskCallback, source);
    }
    // 广播结果（兼容重连后前端仍能收到响应）
    this._broadcastAuthenticated({ id, type: 'version.update.result', success: true, data: result });
    // 更新完成后推送最新版本信息
    const [vanilla, tmod] = await Promise.all([
      this.version.getVanillaVersion(),
      this.version.getTmodVersion(),
    ]);
    this._broadcastAuthenticated({ type: 'version.push', data: { vanilla, tmod } });
    // 推送状态更新
    this._broadcastAuthenticated({ type: 'status.push', data: this.state.getPublicState() });
  }

  async _handleVersionRollback(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.version.rollback(mode);
    this._send(ws, { id, type: 'version.rollback.result', success: true, data: result });
  }

  // ==================== World ====================

  async _handleWorldList(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const worlds = await this.world.list(mode);
    this._send(ws, { id, type: 'world.list.result', success: true, data: { worlds } });
  }

  async _handleWorldInfo(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const info = await this.world.info(mode, payload.worldName);
    this._send(ws, { id, type: 'world.info.result', success: true, data: info });
  }

  async _handleWorldSwitch(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.world.switchWorld(mode, payload.worldName);
    this._send(ws, { id, type: 'world.switch.result', success: true, data: result });
  }

  async _handleWorldDelete(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.world.delete(mode, payload.worldName);
    this._send(ws, { id, type: 'world.delete.result', success: true, data: result });
  }

  async _handleWorldUploadStart(ws, client, id, payload) {
    const { fileName, total, uploadId } = payload;
    this._uploadStates.set(uploadId, { chunks: [], fileName, total, type: 'world' });
    this._send(ws, { id, type: 'world.upload.start.result', success: true, data: { uploadId } });
  }

  async _handleWorldUploadChunk(ws, client, id, payload) {
    const { uploadId, index, data } = payload;
    const state = this._uploadStates.get(uploadId);
    if (!state) throw new Error('上传不存在或已过期');
    state.chunks[index] = data;
    this._send(ws, { id, type: 'world.upload.chunk.result', success: true });
  }

  async _handleWorldUploadFinish(ws, client, id, payload) {
    const { uploadId } = payload;
    const state = this._uploadStates.get(uploadId);
    if (!state) throw new Error('上传不存在或已过期');
    const mode = this.state.get('currentMode');
    const result = await this.world.handleUpload(mode, uploadId, state.fileName, state.chunks);
    this._uploadStates.delete(uploadId);
    this._send(ws, { id, type: 'world.upload.finish.result', success: true, data: result });
  }

  async _handleWorldDownload(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.world.download(mode, payload.worldName);
    this._send(ws, { id, type: 'world.download.result', success: true, data: result });
  }

  // ==================== Player (真实数据) ====================

  async _handlePlayerList(ws, client, id) {
    const playerState = this._playerState.getState();
    this._send(ws, { id, type: 'player.list.result', success: true, data: playerState });
  }

  async _handlePlayerKick(ws, client, id, payload) {
    if (!this.game.isRunning()) throw new Error('服务器未运行');
    const name = payload.name || payload.playerName;
    const result = this.game.kick(name);
    this._send(ws, { id, type: 'player.kick.result', success: true, message: result.message });
  }

  async _handlePlayerBan(ws, client, id, payload) {
    if (!this.game.isRunning()) throw new Error('服务器未运行');
    const name = payload.name || payload.playerName;
    const result = this.game.ban(name);
    this._send(ws, { id, type: 'player.ban.result', success: true, message: result.message });
  }

  // ==================== Mod ====================

  async _handleModList(ws, client, id) {
    try {
      const mods = await this.mod.list();
      this._send(ws, { id, type: 'mod.list.result', success: true, data: { mods } });
    } catch (e) {
      this._send(ws, { id, type: 'mod.list.result', success: false, message: e.message });
    }
  }

  async _handleModEnable(ws, client, id, payload) {
    const result = await this.mod.enable(payload.modName);
    this._send(ws, { id, type: 'mod.enable.result', success: true, data: result });
  }

  async _handleModDisable(ws, client, id, payload) {
    const result = await this.mod.disable(payload.modName);
    this._send(ws, { id, type: 'mod.disable.result', success: true, data: result });
  }

  async _handleModUploadStart(ws, client, id, payload) {
    const { fileName, total, uploadId } = payload;
    const safeUploadId = uploadId || `mod_upload_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const uploadState = await this.mod.startUpload(safeUploadId, fileName);
    this._uploadStates.set(safeUploadId, { ...uploadState, total, type: 'mod' });
    this._send(ws, { id, type: 'mod.upload.start.result', success: true, data: { uploadId: safeUploadId } });
  }

  async _handleModUploadChunk(ws, client, id, payload) {
    const { uploadId, index, data } = payload;
    const state = this._uploadStates.get(uploadId);
    if (!state) throw new Error('上传不存在或已过期');
    await this.mod.writeUploadChunk(uploadId, index, data);
    this._send(ws, { id, type: 'mod.upload.chunk.result', success: true });
  }

  async _handleModUploadFinish(ws, client, id, payload) {
    const { uploadId } = payload;
    const state = this._uploadStates.get(uploadId);
    if (!state) throw new Error('上传不存在或已过期');
    const result = await this.mod.finishUpload(state);
    this._uploadStates.delete(uploadId);
    this._send(ws, { id, type: 'mod.upload.finish.result', success: true, data: result });
  }

  async _handleModDelete(ws, client, id, payload) {
    const result = await this.mod.delete(payload.modName);
    this._send(ws, { id, type: 'mod.delete.result', success: true, data: result });
  }

  // ==================== ModConfigs ====================

  async _handleModConfigList(ws, client, id) {
    const result = await this.modConfig.list();
    this._send(ws, { id, type: 'modconfig.list.result', success: true, data: result });
  }

  async _handleModConfigRead(ws, client, id, payload) {
    const result = await this.modConfig.read(payload.fileName);
    this._send(ws, { id, type: 'modconfig.read.result', success: true, data: result });
  }

  async _handleModConfigValidate(ws, client, id, payload) {
    const result = this.modConfig.validate(payload.fileName, payload.raw || '');
    this._send(ws, { id, type: 'modconfig.validate.result', success: result.valid, data: result, message: result.valid ? 'JSON 格式正确' : 'JSON 格式错误' });
  }

  async _handleModConfigFormat(ws, client, id, payload) {
    const result = this.modConfig.format(payload.fileName, payload.raw || '');
    this._send(ws, { id, type: 'modconfig.format.result', success: true, data: result });
  }

  async _handleModConfigSave(ws, client, id, payload) {
    try {
      const result = await this.modConfig.save(payload.fileName, payload.raw || '');
      this._send(ws, { id, type: 'modconfig.save.result', success: true, message: '配置已保存，重启 tModLoader 后生效', data: result });
    } catch (e) {
      this._send(ws, { id, type: 'modconfig.save.result', success: false, message: e.message, data: e.data });
    }
  }

  async _handleModConfigBackup(ws, client, id, payload) {
    const backupFile = await this.modConfig.backup(payload.fileName);
    this._send(ws, { id, type: 'modconfig.backup.result', success: true, data: { backupFile } });
  }

  async _handleModConfigRestore(ws, client, id, payload) {
    const result = await this.modConfig.restore(payload.fileName, payload.backupFile);
    this._send(ws, { id, type: 'modconfig.restore.result', success: true, message: '配置已恢复，重启 tModLoader 后生效', data: result });
  }

  // ==================== Backup ====================

  async _handleBackupList(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const backups = await this.backup.list(mode);
    this._send(ws, { id, type: 'backup.list.result', success: true, data: { backups } });
  }

  async _handleBackupCreate(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const backupId = await this.backup.create(mode, payload.reason || 'manual');
    this._send(ws, { id, type: 'backup.create.result', success: true, data: { backupId } });
  }

  async _handleBackupRestore(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.backup.restore(mode, payload.backupId);
    this._send(ws, { id, type: 'backup.restore.result', success: true, data: result });
  }

  async _handleBackupDelete(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.backup.delete(mode, payload.backupId);
    this._send(ws, { id, type: 'backup.delete.result', success: true, data: result });
  }

  // ==================== Log ====================

  async _handleLogList(ws, client, id) {
    const logs = await this.logService.list();
    this._send(ws, { id, type: 'log.list.result', success: true, data: { logs } });
  }

  async _handleLogRead(ws, client, id, payload) {
    const result = await this.logService.read(payload.logId, payload.lines || 100);
    this._send(ws, { id, type: 'log.read.result', success: true, data: result });
  }

  async _handleLogTail(ws, client, id, payload) {
    const result = await this.logService.tail(payload.logId, payload.count || 50);
    this._send(ws, { id, type: 'log.tail.result', success: true, data: result });
  }

  // ==================== Config（增强版） ====================

  async _handleConfigGet(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const config = await this.config.getConfig(mode);
    this._send(ws, { id, type: 'config.get.result', success: true, data: config });
  }

  /**
   * config.save 接受表单字段或原始文本
   * payload.content: 原始文本内容
   * payload.form: 表单字段对象（可选）
   * 返回 restartRequired, changedFields
   */
  async _handleConfigSave(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const form = payload.form;
    let result;

    if (form && typeof form === 'object') {
      // 表单保存：同时写入 state.json（主配置）+ serverconfig.txt（备用）
      result = await this.config.saveConfig(mode, null, form);
      this.state.saveServerConfig(mode, form);
    } else {
      // 原始文本保存
      result = await this.config.saveConfig(mode, payload.content);
    }

    this._send(ws, { id, type: 'config.save.result', success: true, data: result });
  }

  /**
   * config.rawSave 只接受原始文本
   */
  async _handleConfigRawSave(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.config.saveConfig(mode, payload.rawText);
    this._send(ws, { id, type: 'config.rawSave.result', success: true, data: result });
  }

  // ==================== File Management ====================

  async _handleFileList(ws, client, id, payload) {
    const result = await this.file.list(payload.path);
    this._send(ws, { id, type: 'file.list.result', success: true, data: result });
  }

  async _handleFileRead(ws, client, id, payload) {
    const result = await this.file.read(payload.path);
    this._send(ws, { id, type: 'file.read.result', success: true, data: result });
  }

  async _handleFileWrite(ws, client, id, payload) {
    const result = await this.file.write(payload.path, payload.content);
    this._send(ws, { id, type: 'file.write.result', success: true, data: result });
  }

  async _handleFileRename(ws, client, id, payload) {
    const result = await this.file.rename(payload.path, payload.newName);
    this._send(ws, { id, type: 'file.rename.result', success: true, data: result });
  }

  async _handleFileRemove(ws, client, id, payload) {
    const result = await this.file.remove(payload.path);
    this._send(ws, { id, type: 'file.remove.result', success: true, data: result });
  }

  async _handleFileMkdir(ws, client, id, payload) {
    const result = await this.file.mkdir(payload.path, payload.dirName);
    this._send(ws, { id, type: 'file.mkdir.result', success: true, data: result });
  }

  async _handleFileRoots(ws, client, id, payload) {
    const mode = payload.mode || this.state.get('currentMode');
    const result = await this.file.getRoots(mode);
    this._send(ws, { id, type: 'file.roots.result', success: true, data: result });
  }

  // ==================== File Upload ====================

  async _handleFileUploadStart(ws, client, id, payload) {
    const { fileName, fileSize, totalChunks, destDir } = payload;
    const uploadId = `file_upload_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const uploadState = await this.file.startUpload(uploadId, fileName, destDir);
    this._uploadStates.set(uploadId, { ...uploadState, fileSize, totalChunks, type: 'file' });
    this._send(ws, { id, type: 'file.upload.start.result', success: true, data: { uploadId } });
  }

  async _handleFileUploadChunk(ws, client, id, payload) {
    const { uploadId, index, data } = payload;
    const state = this._uploadStates.get(uploadId);
    if (!state) throw new Error('上传不存在或已过期');
    await this.file.writeUploadChunk(uploadId, index, data);
    this._send(ws, { id, type: 'file.upload.chunk.result', success: true });
  }

  async _handleFileUploadFinish(ws, client, id, payload) {
    const { uploadId } = payload;
    const state = this._uploadStates.get(uploadId);
    if (!state) throw new Error('上传不存在或已过期');
    const result = await this.file.finishUpload(state);
    this._uploadStates.delete(uploadId);
    this._send(ws, { id, type: 'file.upload.finish.result', success: true, data: result });
  }

  async _handleFileCompress(ws, client, id, payload) {
    const result = await this.file.compress(payload.path);
    this._send(ws, { id, type: 'file.compress.result', success: true, data: result });
  }

  async _handleFileExtract(ws, client, id, payload) {
    const result = await this.file.extract(payload.path, payload.destDir);
    this._send(ws, { id, type: 'file.extract.result', success: true, data: result });
  }

  // ==================== Helpers ====================

  _send(ws, msg) {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch (e) {
      logger.warn('WebSocketGateway', 'Send failed', e.message);
    }
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    this._clients.forEach((client) => {
      try {
        if (client.ws.readyState === 1) {
          client.ws.send(data);
        }
      } catch (e) { /* ignore */ }
    });
  }

  _broadcastAuthenticated(msg) {
    const data = JSON.stringify(msg);
    this._clients.forEach((client) => {
      if (client.authenticated) {
        try {
          if (client.ws.readyState === 1) {
            client.ws.send(data);
          }
        } catch (e) { /* ignore */ }
      }
    });
  }

  // ==================== Broadcast ====================

  async _handleBroadcastGet(ws, client, id) {
    const config = this.state.getBroadcastConfig();
    this._send(ws, { id, type: 'broadcast.get.result', success: true, data: config });
  }

  async _handleBroadcastSave(ws, client, id, payload) {
    if (!payload || !payload.text) {
      return this._send(ws, { id, type: 'broadcast.save.result', success: false, message: '公告内容不能为空' });
    }
    this.state.saveBroadcastConfig({ text: payload.text, interval: payload.interval || 10 });
    // 如果游戏正在运行，更新广播定时器
    if (this.game.isRunning() && this.game._broadcastTimer) {
      this.game._restartBroadcast();
    }
    this._send(ws, { id, type: 'broadcast.save.result', success: true, message: '公告设置已保存' });
  }

  _handleDisconnect(ws) {
    const client = this._clients.get(ws);
    if (client) {
      client.subscriptions.forEach(unsub => { try { unsub(); } catch(e) {} });
      this._clients.delete(ws);
      logger.info('WebSocketGateway', `Client disconnected (total: ${this._clients.size})`);
    }
  }
}

module.exports = WebSocketGateway;
