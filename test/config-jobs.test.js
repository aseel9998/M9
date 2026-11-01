'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('../src/config');
const { Logger } = require('../src/logger');
const { runJob } = require('../src/jobs');
const { tmpDir } = require('./helpers');

test('config defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000); assert.equal(c.panelPath, 'knight'); assert.equal(c.logLevel, 'INFO');
  assert.equal(c.logMaxBytes, 5 * 1024 * 1024); assert.equal(c.trustProxyHops, 0);
});

test('config reports every problem at once', () => {
  try {
    loadConfig({ PORT: 'abc', LOG_LEVEL: 'LOUD', PANEL_PATH: '../x', PANEL_PASSWORD: 'short', LOG_STDOUT: 'maybe', COOKIE_SECURE: 'x' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 6);
  }
});

test('runJob logs failures with stack and does not throw', async () => {
  const dir = tmpDir();
  const l = new Logger({ dir, stdout: false });
  const r = await runJob(l, 'boom-job', () => { throw new Error('job exploded'); });
  assert.equal(r.ok, false);
  const e = l.readEntries('app', { minLevel: 'ERROR' })[0];
  assert.equal(e.msg, 'background job failed');
  assert.equal(e.job, 'boom-job');
  assert.ok(e.err.stack.includes('job exploded'));
  assert.equal((await runJob(l, 'fine', async () => 7)).result, 7);
});
