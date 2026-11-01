'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PREFIX, SUFFIXES, normalizePrefix, validatePrefix, buildPaths } = require('./paths');

class Settings {
  constructor({ dir, logger, envPrefix = '', panelPath = 'knight' }) {
    this.file = path.join(dir, 'settings.json');
    this.logger = logger;
    this.envPrefix = envPrefix;
    this.panelPath = panelPath;
    this.loadError = null;
    this.data = this._load();
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
      if (d.transportPathPrefix && validatePrefix(d.transportPathPrefix, { panelPath: this.panelPath })) {
        this.loadError = 'stored transportPathPrefix is invalid; using default';
        this.logger.error('settings.json contains an invalid transportPathPrefix; using the default', { file: this.file });
        delete d.transportPathPrefix;
      }
      return d;
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      this.loadError = err.message;
      this.logger.error('settings.json unreadable; using defaults', { err, file: this.file });
      return {};
    }
  }

  status() { return { storeOk: !this.loadError, error: this.loadError || undefined }; }
  get lockedByEnv() { return !!this.envPrefix; }
  get transportPathPrefix() { return this.envPrefix || this.data.transportPathPrefix || DEFAULT_PREFIX; }
  get paths() { return buildPaths(this.transportPathPrefix); }

  snapshot() {
    return {
      transportPathPrefix: this.transportPathPrefix, isDefault: this.transportPathPrefix === DEFAULT_PREFIX,
      lockedByEnv: this.lockedByEnv, defaultPrefix: DEFAULT_PREFIX, suffixes: SUFFIXES, paths: this.paths
    };
  }

  /** An empty prefix resets to the default. Returns {ok, status, error}. */
  update({ transportPathPrefix }) {
    if (this.lockedByEnv) return { ok: false, status: 409, error: 'transportPathPrefix is set by the TRANSPORT_PATH_PREFIX environment variable' };
    if (typeof transportPathPrefix !== 'string') return { ok: false, status: 400, error: 'transportPathPrefix must be a string' };
    const prefix = normalizePrefix(transportPathPrefix);
    const next = { ...this.data };
    if (prefix === '' || prefix === DEFAULT_PREFIX) delete next.transportPathPrefix;
    else {
      const problem = validatePrefix(prefix, { panelPath: this.panelPath });
      if (problem) return { ok: false, status: 400, error: problem };
      next.transportPathPrefix = prefix;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger.error('could not save settings.json', { err });
      return { ok: false, status: 500, error: 'could not save settings' };
    }
    this.data = next;
    this.loadError = null;
    return { ok: true, snapshot: this.snapshot() };
  }
}

module.exports = { Settings };
