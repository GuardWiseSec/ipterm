// Checks the known VPN servers: the providers' own server lists (src/vpn-lists.js), the Durable Object that keeps them
// (VpnServers in src/worker.js) and the verdict lookups give. No server and no network: the lists come from
// tools/fixtures/vpn-lists/ (a few real entries of each, saved 2026-10-21, plus odd ones), or are made up here from them
// when a check needs a full-sized list, and the whole Worker runs in Node as in tools/check_bots.mjs, with fetch,
// caches.default and the budget counter stubbed.
//
// 1. Parsers: each provider's saved list gives the addresses it should, every one an entry (none of these lists names
//    the addresses its users reach sites from), and skips what isn't a VPN entry: Mullvad's in-tunnel gateways, PIA's API
//    proxies ("meta") and its signature line, IVPN servers with no hosts, private and documentation addresses, junk.
// 2. What is kept and found (mergeRecord, packIndex, unpackIndex, findServer): every address seen on a provider's list
//    in the last VPN_MAX_AGE, with when it was last listed; exact addresses only (never a neighbour), IPv6 in any
//    spelling, an exit preferred over an entry, an address listed too long ago passed over, and a damaged blob refused.
// 3. The refresh (VpnServers.refresh, on a stand-in for the object's storage): one request per provider and no retries,
//    with an ipterm user agent; a list that fails to download, isn't JSON, has fewer than the provider's minimum or is
//    over its size cap changes nothing and says why; PIA's lists, which name other servers each time, add up; a short
//    list removes nothing seen in the last 3 days; an address drops out 3 days after it was last listed, and with none
//    left, so does the blob; then a lookup's request for the blob sets an alarm to refresh, at most once an hour; two
//    refreshes at once share one set of requests; the cron trigger (scheduled) runs one.
// 4. Lookups: the JSON (vpnServer), the text answer (/<ip>/text, with ?color=1), the IP page and the terminal's lookup
//    (/api/lookup, vpnText in public/app.js, which must say the same) for a listed address, IPv4 and IPv6; a
//    neighbour and an unlisted address unchanged; a Worker's index past its 10 minutes answering at once while the
//    next loads; a Worker with none asking the object once a minute, not every lookup, and never waiting on a load
//    that doesn't settle; a provider taken out of the code answering nothing; a bot gets the listing (it is free) and still spends no budget;
//    leaktest's check of a listed visitor carries it and skips proxycheck.io; a listed exit (a made-up provider, as no
//    real one lists exits) skips proxycheck.io in a lookup too; /status shows each list; without the binding nothing
//    changes. Then leaktest in public/app.js: a listing counts as a VPN, so the sponsored line (shown only after a
//    no-VPN verdict from a check that ran) stays away, and the copied Markdown's masking hides the provider's name.
// 6. iCloud Private Relay (src/relay-list.js, refreshRelay and relayData in src/worker.js): Apple's own list of its
//    relays' addresses, saved lines plus junk (tools/fixtures/vpn-lists/icloud-relay.csv): ranges read and merged,
//    and their edges in IPv4 and IPv6 (first and last address in, the neighbours out, adjacent ranges merged, also
//    across a 32-bit word); the refresh: no If-None-Match the first time, Apple's ETag the next, a 304 keeping the
//    ranges and dating them, a failure or a short list keeping the last good copy, a copy 3 days old unused, an old
//    format refreshed; then lookups: JSON (relay), text, page and terminal in both IP versions, ?lite=1, a bot,
//    leaktest's check, /status, no proxycheck.io query for a relay address, and leaktest's verdict (a relay, with no
//    sponsored line).
// 7. The docs name the feature, the providers and this check.
//
//   node tools/check_vpnlists.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as L from '../src/vpn-lists.js';
import * as A from '../src/relay-list.js';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const app = read('public/app.js'), INDEX = read('public/index.html');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_vpnlists.mjs`);
  return src.slice(a, b);
}
const P = Object.fromEntries(L.VPN_PROVIDERS.map(p => [p.id, p]));
const FIX = { mullvad: 'mullvad.json', pia: 'pia.txt', ivpn: 'ivpn.json', airvpn: 'airvpn.json' };
const fixture = id => read('tools/fixtures/vpn-lists/' + FIX[id]);
// A parsed record as { address: role }, the address as findServer would key it.
function roles(rec) {
  const out = {};
  rec.four.forEach((n, i) => { out[[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')] = rec.role4[i] ? 'entry' : 'exit'; });
  for (let i = 0; i < rec.role6.length; i++) out['v6:' + [...rec.six.subarray(i * 4, i * 4 + 4)].join(',')] = rec.role6[i] ? 'entry' : 'exit';
  return out;
}
const k6 = ip => 'v6:' + L.v6words(ip).join(',');

console.log('-- 1. parsers, on the saved lists (src/vpn-lists.js)');
ok(L.VPN_PROVIDERS.map(p => p.id).join(' ') === 'mullvad pia ivpn airvpn', `the providers: ${L.VPN_PROVIDERS.map(p => p.name).join(', ')}`);
ok(!L.VPN_PROVIDERS.some(p => /nordvpn|proton|surfshark/i.test(p.url)), 'no NordVPN (its terms forbid automated access), Proton VPN or Surfshark list is fetched');
ok(L.VPN_PROVIDERS.every(p => p.url.startsWith('https://') && p.max > 0 && p.min > 0), 'every list is fetched over https, with a size cap and a minimum');
const expect = {
  mullvad: { v4: ['45.142.26.2', '62.101.165.2', '103.139.178.63', '103.124.165.191'], v6: ['2a04:27c0:0:e::f001', '2a04:27c0:0:f::f001', '2a06:3040:10:610::f101'],
    not: ['10.64.0.1', k6('fc00:bbbb:bbbb:bb01::1')], what: 'WireGuard relays, an inactive one too; not the in-tunnel gateways' },
  pia: { v4: ['191.96.227.20', '191.96.227.51', '191.96.227.49', '191.96.227.42', '151.240.205.152', '102.129.152.25', '102.129.153.192'],
    not: ['191.96.227.2', '151.240.205.5', '37.19.198.162', '102.129.152.2'], what: 'wg, ikev2 and OpenVPN addresses once each; not the "meta" API proxies' },
  ivpn: { v4: ['149.22.83.97', '149.22.83.100', '46.102.153.242', '46.102.153.246', '146.70.78.74'], not: ['149.22.83.102'],
    what: "WireGuard and OpenVPN hosts; a server without hosts or without one protocol's host is no trouble" },
  airvpn: { v4: ['185.156.175.170', '185.156.175.172', '185.156.175.173', '185.156.175.174', '185.156.175.34'], v6: ['2001:ac8:28:8:c4d0:d13a:3b31:4d'],
    not: ['185.156.175.171'], what: 'entry addresses 1 to 4, IPv4 and IPv6' },
};
const counts = { mullvad: [4, 3], pia: [21, 0], ivpn: [5, 0], airvpn: [8, 8] };
for (const p of L.VPN_PROVIDERS) {
  const rec = L.toRecord(p.parse(fixture(p.id))), r = roles(rec), e = expect[p.id];
  const want = [...e.v4, ...(e.v6 || []).map(k6)];
  ok(want.every(a => r[a] === 'entry') && e.not.every(a => !(a in r)) &&
    rec.four.length === counts[p.id][0] && rec.role6.length === counts[p.id][1] && Object.values(r).every(x => x === 'entry'),
  `${p.name}: ${rec.four.length} IPv4 and ${rec.role6.length} IPv6, all entries: ${e.what}`);
}
const junk = L.toRecord([['10.0.0.1', 'entry'], ['192.168.1.1', 'entry'], ['100.64.0.1', 'entry'], ['127.0.0.1', 'entry'], ['198.51.100.7', 'entry'],
  ['224.0.0.1', 'entry'], ['2001:db8:1::1', 'entry'], ['fe80::1', 'entry'], ['fd00::1', 'entry'], ['::ffff:1.2.3.4', 'entry'], ['not-an-ip', 'entry'],
  ['', 'entry'], [null, 'entry'], [42, 'entry'], ['1.2.3.4', 'maybe'], ['01.2.3.4', 'entry'], ['8.8.8.8 ', 'entry'], ['2A04:27C0::1', 'entry'], ['8.8.8.8', 'exit']]);
ok(junk.four.length === 1 && junk.role4[0] === 0 && junk.role6.length === 1,
  'private, shared, loopback, documentation, multicast, link-local and unique-local addresses, IPv4-mapped IPv6, junk and unknown roles are skipped; an address listed as entry and exit is an exit');
for (const [id, text, what] of [['mullvad', '{"not":"a list"}', 'an object instead of a list'], ['pia', '{}\n\nSIG', 'no regions'], ['ivpn', '[]', 'a list instead of an object'],
  ['airvpn', '{"servers":"none"}', 'servers as text']]) {
  ok(L.toRecord(P[id].parse(text)).four.length === 0, `${P[id].name}: ${what} gives no addresses (and no error)`);
}
let threw = 0;
for (const p of L.VPN_PROVIDERS) { try { p.parse('<html>busy</html>'); } catch { threw++; } }
ok(threw === L.VPN_PROVIDERS.length, 'an HTML page instead of JSON is an error for every provider (the refresh then changes nothing)');
ok(L.toRecord(P.pia.parse(fixture('pia').split('\n')[0])).four.length === counts.pia[0], "PIA's list reads the same without its signature lines");

console.log('-- 2. what is kept and found (mergeRecord, packIndex, unpackIndex, findServer)');
const NOW = Date.parse('2026-10-21T12:00:00Z'), HOUR = 3600_000, iso = t => new Date(Math.floor(t / 1000) * 1000).toISOString();
const one = list => L.toRecord(list.map(ip => [ip, 'entry']));
const m1 = L.mergeRecord(null, one(['1.1.1.10', '1.1.1.11', '2a0f::1']), NOW - L.VPN_MAX_AGE - 2 * HOUR);
const m2 = L.mergeRecord(m1, one(['1.1.1.11', '1.1.1.12']), NOW - L.VPN_MAX_AGE + HOUR);
const m3 = L.mergeRecord(m2, null, NOW), m4 = L.mergeRecord(m2, L.toRecord([['1.1.1.12', 'exit']]), NOW);
const seenOf = (r, n) => r.seen4[[...r.four].indexOf(n)];
ok(m2.four.length === 3 && m2.role6.length === 1 && seenOf(m2, L.v4num('1.1.1.11')) === (NOW - L.VPN_MAX_AGE + HOUR) / 1000 &&
  seenOf(m2, L.v4num('1.1.1.10')) === (NOW - L.VPN_MAX_AGE - 2 * HOUR) / 1000,
  "a provider's next list adds to what is kept, and each address keeps when it was last listed");
ok(m3.four.length === 2 && m3.role6.length === 0 && !([...m3.four].includes(L.v4num('1.1.1.10'))),
  'a failed download (no list) only lets addresses expire: those last listed over VPN_MAX_AGE ago go');
ok(m4.role4[[...m4.four].indexOf(L.v4num('1.1.1.12'))] === 0 && L.mergeRecord({ four: new Uint32Array([1]), role4: new Uint8Array([1]) }, null, NOW).four.length === 0,
  "the latest list's role wins, and a stored record without dates counts for nothing");
const rec = (id, t) => L.mergeRecord(null, L.toRecord(P[id].parse(fixture(id))), t);
const exitRec = L.mergeRecord(null, L.toRecord([['203.0.114.9', 'exit'], ['45.142.26.2', 'exit'], ['2a04:27c0:0:e::f001', 'exit']]), NOW);
const lists = [{ id: 'mullvad', name: 'Mullvad', at: NOW - HOUR, rec: rec('mullvad', NOW - HOUR) }, { id: 'pia', name: 'Private Internet Access', at: NOW - 2 * HOUR, rec: rec('pia', NOW - 2 * HOUR) },
  { id: 'old', name: 'OldVPN', at: NOW - L.VPN_MAX_AGE - HOUR, rec: L.mergeRecord(null, L.toRecord([['5.6.7.8', 'exit']]), NOW - L.VPN_MAX_AGE - HOUR) }, { id: 'ex', name: 'ExampleVPN', at: NOW, rec: exitRec }];
const blob = L.packIndex(lists, NOW), idx = L.unpackIndex(blob.slice(0));
ok(idx.n4 === lists.reduce((n, l) => n + l.rec.four.length, 0) && idx.providers.length === 4 && idx.built === new Date(NOW).toISOString(),
  `${blob.byteLength} bytes for ${idx.n4} IPv4 and ${idx.n6} IPv6 addresses, with each provider's name and date`);
const f = ip => L.findServer(idx, ip, NOW);
ok(JSON.stringify(f('191.96.227.42')) === JSON.stringify({ provider: 'Private Internet Access', role: 'entry', seen: iso(NOW - 2 * HOUR) }),
  `an exact IPv4 match names the provider, the role and when it was last listed: ${JSON.stringify(f('191.96.227.42'))}`);
ok(!f('191.96.227.41') && !f('191.96.227.43') && !f('191.96.227.0') && !f('191.96.0.0'), 'its neighbours and its network are no match (exact addresses only)');
ok(f('2a06:3040:10:610::f101') && f('2A06:3040:0010:0610:0000:0000:0000:F101') && f('2a06:3040:10:610:0:0:0:f101') && !f('2a06:3040:10:610::f102'),
  'IPv6 matches in any spelling, and only that address');
ok(f('45.142.26.2').role === 'exit' && f('45.142.26.2').provider === 'ExampleVPN' && f('2a04:27c0:0:e::f001').role === 'exit' && f('103.139.178.63').provider === 'Mullvad',
  'an address two lists name: the exit wins over the entry');
ok(!f('5.6.7.8') && L.findServer(idx, '5.6.7.8', NOW - L.VPN_MAX_AGE) !== null, 'an address last listed more than VPN_MAX_AGE ago is passed over');
ok(!f('8.8.8.8') && !f('not-an-ip') && !f('') && !L.findServer(null, '45.142.26.2', NOW), 'an unlisted address, junk, or no index: no match');
ok(L.findServer(idx, '45.142.26.2', NOW, new Set(['mullvad', 'pia'])).provider === 'Mullvad' && !L.findServer(idx, '203.0.114.9', NOW, new Set(['mullvad', 'pia'])),
  'given the providers still in use, a listing of any other is passed over (here ExampleVPN, so Mullvad answers for 45.142.26.2)');
const bad = new Uint8Array(blob.slice(0)); bad[0] = 0;
let refused = 0;
for (const b of [bad.buffer, blob.slice(0, blob.byteLength - 1), new ArrayBuffer(4)]) { try { L.unpackIndex(b); } catch { refused++; } }
ok(refused === 3, 'a blob with the wrong header, cut short, or too small is refused');
const empty = L.unpackIndex(L.packIndex([], NOW));
ok(empty.n4 === 0 && !L.findServer(empty, '45.142.26.2', NOW), 'an empty index finds nothing');

// The whole Worker, as in tools/check_bots.mjs. Its Durable Object base class gets a stand-in, and its storage one too.
const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_vpnlists.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });
const cache = new Map();                                 // caches.default, bytes as they are (the index is binary)
globalThis.caches = { default: {
  async match(req) { const e = cache.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body.slice(), { headers: e.headers }) : undefined; },
  async put(req, res) { cache.set(typeof req === 'string' ? req : req.url, { body: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] }); },
} };
// Workers' constant-time compare (statusKeyOk, for /status), which Node's Web Crypto lacks. Equal-length digests here.
crypto.subtle.timingSafeEqual ||= (a, b) => { const x = new Uint8Array(a), y = new Uint8Array(b); return x.length === y.length && x.every((v, i) => v === y[i]); };
class Storage {                                           // a Durable Object's storage: values are copied, as they are stored
  constructor() { this.m = new Map(); this.alarm = null; this.alarms = 0; }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) this.m.set(a, structuredClone(b)); else this.m.set(k, structuredClone(v)); }
  async delete(k) { return Array.isArray(k) ? k.filter(x => this.m.delete(x)).length : this.m.delete(k); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t) { this.alarm = t; this.alarms++; }
}

// Full-sized lists in each provider's format: the saved entries plus n made-up addresses (from a seed, so a second list
// can differ). A test list's own counts come from the parser, not from here.
const gen = {
  mullvad: (n, s = 0) => { const j = JSON.parse(fixture('mullvad'));
    j.wireguard.relays.push(...Array.from({ length: n }, (_, i) => ({ hostname: 'gen-wg-' + i, active: true,
      ipv4_addr_in: `45.${100 + s}.${i >> 8}.${i & 255}`, ipv6_addr_in: `2a04:27c0:${(s + 1).toString(16)}:${i.toString(16)}::f001` })));
    return JSON.stringify(j); },
  pia: (n, s = 0) => { const [json, ...sig] = fixture('pia').split('\n'), j = JSON.parse(json);
    j.regions.push({ id: 'gen', servers: { wg: Array.from({ length: n }, (_, i) => ({ ip: `102.${100 + s}.${i >> 8}.${i & 255}`, cn: 'gen' + i })) } });
    return [JSON.stringify(j), ...sig].join('\n'); },
  ivpn: (n, s = 0) => { const j = JSON.parse(fixture('ivpn'));
    j.servers.push(...Array.from({ length: n }, (_, i) => ({ hosts: { wireguard: { host: `149.${100 + s}.${i >> 8}.${i & 255}` } } })));
    return JSON.stringify(j); },
  airvpn: (n, s = 0) => { const j = JSON.parse(fixture('airvpn'));
    j.servers.push(...Array.from({ length: n }, (_, i) => ({ public_name: 'Gen' + i, ip_v4_in1: `185.${100 + s}.${i >> 8}.${i & 255}` })));
    return JSON.stringify(j); },
};
const size = (id, text) => { const r = L.toRecord(P[id].parse(text)); return r.four.length + r.role6.length; };

// fetch: the providers' lists from `serve` (by provider id: a body, a Response, or a function that throws), and IPinfo,
// proxycheck.io, DNS and the registries as in tools/check_bots.mjs. Every request is noted.
const calls = [];
let serve = {};
const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const providerOf = u => Object.keys(P).find(id => P[id].url === u) || (extra && u === extra.url ? extra.id : null);
let extra = null;                                        // a made-up provider that lists exits (no real one does)
const relayCalls = [];                                   // Apple's list: the If-None-Match each request sent
let serveRelay = () => new Response('busy', { status: 503 });
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : input.url;
  if (u === A.RELAY.url) { calls.push(['relay', u]); relayCalls.push((init.headers || {})['if-none-match'] || null); return serveRelay(init); }
  const id = providerOf(u);
  let m;
  if (id) {
    calls.push(['list', id, (init.headers || {})['user-agent'] || '']);
    const s = serve[id];
    if (typeof s === 'function') return s();
    return s instanceof Response ? s : reply(s);
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lookup\/([^?]+)/.exec(u))) {
    calls.push(['core', u]);
    return reply({ ip: decodeURIComponent(m[1]), geo: { city: 'Amsterdam', region: 'North Holland', country: 'Netherlands', country_code: 'NL', continent: 'Europe',
      latitude: 52.37, longitude: 4.89, timezone: 'Europe/Amsterdam', postal_code: '1012' },
    as: { asn: 'AS9009', name: 'M247 Europe SRL', domain: 'm247.com', type: 'hosting' }, is_hosting: true });
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lite\/([^?]+)/.exec(u))) {
    calls.push(['lite', u]);
    return reply({ ip: decodeURIComponent(m[1]), asn: 'AS9009', as_name: 'M247 Europe SRL', as_domain: 'm247.com', country_code: 'NL', country: 'Netherlands', continent: 'Europe' });
  }
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u))) {
    calls.push(['proxycheck', u]);
    return reply({ status: 'ok', [decodeURIComponent(m[1])]: { network: { type: 'hosting' }, detections: { proxy: false, vpn: false, tor: false, hosting: true, anonymous: false, risk: 0 } } });
  }
  if (u.startsWith('https://cloudflare-dns.com/')) { calls.push(['dns', u]); return reply({ Status: 3, Answer: [] }); }
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    calls.push(['rdap', u]);
    return reply({ services: [[m[1] === 'ipv4' ? ['0.0.0.0/0'] : m[1] === 'ipv6' ? ['::/0'] : ['1-4294967295'], ['https://rdap.test/']]] });
  }
  if ((m = /^https:\/\/rdap\.test\/ip\/(.+)$/.exec(u))) {
    calls.push(['rdap', u]);
    const ip = decodeURIComponent(m[1]), v6 = ip.includes(':');
    return reply({ objectClassName: 'ip network', handle: 'NET-TEST', name: 'TEST-NET', startAddress: ip, endAddress: ip,
      cidr0_cidrs: [{ [v6 ? 'v6prefix' : 'v4prefix']: ip, length: v6 ? 128 : 32 }], events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00Z' }], entities: [] });
  }
  if (u.startsWith('https://check.torproject.org/')) { calls.push(['tor', u]); return new Response('', { status: 200 }); }
  calls.push(['other', u]);
  return new Response('not stubbed in tools/check_vpnlists.mjs', { status: 404 });
};
const lists0 = () => calls.filter(c => c[0] === 'list');

let mayTake = true;
const taken = [];
const env = {
  IPINFO_TOKEN: 'test-token', IPINFO_PLAN: 'core', PROXYCHECK_KEY: 'test-key', STATUS_KEY: 'test-status-key-0123456789', SOURCE_URL: 'https://github.com/GuardWiseSec/ipterm',
  BUDGET: { idFromName: name => name, get: id => ({
    async take() { taken.push(id); if (!mayTake) throw new Error(`a bot reached the ${id} budget`); return { ok: true }; },
    async status() { return { used: 0, usedHour: 0, hoursRunOut: [], ranOutAt: null, past: [] }; },
  }) },
  ASSETS: { fetch: async () => new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
};
const { default: W, VpnServers } = await import('../src/worker.js');
const storage = new Storage();
const vs = new VpnServers({ storage }, env);
const names = [];
const binding = { idFromName: n => { names.push(n); return n; }, get: () => vs };

// The Worker's clock: the index stays in each Worker's memory for 10 minutes, so a check that needs a new one moves on.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const later = ms => { skew += ms; cache.clear(); };

console.log('-- 3. the refresh: every address seen in the last 3 days (VpnServers in src/worker.js)');
const T0 = Date.now();
const full = { mullvad: gen.mullvad(300), pia: gen.pia(300), ivpn: gen.ivpn(300), airvpn: gen.airvpn(300) };
serve = { ...full };
calls.length = 0;
let meta = await vs.refresh(T0);
ok(lists0().length === 4 && new Set(lists0().map(c => c[1])).size === 4, `one request per provider, no more: ${lists0().map(c => c[1]).join(', ')}`);
ok(lists0().every(c => c[2].startsWith('ipterm (https://github.com/GuardWiseSec/ipterm)')), `with ipterm's user agent: ${JSON.stringify(lists0()[0][2])}`);
ok(Object.keys(P).every(id => meta[id].at === new Date(T0).toISOString() && meta[id].n4 + meta[id].n6 === size(id, full[id]) && meta[id].listed === size(id, full[id]) && !meta[id].error),
  'each list kept, dated, counted: ' + Object.keys(P).map(id => `${id} ${meta[id].n4 + meta[id].n6}`).join(', '));
let idx2 = L.unpackIndex(await vs.blob(T0));
ok(L.findServer(idx2, '45.142.26.2', T0).provider === 'Mullvad' && L.findServer(idx2, '149.22.83.100', T0).provider === 'IVPN' &&
  L.findServer(idx2, '2001:ac8:28:8:c4d0:d13a:3b31:4d', T0).provider === 'AirVPN' && L.findServer(idx2, '102.100.0.44', T0).provider === 'Private Internet Access',
  `the blob (${(await vs.blob(T0)).byteLength} bytes) answers for every provider`);

serve = {
  mullvad: () => reply('busy', 503),
  pia: '<html>maintenance</html>',
  ivpn: '{"servers":[{"hosts":{"wireguard":{"host":"149.22.83.100"}}}],"config":{}}',
  airvpn: reply('x'.repeat(10), 200, { 'content-length': String(P.airvpn.max + 1) }),
};
calls.length = 0;
meta = await vs.refresh(T0 + 6 * HOUR);
const kept = id => meta[id].at === new Date(T0).toISOString() && meta[id].n4 + meta[id].n6 === size(id, full[id]) && meta[id].tried === new Date(T0 + 6 * HOUR).toISOString();
ok(lists0().length === 4 && Object.keys(P).every(kept), 'a failed refresh keeps every address, and notes the try');
ok(/HTTP 503/.test(meta.mullvad.error) && /JSON|Unexpected/i.test(meta.pia.error) && /only 1 addresses \(at least 20 expected\)/.test(meta.ivpn.error) && /too large/.test(meta.airvpn.error),
  `and says why: ${Object.keys(P).map(id => `${id}: ${meta[id].error}`).join('; ')}`);
idx2 = L.unpackIndex(await vs.blob(T0 + 6 * HOUR));
ok(idx2.providers.map(p => p.n4 + p.n6).join() === Object.keys(P).map(id => size(id, full[id])).join() && L.findServer(idx2, '45.142.26.2', T0 + 6 * HOUR),
  'the blob still holds them all');

serve = { ...full, pia: gen.pia(300, 1), airvpn: gen.airvpn(100) };
meta = await vs.refresh(T0 + 12 * HOUR);
idx2 = L.unpackIndex(await vs.blob(T0 + 12 * HOUR));
ok(meta.pia.n4 === size('pia', full.pia) + 300 && meta.pia.listed === size('pia', gen.pia(300, 1)) &&
  L.findServer(idx2, '102.100.0.44', T0 + 12 * HOUR) && L.findServer(idx2, '102.101.0.44', T0 + 12 * HOUR),
  `PIA's list names other servers each time: both lists' addresses are kept (${meta.pia.n4} after two lists of ${meta.pia.listed})`);
ok(meta.airvpn.at === new Date(T0 + 12 * HOUR).toISOString() && !meta.airvpn.error && meta.airvpn.listed === size('airvpn', gen.airvpn(100)) &&
  meta.airvpn.n4 + meta.airvpn.n6 === size('airvpn', full.airvpn) && L.findServer(idx2, '185.100.1.40', T0 + 12 * HOUR),
  `a short list (${meta.airvpn.listed} after ${size('airvpn', full.airvpn)}) is taken, but removes nothing seen in the last 3 days`);
serve = { ...full, pia: gen.pia(300, 2), airvpn: gen.airvpn(104, 1) };
meta = await vs.refresh(T0 + 18 * HOUR);

serve = Object.fromEntries(Object.keys(P).map(id => [id, () => { throw new TypeError('network connection lost'); }]));
const TX = T0 + L.VPN_MAX_AGE + HOUR;
meta = await vs.refresh(TX);
const fx = ip => L.findServer(L.unpackIndex(blobX), ip, TX), blobX = await vs.blob(TX);
ok(Object.keys(P).every(id => /network connection lost/.test(meta[id].error)) && !fx('185.100.1.40') && fx('185.100.0.7') && fx('185.101.0.7') &&
  !fx('102.100.0.44') && fx('102.101.0.44') && fx('102.102.0.44') && fx('45.142.26.2') && meta.pia.n4 === size('pia', full.pia) + 300,
  'an address drops out 3 days after it was last listed (AirVPN\'s that the short list left out, PIA\'s from the first list), the rest stay');
ok(fx('102.101.0.44').seen === new Date(Math.floor((T0 + 12 * HOUR) / 1000) * 1000).toISOString(), `and a match says when it was last listed: ${fx('102.101.0.44').seen}`);
const T4 = T0 + 18 * HOUR + L.VPN_MAX_AGE + HOUR;
meta = await vs.refresh(T4);
ok(Object.keys(P).every(id => meta[id].n4 + meta[id].n6 === 0) && (await storage.get('blob')) === undefined,
  'once nothing has been listed for 3 days, no blob is left, so lookups find nothing');
const alarms = storage.alarms;
ok((await vs.blob(T4 + 10 * 60_000)) === null && storage.alarms === alarms, 'with no blob, a lookup asking within the hour of the last try starts nothing');
await vs.blob(T4 + 2 * HOUR); await vs.blob(T4 + 2 * HOUR + 1);
ok(storage.alarms === alarms + 1 && storage.alarm === T4 + 2 * HOUR + 1000, 'an hour later it sets one alarm to refresh in a second, and a second lookup adds none');
const old = new Uint8Array(16); old.set([86, 80, 78, 49]);                    // "VPN1": a blob in an older format
await storage.put('blob', old.buffer); storage.alarm = null;
ok((await vs.blob(T4 + 4 * HOUR)) === null && storage.alarm === T4 + 4 * HOUR + 1000 && !L.isIndex(old.buffer) && L.isIndex(L.packIndex([], T4)),
  'a stored blob in an older format counts as none: the lookup gets null and an alarm refreshes it');
serve = { ...full };
calls.length = 0;
await vs.alarm();
ok(lists0().length === 4 && (await storage.get('blob')) instanceof ArrayBuffer, 'the alarm refreshes the lists');
calls.length = 0;
await Promise.all([vs.refresh(), vs.refresh()]);
ok(lists0().length === 4, `two refreshes at once share one set of requests: ${lists0().length} requests`);
calls.length = 0;
const waits = [];
await W.scheduled({ cron: '17 */6 * * *' }, { ...env, VPN_SERVERS: binding }, { waitUntil: p => waits.push(p) });
await Promise.all(waits);
ok(lists0().length === 4 && names.includes('lists'), `the cron trigger (scheduled) refreshes the lists through the "lists" object: ${lists0().length} requests`);
let quiet = true;
try { await W.scheduled({}, { ...env }, { waitUntil: () => { quiet = false; } }); } catch { quiet = false; }
ok(quiet, 'without the VPN_SERVERS binding the cron does nothing, and fails nothing');

// One request, as the Worker sees it on ipterm.net (from tools/check_bots.mjs).
async function run(path, { ua, me = '81.2.69.142', worker = W, settle = true, ...headers }) {
  calls.length = 0; taken.length = 0;
  const pending = [];
  const res = await worker.fetch(new Request('https://ipterm.net' + path, { headers: { 'user-agent': ua, 'cf-connecting-ip': me, ...headers } }), env,
    { waitUntil: p => pending.push(p) });
  const body = await res.text();
  for (let n = 0; settle && n < pending.length;) { const m = pending.length; await Promise.allSettled(pending.slice(n, m)); n = m; }
  const init = /<script type="application\/json" id="ipterm-initial">([\s\S]*?)<\/script>/.exec(body);
  let data = null;
  try { data = init ? JSON.parse(init[1]).data : JSON.parse(body); } catch {}
  return { status: res.status, body, data, kinds: calls.map(c => c[0]), taken: [...taken] };
}
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOG = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CURL = 'curl/8.7.1';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const TERMINAL = { accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };
const vpnLine = body => (/^vpn \/ proxy +(.*)$/m.exec(body) || [])[1];
const dd = body => (/<dt>vpn \/ proxy<\/dt><dd>([^<]*)<\/dd>/.exec(body) || [])[1];
const unesc = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const V = Function(slice(app, '  const pcKnown =', "  // A lookup's block") + 'return { vpnText, listedText };')();
const ENTRY = p => `yes: a known VPN server (on ${p}'s own server list, as an address its users connect to; sites may see them at a different address)`;
const EXIT = p => `yes: a known VPN server (on ${p}'s own server list, as an address its users reach sites from)`;

console.log('-- 4. lookups: the verdict (withPrivacy, vpnText in src/worker.js and public/app.js)');
env.VPN_SERVERS = binding;
const MV = '45.142.26.2', MV6 = '2a04:27c0:0:e::f001';
const j = await run(`/${MV}/json`, { ua: CURL, accept: '*/*' }), d = j.data || {};
const seenAt = iso(Date.parse((await vs.status()).mullvad.at));
ok(j.status === 200 && JSON.stringify(d.vpnServer) === JSON.stringify({ provider: 'Mullvad', role: 'entry', lastSeen: seenAt }) && d.source === 'ipinfo-core' &&
  d.privacy && j.kinds.includes('proxycheck'),
  `curl /${MV}/json: vpnServer ${JSON.stringify(d.vpnServer)}; an entry still gets proxycheck.io's opinion (${d.privacy ? 'asked' : 'not asked'})`);
const t = await run(`/${MV}/text`, { ua: CURL, accept: '*/*' });
ok(vpnLine(t.body) === ENTRY('Mullvad') && /^source +IPinfo Core \+ proxycheck\.io \+ Mullvad's server list$/m.test(t.body),
  `curl /${MV}/text: ${JSON.stringify(vpnLine(t.body))}, and the source line names the list`);
const c = await run(`/${MV}/text?color=1`, { ua: CURL, accept: '*/*' });
ok(c.body.includes("\x1b[1;33myes\x1b[0m: a known VPN server (on Mullvad's own server list"), '... and with ?color=1 its "yes" is bold yellow, as a known VPN address was');
const pg = await run(`/${MV}`, { ua: CHROME, ...NAV });
ok(unesc(dd(pg.body)) === ENTRY('Mullvad'), `the IP page: ${JSON.stringify(unesc(dd(pg.body)))}`);
const t6 = await run(`/${MV6}/text`, { ua: CURL, accept: '*/*' }), pg6 = await run(`/${MV6}`, { ua: CHROME, ...NAV }), tl4 = await run(`/api/lookup?ip=${MV}`, { ua: CHROME, ...TERMINAL });
ok(vpnLine(t6.body) === ENTRY('Mullvad') && unesc(dd(pg6.body)) === ENTRY('Mullvad') && tl4.data && V.vpnText(tl4.data) === ENTRY('Mullvad'),
  `the same in IPv6 (${MV6}: text answer and page) and for the terminal's lookup of ${MV}`);
const tl = await run(`/api/lookup?ip=${MV6}`, { ua: CHROME, ...TERMINAL }), td = tl.data || {};
const tl2 = await run('/api/lookup?ip=2A04:27C0:0000:000E:0000:0000:0000:F001', { ua: CHROME, ...TERMINAL });
ok(td.vpnServer && td.vpnServer.provider === 'Mullvad' && V.vpnText(td) === ENTRY('Mullvad') && tl2.data && tl2.data.vpnServer && tl2.data.vpnServer.provider === 'Mullvad',
  `the terminal's lookup of ${MV6} (and of it written out in full): ${JSON.stringify(V.vpnText(td))}`);
const nb = await run('/45.142.26.3/json', { ua: CURL, accept: '*/*' }), un = await run('/46.1.2.3/text', { ua: CURL, accept: '*/*' });
ok(nb.data && !('vpnServer' in nb.data) && Object.keys(d).filter(k => k !== 'vpnServer').join() === Object.keys(nb.data).join() && vpnLine(un.body) === 'not on known VPN or proxy lists, but it is a hosting network, which VPN servers usually use',
  `a neighbour (45.142.26.3) has no vpnServer and the same fields otherwise, and an unlisted address reads as before: ${JSON.stringify(vpnLine(un.body))}`);

mayTake = false;
const gb = await run('/191.96.227.42', { ua: GOOG }), gd = gb.data || {};
ok(gd.vpnServer && gd.vpnServer.provider === 'Private Internet Access' && gd.source === 'ipinfo-lite' && !gd.privacy && !gb.taken.length &&
  !gb.kinds.some(k => k === 'core' || k === 'proxycheck') && unesc(dd(gb.body)) === ENTRY('Private Internet Access'),
  `Googlebot on /191.96.227.42 gets the listing, which is free, and still no budget: source ${gd.source}, budget counter ${JSON.stringify(gb.taken)}, ` +
  `requests ${JSON.stringify(gb.kinds)}; ${JSON.stringify(unesc(dd(gb.body)))}`);
mayTake = true;

const ck = await run('/api/check', { ua: CHROME, me: '149.22.83.100', ...TERMINAL }), cn = (ck.data || {}).network || {};
ok(ck.status === 200 && cn.vpnServer && cn.vpnServer.provider === 'IVPN' && cn.privacy === null && !ck.kinds.includes('proxycheck') && cn.source === 'ipinfo-core',
  `leaktest's check from a listed address (149.22.83.100): network.vpnServer ${JSON.stringify(cn.vpnServer)}, no proxycheck.io query (requests ${JSON.stringify(ck.kinds)})`);
const ck2 = await run('/api/check', { ua: CHROME, me: '81.2.69.142', ...TERMINAL }), cn2 = (ck2.data || {}).network || {};
ok(!('vpnServer' in cn2) && cn2.privacy && ck2.kinds.includes('proxycheck'), "... and from an unlisted one: no vpnServer, and proxycheck.io asked as before");

// A provider that lists exits: none of the real ones does, so a made-up one, refreshed into the same object.
extra = { id: 'examplevpn', name: 'ExampleVPN', url: 'https://vpnlist.test/servers.json', max: 100_000, min: 1, parse: text => JSON.parse(text).map(ip => [ip, 'exit']) };
L.VPN_PROVIDERS.push(extra);
serve = { ...full, examplevpn: JSON.stringify(['203.0.114.10', '2a0f:1234::10']) };
await vs.refresh(Date.now());
later(11 * 60_000);
const stale = await run('/203.0.114.10/json', { ua: CURL, accept: '*/*' });
ok(stale.data && !stale.data.vpnServer, "past its 10 minutes, a Worker's index still answers at once (without the newly refreshed provider) while the next one loads");
const ex = await run('/203.0.114.10/text', { ua: CURL, accept: '*/*' }), exj = await run('/2a0f:1234::10/json', { ua: CURL, accept: '*/*' });
ok(vpnLine(ex.body) === EXIT('ExampleVPN') && !ex.kinds.includes('proxycheck') && exj.data && exj.data.vpnServer && exj.data.vpnServer.role === 'exit' &&
  !exj.data.privacy && V.vpnText(exj.data) === EXIT('ExampleVPN'),
  `a listed exit: ${JSON.stringify(vpnLine(ex.body))}, and no proxycheck.io query (requests ${JSON.stringify(ex.kinds)})`);
ok(V.vpnText({ source: 'ipinfo-core', flags: { anonymous: true }, vpnServer: { provider: 'Mullvad', role: 'entry' } }) === 'yes: a known VPN, proxy or Tor address' &&
  V.vpnText({ source: 'ipinfo-core', flags: { anonymous: true }, vpnServer: { provider: 'ExampleVPN', role: 'exit' } }) === EXIT('ExampleVPN') &&
  V.vpnText({ source: 'ipinfo-lite', vpnServer: { provider: 'Mullvad', role: 'entry' } }) === ENTRY('Mullvad') &&
  V.vpnText({ source: 'ipinfo-lite' }).startsWith('not checked'),
  "the order: a listed exit first; IPinfo's or proxycheck.io's \"yes\" before an entry; a listing even where nothing else checked");
L.VPN_PROVIDERS.pop(); extra = null;
const gone = await run('/203.0.114.10/json', { ua: CURL, accept: '*/*' });
ok(gone.data && !gone.data.vpnServer, 'a provider taken out of VPN_PROVIDERS answers nothing at once, though the stored lists hold it until the next refresh');

const st = await run('/status?format=text', { ua: CURL, accept: '*/*', 'x-status-key': env.STATUS_KEY });
const sj = await run('/status', { ua: CURL, accept: '*/*', 'x-status-key': env.STATUS_KEY }), sv = (sj.data || {}).vpnServers || {};
ok(Array.isArray(sv.providers) && sv.providers.map(p => p.id).join() === 'mullvad,pia,ivpn,airvpn' && sv.providers.every(p => p.addresses > 0 && p.latestList > 0 && p.updated && !p.stale) &&
  /^ {2}mullvad +\d+ addresses \(\d+ on the latest list\), updated \d{4}-\d\d-\d\d \d\d:\d\d UTC$/m.test(st.body),
  `/status shows each list: ${sv.providers ? sv.providers.map(p => `${p.id} ${p.addresses}`).join(', ') : 'nothing'}; text ${JSON.stringify((/^ {2}mullvad.*$/m.exec(st.body) || [''])[0])}`);

// An object with no lists yet (a new deployment before its first download, or every list expired), seen by a Worker
// that has never had an index (a second copy of the module: a fresh isolate): it asks again a minute later, not on
// every lookup.
let blobCalls = 0;
env.VPN_SERVERS = { idFromName: n => n, get: () => ({ blob: async () => { blobCalls++; return null; }, relayBlob: async () => null }) };
const { default: fresh } = await import('../src/worker.js?fresh-isolate');
later(11 * 60_000);
await run('/46.1.2.4/json', { ua: CURL, accept: '*/*', worker: fresh }); await run('/46.1.2.5/json', { ua: CURL, accept: '*/*', worker: fresh });
const callsSoon = blobCalls;
later(61_000);
await run('/46.1.2.6/json', { ua: CURL, accept: '*/*', worker: fresh });
ok(callsSoon === 1 && blobCalls === 2, `with no lists in the object, two lookups within a minute ask it once, and the next minute once more: ${callsSoon}, then ${blobCalls}`);
// An object that never answers (its requester's context gone, say): each lookup waits VPN_WAIT at most, and after 30
// seconds the next lookup starts a new load instead of waiting on the dead one forever.
let hangs = 0;
env.VPN_SERVERS = { idFromName: n => n, get: () => ({ blob: () => { hangs++; return new Promise(() => {}); }, relayBlob: () => new Promise(() => {}) }) };
const { default: fresh2 } = await import('../src/worker.js?fresh-isolate-2');
const h0 = realNow(), h1 = await run('/46.1.2.7/json', { ua: CURL, accept: '*/*', worker: fresh2, settle: false }), waited = realNow() - h0;
await run('/46.1.2.8/json', { ua: CURL, accept: '*/*', worker: fresh2, settle: false });
const hangsSoon = hangs;
later(31_000);
await run('/46.1.2.9/json', { ua: CURL, accept: '*/*', worker: fresh2, settle: false });
ok(h1.status === 200 && waited >= 1400 && waited < 4000 && hangsSoon === 1 && hangs === 2,
  `an object that never answers: the lookup goes on after ${waited} ms, a second shares the same load (${hangsSoon} call), and 30 seconds on a new one starts (${hangs} calls)`);
env.VPN_SERVERS = binding;

delete env.VPN_SERVERS;
later(11 * 60_000);
const nob = await run(`/${MV}/json`, { ua: CURL, accept: '*/*' }), nos = await run('/status', { ua: CURL, accept: '*/*', 'x-status-key': env.STATUS_KEY });
ok(nob.data && !('vpnServer' in nob.data) && nob.data.privacy && /no VPN_SERVERS binding/.test(((nos.data || {}).vpnServers || {}).error || ''),
  'without the VPN_SERVERS binding (an older copy) lookups are as before and /status says so');
env.VPN_SERVERS = binding;

console.log('-- 4. leaktest in public/app.js: a listing is a VPN, so no sponsored line');
const leak = slice(app, '    const net = d.network || {}, f = net.flags || {}, pc = net.privacy || null;', '    const tunnel =');
const decide = Function('trace', 'd', 'pcKnown', 'otherInfo', leak + 'return { listed, relay, otherRelay, vpnKnown, anon, vpn, homeNet };');
const pcKnown = pc => !!(pc && pc.anonymous && (pc.vpn || pc.proxy || pc.tor || pc.operator));
const listedRun = decide(null, { countryCode: 'NL', network: { source: 'ipinfo-core', asType: 'isp', flags: {}, privacy: null, vpnServer: { provider: 'IVPN', role: 'entry' } } }, pcKnown);
const lite = decide(null, { network: { source: 'ipinfo-lite', flags: null, privacy: null, vpnServer: { provider: 'IVPN', role: 'entry' } } }, pcKnown);
const plainRun = decide(null, { countryCode: 'US', network: { source: 'ipinfo-core', asType: 'isp', flags: {}, privacy: null } }, pcKnown);
ok(listedRun.vpn && listedRun.anon && listedRun.vpnKnown && !listedRun.homeNet && lite.vpn && lite.vpnKnown && !plainRun.vpn && plainRun.homeNet,
  'a visitor whose address a provider lists is on a VPN (even an entry address on a home-ISP network, or with IPinfo Lite only); an unlisted home address is not');
ok(app.includes('    const offer = vpnKnown && !vpn && !vpnSeen;') && app.includes("    if (offer) await sponsor('check');"),
  'the sponsored line still needs a check that ran and found no VPN (offer = vpnKnown && !vpn && !vpnSeen), which a listing never is');
ok(app.includes("else if (listed) add('vpn', 'ok', 'VPN detection', `your IP is a known VPN server (on ${listed.provider}'s own server list): sites see that, not your provider`") &&
  app.includes("pc && pc.operator, listed && listed.provider, ...placeTerms(otherInfo)"),
  "leaktest's VPN line names the list, and its copied Markdown hides the provider's name with the visitor's other details");

const MD = Function(slice(app, '  const reEsc =', '  function markdown(') + 'return { termRe, mdTerms };')();
const hid = L.VPN_PROVIDERS.map(p => p.name).map(name => {
  const line = `your IP is a known VPN server (on ${name}'s own server list): sites see that, not your provider`;
  return MD.mdTerms(['Example ISP', name]).map(MD.termRe).reduce((t, re) => t.replace(re, '[hidden]'), line);
});
ok(hid.every(t => t === "your IP is a known VPN server (on [hidden]'s own server list): sites see that, not your provider"),
  `the copied Markdown's own masking (termRe, mdTerms in public/app.js) hides every provider's name in that line: ${JSON.stringify(hid[1])}`);

console.log("-- 6. iCloud Private Relay: Apple's own list of its relays' addresses (src/relay-list.js, refreshRelay in src/worker.js)");
const csv = read('tools/fixtures/vpn-lists/icloud-relay.csv');
const rr = A.parseRelay(csv);
ok(rr.count === 20 && rr.four.length === 4 && rr.six.length === 3,
  `the saved lines: 20 ranges read and 9 junk lines skipped (blank, a header, not an address, private, wider than a /8, documentation, narrower than a /64, a bad length, no length), merged into ${rr.four.length} IPv4 and ${rr.six.length} IPv6 ranges`);
const ri = A.unpackRelay(A.packRelay(rr, NOW)), rf = ip => !!A.findRelay(ri, ip, NOW);
const edges = [
  ['172.224.226.0', true, 'the first address of a /27'], ['172.224.226.45', true, 'the last address of the /31s adjacent to it'],
  ['172.224.226.46', false, 'the next address'], ['172.224.225.255', false, 'the address before the first'],
  ['172.225.7.16', true, 'a /32'], ['172.225.7.18', true, 'the last of three adjacent /32s'], ['172.225.7.15', false, 'just below them'], ['172.225.7.19', false, 'just above them'],
  ['172.225.76.255', true, 'the last address of two adjacent /24s'], ['172.225.77.0', false, 'the next /24'], ['172.225.74.255', false, 'the /24 before'],
  ['172.226.1.7', true, "the saved list's last line"],
  ['2606:54c0::', true, 'the first address of three adjacent IPv6 /45s'], ['2606:54c0:17:ffff:ffff:ffff:ffff:ffff', true, 'their last address'],
  ['2606:54c0:18::', false, 'the next /64'], ['2606:54bf:ffff:ffff:ffff:ffff:ffff:ffff', false, 'the address before the first'],
  ['2a02:26f7:b000:4000::', true, "an isolated /64's first address"], ['2A02:26F7:B000:4000:FFFF:FFFF:FFFF:FFFF', true, 'its last address, in capitals'],
  ['2a02:26f7:b000:4001::', false, 'the next /64'], ['2a02:26f7:b000:3fff:ffff:ffff:ffff:ffff', false, 'the address before'],
  ['2a02:26f7:ffff:ffff:1::', true, 'a /64 that ends a 32-bit word'], ['2a02:26f8::ffff', true, 'the adjacent /64 after the carry, merged with it'],
  ['2a02:26f8:0:1::', false, 'the /64 after that'],
  ['10.0.0.1', false, 'a private range on a junk line'], ['16.1.2.3', false, 'a range wider than a /8'], ['2a02:26f7:b000:5000::1', false, 'a /128 (narrower than a /64)'],
  ['8.8.8.8', false, 'an unrelated address'], ['not-an-ip', false, 'junk'],
];
const wrongEdges = edges.filter(([ip, want]) => rf(ip) !== want);
ok(!wrongEdges.length, `range edges in IPv4 and IPv6 (${edges.length} addresses): ` + (wrongEdges.length ? 'wrong: ' + wrongEdges.map(e => `${e[0]} (${e[2]})`).join(', ')
  : 'first and last addresses in, their neighbours out, adjacent ranges merged, also across a 32-bit word'));
ok(A.findRelay(ri, '172.224.226.0', NOW + L.VPN_MAX_AGE) && !A.findRelay(ri, '172.224.226.0', NOW + L.VPN_MAX_AGE + 1), 'a copy of the list 3 days old (VPN_MAX_AGE) is not used');
const crlf = A.parseRelay('172.226.1.0/24,US,US-CA,San Jose,' + String.fromCharCode(13, 10) + '2a02:26f7:c000::/48,US,,,' + String.fromCharCode(13, 10));
ok(crlf.count === 2 && crlf.four[0][1] === L.v4num('172.226.1.255') && crlf.six.length === 1, 'lines ending in CRLF read the same (a Windows copy of the list)');
const rs1 = A.unpackRelay(A.restampRelay(A.packRelay(rr, NOW), NOW + HOUR));
ok(rs1.at === new Date(NOW + HOUR).toISOString() && rs1.count === 20 && [...rs1.first6].join() === [...ri.first6].join() && [...rs1.last4].join() === [...ri.last4].join(),
  'restampRelay (after a 304) keeps every range and changes only the date');
// Read as a stream, a chunk at a time (as the refresh does): the same ranges, whatever the chunks split, a line or a
// multi-byte character; refused past its cap; and linear in the number of lines even with no commas at all.
const utf = csv + '\n172.227.0.0/24,BR,BR-SP,S' + String.fromCharCode(0xe3) + 'o Paulo,\n';   // a city name with a two-byte character
const bytes = new TextEncoder().encode(utf);
const chunked = size => new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); } });
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const whole = A.parseRelay(utf);
ok(same(await A.parseRelayStream(new Response(utf).body, 1e6), whole) && same(await A.parseRelayStream(chunked(3), 1e6), whole) &&
  same(await A.parseRelayStream(chunked(7), 1e6), whole) && whole.count === 21,
  'read as a stream, in chunks of 3 and 7 bytes (splitting lines and a multi-byte city name), the ranges come out the same');
let capped = '';
try { await A.parseRelayStream(chunked(64), 100); } catch (e) { capped = e.message; }
ok(capped === 'response too large', `a stream past its cap is refused: ${capped}`);
const bare = Array.from({ length: 100_000 }, (_, i) => `17.${100 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}/32`).join('\n');
const tb = realNow(), bareRec = A.parseRelay(bare), tookBare = realNow() - tb;
ok(bareRec.count === 100_000 && bareRec.four.length === 1 && tookBare < 3000, `100,000 lines with no comma parse in ${tookBare} ms (each line's comma is looked for in that line only)`);
const rgood = A.packRelay(rr, NOW), rbad = new Uint8Array(rgood.slice(0)); rbad[3] = 50;
let rrefused = 0;
for (const b of [rbad.buffer, rgood.slice(0, rgood.byteLength - 4), L.packIndex([], NOW)]) { try { A.unpackRelay(b); } catch { rrefused++; } }
ok(rrefused === 3 && A.isRelay(rgood) && !A.isRelay(L.packIndex([], NOW)), "a blob that isn't the relay format, is cut short, or is the VPN index is refused");

// The refresh. Apple's list made full-sized: the saved lines plus 12,000 /32s in a row (they merge into one range).
const bigRelay = n => csv + '\n' + Array.from({ length: n }, (_, i) => `17.100.${i >> 8}.${i & 255}/32,US,US-CA,Cupertino,`).join('\n');
const TR = Date.now();
serveRelay = () => new Response(bigRelay(12000), { status: 200, headers: { etag: '"e1"' } });
relayCalls.length = 0;
await vs.refresh(TR);
let rm = await vs.relayStatus();
ok(relayCalls.length === 1 && relayCalls[0] === null && rm.count === 12020 && rm.etag === '"e1"' && !rm.error && rm.n4 === 5 && rm.n6 === 3 &&
  A.findRelay(A.unpackRelay(await vs.relayBlob(TR)), '17.100.46.223', TR),
  `the first download asks with no If-None-Match and keeps ${rm.count} ranges (${rm.n4} IPv4 and ${rm.n6} IPv6 merged) and Apple's ETag`);
serveRelay = init => ((init.headers || {})['if-none-match'] === '"e1"' ? new Response(null, { status: 304 }) : new Response('unexpected', { status: 200 }));
await vs.refresh(TR + 6 * HOUR);
rm = await vs.relayStatus();
const r6 = A.unpackRelay(await vs.relayBlob(TR + 6 * HOUR));
ok(relayCalls[1] === '"e1"' && rm.unchanged && !rm.error && rm.at === new Date(TR + 6 * HOUR).toISOString() && r6.at === rm.at && A.findRelay(r6, '17.100.0.0', TR + 6 * HOUR),
  'the next asks with that ETag, and a 304 keeps the ranges, dated now');
serveRelay = () => new Response('busy', { status: 503 });
await vs.refresh(TR + 12 * HOUR);
rm = await vs.relayStatus();
ok(/HTTP 503/.test(rm.error) && rm.at === new Date(TR + 6 * HOUR).toISOString() && rm.count === 12020 && A.findRelay(A.unpackRelay(await vs.relayBlob(TR + 12 * HOUR)), '172.224.226.0', TR + 12 * HOUR),
  `a failed download keeps the last good copy and says why: ${rm.error}`);
serveRelay = () => new Response(csv, { status: 200, headers: { etag: '"e2"' } });
await vs.refresh(TR + 18 * HOUR);
rm = await vs.relayStatus();
ok(/only 20 ranges \(at least 10000 expected\)/.test(rm.error) && rm.etag === '"e1"' && rm.count === 12020 && relayCalls[3] === '"e1"',
  `a list far too short is refused and the last good copy kept: ${rm.error}`);
ok(!A.findRelay(A.unpackRelay(await vs.relayBlob(TR + 7 * HOUR + L.VPN_MAX_AGE)), '172.224.226.0', TR + 7 * HOUR + L.VPN_MAX_AGE),
  'with no good download or 304 for 3 days, lookups stop using it');
const oldRelay = new Uint8Array(16); oldRelay.set([65, 80, 82, 48]);              // "APR0": an older format
const keepRelay = await storage.get('relay');
await storage.put('relay', oldRelay.buffer); storage.alarm = null;
ok((await vs.relayBlob(TR + 30 * HOUR)) === null && storage.alarm === TR + 30 * HOUR + 1000, 'a stored copy in an older format counts as none: the lookup gets null and an alarm refreshes it');
await storage.put('relay', keepRelay); storage.alarm = null;

// Lookups
const RELAY_LINE = "yes: Apple's iCloud Private Relay (on Apple's own list of its relay addresses: sites see Apple's address, not the user's)";
later(11 * 60_000);
await run('/8.8.4.4/json', { ua: CURL, accept: '*/*' });                         // loads this Worker's copy
const rj = await run('/172.224.226.45/json', { ua: CURL, accept: '*/*' }), rjd = rj.data || {};
ok(JSON.stringify(rjd.relay) === JSON.stringify({ service: 'iCloud Private Relay', operator: 'Apple', listUpdated: new Date(TR + 6 * HOUR).toISOString() }) &&
  !rjd.privacy && !rj.kinds.includes('proxycheck') && !('vpnServer' in rjd),
  `curl /172.224.226.45/json (the last address of a merged range): relay ${JSON.stringify(rjd.relay)}, and no proxycheck.io query`);
const rn = await run('/172.224.226.46/json', { ua: CURL, accept: '*/*' });
ok(rn.data && !('relay' in rn.data) && rn.kinds.includes('proxycheck'), 'the next address (172.224.226.46) has no relay field, and proxycheck.io is asked as before');
const rt6 = await run('/2a02:26f7:b000:4000:ffff:ffff:ffff:ffff/text', { ua: CURL, accept: '*/*' }), rt4 = await run('/172.225.7.18/text', { ua: CURL, accept: '*/*' });
ok(vpnLine(rt6.body) === RELAY_LINE && vpnLine(rt4.body) === RELAY_LINE && /^source +IPinfo Core \+ Apple's iCloud Private Relay list$/m.test(rt6.body),
  `the text answer, IPv6 (the last address of a /64) and IPv4: ${JSON.stringify(vpnLine(rt6.body))}, and the source line names Apple's list`);
const rp6 = await run('/2606:54c0:17:ffff:ffff:ffff:ffff:ffff', { ua: CHROME, ...NAV }), rp6n = await run('/2606:54c0:18::', { ua: CHROME, ...NAV });
const rp4 = await run('/172.225.76.255', { ua: CHROME, ...NAV });
ok(unesc(dd(rp6.body)) === RELAY_LINE && unesc(dd(rp4.body)) === RELAY_LINE && unesc(dd(rp6n.body)) !== RELAY_LINE,
  "the IP page at a range's last address, IPv6 and IPv4, and not at the next IPv6 /64");
const ra4 = await run('/api/lookup?ip=172.225.7.16', { ua: CHROME, ...TERMINAL }), ra6 = await run('/api/lookup?ip=2606:54c0::', { ua: CHROME, ...TERMINAL });
ok(V.vpnText(ra4.data || {}) === RELAY_LINE && V.vpnText(ra6.data || {}) === RELAY_LINE, "the terminal's lookup (vpnText in public/app.js) says the same, IPv4 and IPv6");
const rlite = await run('/api/lookup?ip=172.225.7.17&block=0&lite=1', { ua: CHROME, ...TERMINAL }), rld = rlite.data || {};
ok(rld.relay && rld.source === 'ipinfo-lite' && !rld.privacy && !rlite.kinds.some(k => k === 'core' || k === 'proxycheck'),
  "?lite=1 (leaktest's lookup of the other IP version) carries the free listing, and still spends no budget");
mayTake = false;
const rg = await run('/172.225.75.9', { ua: GOOG }), rgd = rg.data || {};
ok(rgd.relay && rgd.source === 'ipinfo-lite' && !rg.taken.length && unesc(dd(rg.body)) === RELAY_LINE, 'Googlebot gets the listing, which is free, and no budget');
mayTake = true;
const rc = await run('/api/check', { ua: CHROME, me: '172.224.226.0', ...TERMINAL }), rcn = (rc.data || {}).network || {};
ok(rcn.relay && rcn.relay.service === 'iCloud Private Relay' && rcn.privacy === null && !rc.kinds.includes('proxycheck'),
  `leaktest's check from a relay address: network.relay ${JSON.stringify(rcn.relay)}, no proxycheck.io query`);
const rsj = await run('/status', { ua: CURL, accept: '*/*', 'x-status-key': env.STATUS_KEY }), rst = await run('/status?format=text', { ua: CURL, accept: '*/*', 'x-status-key': env.STATUS_KEY });
const pr = (rsj.data || {}).privateRelay || {};
ok(pr.ranges === 12020 && pr.ipv4 === 5 && pr.ipv6 === 3 && pr.updated && !pr.stale && /^icloud relay +12020 ranges \(5 IPv4 and 3 IPv6 merged\), updated .*; last try .* failed: only 20 ranges/m.test(rst.body),
  `/status shows Apple's list: ${JSON.stringify((/^icloud relay.*$/m.exec(rst.body) || [''])[0])}`);

// leaktest (public/app.js): a relay, named, graded as a tunnel the way WARP and Tor are, and never followed by the sponsored line
const relayNet = { source: 'ipinfo-core', asn: 'AS36183', asType: 'hosting', flags: { hosting: true }, privacy: null, relay: { service: 'iCloud Private Relay' } };
const rv = decide(null, { network: relayNet }, pcKnown, { asn: 'AS13335', relay: { service: 'iCloud Private Relay' } });
const rv2 = decide(null, { network: relayNet }, pcKnown, { asn: 'AS7922' });
ok(rv.relay && rv.vpn && rv.anon && rv.vpnKnown && rv.otherRelay && rv2.vpn && !rv2.otherRelay,
  "a visitor on Apple's list is on a relay (vpn and vpnKnown true, so no sponsored line); their other IP version counts as relayed only when Apple lists it too");
ok(app.includes("else if (relay) add('vpn', 'ok', 'VPN detection', \"you're on Apple's iCloud Private Relay (your IP is on Apple's own list of its relay addresses): sites see Apple's address, not yours. It covers Safari, not your other apps\"") &&
  app.includes("relay ? 'relay on' : vpn ? 'vpn on'") && app.includes("(g.kind === 'other' && !tor && !relay)") && app.includes("else if (otherRelay) add('ipv6', 'ok', otherV") &&
  app.includes("const offer = vpnKnown && !vpn && !vpnSeen;"),
  "leaktest names it (tag \"relay on\"), lets the relay pick the DNS resolver as a Tor exit does, accepts the other IP version through the relay, and the sponsored line's rule is unchanged");

// Each list's alarm refreshes that list only: a missing relay list doesn't send the VPN lists' requests again.
await storage.delete(['want:vpn', 'want:relay']);
await storage.put('relay', oldRelay.buffer); await storage.put('relayTried', TR - 2 * HOUR);
await vs.relayBlob(TR);
calls.length = 0; relayCalls.length = 0;
serveRelay = () => new Response(bigRelay(12000), { status: 200, headers: { etag: '"e3"' } });
await vs.alarm();
ok(relayCalls.length === 1 && lists0().length === 0 && (await vs.relayStatus()).etag === '"e3"' && A.isRelay(await storage.get('relay')),
  `a lookup that finds the relay list missing sets an alarm that downloads Apple's list only: ${relayCalls.length} request to Apple, ${lists0().length} to the VPN providers`);
const keepBlob = await storage.get('blob');
await storage.delete('blob'); await storage.put('tried', TR - 2 * HOUR); storage.alarm = null;
await vs.blob(TR);
calls.length = 0; relayCalls.length = 0; serve = { ...full };
await vs.alarm();
ok(relayCalls.length === 0 && lists0().length === 4 && (await storage.get('blob')) instanceof ArrayBuffer,
  `and one that finds the VPN index missing downloads the VPN lists only: ${lists0().length} requests, ${relayCalls.length} to Apple`);
if (keepBlob) await storage.put('blob', keepBlob);
storage.alarm = null;

console.log('-- 7. the docs');
const hb = read('docs/handbook.md'), readme = read('README.md'), llms = read('public/llms.txt'), api = JSON.parse(read('public/openapi.json'));
const worker = read('src/worker.js'), toml = read('wrangler.toml');
ok(hb.includes('Known VPN servers') && hb.includes('tools/check_vpnlists.mjs') && ['Mullvad', 'Private Internet Access', 'IVPN', 'AirVPN', 'NordVPN', 'Proton', 'Surfshark'].every(n => hb.includes(n)),
  'docs/handbook.md describes the lists, who is in and who is out, and this check');
ok(/Mullvad/.test(readme) && /vpnServer/.test(llms) && JSON.stringify(api).includes('vpnServer') && worker.includes("VPN providers' own server lists"),
  'README.md, public/llms.txt, public/openapi.json (vpnServer) and the Worker\'s notes mention it');
ok(/\[triggers\]\s*\ncrons = \["17 \*\/6 \* \* \*"\]/.test(toml) && /class_name = "VpnServers"/.test(toml) && /new_sqlite_classes = \["VpnServers"\]/.test(toml),
  'wrangler.toml binds VpnServers, adds its migration and the 6-hourly cron');
ok(hb.includes("### iCloud Private Relay: Apple's own list") && /Residential proxy networks/.test(hb) && /iCloud Private Relay/.test(readme) && /`relay`/.test(llms) &&
  api.components.schemas && JSON.stringify(api).includes('"relay"') && read('public/privacy.html').includes('iCloud Private Relay'),
  'the handbook (iCloud Private Relay, and what no list covers: residential and commercial proxy networks), README, llms.txt, openapi.json (relay) and the privacy page describe Private Relay');
const helpBody = (await run('/help', { ua: CURL, accept: '*/*' })).body;
ok(/own server lists/.test(helpBody) && /iCloud Private Relay/.test(helpBody), "/help mentions the providers' own server lists and iCloud Private Relay");

Date.now = realNow;
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
