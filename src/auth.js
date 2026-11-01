'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60 * 1000;
const COOKIE = 'bk_session';

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), String(salt), 64).toString('hex');

class Auth {
  constructor({ dir, logger, setupKey = '', envPassword = '', sessionTtlMs = 12 * 3600 * 1000 }) {
    this.file = path.join(dir, 'auth.json');
    this.logger = logger;
    this.setupKey = setupKey;
    this.sessionTtlMs = sessionTtlMs;
    this.fails = new Map();
    this.corrupt = false;
    this.data = this._load();
    if (!this.corrupt && !this.data.secret) {
      this.data.secret = crypto.randomBytes(32).toString('hex');
      this._save();
    }
    if (!this.corrupt && !this.data.hash && envPassword) {
      this._setPassword(envPassword);
      logger.security('INFO', 'panel password initialised from PANEL_PASSWORD');
    }
  }

  static statusOf(dir) {
    const file = path.join(dir, 'auth.json');
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { storeOk: true, passwordCreated: !!d.hash };
    } catch (err) {
      if (err.code === 'ENOENT') return { storeOk: true, passwordCreated: false };
      return { storeOk: false, passwordCreated: false, error: err.message };
    }
  }

  status() {
    return this.corrupt ? { storeOk: false, passwordCreated: false, error: this.loadError } : Auth.statusOf(path.dirname(this.file));
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      // A damaged store must never reopen first-run setup to anyone who connects.
      this.corrupt = true;
      this.loadError = err.message;
      this.logger.critical('auth store unreadable; login and setup are disabled until it is fixed', { err, file: this.file });
      return {};
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _setPassword(pw) {
    this.data.salt = crypto.randomBytes(16).toString('hex');
    this.data.hash = hashPw(pw, this.data.salt);
    this.data.secret = crypto.randomBytes(32).toString('hex');
    this._save();
  }

  hasPassword() { return !!this.data.hash; }
  needsSetupKey() { return !this.hasPassword() && !!this.setupKey; }

  isBlocked(ip) {
    const f = this.fails.get(ip);
    return !!f && f.blockedUntil > Date.now();
  }

  _fail(ip) {
    if (this.fails.size > 5000) this.fails.clear();
    const f = this.fails.get(ip) || { count: 0, blockedUntil: 0 };
    if (f.blockedUntil && f.blockedUntil <= Date.now()) { f.count = 0; f.blockedUntil = 0; }
    f.count++;
    if (f.count >= MAX_FAILS) f.blockedUntil = Date.now() + BLOCK_MS;
    this.fails.set(ip, f);
  }

  setup({ password, confirm, key, ip }) {
    if (this.corrupt) return { ok: false, status: 503, error: 'auth store unreadable' };
    if (this.hasPassword()) return { ok: false, status: 409, error: 'password already set' };
    if (this.isBlocked(ip)) { this.logger.security('WARNING', 'setup blocked: too many failures', { ip }); return { ok: false, status: 429, error: 'too many attempts' }; }
    if (this.setupKey && !safeEq(key || '', this.setupKey)) {
      this._fail(ip);
      this.logger.security('WARNING', 'setup failed: wrong setup key', { ip });
      return { ok: false, status: 401, error: 'wrong setup key' };
    }
    if (String(password || '').length < 8) return { ok: false, status: 400, error: 'password must be at least 8 characters' };
    if (password !== confirm) return { ok: false, status: 400, error: 'passwords do not match' };
    this._setPassword(password);
    this.fails.delete(ip);
    this.logger.security('INFO', 'panel password created', { ip });
    return { ok: true, cookie: this.createSession() };
  }

  login({ password, ip }) {
    if (this.corrupt) return { ok: false, status: 503, error: 'auth store unreadable' };
    if (!this.hasPassword()) return { ok: false, status: 409, error: 'setup required' };
    if (this.isBlocked(ip)) { this.logger.security('WARNING', 'login blocked: too many failures', { ip }); return { ok: false, status: 429, error: 'too many attempts' }; }
    if (!safeEq(hashPw(password || '', this.data.salt), this.data.hash)) {
      this._fail(ip);
      this.logger.security('WARNING', 'login failed', { ip });
      return { ok: false, status: 401, error: 'wrong password' };
    }
    this.fails.delete(ip);
    this.logger.security('INFO', 'login succeeded', { ip });
    return { ok: true, cookie: this.createSession() };
  }

  createSession() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + this.sessionTtlMs, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.data.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Returns {ok, reason}. reason: none | malformed | bad_signature | expired */
  verifySession(cookieHeader) {
    if (!this.data.secret) return { ok: false, reason: 'none' };
    const m = String(cookieHeader || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
    if (!m) return { ok: false, reason: 'none' };
    const [payload, sig] = m.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig) return { ok: false, reason: 'malformed' };
    const expect = crypto.createHmac('sha256', this.data.secret).update(payload).digest('base64url');
    if (!safeEq(sig, expect)) return { ok: false, reason: 'bad_signature' };
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return exp > Date.now() ? { ok: true } : { ok: false, reason: 'expired' };
    } catch (_) { return { ok: false, reason: 'malformed' }; }
  }
}

module.exports = { Auth, COOKIE };
