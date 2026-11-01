(function () {
  'use strict';
  var base = document.documentElement.getAttribute('data-base');
  var $ = function (id) { return document.getElementById(id); };
  var timer = null;

  function params() {
    return new URLSearchParams({ channel: $('channel').value, level: $('level').value, limit: $('limit').value, q: $('q').value });
  }
  function render(entries) {
    var box = $('rows');
    box.textContent = '';
    entries.slice().reverse().forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'row lvl-' + String(e.level).toLowerCase();
      var head = document.createElement('div');
      head.className = 'head';
      head.textContent = [e.ts, e.level, e.channel, e.msg].join('  ');
      row.appendChild(head);
      var extra = {};
      Object.keys(e).forEach(function (k) { if (['ts', 'level', 'channel', 'msg'].indexOf(k) === -1) extra[k] = e[k]; });
      if (Object.keys(extra).length) {
        var pre = document.createElement('pre');
        pre.textContent = JSON.stringify(extra, null, 2);
        row.appendChild(pre);
      }
      box.appendChild(row);
    });
  }
  function load() {
    $('status').textContent = '';
    fetch(base + '/api/logs?' + params(), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.href = base + '/login'; return null; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { if (d) { render(d.entries); $('count').textContent = d.count; } })
      .catch(function (e) { $('status').textContent = 'Error: ' + e.message; });
  }
  function copyDiagnostics() {
    fetch(base + '/api/diagnostics', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) { return navigator.clipboard.writeText(t); })
      .then(function () { $('status').textContent = 'Copied.'; })
      .catch(function (e) { $('status').textContent = 'Copy failed: ' + e.message + ' (use the download button instead)'; });
  }
  $('refresh').addEventListener('click', load);
  $('copy').addEventListener('click', copyDiagnostics);
  ['channel', 'level', 'limit'].forEach(function (id) { $(id).addEventListener('change', load); });
  $('channel').addEventListener('change', function () {
    var c = $('channel').value;
    $('dl-raw').href = base + '/api/logs/download?channel=' + (c === 'all' ? 'app' : c);
  });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
  $('auto').addEventListener('change', function () {
    if (timer) { clearInterval(timer); timer = null; }
    if ($('auto').checked) timer = setInterval(load, 5000);
  });
  load();
})();
