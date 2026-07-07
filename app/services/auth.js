const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

const JWT_SECRET = process.env.JWT_SECRET || 'terraria-panel-secret-change-me';
const JWT_EXPIRES = '24h';
const SALT_ROUNDS = 10;

const ROLES = { OWNER: 'owner', ADMIN: 'admin', VIEWER: 'viewer' };
const ROLE_HIERARCHY = { owner: 3, admin: 2, viewer: 1 };

const PERMISSIONS = {
  'server.start':         ['owner', 'admin'],
  'server.stop':          ['owner', 'admin'],
  'server.restart':       ['owner', 'admin'],
  'server.forceStop':     ['owner'],
  'server.save':          ['owner', 'admin'],
  'server.command':       ['owner', 'admin'],
  'mode.switch':          ['owner'],
  'version.update':       ['owner', 'admin'],
  'version.rollback':     ['owner'],
  'world.delete':         ['owner', 'admin'],
  'world.upload':         ['owner', 'admin'],
  'world.download':       ['owner', 'admin', 'viewer'],
  'world.create':         ['owner', 'admin'],
  'world.switch':         ['owner', 'admin'],
  'mod.upload':           ['owner', 'admin'],
  'mod.delete':           ['owner', 'admin'],
  'mod.enable':           ['owner', 'admin'],
  'mod.disable':          ['owner', 'admin'],
  'backup.restore':       ['owner'],
  'backup.create':        ['owner', 'admin'],
  'backup.delete':        ['owner'],
  'config.save':          ['owner', 'admin'],
  'player.kick':          ['owner', 'admin'],
  'player.ban':           ['owner'],
};

class AuthService {
  constructor() {
    this.users = [];
    this._loginFailures = new Map();
    this._load();
    if (JWT_SECRET === 'terraria-panel-secret-change-me') {
      logger.warn('AuthService', 'JWT_SECRET 使用默认值，生产环境建议通过环境变量设置强随机密钥');
    }
  }

  _load() {
    try {
      if (fs.existsSync(PATHS.USERS_FILE)) {
        this.users = fs.readJsonSync(PATHS.USERS_FILE);
      }
    } catch (e) {
      logger.error('AuthService', 'Failed to load users', e.message);
      this.users = [];
    }
  }

  _save() {
    try {
      fs.writeJsonSync(PATHS.USERS_FILE, this.users, { spaces: 2 });
    } catch (e) {
      logger.error('AuthService', 'Failed to save users', e.message);
    }
  }

  isInitialized() {
    return this.users.length > 0;
  }

  async createOwner(username, password) {
    if (this.isInitialized()) {
      throw new Error('管理员已存在，不能重复创建');
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    this.users.push({
      id: 'u_owner',
      username,
      password: hash,
      role: ROLES.OWNER,
      passwordVersion: 1,
      createdAt: new Date().toISOString(),
    });
    this._save();
    logger.info('AuthService', `Owner created: ${username}`);
    return { id: 'u_owner', username, role: ROLES.OWNER };
  }

  async createUser(username, password, role = ROLES.VIEWER) {
    if (!this.isInitialized()) {
      throw new Error('请先创建管理员账号');
    }
    if (!ROLE_HIERARCHY[role]) {
      throw new Error(`无效角色: ${role}`);
    }
    const existing = this.users.find(u => u.username === username);
    if (existing) throw new Error('用户名已存在');

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = {
      id: `u_${Date.now()}`,
      username,
      password: hash,
      role,
      passwordVersion: 1,
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this._save();
    return { id: user.id, username: user.username, role: user.role };
  }

  async login(username, password, context = {}) {
    const key = this._loginKey(username, context.ip);
    const failure = this._loginFailures.get(key);
    if (failure && failure.lockedUntil && failure.lockedUntil > Date.now()) {
      const minutes = Math.ceil((failure.lockedUntil - Date.now()) / 60000);
      throw new Error(`登录失败次数过多，请 ${minutes} 分钟后再试`);
    }

    const user = this.users.find(u => u.username === username);
    if (!user) throw this._recordLoginFailure(key);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw this._recordLoginFailure(key);

    this._loginFailures.delete(key);
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, passwordVersion: user.passwordVersion || 1 },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    logger.info('AuthService', `User logged in: ${username}`);
    return {
      token,
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  verifyToken(token) {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = this.users.find(u => u.id === decoded.id);
    if (!user) {
      throw new Error('用户不存在');
    }
    if (decoded.passwordVersion !== (user.passwordVersion || 1)) {
      throw new Error('密码已修改，请重新登录');
    }
    return decoded;
  }

  _loginKey(username, ip) {
    return `${String(username || '').toLowerCase()}@${ip || 'unknown'}`;
  }

  _recordLoginFailure(key) {
    const current = this._loginFailures.get(key) || { count: 0, lockedUntil: 0 };
    current.count += 1;
    if (current.count > 10) {
      current.lockedUntil = Date.now() + 15 * 60 * 1000;
    }
    this._loginFailures.set(key, current);

    if (current.lockedUntil && current.lockedUntil > Date.now()) {
      logger.warn('AuthService', `Login locked: ${key}`);
      return new Error('登录失败次数过多，已锁定 15 分钟');
    }
    if (current.count >= 3) {
      return new Error(`用户名或密码错误，已连续失败 ${current.count} 次，超过 10 次将锁定 15 分钟`);
    }
    return new Error('用户名或密码错误');
  }

  hasPermission(role, action) {
    const allowed = PERMISSIONS[action];
    if (!allowed) return false;
    return allowed.includes(role);
  }

  getUser(username) {
    const u = this.users.find(x => x.username === username);
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role };
  }

  getUserById(id) {
    const u = this.users.find(x => x.id === id);
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role };
  }

  listUsers() {
    return this.users.map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt }));
  }

  async changePassword(id, oldPassword, newPassword) {
    const user = this.users.find(u => u.id === id);
    if (!user) throw new Error('用户不存在');
    const valid = await bcrypt.compare(oldPassword, user.password);
    if (!valid) throw new Error('旧密码错误');
    user.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.passwordVersion = (user.passwordVersion || 1) + 1;
    this._save();
    logger.info('AuthService', `Password changed for user: ${user.username}`);
  }
}

module.exports = { AuthService, ROLES, ROLE_HIERARCHY, PERMISSIONS };
