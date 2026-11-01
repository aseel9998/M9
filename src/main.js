'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./config');
const { Logger } = require('./logger');
const { Auth } = require('./auth');
const { Settings } = require('./settings');
const { createApp } = require('./app');
const { installProcessHandlers } = require('./process-handlers');
const { schedule, runJob } = require('./jobs');
const { VERSION, BUILD } = require('./version');

function failConfig(err) {
  const entry = { ts: new Date().toISOString(), level: 'CRITICAL', channel: 'app', msg: 'invalid configuration', problems: err.problems || [String(err.message)] };
  process.stderr.write(JSON.stringify(entry) + '\n');
  try { // best effort: keep a copy on disk for later diagnosis
    const dir = path.join(path.resolve(process.env.BK_DATA_DIR || './data'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.log'), JSON.stringify(entry) + '\n');
  } catch (_) { /* stderr already carries the error */ }
  process.exit(1);
}

function resolveDataDir(requested) {
  const writable = dir => { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); };
  try { writable(requested); return { dir: requested, fallback: false }; } catch (err) {
    const dir = path.join(os.tmpdir(), 'bk-data');
    fs.mkdirSync(dir, { recursive: true });
    return { dir, fallback: true, reason: err.message };
  }
}

function main() {
  let base;
  try { base = loadConfig(process.env); } catch (err) {
    if (err instanceof ConfigError) failConfig(err);
    throw err;
  }
  const data = resolveDataDir(base.dataDir);
  const config = Object.freeze({ ...base, dataDir: data.dir, dataDirRequested: base.dataDir, dataDirFallback: data.fallback });

  const logger = new Logger({
    dir: path.join(config.dataDir, 'logs'), level: config.logLevel, maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles, stdout: config.logStdout, logIps: config.logClientIp
  });

  const auth = new Auth({ dir: config.dataDir, logger, setupKey: config.setupKey, envPassword: config.panelPassword });
  const settings = new Settings({ dir: config.dataDir, logger, envPrefix: config.transportPathPrefix, panelPath: config.panelPath });
  const app = createApp({ config, logger, auth, settings });
  installProcessHandlers(logger, { onShutdown: () => app.close() });

  logger.info('startup', { version: VERSION, build: BUILD, node: process.version, pid: process.pid, port: config.port, panelPath: config.panelPath, dataDir: config.dataDir, logLevel: config.logLevel });
  if (data.fallback) logger.warn('data directory not writable; using temporary fallback (data will be lost on restart)', { requested: base.dataDir, fallback: data.dir, reason: data.reason });
  if (!auth.hasPassword() && !config.setupKey) logger.warn('no password exists and SETUP_KEY is not set: the first visitor to the login page can create the panel password');

  app.server.on('error', err => {
    logger.critical('http server error', { err, port: config.port });
    process.exit(1);
  });
  app.server.listen(config.port, config.host, () => {
    logger.info('listening', { host: config.host, port: app.server.address().port });
  });

  const retention = () => {
    const removed = logger.pruneOld(config.logRetentionDays);
    if (removed.length) logger.info('old log files removed', { count: removed.length });
  };
  runJob(logger, 'log-retention', retention);
  schedule(logger, 'log-retention', 3600 * 1000, retention);
}

if (require.main === module) main();
module.exports = { main };
