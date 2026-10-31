// Checks whois's second way to ARIN's records: when rdap.arin.net fails a whois of an address or AS number, RIPEstat's
// copy of ARIN's record (arinRelay(), relayAbuse() and whoisLookup() in src/worker.js). No server and no network: the
// whole Worker runs in Node with fetch stubbed, ARIN's server answering 525 (Cloudflare's failed TLS handshake) and
// RIPEstat answering from records shaped like its real ones (October 2026), cut down to what whois reads.
//
// 1. The record, as RDAP's: the smallest network around the address, which is a customer's (Comcast's POMPANO-4, its
//    provider's abuse contact with it), or of two the same size the one reassigned (Linode inside Akamai's block, with
//    Linode's own abuse contact, the one the network names too), in either order; its holder unescaped ("AT&amp;T" is
//    AT&T); several CIDRs in address order; an answer of about 600 KB (a root server's runs past 500 KB); an IPv6
//    address asked as its /64 (RIPEstat has no match for a bare one), its CIDR as ARIN writes it; an AS number's range,
//    handle and holder; and early-registration space, where ARIN's "Various Registries" network and its "No, Contact
//    Known" placeholder must not hide the holder's own contact. Each with source 'ripestat', registryError (ARIN's
//    failure) and the RDAP link, in JSON, as text, on the page and for the terminal, and kept an hour, not a day.
//    abuse-contact-finder is asked beside it but waited for only when the records leave the contact open: two holders,
//    neither named by the network, take the one whose email it lists (not just its first), or none when it fails, and
//    that record is kept ten minutes.
// 2. When ARIN's failure stands, as before: RIPEstat answers for another registry (a block ARIN passed on to RIPE NCC),
//    has no match, or takes past the deadline; a bot (isBot) asks only RDAP; APNIC failing asks no one else; a lookup's
//    registry date never asks RIPEstat; and a silent ARIN, at the deadline, leaves no time for it. But once ARIN is
//    left alone for a minute after that silence, a whois goes to RIPEstat at once, "rdap.arin.net didn't answer", and
//    the slow record beside the silence didn't make RIPEstat be left alone. Then RIPEstat failing (503, twice) is left
//    alone for a minute: the next whois reports ARIN's failure at once, without asking it.
// 3. In the code: a lookup's registry date (blockAsk) asks RDAP only, and the terminal words the source line as the
//    Worker does.
//
//   node tools/check_relay.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const worker = read('src/worker.js'), app = read('public/app.js'), INDEX = read('public/index.html');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_relay.mjs`);
  return src.slice(a, b);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_relay.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const store = new Map();                                 // caches.default, as one data center's
globalThis.caches = { default: {
  async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); },
} };

const calls = [];
const asked = prefix => calls.filter(u => u.startsWith(prefix)).length;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const never = init => new Promise((_, no) => {
  const s = init && init.signal;
  if (!s) return;
  if (s.aborted) no(s.reason); else s.addEventListener('abort', () => no(s.reason), { once: true });
});

// RIPEstat's whois records: each a list of { key, value }, as its data call sends them (sorted by kind, values
// HTML-escaped). ARIN's own network over each block, and its hostmaster contact, as RIPEstat gives them.
const R = o => Object.entries(o).map(([key, value]) => ({ key, value, details_link: null }));
const ARIN_NET = (range, cidr, name, handle) => R({ NetRange: range, CIDR: cidr, NetName: name, NetHandle: handle, Parent: '()',
  NetType: 'Allocated to ARIN', OriginAS: '', Organization: 'American Registry for Internet Numbers (ARIN)', RegDate: '2005-04-19', source: 'ARIN' });
const ARIN_ABUSE = R({ OrgAbuseHandle: 'ARIN-HOSTMASTER', OrgAbuseName: 'Registration Services Department', OrgAbusePhone: '+1-703-227-0660', OrgAbuseEmail: 'hostmaster@arin.net', source: 'ARIN' });
const ARIN_ORG = R({ OrgName: 'American Registry for Internet Numbers', OrgId: 'ARIN', Country: 'US', source: 'ARIN' });
const abuseRec = (handle, email, phone, p = 'OrgAbuse') => R({ [p + 'Handle']: handle, [p + 'Name']: 'Abuse', [p + 'Phone']: phone, [p + 'Email']: email, source: 'ARIN' });
const orgRec = (name, id) => R({ OrgName: name, OrgId: id, Country: 'US', source: 'ARIN' });
const net = (range, cidr, name, handle, parent, type, holder, reg, cust = false) => R({ NetRange: range, CIDR: cidr, NetName: name, NetHandle: handle,
  Parent: parent, NetType: type, OriginAS: '', [cust ? 'Customer' : 'Organization']: holder, RegDate: reg, source: 'ARIN' });

const COMCAST = [  // 73.1.2.3/32: a customer's reassignment inside Comcast's allocation
  R({ CustName: 'Comcast IP Services, L.L.C.', City: 'Mt Laurel', Country: 'US', RegDate: '2014-08-20', source: 'ARIN' }),
  net('73.0.0.0 - 73.1.255.255', '73.0.0.0/15', 'POMPANO-4', 'NET-73-0-0-0-2', 'CABLE-1 (NET-73-0-0-0-1)', 'Reassigned', 'Comcast IP Services, L.L.C. (C05249387)', '2014-08-21', true),
  net('73.0.0.0 - 73.255.255.255', '73.0.0.0/8', 'CABLE-1', 'NET-73-0-0-0-1', 'NET73 (NET-73-0-0-0-0)', 'Direct Allocation', 'Comcast Cable Communications, LLC (CCCS)', '2005-04-19'),
  ARIN_NET('73.0.0.0 - 73.255.255.255', '73.0.0.0/8', 'NET73', 'NET-73-0-0-0-0'),
  ARIN_ABUSE, abuseRec('NAPO-ARIN', 'abuse@comcast.net', '+1-888-565-4329'), abuseRec('NAPO-ARIN', 'abuse@comcast.net', '+1-888-565-4329'),
  ARIN_ORG, orgRec('Comcast Cable Communications, LLC', 'CCCS'),
];
const LINODE = [   // 45.33.1.1/32: Akamai's allocation reassigned whole to Linode
  ARIN_NET('45.0.0.0 - 45.255.255.255', '45.0.0.0/8', 'NET45', 'NET-45-0-0-0-0'),
  net('45.33.0.0 - 45.33.127.255', '45.33.0.0/17', 'LINODE', 'NET-45-33-0-0-2', 'LINODE-US (NET-45-33-0-0-1)', 'Reassigned', 'Linode (LINOD)', '2022-12-21'),
  net('45.33.0.0 - 45.33.127.255', '45.33.0.0/17', 'LINODE-US', 'NET-45-33-0-0-1', 'NET45 (NET-45-0-0-0-0)', 'Direct Allocation', 'Akamai Technologies, Inc. (AKAMAI)', '2015-03-20'),
  ARIN_ABUSE, abuseRec('LAS12-ARIN', 'abuse@linode.com', '+1-609-380-7100'), abuseRec('NUS-ARIN', 'abuse@akamai.com', '+1-617-444-2535'),
  orgRec('Akamai Technologies, Inc.', 'AKAMAI'), ARIN_ORG, orgRec('Linode', 'LINOD'),
  abuseRec('LAS12-ARIN', 'abuse@linode.com', '+1-609-380-7100', 'RAbuse'),
];
const ATT = [      // 12.0.0.1/32: a customer's name with an ampersand, escaped as RIPEstat sends it
  net('12.0.0.0 - 12.0.3.255', '12.0.0.0/22', 'ATT-NET-12-0-0-0-22', 'NET-12-0-0-0-2', 'ATT (NET-12-0-0-0-1)', 'Reassigned', 'AT&amp;T CBB TIER-3 LAB (C11309735)', '2025-08-07', true),
  net('12.0.0.0 - 12.255.255.255', '12.0.0.0/8', 'ATT', 'NET-12-0-0-0-1', 'NET12 (NET-12-0-0-0-0)', 'Direct Allocation', 'AT&amp;T Enterprises, LLC (AEL-360)', '1983-08-23'),
  ARIN_NET('12.0.0.0 - 12.255.255.255', '12.0.0.0/8', 'NET12', 'NET-12-0-0-0-0'),
  abuseRec('ABUSE7-ARIN', 'abuse@att.net', '+1-919-319-8167'), ARIN_ABUSE, orgRec('AT&amp;T Enterprises, LLC', 'AEL-360'), ARIN_ORG,
];
const AMAZON = [   // 52.95.110.1/32: one network of two CIDRs, out of address order
  net('52.84.0.0 - 52.95.255.255', '52.88.0.0/13, 52.84.0.0/14', 'AT-88-Z', 'NET-52-84-0-0-1', 'NET52 (NET-52-0-0-0-0)', 'Direct Allocation', 'Amazon Technologies Inc. (AT-88-Z)', '2015-09-02'),
  ARIN_NET('52.0.0.0 - 52.255.255.255', '52.0.0.0/8', 'NET52', 'NET-52-0-0-0-0'),
  abuseRec('AEA8-ARIN', 'trustandsafety@support.aws.com', '+1-206-555-0000'), ARIN_ABUSE, orgRec('Amazon Technologies Inc.', 'AT-88-Z'), ARIN_ORG,
];
const AWS6 = [     // 2600:1f18:0:0::/64: IPv6, ARIN writing its addresses in capitals
  net('2600:1F00:: - 2600:1FFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', '2600:1F00::/24', 'AMZ-EC2', 'NET6-2600-1F00-1', 'NET6-2600 (NET6-2600-0)', 'Direct Allocation', 'Amazon.com, Inc. (AMAZO-4)', '2014-10-17'),
  ARIN_NET('2600:: - 260F:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', '2600::/12', 'NET6-2600', 'NET6-2600-0'),
  abuseRec('AEA8-ARIN', 'trustandsafety@support.aws.com', '+1-206-555-0000'), ARIN_ABUSE, orgRec('Amazon.com, Inc.', 'AMAZO-4'), ARIN_ORG,
];
const UUNET = [    // AS701: a range of AS numbers, a holder with more than one abuse contact
  R({ ASNumber: '701 - 705', ASName: 'UUNET', ASHandle: '701', RegDate: '1990-08-03', source: 'ARIN' }),
  abuseRec('ABUSE3-ARIN', 'abuse-mail@verizonbusiness.com', '+1-800-900-0241'), abuseRec('ABUSE5603-ARIN', 'abuse@verizon.com', '+1-800-900-0241'),
  orgRec('Verizon Business', 'MCICS'),
];
const TWO = [      // 99.x/32: two holders, the network naming neither's contact: abuse-contact-finder decides
  net('99.1.0.0 - 99.1.255.255', '99.1.0.0/16', 'EX-HOSTING', 'NET-99-1-0-0-1', 'EX-TRANSIT (NET-99-0-0-0-1)', 'Reallocated', 'Example Hosting &#38; Co (EXH)', '2024-02-01'),
  net('99.0.0.0 - 99.255.255.255', '99.0.0.0/8', 'EX-TRANSIT', 'NET-99-0-0-0-1', 'NET99 (NET-99-0-0-0-0)', 'Direct Allocation', 'Example Transit (EXT)', '2001-01-01'),
  abuseRec('EXH-ABUSE-ARIN', 'abuse@hosting.example', '+1-555-0100'), abuseRec('EXT-ABUSE-ARIN', 'abuse@transit.example', '+1-555-0101'),
  orgRec('Example Hosting & Co', 'EXH'), orgRec('Example Transit', 'EXT'),
];
const LEGACY = [   // 192.3.50.1/32: early-registration space, where ARIN's "Various Registries" network and its
  // placeholder contact come with every answer; the holder's own contact, and another the network names
  net('192.0.0.0 - 192.255.255.255', '192.0.0.0/8', 'NET192', 'NET-192-0-0-0-0', '()', 'Early Registrations, Maintained by ARIN', 'Various Registries (Maintained by ARIN) (VR-ARIN)', '1993-05-01'),
  net('192.3.0.0 - 192.3.255.255', '192.3.0.0/16', 'HOSTPAPA-NET', 'NET-192-3-0-0-1', 'NET192 (NET-192-0-0-0-0)', 'Direct Allocation', 'HostPapa (HOSTP-7)', '2012-03-01'),
  abuseRec('CKN23-ARIN', 'nobody@example.com', '+1-800-555-1234'), abuseRec('NETAB23-ARIN', 'net-abuse-global@hostpapa.com', '+1-888-959-7272'),
  orgRec('HostPapa', 'HOSTP-7'), orgRec('Various Registries (Maintained by ARIN)', 'VR-ARIN'),
  abuseRec('NETAB27-ARIN', 'abuse@colocrossing.com', '+1-800-518-9716', 'RAbuse'),
];
// 192.3.60.1/32: the same, the holder with two abuse contacts, neither the network's: with one holder, its first
const LEGACY2 = [...LEGACY.slice(0, 3), abuseRec('NETAB23-ARIN', 'net-abuse-global@hostpapa.com', '+1-888-959-7272'),
  abuseRec('NETAB24-ARIN', 'abuse-desk@hostpapa.com', '+1-888-959-7272'), ...LEGACY.slice(4)];
const LINODE_REV = [LINODE[0], LINODE[2], LINODE[1], ...LINODE.slice(3)];   // the parent listed before the network reassigned from it
const WHOIS = [    // [resource it answers, records, authorities]
  [/^73\.[01]\.\d+\.\d+\/32$/, COMCAST], [/^45\.33\.1\.1\/32$/, LINODE], [/^45\.33\.2\.2\/32$/, LINODE_REV], [/^12\.0\.0\.1\/32$/, ATT],
  [/^52\.95\.110\.[123]\/32$/, AMAZON], [/^2600:1f18:0:0::\/64$/, AWS6], [/^AS701$/, UUNET], [/^99\.1\.\d+\.\d+\/32$/, TWO], [/^192\.3\.50\.\d+\/32$/, LEGACY], [/^192\.3\.60\.1\/32$/, LEGACY2],
  [/^45\.142\.26\.2\/32$/, [R({ inetnum: '45.142.26.0/24', netname: 'EXAMPLE-RIPE', country: 'AL', 'abuse-c': 'EX1-RIPE', source: 'RIPE' })], ['ripe']],
];
// abuse-contact-finder, [delay, contacts or a failure]: it lists every email of the contacts, in alphabetical order
const FINDER = { '99.1.2.3': [100, ['abuse-desk@another.example', 'abuse@hosting.example']], '99.1.5.6': [100, null],
  '192.3.50.1': [100, ['abuse@colocrossing.com', 'net-abuse-global@hostpapa.com']], '192.3.50.2': [100, null], '192.3.60.1': [100, null] };
// A root server's answer runs past 500 KB with its route objects (irr_records): 52.95.110.2's is padded to about 900 KB,
// inside ripestat()'s 1 MB, and 52.95.110.3's to about 1.5 MB, past it
const ROUTES = n => Array.from({ length: n }, (_, i) => [{ key: 'route', value: `52.${i % 256}.0.0/16`, details_link: null },
  { key: 'origin', value: 'AS16509', details_link: null }, { key: 'descr', value: 'padding to make the answer large, as real route objects do', details_link: null }]);
const PADDED = { '52.95.110.2/32': ROUTES(4000), '52.95.110.3/32': ROUTES(7000) };
const noMatch = res => reply({ data: { authorities: ['arin'], records: [R({ ['No match found for + ! ' + res]: '' })], resource: res } });

async function serve(u, init) {
  let m;
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    const arin = ['https://rdap.arin.net/registry/'];
    return reply({ services: {
      ipv4: [[['73.0.0.0/8', '45.0.0.0/8', '12.0.0.0/8', '52.0.0.0/8', '63.0.0.0/8', '96.0.0.0/8', '97.0.0.0/8', '98.0.0.0/8', '99.0.0.0/8', '192.0.0.0/8'], arin],
        [['1.0.0.0/8'], ['https://rdap.apnic.net/']]],
      ipv6: [[['2600::/12'], arin]], asn: [[['701-705'], arin]], dns: [],
    }[m[1]] });
  }
  if ((m = /^https:\/\/rdap\.arin\.net\/registry\/(?:ip|autnum)\/(.+)$/.exec(u))) {
    if (m[1].startsWith('63.')) return never(init);                // silent
    if (m[1] === '96.1.1.1') return reply({ objectClassName: 'ip network', handle: 'NET-96-TEST', name: 'TEST-NET', startAddress: '96.1.1.0', endAddress: '96.1.1.255',
      cidr0_cidrs: [{ v4prefix: '96.1.1.0', length: 24 }], events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00Z' }], entities: [] });
    return new Response('error code: 525', { status: 525 });
  }
  if (u.startsWith('https://rdap.apnic.net/')) return reply({ errorCode: 429 }, 429);
  if ((m = /^https:\/\/stat\.ripe\.net\/data\/whois\/data\.json\?resource=([^&]+)/.exec(u))) {
    const res = decodeURIComponent(m[1]);
    if (res.startsWith('97.')) return reply({ messages: [['error', 'busy']] }, 503);
    if (res === '99.9.9.9/32') return never(init);                 // a record RIPEstat hasn't read lately: past the deadline
    const hit = WHOIS.find(([re]) => re.test(res));
    return hit ? reply({ data: { records: hit[1], irr_records: PADDED[res] || [], authorities: hit[2] || ['arin'], resource: res } }) : noMatch(res);
  }
  // A lookup of an address (/api/lookup), for its registry date: IPinfo's free API, proxycheck.io and reverse DNS
  if ((m = /^https:\/\/ipinfo\.io\/([^/?]+)\/json$/.exec(u))) return reply({ ip: m[1], city: 'Coral Springs', region: 'Florida', country: 'US', org: 'AS7922 Comcast Cable Communications, LLC' });
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u))) return reply({ status: 'ok', [m[1]]: { detections: { proxy: false, vpn: false, tor: false, hosting: false, anonymous: false } } });
  if (u.startsWith('https://cloudflare-dns.com/')) return reply({ Status: 3, Answer: [] });
  if ((m = /^https:\/\/stat\.ripe\.net\/data\/abuse-contact-finder\/data\.json\?resource=([^&]+)/.exec(u))) {
    const [delay, contacts] = FINDER[decodeURIComponent(m[1])] || [2500, []];
    await sleep(delay);
    return contacts ? reply({ data: { abuse_contacts: contacts, authoritative_rir: 'arin' } }) : reply({}, 503);
  }
  return new Response('not stubbed in tools/check_relay.mjs', { status: 404 });
}
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : input.url;
  calls.push(u);
  return Object.defineProperty(await serve(u, init), 'url', { value: u });
};
const keepAlive = setInterval(() => {}, 1000);

const env = { ASSETS: { fetch: async () => new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } };
const { default: W } = await import('../src/worker.js');
const CURL = 'curl/8.7.1';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const API = { ua: CHROME, accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };
async function run(path, { ua = CURL, ...headers } = {}) {
  const t0 = Date.now(), waits = [];
  const res = await Promise.race([
    W.fetch(new Request('https://ipterm.net' + path, { headers: { 'user-agent': ua, 'cf-connecting-ip': '81.2.69.142', ...headers } }), env,
      { waitUntil: p => waits.push(p) }),
    sleep(12000).then(() => null),
  ]);
  if (!res) return { status: 0, ms: Date.now() - t0, body: '', data: {} };
  const body = await res.text(), ms = Date.now() - t0;
  await Promise.allSettled(waits);
  const init = /<script type="application\/json" id="ipterm-initial">([\s\S]*?)<\/script>/.exec(body);
  let data = {}, initial = null;
  try { initial = init ? JSON.parse(init[1]) : null; data = initial ? initial.data || {} : JSON.parse(body); } catch {}
  return { status: res.status, ms, body, data, initial };
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const article = body => (/<article class="static" id="static">[\s\S]*?<\/article>/.exec(body) || [''])[0];
const J = x => JSON.stringify(x);
const viaRipe = (res, n = 1) => asked('https://stat.ripe.net/data/whois/data.json?resource=' + encodeURIComponent(res)) === n;

const ARIN525 = "ARIN's whois server (rdap.arin.net) failed to answer (HTTP 525). That's on their side; try again in a moment.";
const ARIN_SILENT = "ARIN's whois server (rdap.arin.net) didn't answer. That's on their side; try again later.";
const APNIC429 = "APNIC's whois server (rdap.apnic.net) failed to answer (HTTP 429). That's on their side; try again in a moment.";
const E525 = 'rdap.arin.net failed to answer: HTTP 525';
const SOURCE = `ARIN's whois data, relayed by RIPEstat (${E525})`;

console.log("-- ARIN's record through RIPEstat, as RDAP gives it (arinRelay, relayAbuse, whoisLookup)");
const [comcast, linode, linodeRev, att, amazon, big, aws6, uunet, two, twoNoFinder, legacy, legacyNoFinder, legacy2, plainRdap, bot, ripeBlock, noCopy, apnic, lookup] = await Promise.all([
  run('/api/whois?q=73.1.2.3', API),
  run('/api/whois?q=45.33.1.1', API),
  run('/api/whois?q=45.33.2.2', API),
  run('/whois/12.0.0.1?format=json'),
  run('/api/whois?q=52.95.110.1', API),
  run('/api/whois?q=52.95.110.2', API),
  run('/api/whois?q=2600:1f18::1', API),
  run('/api/whois?q=AS701', API),
  run('/api/whois?q=99.1.2.3', API),
  run('/api/whois?q=99.1.5.6', API),
  run('/api/whois?q=192.3.50.1', API),
  run('/api/whois?q=192.3.50.2', API),
  run('/api/whois?q=192.3.60.1', API),
  run('/api/whois?q=96.1.1.1', API),
  run('/whois/73.1.9.9', { ua: GOOGLEBOT }),
  run('/api/whois?q=45.142.26.2', API),
  run('/api/whois?q=98.1.1.1', API),
  run('/api/whois?q=1.2.3.4', API),
  run('/api/lookup?ip=73.9.9.9', API),
]);
const c = comcast.data;
ok(comcast.status === 200 && c.found === true && c.source === 'ripestat' && c.registryError === E525 && c.registry === 'ARIN',
  `whois 73.1.2.3, ARIN answering 525: ${comcast.status}, source ${c.source}, registryError ${J(c.registryError)}, registry ${c.registry}`);
ok(c.name === 'POMPANO-4' && c.handle === 'NET-73-0-0-0-2' && c.type === 'ASSIGNMENT' && c.org === 'Comcast IP Services, L.L.C.' &&
  J(c.range) === J({ start: '73.0.0.0', end: '73.1.255.255' }) && J(c.cidrs) === J(['73.0.0.0/15']) && c.registered === '2014-08-21',
  `... the customer's network, the smallest around it, as RDAP gives it: ${c.name} ${c.handle} ${c.type}, ${J(c.org)}, ${J(c.cidrs)}, registered ${c.registered}`);
ok(J(c.abuse) === J({ email: 'abuse@comcast.net', phone: '+1-888-565-4329', handle: 'NAPO-ARIN' }),
  `... with its provider's abuse contact, the only one besides ARIN's own (as RDAP gives it): ${J(c.abuse)}`);
ok(c.country === null && c.description === null && c.updated === null && c.asnRange === null && c.rdapUrl === 'https://rdap.arin.net/registry/ip/73.1.2.3' && !('_ttl' in c),
  `... no country or description (none in ARIN's RDAP either), no last-changed date (RIPEstat leaves it out), the RDAP link ${c.rdapUrl}`);
ok(viaRipe('73.1.2.3/32') && !asked('https://stat.ripe.net/data/whois/data.json?resource=73.1.2.3&') && asked('https://rdap.arin.net/registry/ip/73.1.2.3') === 2,
  "... after ARIN's two tries, one RIPEstat whois request, for the address's /32 (which gives the networks around it)");
ok(asked('https://stat.ripe.net/data/abuse-contact-finder/data.json?resource=73.1.2.3') === 1 && comcast.ms < 1800,
  `... abuse-contact-finder asked beside it but not waited for (it takes 2.5 s here): the answer came after ${comcast.ms} ms`);
const entry = [...store].find(([k]) => k.includes('whois/73.1.2.3'));
ok(entry && entry[1].headers['cache-control'] === 'public, max-age=3600' && J(JSON.parse(entry[1].body)) === J(c),
  `... kept an hour, not a day, so RDAP's fuller record comes back soon: ${entry ? entry[1].headers['cache-control'] : 'not cached'}`);

const l = linode.data;
ok(linode.status === 200 && l.name === 'LINODE' && l.handle === 'NET-45-33-0-0-2' && l.org === 'Linode' && l.type === 'ASSIGNMENT' &&
  J(l.abuse) === J({ email: 'abuse@linode.com', phone: '+1-609-380-7100', handle: 'LAS12-ARIN' }),
  `whois 45.33.1.1 (Akamai's block reassigned whole to Linode): the one reassigned, ${l.name} ${J(l.org)}, and Linode's abuse contact, which the network names too: ${J(l.abuse)}`);
ok(linodeRev.status === 200 && linodeRev.data.name === 'LINODE' && linodeRev.data.handle === 'NET-45-33-0-0-2' && linodeRev.data.org === 'Linode' && linodeRev.data.type === 'ASSIGNMENT',
  `... and the same with Akamai's network listed first: ${linodeRev.data.name} ${linodeRev.data.handle} (the tie is broken by the parent link, not the order)`);
ok(att.status === 200 && att.data.org === 'AT&T CBB TIER-3 LAB' && att.data.name === 'ATT-NET-12-0-0-0-22' && att.data.abuse.email === 'abuse@att.net',
  `whois 12.0.0.1: the holder unescaped ("AT&amp;T" from RIPEstat): ${J(att.data.org)}`);
ok(amazon.status === 200 && J(amazon.data.cidrs) === J(['52.84.0.0/14', '52.88.0.0/13']) && J(amazon.data.range) === J({ start: '52.84.0.0', end: '52.95.255.255' }),
  `whois 52.95.110.1: two CIDRs in address order, as RDAP lists them: ${J(amazon.data.cidrs)}`);
ok(big.status === 200 && big.data.source === 'ripestat' && big.data.name === 'AT-88-Z',
  `whois 52.95.110.2, RIPEstat's answer padded to about 900 KB with route objects (as a root server's runs past 500 KB): ${big.status}, ${big.data.source}`);
const a6 = aws6.data;
ok(aws6.status === 200 && a6.name === 'AMZ-EC2' && J(a6.cidrs) === J(['2600:1F00::/24']) &&
  J(a6.range) === J({ start: '2600:1f00::', end: '2600:1fff:ffff:ffff:ffff:ffff:ffff:ffff' }) && viaRipe('2600:1f18:0:0::/64') && !viaRipe('2600:1f18::1'),
  `whois 2600:1f18::1: asked as its /64 (a bare IPv6 address has no match), the CIDR as ARIN writes it, the range in ipterm's form: ${J(a6.cidrs)} ${J(a6.range)}`);
const u = uunet.data;
ok(uunet.status === 200 && u.kind === 'asn' && u.query === 'AS701' && u.handle === 'AS701' && u.name === 'UUNET' && u.org === 'Verizon Business' &&
  J(u.asnRange) === J({ start: 701, end: 705 }) && J(u.cidrs) === J([]) && u.range === null && u.type === null && u.registered === '1990-08-03' &&
  u.rdapUrl === 'https://rdap.arin.net/registry/autnum/701' && viaRipe('AS701'),
  `whois AS701: ${u.handle} ${u.name}, ${J(u.org)}, AS range ${J(u.asnRange)}, registered ${u.registered}`);
ok(u.abuse && u.abuse.handle === 'ABUSE3-ARIN' && u.abuse.email === 'abuse-mail@verizonbusiness.com',
  `... of its holder's two abuse contacts the first (RIPEstat's order isn't RDAP's, but both are the holder's): ${J(u.abuse)}`);
ok(two.status === 200 && two.data.org === 'Example Hosting & Co' && two.data.type === 'ALLOCATION' &&
  J(two.data.abuse) === J({ email: 'abuse@hosting.example', phone: '+1-555-0100', handle: 'EXH-ABUSE-ARIN' }),
  `whois 99.1.2.3 (two holders, the network naming neither's contact): the one whose email abuse-contact-finder names, second in its list, ${J(two.data.abuse)}; "&#38;" unescaped, "Reallocated" RDAP's ${two.data.type}`);
const ttl = q => ((([...store].find(([k]) => k.includes('whois/' + q)) || [])[1] || { headers: {} }).headers['cache-control']);
ok(twoNoFinder.status === 200 && twoNoFinder.data.abuse === null && twoNoFinder.data.name === 'EX-HOSTING' && ttl('99.1.5.6') === 'public, max-age=600',
  `... and with abuse-contact-finder failing, the record without one, kept ten minutes rather than an hour: abuse ${J(twoNoFinder.data.abuse)}, ${ttl('99.1.5.6')}`);
const HOSTPAPA = { email: 'net-abuse-global@hostpapa.com', phone: '+1-888-959-7272', handle: 'NETAB23-ARIN' };
ok(legacy.status === 200 && legacy.data.name === 'HOSTPAPA-NET' && legacy.data.org === 'HostPapa' && J(legacy.data.abuse) === J(HOSTPAPA) &&
  legacyNoFinder.status === 200 && J(legacyNoFinder.data.abuse) === J(HOSTPAPA) && ttl('192.3.50.2') === 'public, max-age=3600',
  `whois 192.3.50.1 (early-registration space: ARIN's "Various Registries" network and its "No, Contact Known" placeholder in the answer): the holder's own contact, ` +
  `as RDAP gives it, whether abuse-contact-finder (which lists the network's ColoCrossing contact first) answers or fails: ${J(legacy.data.abuse)}`);
ok(legacy2.status === 200 && J(legacy2.data.abuse) === J(HOSTPAPA),
  `whois 192.3.60.1 (the same space, its holder with two abuse contacts, abuse-contact-finder failing): one holder besides ARIN's "Various Registries", so its first: ${J(legacy2.data.abuse)}`);

console.log("-- when ARIN's failure stands");
ok(plainRdap.status === 200 && plainRdap.data.source === 'rdap' && !plainRdap.data.registryError && !asked('https://stat.ripe.net/data/whois/data.json?resource=96.'),
  `whois 96.1.1.1, ARIN answering: RDAP's record, source ${plainRdap.data.source}, and no RIPEstat request`);
ok(bot.status === 502 && bot.body.includes(esc(ARIN525)) && !asked('https://stat.ripe.net/data/whois/data.json?resource=73.1.9.9'),
  `Googlebot on /whois/73.1.9.9: ${bot.status}, ARIN's failure, and no RIPEstat request (bots start none, as for routing)`);
ok(ripeBlock.status === 502 && ripeBlock.data.error === ARIN525 && viaRipe('45.142.26.2/32'),
  `whois 45.142.26.2 (a block ARIN passed on to RIPE NCC: RIPEstat answers for RIPE NCC): ${ripeBlock.status}, ${J(ripeBlock.data.error)}`);
ok(noCopy.status === 502 && noCopy.data.error === ARIN525 && viaRipe('98.1.1.1/32'),
  `whois 98.1.1.1 (RIPEstat has no match): ${noCopy.status}, ARIN's failure`);
ok(apnic.status === 502 && apnic.data.error === APNIC429 && !asked('https://stat.ripe.net/data/whois/data.json?resource=1.'),
  `whois 1.2.3.4 (APNIC answers 429): ${apnic.status}, APNIC's failure, and no RIPEstat request (only ARIN's records)`);
ok(lookup.status === 200 && lookup.data.ip === '73.9.9.9' && asked('https://rdap.arin.net/registry/ip/73.9.9.9') >= 1 && !lookup.data.block &&
  !asked('https://stat.ripe.net/data/whois/data.json?resource=73.9.9.9') && !asked('https://stat.ripe.net/data/abuse-contact-finder/data.json?resource=73.9.9.9'),
  `a lookup of 73.9.9.9, ARIN answering 525 for its registry date: ${lookup.status}, no block, and no RIPEstat request (blockData asks RDAP only)`);

console.log('-- the same record as text, on the page and for the terminal');
const [text, page] = await Promise.all([run('/whois/73.1.2.3?format=text'), run('/whois/73.1.2.3', { ua: CHROME, ...NAV })]);
ok(text.status === 200 && /^source +ARIN's whois data, relayed by RIPEstat \(rdap\.arin\.net failed to answer: HTTP 525\)$/m.test(text.body) &&
  /^owner +Comcast IP Services, L\.L\.C\.$/m.test(text.body) && /^rdap +https:\/\/rdap\.arin\.net\/registry\/ip\/73\.1\.2\.3$/m.test(text.body),
  `curl /whois/73.1.2.3?format=text has the source line: ${J((/^source .*$/m.exec(text.body) || [''])[0])}`);
const art = article(page.body);
ok(page.status === 200 && art.includes(esc(SOURCE)) && art.includes('>ripestat<') && page.data.source === 'ripestat' && page.data.registryError === E525,
  'the /whois/73.1.2.3 page: the source row, a ripestat tag, and the same record for the terminal it boots');
ok(worker.includes(`"ARIN's whois data, relayed by RIPEstat" + (d.registryError ? \` (\${d.registryError})\` : '')`) &&
  app.includes(`"ARIN's whois data, relayed by RIPEstat" + (d.registryError ? \` (\${d.registryError})\` : '')`) &&
  app.includes("d.source === 'ripestat' ? 'ripestat' : 'rdap'"),
  "public/app.js (renderWhois) words the source line as the Worker does (relayText), and tags the record ripestat");

console.log("-- a silent ARIN, and a record RIPEstat takes past the deadline for, side by side; then RIPEstat at once while ARIN is left alone");
const DEADLINE = Number((/^const DEADLINE = (\d+);/m.exec(worker) || [])[1]);
const [silent, slow, huge] = await Promise.all([run('/api/whois?q=63.1.2.3', API), run('/api/whois?q=99.9.9.9', API), run('/api/whois?q=52.95.110.3', API)]);
ok(huge.status === 502 && huge.data.error === ARIN525 && viaRipe('52.95.110.3/32'),
  `whois 52.95.110.3 (RIPEstat's answer about 1.5 MB, past ripestat()'s cap): ${huge.status}, ARIN's failure`);
ok(silent.status === 502 && silent.data.error === ARIN_SILENT && !asked('https://stat.ripe.net/data/whois/data.json?resource=63.'),
  `whois 63.1.2.3 (ARIN never answers): ${silent.status} after ${(silent.ms / 1000).toFixed(1)} s, ${J(silent.data.error)}, no RIPEstat request (no time left for it)`);
ok(slow.status === 502 && slow.data.error === ARIN525 && slow.ms >= DEADLINE - 600 && slow.ms <= DEADLINE + 800 && viaRipe('99.9.9.9/32'),
  `whois 99.9.9.9 (ARIN answers 525, RIPEstat's whois never answers): ARIN's failure at the deadline, after ${(slow.ms / 1000).toFixed(1)} s`);
const paused = await run('/api/whois?q=73.0.0.9', API);
ok(paused.status === 200 && paused.data.source === 'ripestat' && paused.data.registryError === "rdap.arin.net didn't answer" && paused.ms < 1000 &&
  !asked('https://rdap.arin.net/registry/ip/73.0.0.9') && viaRipe('73.0.0.9/32'),
  `whois 73.0.0.9 right after, ARIN left alone for a minute: RIPEstat's copy after ${paused.ms} ms, registryError ${J(paused.data.registryError)}, ` +
  "ARIN not asked; and neither the slow record (abuse-contact-finder answered meanwhile) nor the one too large made RIPEstat be left alone");

console.log('-- RIPEstat down: ARIN\'s failure, and then at once, RIPEstat left alone for a minute (relayQuiet)');
const down = await run('/api/whois?q=97.1.1.1', API);
ok(down.status === 502 && down.data.error === ARIN_SILENT && viaRipe('97.1.1.1/32', 2) && down.ms < 2000,
  `whois 97.1.1.1 (RIPEstat answers 503, twice): ${down.status} after ${down.ms} ms, ARIN's failure ("didn't answer": ARIN is still left alone)`);
const after = await run('/api/whois?q=98.2.2.2', API);
ok(after.status === 502 && after.data.error === ARIN_SILENT && after.ms < 300 && !asked('https://stat.ripe.net/data/whois/data.json?resource=98.2.2.2'),
  `whois 98.2.2.2 right after: ARIN's failure after ${after.ms} ms, with no RIPEstat request while it is left alone`);

console.log('-- in the code');
ok(/rdapLookup\(/.test(slice(worker, 'function blockAsk(', '\n}\n')) && (worker.match(/whoisLookup\(/g) || []).length === 2 &&
  /cached\(io, 'whois\/' \+ query, 86400, \(\) => whoisLookup\(io, /.test(worker),
  "a lookup's registry date (blockAsk) asks RDAP only: whoisLookup is called once, by whois of an address or AS number (whoisRoute)");

clearInterval(keepAlive);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
