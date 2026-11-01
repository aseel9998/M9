'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redact } = require('./redact');
const { VERSION, BUILD } = require('./version');

const KNOWN_ENV = ['PORT', 'HOST', 'BK_DATA_DIR', 'PANEL_PATH', 'PANEL_PASSWORD', 'SETUP_KEY', 'LOG_LEVEL', 'LOG_MAX_MB', 'LOG_MAX_FILES',
  'LOG_RETENTION_DAYS', 'LOG_STDOUT', 'LOG_CLIENT_IP', 'TRUST_PROXY_HOPS', 'COOKIE_SECURE', 'TRANSPORT_PATH_PREFIX', 'BUILD_ID', 'NODE_ENV',
  'RAILWAY_ENVIRONMENT', 'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_VOLUME_MOUNT_PATH', 'SERVER_PORT'];

function runChecks({ config, logger, authStatus, settings }) {
  const checks = [];
  try {
    const probe = path.join(config.dataDir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    checks.push({ name: 'data_dir_writable', ok: true, critical: true });
  } catch (err) { checks.push({ name: 'data_dir_writable', ok: false, critical: true, detail: err.message }); }

  let logOk = logger.state.writeOk !== false;
  let logDetail = logOk ? undefined : logger.state.lastWriteError;
  try { fs.accessSync(logger.dir, fs.constants.W_OK); } catch (err) { logOk = false; logDetail = err.message; }
  checks.push({ name: 'log_dir_writable', ok: logOk, critical: true, detail: logDetail });

  const st = authStatus();
  checks.push({ name: 'auth_store', ok: st.storeOk, critical: true, detail: st.error });
  if (settings) { const ss = settings.status(); checks.push({ name: 'settings_store', ok: ss.storeOk, critical: false, detail: ss.error }); }
  return checks;
}

function describeConfig(config, authStatus, settings) {
  return {
    port: config.port, host: config.host, panelPath: config.panelPath,
    dataDir: config.dataDir, dataDirRequested: config.dataDirRequested, dataDirFallback: !!config.dataDirFallback,
    logLevel: config.logLevel, logMaxMb: config.logMaxBytes / 1048576, logMaxFiles: config.logMaxFiles,
    logRetentionDays: config.logRetentionDays, logStdout: config.logStdout, logClientIp: config.logClientIp,
    trustProxyHops: config.trustProxyHops, cookieSecure: config.cookieSecure,
    panelPasswordFromEnv: !!config.panelPassword, setupKeyConfigured: !!config.setupKey,
    passwordCreated: authStatus.passwordCreated,
    transportPath: settings ? { isDefault: settings.snapshot().isDefault, lockedByEnv: settings.lockedByEnv, length: settings.transportPathPrefix.length } : undefined
  };
}

function runtimeInfo(config) {
  let disk;
  try { const s = fs.statfsSync(config.dataDir); disk = { freeMb: Math.round(s.bavail * s.bsize / 1048576), totalMb: Math.round(s.blocks * s.bsize / 1048576) }; } catch (_) { disk = null; }
  const mem = process.memoryUsage();
  return {
    node: process.version, platform: process.platform, arch: process.arch, pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    uptimeSec: Math.round(process.uptime()), cpus: os.cpus().length, loadavg: os.loadavg(),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    container: fs.existsSync('/.dockerenv'), disk
  };
}

function buildReport({ config, logger, authStatus, settings, tail = 200 }) {
  const st = authStatus();
  const sample = logger.readEntries('all', { limit: 2000 });
  const levels = {};
  for (const e of sample) levels[e.level] = (levels[e.level] || 0) + 1;
  const report = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    app: { name: 'blue-knight-panel', version: VERSION, build: BUILD },
    runtime: runtimeInfo(config),
    config: describeConfig(config, st, settings),
    environment: { presentVariables: KNOWN_ENV.filter(n => process.env[n] !== undefined) },
    checks: runChecks({ config, logger, authStatus, settings }),
    logSummary: { levelCountsInLast2000Entries: levels, files: { app: logger.listFiles('app'), security: logger.listFiles('security') } },
    recentErrors: logger.readEntries('all', { minLevel: 'ERROR', limit: 50 }),
    recentLogs: { app: logger.readEntries('app', { limit: tail }), security: logger.readEntries('security', { limit: tail }) }
  };
  return redact(report, { maxArray: 1000, maxDepth: 10 });
}

module.exports = { runChecks, buildReport, describeConfig };
