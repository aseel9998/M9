'use strict';
const os = require('node:os');
const { VERSION, BUILD } = require('./version');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, base, body, scripts = [] }) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl" data-base="${esc(base)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="${esc(base)}/assets/style.css"></head>
<body>${body}
<script src="${esc(base)}/assets/client-errors.js"></script>
${scripts.map(s => `<script src="${esc(base)}/assets/${esc(s)}"></script>`).join('\n')}
</body></html>`;
}

function loginPage({ base, setup, needsKey, error }) {
  const err = error ? `<p class="error" role="alert">${esc(error)}</p>` : '';
  const key = needsKey ? `<label>کلید راه‌اندازی / Setup key<input name="setup_key" type="password" autocomplete="off" required></label>` : '';
  const confirm = setup ? `<label>تکرار رمز / Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>` : '';
  const body = `<main class="card narrow"><h1>Blue Knight Panel</h1>
<p class="muted">${setup ? 'ساخت رمز اولیه / Create the panel password' : 'ورود / Sign in'}</p>${err}
<form method="post" action="${esc(base)}/login">${key}
<label>رمز / Password<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required></label>${confirm}
<button type="submit">${setup ? 'ایجاد / Create' : 'ورود / Sign in'}</button></form></main>`;
  return layout({ title: 'Blue Knight Panel', base, body });
}

function nav(base) {
  return `<nav><a href="${esc(base)}">داشبورد / Dashboard</a><a href="${esc(base)}/settings">تنظیمات / Settings</a><a href="${esc(base)}/logs">لاگ‌ها / Logs</a>
<form method="post" action="${esc(base)}/logout"><button type="submit" class="link">خروج / Logout</button></form></nav>`;
}

function dashboardPage({ base, startedAt }) {
  const body = `${nav(base)}<main class="card"><h1>Blue Knight Panel</h1>
<dl><dt>Version</dt><dd>${esc(VERSION)} (build ${esc(BUILD)})</dd><dt>Node</dt><dd>${esc(process.version)}</dd>
<dt>Host</dt><dd>${esc(os.hostname())}</dd><dt>Started</dt><dd>${esc(new Date(startedAt).toISOString())}</dd></dl>
<p><a class="btn" href="${esc(base)}/api/diagnostics/download">دانلود گزارش تشخیصی / Download diagnostic report</a></p>
<p class="muted">Milestone 1: core, authentication, logging and diagnostics. Proxy engines and subscriptions arrive in later milestones.</p></main>`;
  return layout({ title: 'Dashboard', base, body });
}

function logsPage({ base }) {
  const body = `${nav(base)}<main class="card wide"><h1>لاگ‌ها / Logs</h1>
<div class="controls">
<label>Channel<select id="channel"><option value="app">app</option><option value="security">security</option><option value="all">all</option></select></label>
<label>Level ≥<select id="level"><option>DEBUG</option><option selected>INFO</option><option>WARNING</option><option>ERROR</option><option>CRITICAL</option></select></label>
<label>Limit<select id="limit"><option>100</option><option selected>200</option><option>500</option><option>1000</option></select></label>
<label>Search<input id="q" maxlength="100"></label>
<button id="refresh" type="button">Refresh</button><label class="inline"><input id="auto" type="checkbox"> Auto</label></div>
<div class="actions">
<a class="btn" href="${esc(base)}/api/diagnostics/download">⬇ Diagnostic report (.json)</a>
<a class="btn" id="dl-raw" href="${esc(base)}/api/logs/download?channel=app">⬇ Raw log</a>
<button id="copy" type="button">Copy diagnostics</button></div>
<p id="status" class="muted" role="status"></p><p class="muted">Entries: <span id="count">0</span></p>
<div id="rows" class="rows"></div></main>`;
  return layout({ title: 'Logs', base, body, scripts: ['logs.js'] });
}

function settingsPage({ base }) {
  const body = `${nav(base)}<main class="card"><h1>تنظیمات / Settings</h1>
<h2>پیشوند مسیر ترنسپورت / Transport path prefix</h2>
<p class="muted">این پیشوند اول مسیر همه ترنسپورت‌ها است (مثل <code>/@BlueKnight_Net--…--ws</code>). / Prepended to every transport path.</p>
<label>Prefix<input id="prefix" dir="ltr" maxlength="151" autocomplete="off" spellcheck="false"></label>
<p id="locked" class="muted" hidden>این مقدار با متغیر محیطی TRANSPORT_PATH_PREFIX قفل شده است. / Locked by the TRANSPORT_PATH_PREFIX environment variable.</p>
<div class="actions"><button id="save" type="button">ذخیره / Save</button><button id="reset" type="button">پیش‌فرض / Default</button></div>
<p id="status" class="muted" role="status"></p>
<h3>پیش‌نمایش / Preview</h3><div id="preview" class="rows"></div>
<p class="muted">با تغییر مسیر، کلاینت‌ها و اشتراک‌های قبلی کار نمی‌کنند؛ بعد از ذخیره اشتراک را دوباره بگیر. / Existing client configs stop matching after a change; refresh your subscription.</p>
</main>`;
  return layout({ title: 'Settings', base, body, scripts: ['settings.js'] });
}

module.exports = { loginPage, dashboardPage, logsPage, settingsPage, esc };
