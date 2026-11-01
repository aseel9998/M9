'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, loginSession } = require('./helpers');
const { loadConfig, ConfigError } = require('../src/config');
const { DEFAULT_PREFIX, buildPaths, validatePrefix, normalizePrefix } = require('../src/paths');

const J = (cookie, body, extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BK-Req': '1', Cookie: cookie, ...extra }, body: JSON.stringify(body) });

test('default prefix reproduces the original panel paths exactly', () => {
  const p = buildPaths(DEFAULT_PREFIX);
  assert.equal(p.vlessWs, '/@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--ws');
  assert.equal(p.vlessHu, '/@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--httpupgrade');
  assert.equal(p.xhttp, DEFAULT_PREFIX + 'xhttp');
  assert.equal(p.grpcService, '@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--grpc');
});

test('prefix validation', () => {
  assert.equal(validatePrefix('/my-path_1@x.~'), null);
  for (const bad of ['', '/', 'noslash', '/a/b', '/a b', '/a?x=1', '/a#b', '/' + 'x'.repeat(151), '/ключ']) assert.ok(validatePrefix(bad), bad);
  assert.equal(normalizePrefix('  abc '), '/abc');
  // a generated path equal to the panel path or a health endpoint is a real collision
  assert.match(validatePrefix('/abc', { panelPath: 'abcws' }), /collide/);
  assert.equal(validatePrefix('/abc', { panelPath: 'knight' }), null);
});

test('settings API: auth, read, change, persist, reset', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  assert.equal((await fetch(ctx.base + '/api/settings')).status, 401);
  const cookie = await loginSession(ctx);
  const get = await (await fetch(ctx.base + '/api/settings', { headers: { Cookie: cookie } })).json();
  assert.equal(get.isDefault, true); assert.equal(get.transportPathPrefix, DEFAULT_PREFIX);

  const r = await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: 'my-new-prefix--' }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.transportPathPrefix, '/my-new-prefix--');
  assert.equal(j.paths.xhttp, '/my-new-prefix--xhttp');
  assert.equal(j.paths.grpcService, 'my-new-prefix--grpc');
  assert.equal(ctx.settings.transportPathPrefix, '/my-new-prefix--');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'settings.json'), 'utf8')).transportPathPrefix, '/my-new-prefix--');
  assert.equal(fs.statSync(path.join(ctx.dir, 'settings.json')).mode & 0o077, 0);

  const audit = ctx.logger.readEntries('security', {}).find(e => e.msg === 'settings changed');
  assert.ok(audit && audit.prefixLength === 16 && !JSON.stringify(audit).includes('my-new-prefix'), 'audited without the value');

  const reset = await (await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: '' }))).json();
  assert.equal(reset.isDefault, true);
  assert.ok(!('transportPathPrefix' in JSON.parse(fs.readFileSync(path.join(ctx.dir, 'settings.json'), 'utf8'))));
});

test('settings API rejects invalid input, missing CSRF header, cross-origin and oversize', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const cookie = await loginSession(ctx);
  for (const v of ['/a/b', 'has space', '/a?b', 5, null]) {
    assert.equal((await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: v }))).status, 400, String(v));
  }
  assert.equal((await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: '/ok' }, { 'X-BK-Req': '0' }))).status, 403);
  assert.equal((await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: '/ok' }, { Origin: 'http://evil.example' }))).status, 403);
  assert.equal((await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: 'x'.repeat(3000) }))).status, 413);
  assert.equal((await fetch(ctx.base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BK-Req': '1' }, body: '{}' })).status, 401);
  assert.equal(ctx.settings.transportPathPrefix, DEFAULT_PREFIX);
});

test('TRANSPORT_PATH_PREFIX env overrides and locks the setting; invalid env is a config error', async t => {
  const ctx = await startApp({ TRANSPORT_PATH_PREFIX: 'from-env--' }); t.after(ctx.close);
  const cookie = await loginSession(ctx);
  const g = await (await fetch(ctx.base + '/api/settings', { headers: { Cookie: cookie } })).json();
  assert.equal(g.lockedByEnv, true); assert.equal(g.transportPathPrefix, '/from-env--');
  assert.equal((await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: '/other' }))).status, 409);
  assert.throws(() => loadConfig({ TRANSPORT_PATH_PREFIX: '/a/b' }), ConfigError);
});

test('corrupt settings.json: defaults used, service stays ready (degraded), error logged and reported', async t => {
  const { tmpDir } = require('./helpers');
  const { Logger } = require('../src/logger'); const { Auth } = require('../src/auth'); const { createApp } = require('../src/app'); const { Settings } = require('../src/settings');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{oops');
  const config = loadConfig({ BK_DATA_DIR: dir, LOG_STDOUT: 'false' });
  const logger = new Logger({ dir: path.join(dir, 'logs'), stdout: false });
  const settings = new Settings({ dir, logger });
  const app = createApp({ config, logger, auth: new Auth({ dir, logger }), settings });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(app.close);
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/readyz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.find(c => c.name === 'settings_store').ok, false);
  assert.equal(settings.transportPathPrefix, DEFAULT_PREFIX);
  assert.ok(logger.readEntries('app', { minLevel: 'ERROR' }).some(e => e.msg.includes('settings.json unreadable')));
});

test('diagnostic report describes the path setting without revealing it; settings page and script are served', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const cookie = await loginSession(ctx);
  await fetch(ctx.base + '/api/settings', J(cookie, { transportPathPrefix: '/very-private-prefix' }));
  const text = await (await fetch(ctx.base + '/api/diagnostics', { headers: { Cookie: cookie } })).text();
  assert.ok(!text.includes('very-private-prefix'));
  const rep = JSON.parse(text);
  assert.deepEqual(rep.config.transportPath, { isDefault: false, lockedByEnv: false, length: 20 });
  assert.ok(rep.checks.some(c => c.name === 'settings_store' && c.ok));
  const page = await (await fetch(ctx.base + '/settings', { headers: { Cookie: cookie } })).text();
  assert.ok(page.includes('settings.js') && page.includes('id="prefix"'));
  assert.equal((await fetch(ctx.base + '/assets/settings.js')).status, 200);
});
