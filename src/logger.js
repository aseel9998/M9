'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { redact, scrubString } = require('./redact');
const { LEVELS } = require('./config');

const CHANNELS = ['app', 'security'];
const RESERVED = new Set(['ts', 'level', 'channel', 'msg']);

class Logger {
  constructor({ dir, level = 'INFO', maxBytes = 5 * 1024 * 1024, maxFiles = 5, stdout = true, logIps = true, context = {} }) {
    this.dir = dir;
    this.threshold = LEVELS[level] || LEVELS.INFO;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.stdout = stdout;
    this.logIps = logIps;
    this.context = context;
    this.state = { sizes: new Map(), writeOk: true, lastWriteError: null };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  bind(ctx) {
    const child = Object.create(this);
    child.context = { ...this.context, ...ctx };
    return child;
  }

  fileFor(channel) { return path.join(this.dir, channel + '.log'); }

  log(levelName, msg, fields, channel = 'app') {
    const sev = LEVELS[levelName];
    if (!sev || sev < this.threshold) return;
    if (fields instanceof Error) fields = { err: fields };
    const entry = { ts: new Date().toISOString(), level: levelName, channel, msg: scrubString(msg).slice(0, 2000) };
    const extra = redact({ ...this.context, ...(fields || {}) });
    for (const [k, v] of Object.entries(extra || {})) if (!RESERVED.has(k)) entry[k] = v;
    if (!this.logIps && 'ip' in entry) entry.ip = '[masked]';
    const line = JSON.stringify(entry) + '\n';
    if (this.stdout) (sev >= LEVELS.ERROR ? process.stderr : process.stdout).write(line);
    this._append(channel, line);
  }

  debug(m, f) { this.log('DEBUG', m, f); }
  info(m, f) { this.log('INFO', m, f); }
  warn(m, f) { this.log('WARNING', m, f); }
  error(m, f) { this.log('ERROR', m, f); }
  critical(m, f) { this.log('CRITICAL', m, f); }
  security(levelName, m, f) { this.log(levelName, m, f, 'security'); }

  _append(channel, line) {
    try {
      const file = this.fileFor(channel);
      const bytes = Buffer.byteLength(line);
      let size = this.state.sizes.get(channel);
      if (size === undefined) size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > 0 && size + bytes > this.maxBytes) {
        this._rotate(channel);
        size = 0;
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      this.state.sizes.set(channel, size + bytes);
      this.state.writeOk = true;
    } catch (err) {
      this.state.writeOk = false;
      this.state.lastWriteError = err.message;
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', channel: 'logger', msg: 'log file write failed', error: err.message }) + '\n');
    }
  }

  _rotate(channel) {
    const base = this.fileFor(channel);
    try {
      fs.rmSync(`${base}.${this.maxFiles}`, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        if (fs.existsSync(`${base}.${i}`)) fs.renameSync(`${base}.${i}`, `${base}.${i + 1}`);
      }
      if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
    } catch (err) {
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', channel: 'logger', msg: 'log rotation failed', error: err.message }) + '\n');
    }
    this.state.sizes.set(channel, 0);
  }

  /** Files for a channel, oldest first. */
  filesFor(channel) {
    const base = this.fileFor(channel);
    const out = [];
    for (let i = this.maxFiles; i >= 1; i--) if (fs.existsSync(`${base}.${i}`)) out.push(`${base}.${i}`);
    if (fs.existsSync(base)) out.push(base);
    return out;
  }

  listFiles(channel) {
    return this.filesFor(channel).map(f => {
      const st = fs.statSync(f);
      return { name: path.basename(f), bytes: st.size, modified: st.mtime.toISOString() };
    });
  }

  readEntries(channel, { minLevel = 'DEBUG', limit = 200, q = '' } = {}) {
    const channels = channel === 'all' ? CHANNELS : [channel];
    const min = LEVELS[minLevel] || 0;
    const needle = String(q || '').toLowerCase();
    const entries = [];
    for (const ch of channels) {
      for (const file of this.filesFor(ch)) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          let e;
          try { e = JSON.parse(line); } catch (_) { e = { ts: null, level: 'UNPARSEABLE', channel: ch, msg: line.slice(0, 500) }; }
          if ((LEVELS[e.level] || 0) < min) continue;
          if (needle && !line.toLowerCase().includes(needle)) continue;
          entries.push(e);
        }
      }
    }
    if (channels.length > 1) entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return entries.slice(-limit);
  }

  exportRaw(channel) {
    return this.filesFor(channel).map(f => fs.readFileSync(f, 'utf8')).join('');
  }

  /** Delete rotated files older than `days`. The active file is never removed. */
  pruneOld(days) {
    const cutoff = Date.now() - days * 86400000;
    const removed = [];
    for (const ch of CHANNELS) {
      const base = this.fileFor(ch);
      for (let i = 1; i <= this.maxFiles; i++) {
        const f = `${base}.${i}`;
        try {
          if (fs.existsSync(f) && fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); removed.push(path.basename(f)); }
        } catch (err) { this.error('could not prune log file', { file: path.basename(f), err }); }
      }
    }
    return removed;
  }
}

module.exports = { Logger, CHANNELS };
