'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redact, scrubString } = require('../src/redact');
const { Logger } = require('../src/logger');
const { tmpDir } = require('./helpers');

test('redact masks sensitive keys, bearer tokens, URL secrets and proxy links', () => {
  const out = redact({ password: 'p', apiKey: 'k', nested: { Authorization: 'Bearer abc', cookie: 'c' }, ok: 'fine', keyword: 'kept', passed: 'kept' });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.nested.Authorization, '[REDACTED]');
  assert.equal(out.nested.cookie, '[REDACTED]');
  assert.equal(out.ok, 'fine');
  assert.equal(out.keyword, 'kept');
  assert.equal(out.passed, 'kept');
  assert.equal(redact({ passwordCreated: true }).passwordCreated, true, 'booleans are not secrets');
  assert.equal(redact({ password: 12345678 }).password, '[REDACTED]', 'numbers under sensitive keys stay masked');
  assert.ok(!scrubString('GET /x?token=abc123&a=1').includes('abc123'));
  assert.ok(!scrubString('Authorization: Bearer abc.def.ghi').includes('abc.def'));
  assert.ok(!scrubString('link vless://uuid@host:443?x=1#n').includes('uuid@host'));
  assert.ok(!scrubString('Cookie: bk_session=AAA.BBB; x=1').includes('AAA.BBB'));
});

test('redact handles errors, circular references and depth', () => {
  const a = { name: 'a' }; a.self = a;
  assert.equal(redact(a).self, '[Circular]');
  const e = redact(new Error('boom token=zzz'));
  assert.equal(e.name, 'Error');
  assert.ok(e.stack.includes('boom') && !e.stack.includes('zzz'));
});

test('logger writes structured JSON lines, filters by level and never leaks secrets', () => {
  const dir = tmpDir();
  const l = new Logger({ dir, level: 'INFO', stdout: false });
  l.debug('hidden');
  l.info('hello', { password: 'hunter2hunter2', note: 'url?token=SECRET123' });
  l.error('bad', new Error('x'));
  l.security('WARNING', 'sec event', { ip: '1.2.3.4' });
  const raw = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
  assert.ok(!raw.includes('hidden'));
  assert.ok(!raw.includes('hunter2') && !raw.includes('SECRET123'));
  const lines = raw.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].level, 'INFO');
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  assert.equal(lines[1].err.message, 'x');
  assert.ok(lines[1].err.stack);
  const sec = fs.readFileSync(path.join(dir, 'security.log'), 'utf8');
  assert.ok(sec.includes('sec event'));
  assert.ok(!raw.includes('sec event'), 'security events are separated from operational logs');
});

test('logger can mask client IPs', () => {
  const dir = tmpDir();
  const l = new Logger({ dir, stdout: false, logIps: false });
  l.info('req', { ip: '9.9.9.9' });
  assert.ok(!fs.readFileSync(path.join(dir, 'app.log'), 'utf8').includes('9.9.9.9'));
});

test('logger rotates by size and keeps at most maxFiles rotated files', () => {
  const dir = tmpDir();
  const l = new Logger({ dir, stdout: false, maxBytes: 600, maxFiles: 2 });
  for (let i = 0; i < 60; i++) l.info('line ' + i, { pad: 'x'.repeat(40) });
  const files = fs.readdirSync(dir).filter(f => f.startsWith('app.log')).sort();
  assert.deepEqual(files, ['app.log', 'app.log.1', 'app.log.2']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 700);
  const entries = l.readEntries('app', { limit: 1000 });
  assert.equal(entries[entries.length - 1].msg, 'line 59');
});

test('readEntries filters by level and text, merges channels', () => {
  const dir = tmpDir();
  const l = new Logger({ dir, stdout: false });
  l.info('alpha'); l.error('beta'); l.security('WARNING', 'gamma');
  assert.equal(l.readEntries('app', { minLevel: 'ERROR' }).length, 1);
  assert.equal(l.readEntries('app', { q: 'ALPHA' }).length, 1);
  assert.equal(l.readEntries('all', {}).length, 3);
});

test('pruneOld removes only old rotated files', () => {
  const dir = tmpDir();
  const l = new Logger({ dir, stdout: false, maxFiles: 3 });
  l.info('x');
  fs.writeFileSync(path.join(dir, 'app.log.1'), '{}\n');
  fs.writeFileSync(path.join(dir, 'app.log.2'), '{}\n');
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(path.join(dir, 'app.log.1'), old, old);
  fs.utimesSync(path.join(dir, 'app.log'), old, old);
  const removed = l.pruneOld(14);
  assert.deepEqual(removed, ['app.log.1']);
  assert.ok(fs.existsSync(path.join(dir, 'app.log')) && fs.existsSync(path.join(dir, 'app.log.2')));
});

test('logger survives write failures without throwing', () => {
  const dir = tmpDir();
  const l = new Logger({ dir, stdout: false });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'now a file, not a directory');
  assert.doesNotThrow(() => l.error('cannot write'));
  assert.equal(l.state.writeOk, false);
});
