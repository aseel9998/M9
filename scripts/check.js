'use strict';
// Static check without external tooling: syntax of every JS file + forbidden patterns.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'data', '.git'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error('SYNTAX', f, r.stderr); }
  const src = fs.readFileSync(f, 'utf8');
  if (/\beval\(|new Function\(/.test(src) && !f.endsWith('check.js')) { bad++; console.error('FORBIDDEN eval/new Function in', f); }
  if (f.includes(path.join('src', '')) && /console\.log\(/.test(src)) { bad++; console.error('console.log in', f, '(use the logger)'); }
}
console.log(`${files.length} files checked, ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
