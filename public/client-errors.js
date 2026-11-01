(function () {
  'use strict';
  var base = document.documentElement.getAttribute('data-base') || '';
  var sent = 0;
  var MAX = 10;
  function send(p) {
    if (sent >= MAX) return;
    sent++;
    p.url = location.pathname;
    fetch(base + '/api/client-log', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-BK-Req': '1' },
      body: JSON.stringify(p)
    }).catch(function (e) { console.warn('could not send error report', e); });
  }
  window.addEventListener('error', function (e) {
    send({ type: 'error', message: String(e.message || ''), source: String(e.filename || ''), line: e.lineno | 0, col: e.colno | 0, stack: e.error && e.error.stack ? String(e.error.stack) : '' });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send({ type: 'unhandledrejection', message: String(r && r.message ? r.message : r), stack: r && r.stack ? String(r.stack) : '' });
  });
  window.bkReportError = send;
})();
