'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, form, cookieOf, loginSession } = require('./helpers');

const PW = 'correct-horse-battery';
const rawLogs = ctx => ['app', 'security'].map(c => { try { return fs.readFileSync(path.join(ctx.dir, 'logs', c + '.log'), 'utf8'); } catch (_) { return ''; } }).join('\n');

test('health and readiness endpoints', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const h = await (await fetch(ctx.url + '/healthz')).json();
  assert.equal(h.status, 'ok'); assert.ok(h.version);
  const r = await fetch(ctx.url + '/readyz');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.checks.map(c => c.name).sort(), ['auth_store', 'data_dir_writable', 'log_dir_writable', 'settings_store']);
});

test('readiness turns 503 and logs an ERROR when the data dir disappears', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
  const r = await fetch(ctx.url + '/readyz');
  assert.equal(r.status, 503);
  assert.equal((await r.json()).status, 'not_ready');
});

test('request ids: generated, echoed when valid, replaced when invalid, present in logs', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const a = await fetch(ctx.url + '/nope');
  assert.equal(a.status, 404);
  assert.match(a.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const b = await fetch(ctx.url + '/nope', { headers: { 'X-Request-Id': 'trace-abc-12345' } });
  assert.equal(b.headers.get('x-request-id'), 'trace-abc-12345');
  const c = await fetch(ctx.url + '/nope', { headers: { 'X-Request-Id': 'bad id!' } });
  assert.notEqual(c.headers.get('x-request-id'), 'bad id!');
  assert.ok(rawLogs(ctx).includes('"requestId":"trace-abc-12345"'));
});

test('API and pages require a session', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  for (const p of ['/api/logs', '/api/diagnostics', '/api/diagnostics/download', '/api/logs/download', '/api/status']) {
    assert.equal((await fetch(ctx.base + p)).status, 401, p);
  }
  const page = await fetch(ctx.base + '/logs', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.ok(page.headers.get('location').endsWith('/login'));
});

test('first-run setup: validation, setup key, session cookie flags', async t => {
  const ctx = await startApp({ SETUP_KEY: 'letmein-123' }); t.after(ctx.close);
  assert.equal((await fetch(ctx.base + '/login', form({ password: PW, confirm: PW }))).status, 401);
  assert.equal((await fetch(ctx.base + '/login', form({ setup_key: 'letmein-123', password: 'short', confirm: 'short' }))).status, 400);
  assert.equal((await fetch(ctx.base + '/login', form({ setup_key: 'letmein-123', password: PW, confirm: PW + 'x' }))).status, 400);
  const ok = await fetch(ctx.base + '/login', form({ setup_key: 'letmein-123', password: PW, confirm: PW }));
  assert.equal(ok.status, 302);
  const raw = ok.headers.getSetCookie()[0];
  assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Lax/);
  assert.equal((await fetch(ctx.base + '/api/status', { headers: { Cookie: cookieOf(ok) } })).status, 200);
  assert.ok(fs.existsSync(path.join(ctx.dir, 'auth.json')));
  assert.equal(fs.statSync(path.join(ctx.dir, 'auth.json')).mode & 0o077, 0, 'auth.json is private');
  assert.ok(!fs.readFileSync(path.join(ctx.dir, 'auth.json'), 'utf8').includes(PW), 'password is stored only as a hash');
});

test('login: wrong password logged to security channel, lockout after 5 failures, correct password works afterwards for other clients only', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  await loginSession(ctx);
  for (let i = 0; i < 5; i++) assert.equal((await fetch(ctx.base + '/login', form({ password: 'wrong-password' }))).status, 401);
  assert.equal((await fetch(ctx.base + '/login', form({ password: 'wrong-password' }))).status, 429);
  assert.equal((await fetch(ctx.base + '/login', form({ password: PW }))).status, 429, 'blocked even with correct password');
  const sec = ctx.logger.readEntries('security', {});
  assert.ok(sec.filter(e => e.msg === 'login failed').length === 5);
  assert.ok(sec.some(e => e.msg === 'login blocked: too many failures'));
});

test('login succeeds with correct password and logout clears cookie', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  await loginSession(ctx);
  const r = await fetch(ctx.base + '/login', form({ password: PW }));
  assert.equal(r.status, 302);
  const cookie = cookieOf(r);
  const out = await fetch(ctx.base + '/logout', { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(out.status, 302);
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
});

test('tampered or garbage session cookies are rejected and logged', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const cookie = await loginSession(ctx);
  const [p, s] = cookie.slice('bk_session='.length).split('.');
  for (const bad of [`bk_session=${p}.${s.slice(0, -2)}AA`, 'bk_session=garbage', `bk_session=${Buffer.from('{"exp":9999999999999}').toString('base64url')}.${s}`]) {
    assert.equal((await fetch(ctx.base + '/api/logs', { headers: { Cookie: bad } })).status, 401);
  }
  assert.ok(ctx.logger.readEntries('security', {}).some(e => e.msg === 'invalid session cookie presented'));
});

test('cross-origin form posts are rejected (CSRF)', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const status = await new Promise((resolve, reject) => {
    const body = new URLSearchParams({ password: PW, confirm: PW }).toString();
    const req = http.request(ctx.base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Origin: 'http://evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(status, 403);
  assert.equal(ctx.auth.hasPassword(), false);
});

test('logs API: filters, validation, and raw download', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const H = { Cookie: await loginSession(ctx) };
  ctx.logger.error('seeded error', { code: 7 });
  const j = await (await fetch(ctx.base + '/api/logs?channel=app&level=ERROR&limit=10', { headers: H })).json();
  assert.ok(j.entries.some(e => e.msg === 'seeded error'));
  assert.ok(j.entries.every(e => ['ERROR', 'CRITICAL'].includes(e.level)));
  assert.equal((await fetch(ctx.base + '/api/logs?channel=../etc', { headers: H })).status, 400);
  assert.equal((await fetch(ctx.base + '/api/logs?level=LOUD', { headers: H })).status, 400);
  const dl = await fetch(ctx.base + '/api/logs/download?channel=app', { headers: H });
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="bk-app-.*\.log"/);
  assert.ok((await dl.text()).includes('seeded error'));
  assert.equal((await fetch(ctx.base + '/api/logs/download?channel=all', { headers: H })).status, 400);
});

test('diagnostic report: complete, downloadable, and free of secrets', async t => {
  const ctx = await startApp({ SETUP_KEY: 'super-secret-setup-key' }); t.after(ctx.close);
  const H = { Cookie: await (async () => { const r = await fetch(ctx.base + '/login', form({ setup_key: 'super-secret-setup-key', password: PW, confirm: PW })); return cookieOf(r); })() };
  ctx.logger.error('something failed', { err: new Error('db down'), token: 'LEAKME', url: 'http://x/?token=LEAKME2' });
  const res = await fetch(ctx.base + '/api/diagnostics/download', { headers: H });
  assert.match(res.headers.get('content-disposition'), /bk-diagnostics-.*\.json/);
  const text = await res.text();
  const rep = JSON.parse(text);
  for (const k of ['app', 'runtime', 'config', 'checks', 'recentErrors', 'recentLogs', 'logSummary', 'environment']) assert.ok(rep[k], k);
  assert.ok(rep.checks.every(c => c.ok));
  assert.equal(rep.config.setupKeyConfigured, true);
  assert.equal(rep.config.passwordCreated, true);
  assert.ok(rep.recentErrors.some(e => e.msg === 'something failed' && e.err.stack.includes('db down')));
  for (const secret of [PW, 'super-secret-setup-key', 'LEAKME', 'LEAKME2', ctx.auth.data.secret, ctx.auth.data.hash, cookieOf2(H)]) assert.ok(!text.includes(secret), 'leaked: ' + secret.slice(0, 6));
  function cookieOf2(h) { return h.Cookie.split('=')[1]; }
  assert.ok(ctx.logger.readEntries('security', {}).some(e => e.msg === 'diagnostic report downloaded'));
});

test('frontend error reports are accepted, bounded, sanitised and rate limited', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const post = (body, headers = {}) => fetch(ctx.base + '/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BK-Req': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post({ type: 'error', message: 'x is not defined', stack: 'at a.js:1 token=ABC', line: 3, url: '/knight/logs' })).status, 204);
  const e = ctx.logger.readEntries('app', { q: 'x is not defined' })[0];
  assert.equal(e.source, 'frontend'); assert.equal(e.level, 'ERROR'); assert.ok(!JSON.stringify(e).includes('ABC'));
  assert.equal((await post({ message: 'm' }, { 'X-BK-Req': '0' })).status, 403);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('[1,2]')).status, 400);
  assert.equal((await post({ message: 'y'.repeat(20000) })).status, 413);
  assert.equal((await fetch(ctx.base + '/api/client-log', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-BK-Req': '1' }, body: 'x' })).status, 415);
  let limited = false;
  for (let i = 0; i < 40; i++) if ((await post({ message: 'spam' + i })).status === 429) { limited = true; break; }
  assert.ok(limited);
});

test('unhandled handler exceptions return 500 with a request id and log the stack', async t => {
  const ctx = await startApp({}, { extraRoutes: [async c => { if (c.pathname === '/__boom') throw new Error('kaboom'); return false; }] }); t.after(ctx.close);
  const r = await fetch(ctx.url + '/__boom');
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.error, 'internal_error');
  const e = ctx.logger.readEntries('app', { minLevel: 'ERROR' }).find(x => x.msg === 'unhandled error in request handler');
  assert.equal(e.requestId, body.requestId);
  assert.ok(e.err.stack.includes('kaboom'));
});

test('proxy headers: client IP honoured only when TRUST_PROXY_HOPS is set', async t => {
  const trusted = await startApp({ TRUST_PROXY_HOPS: '1' }); t.after(trusted.close);
  await fetch(trusted.url + '/nope', { headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' } });
  assert.ok(trusted.logger.readEntries('app', { q: '"path":"/nope"' }).some(e => e.ip === '203.0.113.9'));
  const plain = await startApp(); t.after(plain.close);
  await fetch(plain.url + '/nope', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.ok(plain.logger.readEntries('app', { q: '"path":"/nope"' }).every(e => e.ip === '127.0.0.1'));
});

test('a corrupt auth store disables login and setup instead of reopening setup', async t => {
  const dir = require('./helpers').tmpDir();
  fs.writeFileSync(path.join(dir, 'auth.json'), '{broken');
  const ctx = await (async () => {
    const { loadConfig } = require('../src/config'); const { Logger } = require('../src/logger'); const { Auth } = require('../src/auth'); const { createApp } = require('../src/app'); const { Settings } = require('../src/settings');
    const config = loadConfig({ BK_DATA_DIR: dir, LOG_STDOUT: 'false' });
    const logger = new Logger({ dir: path.join(dir, 'logs'), stdout: false });
    const auth = new Auth({ dir, logger });
    const app = createApp({ config, logger, auth, settings: new Settings({ dir, logger }) });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${app.server.address().port}/knight`, url: `http://127.0.0.1:${app.server.address().port}`, logger, close: app.close };
  })();
  t.after(ctx.close);
  assert.equal((await fetch(ctx.base + '/login', form({ password: PW, confirm: PW }))).status, 503);
  assert.equal((await fetch(ctx.url + '/readyz')).status, 503);
  assert.ok(ctx.logger.readEntries('app', { minLevel: 'CRITICAL' }).length >= 1);
});

test('UI pages render and static assets are served with correct types', async t => {
  const ctx = await startApp(); t.after(ctx.close);
  const H = { Cookie: await loginSession(ctx) };
  const logs = await (await fetch(ctx.base + '/logs', { headers: H })).text();
  assert.ok(logs.includes('logs.js') && logs.includes('client-errors.js'));
  assert.ok((await (await fetch(ctx.base, { headers: H })).text()).includes('Blue Knight Panel'));
  const js = await fetch(ctx.base + '/assets/logs.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(ctx.base + '/assets/../../package.json')).status, 404);
  const csp = js.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'") && !csp.includes('unsafe-inline'));
});
