// In-memory state, nothing on disk: which resolvers asked for each token, and the rate limits.

// token -> the addresses of the resolvers that asked for <token>.<zone>. An entry lives at most ttlMs
// from the first query (110 seconds, and the server sweeps every 5, so nothing is kept two minutes),
// and take() hands it over once and forgets it. Memory is capped: past maxTokens the oldest go first.
export class TokenStore {
  constructor({ ttlMs = 110_000, maxTokens = 50_000, maxIps = 16, now = () => performance.now() } = {}) {
    this.ttl = ttlMs; this.max = maxTokens; this.maxIps = maxIps; this.now = now;
    this.map = new Map();                                // insertion order is creation order
  }

  record(token, ip) {
    const t = this.now();
    let e = this.map.get(token);
    if (e && t - e.created >= this.ttl) { this.map.delete(token); e = null; }
    if (!e) {
      if (this.map.size >= this.max) this.evict(t);
      e = { created: t, ips: [] };
      this.map.set(token, e);
    }
    if (e.ips.length < this.maxIps && !e.ips.includes(ip)) e.ips.push(ip);
  }

  // The resolvers for these tokens (each address once) and how many of the tokens were asked for.
  // The tokens are forgotten either way.
  take(tokens) {
    const t = this.now(), ips = new Set();
    let seen = 0;
    for (const k of new Set(tokens)) {
      const e = this.map.get(k);
      if (!e) continue;
      this.map.delete(k);
      if (t - e.created >= this.ttl) continue;
      seen++;
      for (const ip of e.ips) ips.add(ip);
    }
    return { resolvers: [...ips], seen };
  }

  sweep(t = this.now()) {
    for (const [k, e] of this.map) {
      if (t - e.created < this.ttl) break;               // everything after this one is newer
      this.map.delete(k);
    }
  }

  evict(t) {
    this.sweep(t);
    for (const k of this.map.keys()) {
      if (this.map.size < this.max) break;
      this.map.delete(k);
    }
  }

  get size() { return this.map.size; }
}

// Token buckets per key: `rate` a second, bursts up to `burst`. The table is capped too; if a flood
// from many sources fills it, it starts over rather than growing.
export class Buckets {
  constructor({ rate, burst, max = 100_000, now = () => performance.now() }) {
    this.rate = rate / 1000; this.burst = burst; this.max = max; this.now = now;
    this.map = new Map();
  }

  take(key) {
    const t = this.now();
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.max) { this.sweep(t); if (this.map.size >= this.max) this.map.clear(); }
      b = { tokens: this.burst, t };
      this.map.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.t) * this.rate);
    b.t = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  sweep(t = this.now()) {                                // drop buckets that have refilled: they hold nothing
    for (const [k, b] of this.map) if (b.tokens + (t - b.t) * this.rate >= this.burst) this.map.delete(k);
  }

  get size() { return this.map.size; }
}
