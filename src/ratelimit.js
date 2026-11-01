'use strict';
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  /** Returns true when the call is allowed. */
  allow(key) {
    const now = Date.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    let h = this.hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + this.windowMs }; this.hits.set(key, h); }
    h.count++;
    return h.count <= this.limit;
  }
}
module.exports = { RateLimiter };
