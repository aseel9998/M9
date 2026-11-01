(function () {
  'use strict';
  var base = document.documentElement.getAttribute('data-base');
  var $ = function (id) { return document.getElementById(id); };
  var info = null;

  function preview() {
    var box = $('preview');
    box.textContent = '';
    if (!info) return;
    var p = $('prefix').value.trim();
    if (p && p.charAt(0) !== '/') p = '/' + p;
    if (!p) p = info.defaultPrefix;
    Object.keys(info.suffixes).forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'row';
      var path = k === 'grpcService' ? p.slice(1) + info.suffixes[k] : p + info.suffixes[k];
      row.textContent = k + '  →  ' + path;
      box.appendChild(row);
    });
  }
  function apply(d) {
    info = d;
    $('prefix').value = d.transportPathPrefix;
    $('prefix').disabled = d.lockedByEnv;
    $('save').disabled = d.lockedByEnv;
    $('reset').disabled = d.lockedByEnv;
    $('locked').hidden = !d.lockedByEnv;
    preview();
  }
  function fail(e) { $('status').textContent = 'Error: ' + e.message; }
  function load() {
    fetch(base + '/api/settings', { credentials: 'same-origin' })
      .then(function (r) { if (r.status === 401) { location.href = base + '/login'; return null; } if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { if (d) apply(d); })
      .catch(fail);
  }
  function save(value) {
    $('status').textContent = '';
    fetch(base + '/api/settings', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-BK-Req': '1' },
      body: JSON.stringify({ transportPathPrefix: value })
    })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
      .then(function (d) { apply(d); $('status').textContent = 'ذخیره شد / Saved.'; })
      .catch(fail);
  }
  $('prefix').addEventListener('input', preview);
  $('save').addEventListener('click', function () { save($('prefix').value); });
  $('reset').addEventListener('click', function () { save(''); });
  load();
})();
