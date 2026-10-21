// Apple's iCloud Private Relay: the addresses its relays send traffic out from, from the list Apple publishes itself
// (https://mask-api.icloud.com/egress-ip-ranges.csv: one range a line, "prefix,country,region,city,"). Unlike the VPN
// lists (src/vpn-lists.js) these are ranges, and they are exits: Private Relay sends a Safari user's traffic out from
// one of them, so sites see that address instead of the user's. A relay, not a VPN: it covers Safari (and some
// unencrypted app traffic), not the rest of the device. The VpnServers Durable Object in src/worker.js downloads the
// list on the same cron trigger as the VPN lists, asking with the last copy's ETag so an unchanged list costs a 304,
// keeps the last good copy when a download fails, and packs the ranges into one blob that lookups search in memory.
// Pure functions only: tools/check_vpnlists.mjs runs them in Node.
import { VPN_MAX_AGE, v4num, v6words, publicV4, globalV6 } from './vpn-lists.js';

// min: fewer ranges than this means a broken download (there were 285,106 on 2026-10-21).
// timeout and max: the list is about 12 MB, read a chunk at a time (parseRelayStream), so a few times that still fits a
// Durable Object's 128 MB.
export const RELAY = { id: 'icloud', name: 'iCloud Private Relay', url: 'https://mask-api.icloud.com/egress-ip-ranges.csv', max: 32_000_000, min: 10_000, timeout: 60_000 };

// The CSV's ranges, merged: overlapping and adjacent ranges become one (285,106 lines came to 1,011 IPv4 and 5,903
// IPv6 ranges), since only whether an address is in one matters here, not the place each line names. IPv4 as
// [first, last] numbers; IPv6 by its first 64 bits, as [first high, first low, last high, last low] 32-bit words: every
// IPv6 range on the list is a /64 or wider. Skipped: a line that isn't a range, an IPv4 range wider than a /8, an IPv6
// one wider than a /16 or narrower than a /64, and anything not public. count: the ranges read before merging.
// relayParser takes one line at a time into flat number arrays (no object per line), so the whole list costs a few MB
// beyond its text, and parseRelayStream never holds that text whole.
function relayParser() {
  const f4 = [], f6 = [];                                // [first, last, ...] and [first hi, first lo, last hi, last lo, ...]
  let count = 0;
  return {
    line(line) {
      const comma = line.indexOf(','), cell = (comma >= 0 ? line.slice(0, comma) : line).trim();
      const slash = cell.indexOf('/'), len = slash > 0 && /^\d{1,3}$/.test(cell.slice(slash + 1)) ? Number(cell.slice(slash + 1)) : -1;
      if (len < 0) return;
      const addr = cell.slice(0, slash), n = v4num(addr);
      if (n != null) {
        if (len < 8 || len > 32) return;
        const size = 2 ** (32 - len), first = n - (n % size);
        if (publicV4(first)) { f4.push(first, first + size - 1); count++; }
        return;
      }
      const w = v6words(addr.toLowerCase());
      if (!w || len < 16 || len > 64 || !globalV6(w)) return;
      const hiMask = len <= 32 ? (0xffffffff << (32 - len)) >>> 0 : 0xffffffff, loMask = len <= 32 ? 0 : (0xffffffff << (64 - len)) >>> 0;
      const hi = (w[0] & hiMask) >>> 0, lo = (w[1] & loMask) >>> 0;
      f6.push(hi, lo, (hi | ~hiMask) >>> 0, (lo | ~loMask) >>> 0); count++;
    },
    done() {
      const o4 = Uint32Array.from({ length: f4.length / 2 }, (_, i) => i).sort((a, b) => f4[a * 2] - f4[b * 2]);
      const o6 = Uint32Array.from({ length: f6.length / 4 }, (_, i) => i).sort((a, b) => f6[a * 4] - f6[b * 4] || f6[a * 4 + 1] - f6[b * 4 + 1]);
      const m4 = [], m6 = [];
      for (const i of o4) {
        const first = f4[i * 2], end = f4[i * 2 + 1], last = m4[m4.length - 1];
        if (last && first <= last[1] + 1) { if (end > last[1]) last[1] = end; } else m4.push([first, end]);
      }
      for (const i of o6) {
        const r = [f6[i * 4], f6[i * 4 + 1], f6[i * 4 + 2], f6[i * 4 + 3]], last = m6[m6.length - 1];
        // adjacent: r starts at last's end + 1 (with the carry from the low word into the high one)
        const next = last ? (last[3] === 0xffffffff ? [last[2] + 1, 0] : [last[2], last[3] + 1]) : null;
        if (last && (r[0] < next[0] || (r[0] === next[0] && r[1] <= next[1]))) {
          if (r[2] > last[2] || (r[2] === last[2] && r[3] > last[3])) { last[2] = r[2]; last[3] = r[3]; }
        } else m6.push(r);
      }
      return { four: m4, six: m6, count };
    },
  };
}

export function parseRelay(text) {
  const p = relayParser();
  for (let i = 0; i < text.length;) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    p.line(text.slice(i, j));
    i = j + 1;
  }
  return p.done();
}

// The same from a response body, a chunk at a time, refused past max bytes.
export async function parseRelayStream(body, max) {
  const p = relayParser(), dec = new TextDecoder(), reader = body.getReader();
  let rest = '', n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel(); throw new Error('response too large'); }
    rest += dec.decode(value, { stream: true });
    let i = 0;
    for (let j; (j = rest.indexOf('\n', i)) >= 0; i = j + 1) p.line(rest.slice(i, j));
    rest = rest.slice(i);
  }
  rest += dec.decode();
  if (rest) p.line(rest);
  return p.done();
}

/* ---------- the packed ranges ----------
   One ArrayBuffer, the same in the Durable Object, the Cache API and each Worker's memory:
     "APR1", header length (uint32), header JSON { at, count, n4, n6 }, padding to 4, then the IPv4 ranges' first and
     last addresses (n4 x uint32 each), the IPv6 ranges' first and last /64s (n6 x 2 uint32 each), little-endian.
   at: when Apple's list was last downloaded, or confirmed unchanged. About 100 KB in October 2026. */
export function packRelay(rec, at) {
  const head = new TextEncoder().encode(JSON.stringify({ at: new Date(at).toISOString(), count: rec.count, n4: rec.four.length, n6: rec.six.length }));
  const start = 8 + head.length + ((4 - (head.length % 4)) % 4), n4 = rec.four.length, n6 = rec.six.length;
  const buf = new ArrayBuffer(start + n4 * 8 + n6 * 16), dv = new DataView(buf);
  new Uint8Array(buf).set([65, 80, 82, 49]);           // APR1
  dv.setUint32(4, head.length, true);
  new Uint8Array(buf, 8, head.length).set(head);
  let o = start;
  for (const r of rec.four) { dv.setUint32(o, r[0], true); o += 4; }
  for (const r of rec.four) { dv.setUint32(o, r[1], true); o += 4; }
  for (const r of rec.six) { dv.setUint32(o, r[0], true); dv.setUint32(o + 4, r[1], true); o += 8; }
  for (const r of rec.six) { dv.setUint32(o, r[2], true); dv.setUint32(o + 4, r[3], true); o += 8; }
  return buf;
}

// The same ranges dated `at`: after a 304, Apple's list is unchanged as of then.
export function restampRelay(buf, at) {
  const x = unpackRelay(buf), four = [], six = [];
  for (let i = 0; i < x.first4.length; i++) four.push([x.first4[i], x.last4[i]]);
  for (let i = 0; i < x.first6.length / 2; i++) six.push([x.first6[i * 2], x.first6[i * 2 + 1], x.last6[i * 2], x.last6[i * 2 + 1]]);
  return packRelay({ four, six, count: x.count }, at);
}

export const isRelay = b => !!(b && b.byteLength >= 8 && String.fromCharCode(...new Uint8Array(b, 0, 4)) === 'APR1');

export function unpackRelay(buf) {
  if (!isRelay(buf)) throw new Error('not an iCloud Private Relay list');
  const u8 = new Uint8Array(buf), dv = new DataView(buf), hl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  const start = 8 + hl + ((4 - (hl % 4)) % 4), n4 = head.n4 >>> 0, n6 = head.n6 >>> 0;
  if (buf.byteLength !== start + n4 * 8 + n6 * 16) throw new Error('iCloud Private Relay list has the wrong length');
  const words = (o, n) => { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getUint32(o + i * 4, true); return a; };
  return { ...head, first4: words(start, n4), last4: words(start + n4 * 4, n4), first6: words(start + n4 * 8, n6 * 2), last6: words(start + n4 * 8 + n6 * 8, n6 * 2) };
}

// Whether an address (a string) is in one of the ranges, and when the list was last checked: { at } or null. Never
// once the list is older than VPN_MAX_AGE at `now` (no good download in 3 days).
export function findRelay(idx, ip, now) {
  if (!idx || typeof ip !== 'string' || !(now - Date.parse(idx.at) <= VPN_MAX_AGE)) return null;
  const n = v4num(ip.trim());
  if (n != null) {
    let lo = 0, hi = idx.first4.length;                 // the last range that starts at or before the address
    while (lo < hi) { const m = (lo + hi) >>> 1; if (idx.first4[m] <= n) lo = m + 1; else hi = m; }
    return lo > 0 && n <= idx.last4[lo - 1] ? { at: idx.at } : null;
  }
  const w = v6words(ip.trim().toLowerCase());
  if (!w) return null;
  const le = (a, i, h, l) => a[i * 2] < h || (a[i * 2] === h && a[i * 2 + 1] <= l);   // a[i] <= (h, l)
  let lo = 0, hi = idx.first6.length / 2;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (le(idx.first6, m, w[0], w[1])) lo = m + 1; else hi = m; }
  if (lo === 0) return null;
  const k = lo - 1, h = idx.last6[k * 2], l = idx.last6[k * 2 + 1];
  return w[0] < h || (w[0] === h && w[1] <= l) ? { at: idx.at } : null;
}
