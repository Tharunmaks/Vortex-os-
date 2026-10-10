'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const audit = require('./audit');

const ROLES = {
  queen: { label: 'Queen', terminal: true, write: true, admin: true },
  worker: { label: 'Worker Bee', terminal: true, write: true, admin: false },
  drone: { label: 'Drone', terminal: false, write: false, admin: false },
};

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return { salt: salt.toString('base64'), hash: key.toString('base64') };
}

async function verifyPassword(password, record) {
  const key = await scrypt(password, Buffer.from(record.salt, 'base64'));
  const expected = Buffer.from(record.hash, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function validatePassword(password, username) {
  if (typeof password !== 'string' || password.length < config.passwordMinLength) {
    return `Password must be at least ${config.passwordMinLength} characters`;
  }
  if (password.length > 256) return 'Password is too long';
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Password must not contain the username';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'Password needs 3 of: lowercase, uppercase, digit, symbol';
  return null;
}

function generatePassword() {
  // 18 chars from an unambiguous alphabet + guaranteed classes.
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(16)) out += alpha[b % alpha.length];
  return out + '-9';
}

class UserStore {
  constructor(file = path.join(config.dataDir, 'users.json')) {
    this.file = file;
    this.users = new Map();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const u of data.users || []) this.users.set(u.username, u);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: [...this.users.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(username) {
    return this.users.get(username) || null;
  }

  list() {
    return [...this.users.values()].map(publicUser);
  }

  count() {
    return this.users.size;
  }

  async create({ username, password, role = 'worker', mustChangePassword = false }) {
    username = String(username || '').toLowerCase();
    if (!USERNAME_RE.test(username)) throw new Error('Username must be 3-32 chars: a-z, 0-9, _ or -, starting with a letter');
    if (!ROLES[role]) throw new Error('Unknown role');
    if (this.users.has(username)) throw new Error('A bee with that name already exists');
    const problem = validatePassword(password, username);
    if (problem) throw new Error(problem);
    const user = {
      username,
      role,
      ...(await hashPassword(password)),
      disabled: false,
      mustChangePassword,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    this.users.set(username, user);
    this.save();
    return publicUser(user);
  }

  async setPassword(username, password, { mustChangePassword = false } = {}) {
    const user = this.get(username);
    if (!user) throw new Error('No such bee');
    const problem = validatePassword(password, username);
    if (problem) throw new Error(problem);
    Object.assign(user, await hashPassword(password), { mustChangePassword });
    this.save();
  }

  update(username, changes) {
    const user = this.get(username);
    if (!user) throw new Error('No such bee');
    if (changes.role !== undefined) {
      if (!ROLES[changes.role]) throw new Error('Unknown role');
      if (user.role === 'queen' && changes.role !== 'queen' && this.queenCount() <= 1) {
        throw new Error('The hive needs at least one active queen');
      }
      user.role = changes.role;
    }
    if (changes.disabled !== undefined) {
      if (changes.disabled && user.role === 'queen' && this.queenCount() <= 1) {
        throw new Error('The hive needs at least one active queen');
      }
      user.disabled = Boolean(changes.disabled);
    }
    this.save();
    return publicUser(user);
  }

  remove(username) {
    const user = this.get(username);
    if (!user) throw new Error('No such bee');
    if (user.role === 'queen' && this.queenCount() <= 1) throw new Error('The hive needs at least one active queen');
    this.users.delete(username);
    this.save();
  }

  queenCount() {
    return [...this.users.values()].filter((u) => u.role === 'queen' && !u.disabled).length;
  }

  touchLogin(username) {
    const user = this.get(username);
    if (user) {
      user.lastLogin = new Date().toISOString();
      this.save();
    }
  }
}

function publicUser(u) {
  return {
    username: u.username,
    role: u.role,
    roleLabel: ROLES[u.role]?.label || u.role,
    disabled: u.disabled,
    mustChangePassword: Boolean(u.mustChangePassword),
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
  };
}

/** Sliding-window failure counter with lockout. */
class RateLimiter {
  constructor({ max, windowMs, lockoutMs }) {
    Object.assign(this, { max, windowMs, lockoutMs });
    this.entries = new Map();
  }

  locked(key, now = Date.now()) {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (e.lockedUntil > now) return e.lockedUntil - now;
    if (now - e.first > this.windowMs) this.entries.delete(key);
    return 0;
  }

  fail(key, now = Date.now()) {
    let e = this.entries.get(key);
    if (!e || now - e.first > this.windowMs) {
      e = { count: 0, first: now, lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.count += 1;
    if (e.count >= this.max) e.lockedUntil = now + this.lockoutMs;
    return e.count;
  }

  reset(key) {
    this.entries.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil < now && now - e.first > this.windowMs) this.entries.delete(k);
    }
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  create(user, ip, userAgent) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, {
      id: crypto.randomBytes(6).toString('hex'),
      username: user.username,
      created: now,
      lastSeen: now,
      ip,
      userAgent: String(userAgent || '').slice(0, 160),
    });
    return token;
  }

  get(token, now = Date.now()) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (now - s.lastSeen > config.sessionIdleMs || now - s.created > config.sessionMaxMs) {
      this.sessions.delete(token);
      return null;
    }
    s.lastSeen = now;
    return s;
  }

  destroy(token) {
    this.sessions.delete(token);
  }

  destroyUser(username, exceptToken) {
    let n = 0;
    for (const [t, s] of this.sessions) {
      if (s.username === username && t !== exceptToken) {
        this.sessions.delete(t);
        n++;
      }
    }
    return n;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  sweep(now = Date.now()) {
    for (const [t, s] of this.sessions) {
      if (now - s.lastSeen > config.sessionIdleMs || now - s.created > config.sessionMaxMs) this.sessions.delete(t);
    }
  }
}

class Auth {
  constructor(store = new UserStore()) {
    this.store = store;
    this.sessions = new SessionManager();
    this.userLimiter = new RateLimiter({
      max: config.login.maxFailuresPerUser,
      windowMs: config.login.windowMs,
      lockoutMs: config.login.lockoutMs,
    });
    this.ipLimiter = new RateLimiter({
      max: config.login.maxFailuresPerIp,
      windowMs: config.login.windowMs,
      lockoutMs: config.login.lockoutMs,
    });
    this.dummy = null;
  }

  async ensureQueen() {
    if (this.store.count() > 0) return null;
    const password = process.env.VORTEX_ADMIN_PASSWORD || generatePassword();
    const username = (process.env.VORTEX_ADMIN_USER || 'queen').toLowerCase();
    await this.store.create({
      username,
      password,
      role: 'queen',
      mustChangePassword: !process.env.VORTEX_ADMIN_PASSWORD,
    });
    audit.log('hive.founded', { user: username });
    return { username, password, generated: !process.env.VORTEX_ADMIN_PASSWORD };
  }

  /** Returns { token, user } or throws an Error with .status. */
  async login(username, password, ip, userAgent) {
    username = String(username || '').toLowerCase().slice(0, 64);
    password = String(password || '');
    const userKey = `u:${username}`;
    const ipKey = `ip:${ip}`;
    const wait = Math.max(this.userLimiter.locked(userKey), this.ipLimiter.locked(ipKey));
    if (wait) {
      audit.log('auth.locked', { user: username, ip }, 'warn');
      const err = new Error(`Too many attempts. Try again in ${Math.ceil(wait / 60000)} min.`);
      err.status = 429;
      throw err;
    }

    const record = this.store.get(username);
    let ok = false;
    if (record) {
      ok = await verifyPassword(password, record);
    } else {
      // Spend the same time as a real check so usernames can't be probed by timing.
      this.dummy = this.dummy || (await hashPassword(crypto.randomBytes(12).toString('hex')));
      await verifyPassword(password, this.dummy);
    }

    if (!ok || record.disabled) {
      this.userLimiter.fail(userKey);
      this.ipLimiter.fail(ipKey);
      audit.log('auth.failed', { user: username, ip, reason: record?.disabled ? 'disabled' : 'bad-credentials' }, 'warn');
      const err = new Error('Invalid credentials');
      err.status = 401;
      throw err;
    }

    this.userLimiter.reset(userKey);
    this.store.touchLogin(username);
    const token = this.sessions.create(record, ip, userAgent);
    audit.log('auth.login', { user: username, ip });
    return { token, user: publicUser(record) };
  }

  /** Resolve a session token into { session, user, perms } or null. */
  resolve(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    const user = this.store.get(session.username);
    if (!user || user.disabled) {
      this.sessions.destroy(token);
      return null;
    }
    return { token, session, user: publicUser(user), perms: ROLES[user.role] };
  }

  sweep() {
    this.sessions.sweep();
    this.userLimiter.sweep();
    this.ipLimiter.sweep();
  }
}

module.exports = {
  Auth,
  UserStore,
  SessionManager,
  RateLimiter,
  ROLES,
  USERNAME_RE,
  hashPassword,
  verifyPassword,
  validatePassword,
  generatePassword,
  publicUser,
};
