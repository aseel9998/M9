'use strict';
// Transport path scheme: every transport lives at <prefix><suffix> on the single public port.
// Mirrors the original panel's layout (prefix + ws/vmess/trojan/httpupgrade/...), but the prefix is configurable.
const DEFAULT_PREFIX = '/@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--@BlueKnight_Net--';
const SUFFIXES = Object.freeze({
  vlessWs: 'ws', vmessWs: 'vmess', trojanWs: 'trojan',
  vlessHu: 'httpupgrade', vmessHu: 'vmess-hu', trojanHu: 'trojan-hu',
  xhttp: 'xhttp', ssWs: 'ss', grpcService: 'grpc'
});
const PREFIX_RE = /^\/[A-Za-z0-9@._~-]{1,150}$/;

function normalizePrefix(input) {
  const p = String(input === undefined || input === null ? '' : input).trim();
  return p && !p.startsWith('/') ? '/' + p : p;
}

/** Returns an error message, or null when the prefix is acceptable. */
function validatePrefix(prefix, { panelPath = 'knight' } = {}) {
  if (!PREFIX_RE.test(prefix)) return 'must start with "/" followed by 1-150 characters from A-Z a-z 0-9 @ . _ ~ - (no further "/", spaces, "?" or "#")';
  const reserved = new Set(['/', '/healthz', '/readyz', '/' + panelPath]);
  const clash = Object.values(buildPaths(prefix)).find(p => reserved.has(p) || p.startsWith('/' + panelPath + '/'));
  return clash ? 'would collide with a reserved panel path' : null;
}

function buildPaths(prefix) {
  const out = {};
  for (const [k, s] of Object.entries(SUFFIXES)) out[k] = k === 'grpcService' ? prefix.slice(1) + s : prefix + s;
  return out;
}

module.exports = { DEFAULT_PREFIX, SUFFIXES, normalizePrefix, validatePrefix, buildPaths };
