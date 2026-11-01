'use strict';
const path = require('node:path');
const { normalizePrefix, validatePrefix } = require('./paths');

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 });

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid configuration: ' + problems.join('; '));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function loadConfig(env = process.env) {
  const problems = [];
  const str = (name, def) => {
    const v = env[name];
    return v === undefined || String(v).trim() === '' ? def : String(v).trim();
  };
  const int = (name, def, min, max) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return def;
    }
    return n;
  };
  const bool = (name, def) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const v = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes'].includes(v)) return true;
    if (['false', '0', 'no'].includes(v)) return false;
    problems.push(`${name} must be true or false`);
    return def;
  };

  const panelPath = str('PANEL_PATH', 'knight').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(panelPath)) problems.push('PANEL_PATH may only contain letters, digits, "-" and "_" (max 32)');

  const logLevel = str('LOG_LEVEL', 'INFO').toUpperCase();
  if (!(logLevel in LEVELS)) problems.push('LOG_LEVEL must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL');

  const cookieSecure = str('COOKIE_SECURE', 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(cookieSecure)) problems.push('COOKIE_SECURE must be auto, true or false');

  const panelPassword = env.PANEL_PASSWORD === undefined ? '' : String(env.PANEL_PASSWORD);
  if (panelPassword && panelPassword.length < 8) problems.push('PANEL_PASSWORD must be at least 8 characters');

  const rawPrefix = str('TRANSPORT_PATH_PREFIX', '');
  let transportPathPrefix = '';
  if (rawPrefix) {
    transportPathPrefix = normalizePrefix(rawPrefix);
    const problem = validatePrefix(transportPathPrefix, { panelPath });
    if (problem) problems.push('TRANSPORT_PATH_PREFIX ' + problem);
  }

  const config = {
    port: int('PORT', 3000, 0, 65535),
    host: str('HOST', '0.0.0.0'),
    panelPath,
    dataDir: path.resolve(str('BK_DATA_DIR', './data')),
    logLevel: logLevel in LEVELS ? logLevel : 'INFO',
    logMaxBytes: int('LOG_MAX_MB', 5, 1, 100) * 1024 * 1024,
    logMaxFiles: int('LOG_MAX_FILES', 5, 1, 50),
    logRetentionDays: int('LOG_RETENTION_DAYS', 14, 1, 365),
    logStdout: bool('LOG_STDOUT', true),
    logClientIp: bool('LOG_CLIENT_IP', true),
    trustProxyHops: int('TRUST_PROXY_HOPS', 0, 0, 5),
    cookieSecure,
    panelPassword,
    setupKey: str('SETUP_KEY', ''),
    transportPathPrefix
  };
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}

module.exports = { loadConfig, ConfigError, LEVELS };
