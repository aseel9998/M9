'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/logger');
const { Auth } = require('../src/auth');
const { Settings } = require('../src/settings');
const { createApp } = require('../src/app');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bk-test-')); }

async function startApp(env = {}, opts = {}) {
  const dir = tmpDir();
  const config = loadConfig({ BK_DATA_DIR: dir, PORT: '0', LOG_STDOUT: 'false', LOG_LEVEL: 'DEBUG', ...env });
  const logger = new Logger({ dir: path.join(dir, 'logs'), level: config.logLevel, maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles, stdout: false, logIps: config.logClientIp });
  const auth = new Auth({ dir, logger, setupKey: config.setupKey, envPassword: config.panelPassword });
  const settings = new Settings({ dir, logger, envPrefix: config.transportPathPrefix, panelPath: config.panelPath });
  const app = createApp({ config, logger, auth, settings, extraRoutes: opts.extraRoutes });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { url, dir, config, logger, auth, settings, base: url + '/' + config.panelPath, close: () => app.close() };
}

const cookieOf = res => res.headers.getSetCookie()[0].split(';')[0];
const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });

async function loginSession(ctx, password = 'correct-horse-battery') {
  const r = await fetch(ctx.base + '/login', form({ password, confirm: password }));
  if (r.status !== 302) throw new Error('setup failed: ' + r.status);
  return cookieOf(r);
}

module.exports = { tmpDir, startApp, cookieOf, form, loginSession };
