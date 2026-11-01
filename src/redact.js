'use strict';
const MASK = '[REDACTED]';
const SENSITIVE_KEY = /pass(word|wd|phrase)|(^|[^a-z])pass([^a-z]|$)|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|setup[-_]?key|session|uuid|(^|[^a-z])key([^a-z]|$)/i;

function scrubString(input) {
  return String(input)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ' + MASK)
    .replace(/(^|[?&;\s"'])((?:token|password|pass|key|secret|setup_key|auth|uuid|sub)=)[^&\s"']+/gi, '$1$2' + MASK)
    .replace(/\b(vless|vmess|trojan|ss|hysteria2|tuic):\/\/[^\s"']+/gi, '$1://' + MASK)
    .replace(/\b(bk_session=)[^;\s"']+/gi, '$1' + MASK);
}

function redact(value, opts = {}, depth = 0, seen = new WeakSet()) {
  const maxArray = opts.maxArray || 50;
  const maxDepth = opts.maxDepth || 8;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return scrubString(value.length > 4000 ? value.slice(0, 4000) + '…[truncated]' : value);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (depth > maxDepth) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const out = { name: value.name, message: scrubString(value.message), stack: scrubString(value.stack || '') };
    if (value.code !== undefined) out.code = String(value.code);
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, maxArray).map(v => redact(v, opts, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 100)) {
    // Booleans carry no secret (e.g. passwordCreated: true) and keep reports useful.
    out[k] = SENSITIVE_KEY.test(k) && typeof v !== 'boolean' ? MASK : redact(v, opts, depth + 1, seen);
  }
  return out;
}

module.exports = { redact, scrubString, MASK };
