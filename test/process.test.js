'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const readLog = (dir, f = 'app.log') => { try { return fs.readFileSync(path.join(dir, 'logs', f), 'utf8'); } catch (_) { return ''; } };

test('invalid configuration: exit code 1, CRITICAL JSON on stderr and in the log file', () => {
  const dir = tmpDir();
  const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, BK_DATA_DIR: dir, PORT: 'abc', LOG_LEVEL: 'LOUD' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  const e = JSON.parse(r.stderr.trim().split('\n')[0]);
  assert.equal(e.level, 'CRITICAL'); assert.equal(e.problems.length, 2);
  assert.ok(readLog(dir).includes('invalid configuration'));
});

test('real process: starts, serves health, logs startup, shuts down cleanly on SIGTERM', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN], { env: { ...process.env, BK_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', LOG_STDOUT: 'false' }, stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig })));
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(ok, 'server became healthy');
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0);
  const log = readLog(dir);
  for (const m of ['startup', 'listening', 'shutdown requested', 'shutdown complete', 'process exit']) assert.ok(log.includes(`"msg":"${m}"`), m);
  assert.ok(log.includes('SETUP_KEY is not set'), 'insecure first-run is warned about');
});

test('port already in use: CRITICAL logged, exit code 1', async () => {
  const dir = tmpDir();
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, BK_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', LOG_STDOUT: 'false' }, encoding: 'utf8', timeout: 10000 });
  blocker.close();
  assert.equal(r.status, 1);
  assert.ok(readLog(dir).includes('http server error'));
  assert.ok(readLog(dir).includes('EADDRINUSE'));
});

test('uncaught exception and unhandled rejection are logged as CRITICAL with stack, exit code 1', () => {
  for (const code of ["setTimeout(()=>{throw new Error('boom-sync')},5)", "Promise.reject(new Error('boom-async'))"]) {
    const dir = tmpDir();
    const script = `const {Logger}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'logger.js'))});const {installProcessHandlers}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'process-handlers.js'))});installProcessHandlers(new Logger({dir:${JSON.stringify(path.join(dir, 'logs'))},stdout:false}));${code}`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    const log = readLog(dir);
    assert.ok(log.includes('"level":"CRITICAL"') && log.includes('boom-'));
    assert.ok(log.includes('at '), 'stack trace present');
  }
});

test('CLI diagnostics works offline from files on disk and masks secrets', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'), JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', channel: 'app', msg: 'last crash', err: { message: 'x', stack: 'at y' } }) + '\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'diagnostics'], { env: { ...process.env, BK_DATA_DIR: dir, PANEL_PASSWORD: 'supersecretpw' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.ok(rep.recentErrors.some(e => e.msg === 'last crash'));
  assert.ok(!r.stdout.includes('supersecretpw'));
  assert.equal(rep.config.panelPasswordFromEnv, true);
});
