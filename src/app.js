'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('./logger');
const { LEVELS } = require('./config');
const { runChecks, buildReport } = require('./diagnostics');
const { RateLimiter } = require('./ratelimit');
const { COOKIE } = require('./auth');
const pages = require('./pages');
const { VERSION, BUILD } = require('./version');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function loadAssets() {
  const dir = path.join(__dirname, '..', 'public');
  const out = new Map();
  for (const f of fs.readdirSync(dir)) {
    const type = ASSET_TYPES[path.extname(f)];
    if (type) out.set(f, { type, body: fs.readFileSync(path.join(dir, f)) });
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

function createApp({ config, logger, auth, settings, extraRoutes = [] }) {
  const base = '/' + config.panelPath;
  const assets = loadAssets();
  const clientLogLimiter = new RateLimiter(30, 60000);
  const startedAt = Date.now();
  let lastReady = null;

  const lastOf = v => String(v || '').split(',').pop().trim();

  function clientIp(req) {
    const peer = req.socket.remoteAddress || 'unknown';
    const hops = config.trustProxyHops;
    if (!hops) return peer;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const candidate = xff[xff.length - hops];
    return candidate && net.isIP(candidate) ? candidate : peer;
  }

  function isSecure(req) {
    if (config.cookieSecure === 'true') return true;
    if (config.cookieSecure === 'false') return false;
    if (req.socket.encrypted) return true;
    return config.trustProxyHops > 0 && lastOf(req.headers['x-forwarded-proto']) === 'https';
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      let oh;
      try { oh = new URL(origin).host; } catch (_) { return false; }
      if (oh === req.headers.host) return true;
      return config.trustProxyHops > 0 && oh === lastOf(req.headers['x-forwarded-host']);
    }
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  }

  const send = (res, status, body, type, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };
  const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
  const html = (res, status, body) => send(res, status, body, 'text/html; charset=utf-8');
  const redirect = (res, to, extra = {}) => { res.writeHead(302, { Location: to, ...extra }); res.end(); };

  const sessionCookie = (req, value, maxAgeSec) =>
    `${COOKIE}=${value}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;

  function session(ctx) {
    const s = auth.verifySession(ctx.req.headers.cookie);
    if (!s.ok && (s.reason === 'bad_signature' || s.reason === 'malformed')) {
      logger.security('WARNING', 'invalid session cookie presented', { ip: ctx.ip, reason: s.reason, requestId: ctx.rid });
    }
    return s.ok;
  }

  function guardApi(ctx) {
    if (session(ctx)) return true;
    json(ctx.res, 401, { error: 'login_required' });
    return false;
  }

  function guardPage(ctx) {
    if (session(ctx)) return true;
    redirect(ctx.res, base + '/login');
    return false;
  }

  function csrfOk(ctx) {
    if (sameOrigin(ctx.req)) return true;
    logger.security('WARNING', 'cross-origin request rejected', { ip: ctx.ip, path: ctx.pathname, origin: ctx.req.headers.origin, requestId: ctx.rid });
    send(ctx.res, 403, 'forbidden', 'text/plain; charset=utf-8');
    return false;
  }

  function parseLogQuery(url) {
    const channel = url.searchParams.get('channel') || 'app';
    if (channel !== 'all' && !CHANNELS.includes(channel)) throw new HttpError(400, 'invalid channel');
    const level = (url.searchParams.get('level') || 'DEBUG').toUpperCase();
    if (!(level in LEVELS)) throw new HttpError(400, 'invalid level');
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
    const q = (url.searchParams.get('q') || '').slice(0, 100);
    return { channel, level, limit, q };
  }

  const authStatus = () => auth.status();
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  const routes = [];
  const add = (method, p, handler) => routes.push({ method, p, handler });

  add('GET', '/healthz', ctx => json(ctx.res, 200, { status: 'ok', version: VERSION, uptimeSec: Math.round(process.uptime()) }));

  add('GET', '/readyz', ctx => {
    const checks = runChecks({ config, logger, authStatus, settings });
    const ok = checks.every(c => c.ok || !c.critical);
    if (lastReady !== ok) {
      if (ok) logger.info('readiness restored'); else logger.error('readiness check failing', { checks });
      lastReady = ok;
    }
    const degraded = ok && checks.some(c => !c.ok);
    json(ctx.res, ok ? 200 : 503, { status: ok ? (degraded ? 'degraded' : 'ready') : 'not_ready', checks: checks.map(c => ({ name: c.name, ok: c.ok })) });
  });

  add('GET', '/', ctx => redirect(ctx.res, base));

  add('GET', base + '/login', ctx => {
    if (auth.hasPassword() && auth.verifySession(ctx.req.headers.cookie).ok) return redirect(ctx.res, base);
    html(ctx.res, 200, pages.loginPage({ base, setup: !auth.hasPassword(), needsKey: auth.needsSetupKey() }));
  });

  add('POST', base + '/login', async ctx => {
    if (!csrfOk(ctx)) return;
    const form = new URLSearchParams(await readBody(ctx.req, 10 * 1024));
    const setup = !auth.hasPassword();
    const result = setup
      ? auth.setup({ password: form.get('password'), confirm: form.get('confirm'), key: form.get('setup_key'), ip: ctx.ip })
      : auth.login({ password: form.get('password'), ip: ctx.ip });
    if (!result.ok) {
      return html(ctx.res, result.status, pages.loginPage({ base, setup, needsKey: auth.needsSetupKey(), error: result.error }));
    }
    redirect(ctx.res, base, { 'Set-Cookie': sessionCookie(ctx.req, result.cookie, 12 * 3600) });
  });

  add('POST', base + '/logout', ctx => {
    if (!csrfOk(ctx)) return;
    logger.security('INFO', 'logout', { ip: ctx.ip, requestId: ctx.rid });
    redirect(ctx.res, base + '/login', { 'Set-Cookie': sessionCookie(ctx.req, '', 0) });
  });

  add('GET', base, ctx => { if (guardPage(ctx)) html(ctx.res, 200, pages.dashboardPage({ base, startedAt })); });
  add('GET', base + '/logs', ctx => { if (guardPage(ctx)) html(ctx.res, 200, pages.logsPage({ base })); });

  add('GET', base + '/settings', ctx => { if (guardPage(ctx)) html(ctx.res, 200, pages.settingsPage({ base })); });
  add('GET', base + '/api/settings', ctx => { if (guardApi(ctx)) json(ctx.res, 200, settings.snapshot()); });
  add('POST', base + '/api/settings', async ctx => {
    const { req, res } = ctx;
    if (!guardApi(ctx)) return;
    if (req.headers['x-bk-req'] !== '1' || !sameOrigin(req)) {
      logger.security('WARNING', 'settings change rejected (csrf)', { ip: ctx.ip, requestId: ctx.rid });
      return json(res, 403, { error: 'forbidden' });
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'json_required' });
    let body;
    try { body = JSON.parse(await readBody(req, 2048)); } catch (err) {
      if (err instanceof HttpError) throw err;
      return json(res, 400, { error: 'invalid_json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid_payload' });
    const result = settings.update({ transportPathPrefix: body.transportPathPrefix });
    if (!result.ok) {
      ctx.log.warn('settings change rejected', { reason: result.error, ip: ctx.ip });
      return json(res, result.status, { error: result.error });
    }
    logger.security('INFO', 'settings changed', { ip: ctx.ip, changed: ['transportPathPrefix'], prefixLength: result.snapshot.transportPathPrefix.length, isDefault: result.snapshot.isDefault, requestId: ctx.rid });
    json(res, 200, result.snapshot);
  });

  add('GET', base + '/api/status', ctx => {
    if (!guardApi(ctx)) return;
    json(ctx.res, 200, { version: VERSION, build: BUILD, node: process.version, startedAt: new Date(startedAt).toISOString(), uptimeSec: Math.round(process.uptime()) });
  });

  add('GET', base + '/api/logs', ctx => {
    if (!guardApi(ctx)) return;
    const { channel, level, limit, q } = parseLogQuery(ctx.url);
    const entries = logger.readEntries(channel, { minLevel: level, limit, q });
    json(ctx.res, 200, { channel, count: entries.length, entries });
  });

  add('GET', base + '/api/logs/download', ctx => {
    if (!guardApi(ctx)) return;
    const { channel } = parseLogQuery(ctx.url);
    if (channel === 'all') throw new HttpError(400, 'choose app or security');
    logger.security('INFO', 'raw log downloaded', { ip: ctx.ip, channel, requestId: ctx.rid });
    send(ctx.res, 200, logger.exportRaw(channel), 'text/plain; charset=utf-8', {
      'Content-Disposition': `attachment; filename="bk-${channel}-${stamp()}.log"`
    });
  });

  const diagnostics = ctx => buildReport({ config, logger, authStatus, settings });

  add('GET', base + '/api/diagnostics', ctx => { if (guardApi(ctx)) json(ctx.res, 200, diagnostics(ctx)); });

  add('GET', base + '/api/diagnostics/download', ctx => {
    if (!guardApi(ctx)) return;
    logger.security('INFO', 'diagnostic report downloaded', { ip: ctx.ip, requestId: ctx.rid });
    send(ctx.res, 200, JSON.stringify(diagnostics(ctx), null, 2), 'application/json; charset=utf-8', {
      'Content-Disposition': `attachment; filename="bk-diagnostics-${stamp()}.json"`
    });
  });

  // Frontend error reports: public (errors can occur before login), so strictly bounded.
  add('POST', base + '/api/client-log', async ctx => {
    const { req, res } = ctx;
    if (req.headers['x-bk-req'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (!String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'json_required' });
    if (!clientLogLimiter.allow(ctx.ip)) return json(res, 429, { error: 'rate_limited' });
    let body;
    try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch (err) {
      if (err instanceof HttpError) throw err;
      return json(res, 400, { error: 'invalid_json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid_payload' });
    const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const type = ['error', 'unhandledrejection'].includes(body.type) ? body.type : 'error';
    ctx.log.error('frontend error', {
      source: 'frontend', type, message: cut(body.message, 500), file: cut(body.source, 300),
      line: Number.isInteger(body.line) ? body.line : undefined, col: Number.isInteger(body.col) ? body.col : undefined,
      stack: cut(body.stack, 3000), page: cut(body.url, 200), ip: ctx.ip, userAgent: cut(req.headers['user-agent'], 200)
    });
    res.writeHead(204);
    res.end();
  });

  const routeTable = new Map(routes.map(r => [r.method + ' ' + r.p, r.handler]));

  async function route(ctx) {
    for (const r of extraRoutes) if (await r(ctx, { json, html, send, redirect, guardApi, guardPage, csrfOk, readBody, HttpError })) return true;
    const key = ctx.req.method + ' ' + ctx.pathname;
    if (routeTable.has(key)) { await routeTable.get(key)(ctx); return true; }
    if (ctx.req.method === 'GET' && ctx.pathname.startsWith(base + '/assets/')) {
      const a = assets.get(ctx.pathname.slice((base + '/assets/').length));
      if (a) { send(ctx.res, 200, a.body, a.type, { 'Cache-Control': 'public, max-age=300' }); return true; }
    }
    return false;
  }

  async function handle(req, res) {
    const t0 = process.hrtime.bigint();
    const inbound = req.headers['x-request-id'];
    const rid = typeof inbound === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
    const ip = clientIp(req);
    const log = logger.bind({ requestId: rid });
    res.setHeader('X-Request-Id', rid);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');

    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { url = null; }
    const pathname = url ? url.pathname : '(invalid)';

    res.on('finish', () => {
      const status = res.statusCode;
      const quiet = pathname === '/healthz' || pathname === '/readyz';
      const level = status >= 500 ? 'ERROR' : [401, 403, 429].includes(status) ? 'WARNING' : quiet ? 'DEBUG' : 'INFO';
      log.log(level, 'request', {
        method: req.method, path: pathname, status, ip,
        durationMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100
      });
    });
    res.on('close', () => { if (!res.writableFinished) log.warn('request aborted by client', { method: req.method, path: pathname, ip }); });

    if (!url) return json(res, 400, { error: 'bad_request', requestId: rid });
    const ctx = { req, res, url, pathname, ip, log, rid };
    try {
      if (!(await route(ctx))) json(res, 404, { error: 'not_found', requestId: rid });
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) json(res, err.status, { error: err.message, requestId: rid }, err.status === 413 ? { Connection: 'close' } : {});
      } else {
        log.error('unhandled error in request handler', { method: req.method, path: pathname, err });
        if (!res.headersSent) json(res, 500, { error: 'internal_error', requestId: rid }); else res.destroy();
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      logger.error('request pipeline failure', { err });
      try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (_) { /* socket already gone */ }
    });
  });
  server.on('clientError', (err, socket) => {
    logger.warn('client connection error', { code: err.code, message: err.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function close() {
    return new Promise(resolve => {
      server.close(() => resolve());
      if (server.closeIdleConnections) server.closeIdleConnections();
      setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, 3000).unref();
    });
  }

  return { server, close };
}

module.exports = { createApp, HttpError };
