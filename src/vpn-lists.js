// Known commercial VPN servers, from the server lists the VPN providers publish themselves: no third-party list, and
// nobody hand-feeds addresses. The VpnServers Durable Object in src/worker.js downloads them on a cron trigger
// (wrangler.toml [triggers]) and keeps every address seen on a provider's list in the last 3 days (mergeRecord), so a
// download that fails or looks broken changes nothing. It packs them into one blob of sorted addresses (packIndex)
// that every lookup searches by exact address (findServer).
// Pure functions only, no Cloudflare APIs: tools/check_vpnlists.mjs runs them in Node on saved copies of each list.
//
// Each listed address has a role:
//   exit   traffic leaves from it: sites see the provider's users at this address (the provider's docs or app code
//          say so; see each provider below)
//   entry  the provider's users connect to it, but their traffic leaves from another address, which the list doesn't
//          name. It is still that provider's server, so a visitor whose own address it is, is on it (leaktest).
// An address a list doesn't give, or gives in a form that is not a public IPv4 or global IPv6 address, is skipped.

export const VPN_MAX_AGE = 3 * 86400_000;      // an address not on its provider's list for this long is dropped
export const VPN_FETCH_TIMEOUT = 20_000;       // per list; the next cron run tries again (no retries in between)

// The providers, in the order lookups prefer when two lists name one address. url: one request per refresh.
// max: the most bytes read from it. min: fewer addresses than this means the list is broken, not shrunk.
// Checked 2026-10-21 (docs/handbook.md, "Known VPN servers", has the details and sources). None of these lists names
// the addresses its users reach sites from, so every address here is an entry:
// - Mullvad: the documented "Mullvad Public API" relay list (api.mullvad.net/public/documentation/), whose
//   ipv4_addr_in is "the ipv4 address to use to connect to the server". Mullvad's help pages show each server's entry
//   (in) and exit (out) addresses apart, and its blog says a server has several exit addresses; an independent mapping
//   found none of them listed. Its terms say nothing on reusing the list. WireGuard only: OpenVPN ended in January 2026.
// - Private Internet Access: PIA's own app code says the listed address is not necessarily the exit, and asks PIA's
//   API for the real one after connecting. Terms silent. The "meta" addresses are API proxies, not VPN entries: skipped.
// - IVPN: its status page offers this JSON ("Live server list as JSON"); no field or doc says where traffic leaves.
// - AirVPN: a documented free API. Its servers send traffic out from separate exit addresses (AirVPN's own app reads
//   them separately from the entries, and none of them is an entry).
// Not here: NordVPN (its terms forbid automated access to its services without written permission), Proton VPN (no
// public route: its API wants an app's version header, which ipterm won't fake) and Surfshark (its list encrypts the
// addresses).
export const VPN_PROVIDERS = [
  {
    id: 'mullvad', name: 'Mullvad', url: 'https://api.mullvad.net/public/relays/wireguard/v2/', max: 2_000_000, min: 100,
    parse(text) {
      const j = JSON.parse(text), out = [];
      for (const r of arr(j && j.wireguard && j.wireguard.relays)) out.push([r.ipv4_addr_in, 'entry'], [r.ipv6_addr_in, 'entry']);
      return out;
    },
  },
  {
    // JSON on the first line, then a blank line and PIA's signature (base64), which reading the addresses doesn't need.
    id: 'pia', name: 'Private Internet Access', url: 'https://serverlist.piaservers.net/vpninfo/servers/v6', max: 2_000_000, min: 100,
    parse(text) {
      const end = text.indexOf('\n'), j = JSON.parse(end > 0 ? text.slice(0, end) : text), out = [];
      for (const r of arr(j && j.regions)) {
        const s = r.servers && typeof r.servers === 'object' ? r.servers : {};
        for (const kind of ['wg', 'awg', 'ovpnudp', 'ovpntcp', 'ikev2']) for (const x of arr(s[kind])) out.push([x.ip, 'entry']);
      }
      return out;
    },
  },
  {
    id: 'ivpn', name: 'IVPN', url: 'https://api.ivpn.net/v5/servers/stats', max: 1_000_000, min: 20,
    parse(text) {
      const j = JSON.parse(text), out = [];
      for (const s of arr(j && j.servers)) {
        const h = s.hosts && typeof s.hosts === 'object' ? s.hosts : {};
        for (const kind of ['wireguard', 'openvpn']) if (h[kind] && typeof h[kind] === 'object') out.push([h[kind].host, 'entry']);
      }
      return out;
    },
  },
  {
    id: 'airvpn', name: 'AirVPN', url: 'https://airvpn.org/api/status/', max: 1_000_000, min: 50,
    parse(text) {
      const j = JSON.parse(text), out = [];
      for (const s of arr(j && j.servers)) for (let i = 1; i <= 4; i++) out.push([s['ip_v4_in' + i], 'entry'], [s['ip_v6_in' + i], 'entry']);
      return out;
    },
  },
];
const arr = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);

/* ---------- addresses ----------
   IPv4 as one unsigned 32-bit number; IPv6 as four. Only public IPv4 and global unicast IPv6 (2000::/3, outside the
   documentation range) count: a list that carries a placeholder such as 2001:db8:1::1 gets it skipped. */
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function v4num(s) {
  if (typeof s !== 'string' || !V4.test(s)) return null;
  const [a, b, c, d] = s.split('.').map(Number);
  return a * 16777216 + b * 65536 + c * 256 + d;
}
export function v6words(s) {
  if (typeof s !== 'string' || s.length > 39 || !/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
  const dbl = s.includes('::'), [h, t] = dbl ? s.split('::') : [s, ''];
  const hp = h ? h.split(':') : [], tp = dbl && t ? t.split(':') : [];
  const fill = 8 - hp.length - tp.length;
  if (dbl ? fill < 1 : hp.length !== 8) return null;
  const g = [...hp, ...Array(dbl ? fill : 0).fill('0'), ...tp];
  if (g.length !== 8 || g.some(x => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  const n = g.map(x => parseInt(x, 16));
  return [0, 2, 4, 6].map(i => n[i] * 65536 + n[i + 1]);
}
export function publicV4(n) {
  const a = n >>> 24, b = (n >>> 16) & 255, c = (n >>> 8) & 255;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}
export const globalV6 = w => w[0] >>> 29 === 1 && w[0] !== 0x20010db8;      // 2000::/3, but not 2001:db8::/32

// A provider's parsed [address, role] pairs as one downloaded list: each address once (exit wins over entry), sorted,
// in typed arrays. role arrays: 0 = exit, 1 = entry.
export function toRecord(pairs) {
  const four = new Map(), six = new Map();
  for (const [ip, role] of pairs) {
    const r = role === 'exit' ? 0 : role === 'entry' ? 1 : -1;
    if (r < 0 || typeof ip !== 'string' || !ip) continue;
    const n = v4num(ip.trim());
    if (n != null) { if (publicV4(n) && four.get(n) !== 0) four.set(n, r); continue; }
    const w = v6words(ip.trim().toLowerCase());
    if (w && globalV6(w)) { const k = w.join(','); if (six.get(k) !== 0) six.set(k, r); }
  }
  const f = [...four.keys()].sort((a, b) => a - b);
  const s = [...six.keys()].map(k => k.split(',').map(Number)).sort(cmp6);
  return {
    four: Uint32Array.from(f), role4: Uint8Array.from(f.map(n => four.get(n))),
    six: Uint32Array.from(s.flat()), role6: Uint8Array.from(s.map(w => six.get(w.join(',')))),
  };
}
const cmp6 = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

// A provider's addresses as kept: every address on any of its lists within VPN_MAX_AGE, each with the time (Unix
// seconds) it was last on one (seen4, seen6). fresh: the list just downloaded (toRecord), or null when that download
// failed or didn't pass, which only lets old addresses expire. So a failed or short download removes nothing seen
// lately (the last good list stays), and a list that names a different part of the servers each time (PIA's changes
// every few minutes) adds up to far more of them than any one download.
export function mergeRecord(old, fresh, now) {
  const t = Math.floor(now / 1000), oldest = t - VPN_MAX_AGE / 1000;
  const four = new Map(), six = new Map();
  if (old && old.seen4 && old.seen6) {
    old.four.forEach((n, i) => { if (old.seen4[i] >= oldest) four.set(n, [old.role4[i], old.seen4[i]]); });
    for (let i = 0; i < old.role6.length; i++) if (old.seen6[i] >= oldest) six.set(old.six.subarray(i * 4, i * 4 + 4).join(','), [old.role6[i], old.seen6[i]]);
  }
  if (fresh) {
    fresh.four.forEach((n, i) => four.set(n, [fresh.role4[i], t]));
    for (let i = 0; i < fresh.role6.length; i++) six.set(fresh.six.subarray(i * 4, i * 4 + 4).join(','), [fresh.role6[i], t]);
  }
  const f = [...four.keys()].sort((a, b) => a - b), s = [...six.keys()].map(k => k.split(',').map(Number)).sort(cmp6);
  const at6 = s.map(w => six.get(w.join(',')));
  return {
    four: Uint32Array.from(f), role4: Uint8Array.from(f.map(n => four.get(n)[0])), seen4: Uint32Array.from(f.map(n => four.get(n)[1])),
    six: Uint32Array.from(s.flat()), role6: Uint8Array.from(at6.map(e => e[0])), seen6: Uint32Array.from(at6.map(e => e[1])),
  };
}

/* ---------- the packed index ----------
   One ArrayBuffer, the same in the Durable Object, the Cache API and each Worker's memory:
     "VPN2", header length (uint32), header JSON { built, providers: [{ id, name, at, n4, n6 }], n4, n6 }, padding to 4,
     IPv4 addresses (n4 x uint32, sorted), IPv6 addresses (n6 x 4 uint32, sorted), when each was last listed (n4 + n6
     x uint32, Unix seconds), then one tag byte per address (provider number x 2, + 1 for an entry), IPv4 first.
   The numbers are little-endian, as Workers and Node write them. 9 bytes per IPv4 address and 21 per IPv6: about 70 KB
   for October 2026's lists, as PIA's add up. A SQLite-backed Durable Object takes 2 MB per value. */
export function packIndex(lists, built) {
  // lists: [{ id, name, at, rec }] in provider order, rec as mergeRecord makes it. Merged and sorted, with each
  // provider's number in the tag.
  const four = [], six = [];
  lists.forEach(({ rec }, p) => {
    rec.four.forEach((n, i) => four.push([n, p * 2 + rec.role4[i], rec.seen4[i]]));
    for (let i = 0; i < rec.role6.length; i++) six.push([...rec.six.subarray(i * 4, i * 4 + 4), p * 2 + rec.role6[i], rec.seen6[i]]);
  });
  four.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  six.sort((a, b) => cmp6(a, b) || a[4] - b[4]);
  const head = new TextEncoder().encode(JSON.stringify({
    built: new Date(built).toISOString(), n4: four.length, n6: six.length,
    providers: lists.map(({ id, name, at, rec }) => ({ id, name, at: new Date(at).toISOString(), n4: rec.four.length, n6: rec.role6.length })),
  }));
  const start = 8 + head.length + ((4 - (head.length % 4)) % 4);
  const buf = new ArrayBuffer(start + four.length * 9 + six.length * 21);
  const dv = new DataView(buf);
  new Uint8Array(buf).set([86, 80, 78, 50]);           // VPN2
  dv.setUint32(4, head.length, true);
  new Uint8Array(buf, 8, head.length).set(head);
  let o = start;
  for (const [n] of four) { dv.setUint32(o, n, true); o += 4; }
  for (const w of six) for (let i = 0; i < 4; i++) { dv.setUint32(o, w[i], true); o += 4; }
  for (const x of four) { dv.setUint32(o, x[2], true); o += 4; }
  for (const x of six) { dv.setUint32(o, x[5], true); o += 4; }
  for (const x of four) dv.setUint8(o++, x[1]);
  for (const x of six) dv.setUint8(o++, x[4]);
  return buf;
}

// Whether a stored value is an index in this format (VpnServers.blob() treats one in an older format as none).
export const isIndex = b => !!(b && b.byteLength >= 8 && String.fromCharCode(...new Uint8Array(b, 0, 4)) === 'VPN2');

export function unpackIndex(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 8 || String.fromCharCode(...u8.subarray(0, 4)) !== 'VPN2') throw new Error('not a VPN server index');
  const dv = new DataView(buf), hl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  const start = 8 + hl + ((4 - (hl % 4)) % 4), n4 = head.n4 >>> 0, n6 = head.n6 >>> 0;
  if (buf.byteLength !== start + n4 * 9 + n6 * 21 || !Array.isArray(head.providers)) throw new Error('VPN server index has the wrong length');
  const words = (o, n) => { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getUint32(o + i * 4, true); return a; };
  const tags = start + (n4 + n6) * 4 + n4 * 4 + n6 * 16;
  return {
    ...head, four: words(start, n4), six: words(start + n4 * 4, n6 * 4),
    seen4: words(start + n4 * 4 + n6 * 16, n4), seen6: words(start + n4 * 8 + n6 * 16, n6),
    tag4: u8.slice(tags, tags + n4), tag6: u8.slice(tags + n4, tags + n4 + n6),
  };
}

// The listing for one address (a string), or null: { provider, role, seen } (seen: when it was last on that
// provider's list, as an ISO date). Exact address only, never its network. A listing older than VPN_MAX_AGE at `now`
// is passed over, and so is a provider whose id isn't in `ids` (a Set), when given. When two lists name the address,
// an exit beats an entry, then the provider listed first.
export function findServer(idx, ip, now, ids = null) {
  if (!idx || typeof ip !== 'string') return null;
  const hits = [];
  const n = v4num(ip.trim());
  if (n != null) {
    let lo = 0, hi = idx.four.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (idx.four[m] < n) lo = m + 1; else hi = m; }
    for (let i = lo; i < idx.four.length && idx.four[i] === n; i++) hits.push([idx.tag4[i], idx.seen4[i]]);
  } else {
    const w = v6words(ip.trim().toLowerCase());
    if (!w) return null;
    const at = i => idx.six.subarray(i * 4, i * 4 + 4);
    let lo = 0, hi = idx.tag6.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (cmp6(at(m), w) < 0) lo = m + 1; else hi = m; }
    for (let i = lo; i < idx.tag6.length && cmp6(at(i), w) === 0; i++) hits.push([idx.tag6[i], idx.seen6[i]]);
  }
  const fresh = hits.filter(([t, seen]) => idx.providers[t >> 1] && (!ids || ids.has(idx.providers[t >> 1].id)) && now - seen * 1000 <= VPN_MAX_AGE);
  if (!fresh.length) return null;
  const [t, seen] = fresh.sort((a, b) => (a[0] & 1) - (b[0] & 1) || a[0] - b[0])[0];
  return { provider: idx.providers[t >> 1].name, role: t & 1 ? 'entry' : 'exit', seen: new Date(seen * 1000).toISOString() };
}
