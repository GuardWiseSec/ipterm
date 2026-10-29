// Checks the reference-page groundwork: the ports sitemap, the IANA row on port pages, page titles and descriptions,
// and the special-purpose address table that the subnet calculator, the IP pages and the terminal share. No server
// and no network: the whole Worker runs in Node, as in tools/check_bots.mjs, with fetch stubbed to answer as IPinfo,
// proxycheck.io, DNS, RDAP and RIPEstat would and to note every request, and parts of public/app.js run against a
// stand-in DOM.
//
// 1. Ports sitemap: /sitemap.xml lists /sitemap-ports.xml with a <lastmod>, and that file lists /port and every port
//    page in public/ports.js (42), each with the same real <lastmod> (PORTS.updated, not in the future), while
//    /sitemap-pages.xml lists none of them. Each of those pages answers Googlebot with an indexable page and makes no
//    outside request.
// 2. The IANA row: every listed port's page, the Worker's and the terminal's (portAbout in public/app.js), names IANA's
//    registered service(s) with the protocol, or says "not registered with IANA" (25565), and links IANA's registry
//    and whatportis.com with rel="noopener", except for the four ports whatportis has no page for (NO_WHATPORTIS in
//    public/ports.js: 8096, 28015, 51413, 64738), which link IANA alone; a port that isn't listed (9999) has no such
//    row. Given IANA's CSV (service-names-port-numbers.csv), every stored name is checked against it as well.
// 3. Titles and descriptions: an IP page is "<ip> IP lookup: <org> (<ASN>), <hostname> | ipterm" with missing parts
//    left out, an anycast address is called anycast and never "located in", a public DNS resolver's page is titled
//    as the resolver and names no place, from IPinfo Core or a bot's IPinfo Lite (/1.1.1.1: "Australia") alike
//    (tools/check_resolvers.mjs checks the rest of those pages), a non-public address is "<ip> · <its kind's word> IPv4 address" (private,
//    loopback, documentation ...: kindWord in public/cidr.js; every indexed RFC 1918 router page "private") tagged with
//    its kind, an address IPinfo calls a bogon is "<ip> IP lookup: IPinfo lists it as a bogon" (below), an ASN page
//    is "AS<n> <name>: ASN, IP ranges and upstreams | ipterm", and a /32 is "a single address", in the Worker's pages
//    and as the terminal titles them (ipTitle, lookup, asn, cidrTitle in public/app.js). A /cidr page's range
//    words are its entry's only for a block the entry holds (::/0 is the whole address space, ::/96 starts with the
//    unspecified address), and a routed prefix's description keeps the block's size. Every description here, IP,
//    ASN, /cidr, port, tool, DNS, whois, mail and report card pages, is 155 characters or less, starts with the
//    page's subject, and og:description says the same; the h1 is the title without " | ipterm". A guide's is 160 or
//    less, with the same words in og:description and its Article's structured data.
// 4. Special-purpose addresses: every block in IANA's IPv4 and IPv6 Special-Purpose Address Registries (the copy
//    below; given the registries' CSVs, the copy is checked too) gets the same answer from the subnet calculator
//    (public/cidr.js), the IP page (the Worker's lookup) and the terminal (classify in public/app.js): public or not,
//    in the same words, as the table in public/cidr.js says.
// 5. Messages that name a range (lookup, whois, routing and port check errors, the whois page, the terminal's whois,
//    the DNS leak test's text answer) give its words once, at the end, with no parentheses inside parentheses.
// 6. IPinfo's bogons: the anycast addresses IANA marks globally reachable but IPinfo calls bogons (192.0.0.9,
//    192.0.0.10, 2001:1::1, 2001:1::2, 2001:1::3) are non-public and never looked up. 192.88.99.1, which the table
//    calls public but IPinfo Core, Lite and its free API all answer { bogon: true } for, gets a page that says so in
//    IPinfo's name, with the table's words for its range, the tag "bogon", no empty range and no fields of nulls; the
//    lookup asks IPinfo and reverse DNS only (no proxycheck.io, no registry), and its JSON, text answer and the
//    terminal's title agree.
// 7. Markup: a value from upstream shaped like { html: "<b>x</b>" } (IPinfo's as_name or as_domain, say) never reaches
//    a page as markup: the lookup keeps strings only, and staticBlock escapes anything that isn't the Worker's own
//    Markup.
//
//   node tools/check_pages.mjs                     (Node 22.15 or later: it loads the Worker through module.registerHooks)
//   node tools/check_pages.mjs service-names-port-numbers.csv iana-ipv4-special-registry-1.csv iana-ipv6-special-registry-1.csv
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const app = read('public/app.js'), worker = read('src/worker.js'), INDEX = read('public/index.html'), handbook = read('docs/handbook.md');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_pages.mjs`);
  return src.slice(a, b);
}

const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_pages.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const store = new Map();
globalThis.caches = { default: {
  async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, { body: await res.text(), headers: [...res.headers] }); },
} };

// IPinfo Core's answers by address: an anycast resolver, an address with and without a hostname, and one with an AS
// number but no name. Anything else is the second one without its hostname.
const CORE = {
  '8.8.4.4': { hostname: 'dns.google', city: 'Mountain View', region: 'California', as: ['AS15169', 'Google LLC'], anycast: true },
  '104.16.132.229': { city: 'San Francisco', region: 'California', as: ['AS13335', 'Cloudflare, Inc.'], anycast: true },
  '74.1.2.3': { hostname: 'c-74-1-2-3.hsd1.fl.comcast.net', city: 'Coral Springs', region: 'Florida', as: ['AS7922', 'Comcast Cable Communications, LLC'] },
  '74.1.2.5': { city: null, region: null, as: ['AS7922', null] },
};
// Addresses IPinfo answers { ip, bogon: true } for, here on all three of its APIs (its free API answered so for each
// of these on 2026-10-25), and one whose network name, domain and place come back shaped like markup.
const BOGONS = new Set(['192.88.99.1', '192.0.0.9', '192.0.0.10', '2001:1::1', '2001:1::2', '2001:1::3']);
const ODD = '74.1.2.9', HTML = { html: '<b id="injected">x</b>' };
const calls = [];
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const DNS = {                                           // example.test, for the DNS, mail and report card pages
  'example.test A': ['93.184.215.14'], 'example.test AAAA': ['2606:2800:21f:cb07::1'], 'example.test NS': ['ns1.example.test.', 'ns2.example.test.'],
  'example.test MX': ['10 mx1.example.test.', '20 mx2.example.test.'], 'example.test TXT': ['"v=spf1 include:_spf.example.test ~all"'],
  '_dmarc.example.test TXT': ['"v=DMARC1; p=none; rua=mailto:dmarc-reports@example.test"'],
};
const TYPE = { A: 1, NS: 2, MX: 15, TXT: 16, AAAA: 28 };
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  let m;
  if ((m = /^https:\/\/api\.ipinfo\.io\/lookup\/([^?]+)/.exec(u))) {
    calls.push(['core', u]);
    if (BOGONS.has(m[1])) return reply({ ip: m[1], bogon: true });
    if (m[1] === ODD) return reply({ ip: m[1], geo: { city: HTML, country: HTML, country_code: ['US'] }, as: { asn: 'AS7922', name: HTML, domain: HTML, type: 'isp' } });
    const c = CORE[m[1]] || { ...CORE['74.1.2.3'], hostname: null };
    return reply({ ip: m[1], ...(c.hostname ? { hostname: c.hostname } : {}),
      geo: { city: c.city, region: c.region, country: 'United States', country_code: 'US', continent: 'North America', latitude: 26.27, longitude: -80.27, timezone: 'America/New_York' },
      as: { asn: c.as[0], ...(c.as[1] ? { name: c.as[1] } : {}), type: 'isp' }, ...(c.anycast ? { is_anycast: true, is_hosting: true } : {}) });
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lite\/([^?]+)/.exec(u))) {
    calls.push(['lite', u]);
    if (BOGONS.has(m[1])) return reply({ ip: m[1], bogon: true });
    if (m[1] === ODD) return reply({ ip: m[1], asn: 'AS7922', as_name: HTML, as_domain: HTML, country_code: HTML, country: HTML, continent: HTML });
    // 1.1.1.1 as IPinfo Lite answers it on the live site (Australia, with no anycast flag); anything else is Comcast's
    if (m[1] === '1.1.1.1') return reply({ ip: m[1], asn: 'AS13335', as_name: 'Cloudflare, Inc.', as_domain: 'cloudflare.com', country_code: 'AU', country: 'Australia', continent: 'Oceania' });
    return reply({ ip: m[1], asn: 'AS7922', as_name: 'Comcast Cable Communications, LLC', as_domain: 'comcast.com', country_code: 'US', country: 'United States', continent: 'North America' });
  }
  if ((m = /^https:\/\/ipinfo\.io\/([^/?]+)\/json$/.exec(u))) {   // the free API, without IPINFO_TOKEN
    calls.push(['ipinfo', u]);
    if (BOGONS.has(m[1])) return reply({ ip: m[1], bogon: true });
    return reply({ ip: m[1], hostname: HTML, city: HTML, country: HTML, loc: HTML, org: HTML, timezone: HTML });
  }
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u))) {
    calls.push(['proxycheck', u]);
    return reply({ status: 'ok', [m[1]]: { network: { type: 'residential' }, detections: { proxy: false, vpn: false, tor: false, hosting: false, anonymous: false, risk: 0 } } });
  }
  if ((m = /^https:\/\/cloudflare-dns\.com\/dns-query\?name=([^&]+)&type=([A-Z]+)/.exec(u))) {
    calls.push(['dns', u]);
    const name = decodeURIComponent(m[1]).replace(/\.$/, ''), ans = DNS[`${name} ${m[2]}`] || [];
    const known = Object.keys(DNS).some(k => k.startsWith(name + ' '));    // a name with other records: NOERROR, no answer
    return reply(ans.length || known ? { Status: 0, Answer: ans.map(data => ({ name, type: TYPE[m[2]], TTL: 300, data })) } : { Status: 3, Answer: [] });
  }
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    calls.push(['rdap', u]);
    return reply({ services: [[m[1] === 'ipv4' ? ['0.0.0.0/0'] : m[1] === 'ipv6' ? ['::/0'] : m[1] === 'asn' ? ['1-4294967295'] : ['org'], ['https://rdap.test/']]] });
  }
  if ((m = /^https:\/\/rdap\.test\/ip\/(.+)$/.exec(u))) {
    calls.push(['rdap', u]);
    return reply({ objectClassName: 'ip network', handle: 'NET-74-0-0-0-1', name: 'COMCAST-TEST', type: 'DIRECT ALLOCATION', startAddress: '74.0.0.0', endAddress: '74.255.255.255',
      cidr0_cidrs: [{ v4prefix: '74.0.0.0', length: 8 }], port43: 'whois.arin.net', events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00-04:00' }],
      entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Comcast Cable Communications, LLC'], ['kind', {}, 'text', 'org']]] },
        { roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Comcast Abuse'], ['kind', {}, 'text', 'group'], ['email', {}, 'text', 'abuse@comcast.test']]] }] });
  }
  if (/^https:\/\/rdap\.test\/domain\/example-check\.org$/.test(u)) {       // .test itself has no registry
    calls.push(['rdap', u]);
    return reply({ objectClassName: 'domain', ldhName: 'EXAMPLE-CHECK.ORG', status: ['client transfer prohibited'],
      events: [{ eventAction: 'registration', eventDate: '2007-10-09T18:20:50Z' }, { eventAction: 'expiration', eventDate: '2030-10-09T07:00:00Z' }],
      nameservers: ['ns1.example-check.org', 'ns2.example-check.org', 'ns3.example-check.org'].map(ldhName => ({ objectClassName: 'nameserver', ldhName })),
      entities: [{ roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '292' }], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar, Inc.']]] }] });
  }
  if ((m = /^https:\/\/stat\.ripe\.net\/data\/([a-z-]+)\/data\.json\?(.*)$/.exec(u))) {
    calls.push(['ripestat', u]);
    const q = new URLSearchParams(m[2]), res = q.get('resource') || '';
    switch (m[1]) {
      case 'prefix-overview': return reply({ data: { resource: res, announced: true, asns: [{ asn: 64500, holder: 'EXAMPLENET - Example Networks, Inc.' }], block: { desc: 'RIPE NCC' }, related_prefixes: [] } });
      case 'routing-status': return reply({ data: { visibility: { v4: { ris_peers_seeing: 300, total_ris_peers: 320 }, v6: { ris_peers_seeing: 300, total_ris_peers: 320 } } } });
      case 'bgp-state': return reply({ data: { bgp_state: [{ target_prefix: res, path: [3333, 1299, 64500], source_id: '00-193.0.0.56' }] } });
      case 'rpki-validation': return reply({ data: { status: 'valid', validating_roas: [{ origin: '64500', prefix: q.get('prefix'), max_length: 24 }] } });
      case 'as-overview': return reply({ data: { holder: res === 'AS64500' ? 'EXAMPLENET - Example Networks, Inc.' : res === 'AS64501' ? 'LONGNET - The Very Long Name of an Example Regional Internet and Cable Television Provider Cooperative, Ltd.' : 'UPSTREAM-' + res + ' - Upstream ' + res, announced: true, block: { desc: 'Assigned by ARIN' } } });
      case 'announced-prefixes': return reply({ data: { prefixes: [{ prefix: '87.121.0.0/16' }, { prefix: '87.122.0.0/24' }, { prefix: '2a0d:5600::/32' }] } });
      case 'asn-neighbours': return reply({ data: { neighbours: [1299, 3356, 174].map((asn, i) => ({ asn, type: 'left', power: 10 - i, v4_peers: 100 })), neighbour_counts: { left: 3 } } });
    }
  }
  if (u.startsWith('https://dlapi.example.test/v1/resolvers?')) {   // the DNS leak responder (DNSLEAK_API), non-public resolvers only
    calls.push(['dnsleak', u]);
    return reply({ seen: 1, resolvers: ['10.0.0.1', '198.18.0.1', 'fd00::53'] });
  }
  if (/^https?:\/\/example\.test\//.test(u)) { calls.push(['site', u]); return new Response(null, { status: 200 }); }
  calls.push(['other', u]);
  return new Response('not stubbed in tools/check_pages.mjs', { status: 404 });
};

const env = {
  IPINFO_TOKEN: 'test-token', IPINFO_PLAN: 'core', PROXYCHECK_KEY: 'test-key',
  BUDGET: { idFromName: name => name, get: () => ({ async take() { return { ok: true }; } }) },
  ASSETS: { fetch: async () => new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
};
const { default: W } = await import('../src/worker.js');
const CIDR = globalThis.IPTERM_CIDR, PORTS = globalThis.IPTERM_PORTS;
// The terminal's address parsing and its classify(), with cidr.js loaded
const { parseIp, classify } = Function('window', slice(app, '  /* ---------- IP parsing ---------- */', '  function computed(p) {') + 'return { parseIp, classify };')({ IPTERM_CIDR: CIDR });

const GOOG = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const CURL = { ua: 'curl/8.7.1', accept: '*/*' };
async function run(path, { ua, ...headers }, envPlus = {}) {
  calls.length = 0;
  const waits = [];
  const res = await W.fetch(new Request('https://ipterm.net' + path, { headers: { 'user-agent': ua, 'cf-connecting-ip': '81.2.69.142', ...headers } }),
    { ...env, ...envPlus }, { waitUntil: p => waits.push(p) });
  const body = await res.text();
  await Promise.allSettled(waits);
  const init = /<script type="application\/json" id="ipterm-initial">([\s\S]*?)<\/script>/.exec(body);
  let data = null;
  try { data = init ? JSON.parse(init[1]).data : JSON.parse(body); } catch {}
  return { status: res.status, body, data, kinds: calls.map(c => c[0]) };
}
const unesc = s => (s == null ? s : s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
const pick = (re, b) => unesc((re.exec(b) || [])[1]);
const head = body => ({
  title: pick(/<title>([^<]*)<\/title>/, body), desc: pick(/<meta name="description" content="([^"]*)">/, body),
  og: pick(/<meta property="og:description" content="([^"]*)">/, body), ogTitle: pick(/<meta property="og:title" content="([^"]*)">/, body),
  h1: pick(/<h1 class="sr-only">([^<]*)<\/h1>/, body), noindex: /<meta name="robots" content="noindex/.test(body),
});
const article = body => (/<article class="static" id="static">[\s\S]*?<\/article>/.exec(body) || [''])[0];
// A description that fits, leads with what the page is about, and is the same in og:description; the h1 is the title.
function fits(what, h, subject) {
  ok(h.desc && h.desc.length <= 155 && h.desc.startsWith(subject) && h.og === h.desc && h.title.endsWith(' | ipterm') && h.ogTitle === h.title &&
    h.h1 === h.title.replace(/ \| ipterm$/, ''), `${what}: description ${h.desc ? h.desc.length : 'missing'} characters, ${JSON.stringify(h.desc)}`);
}

console.log('-- the ports sitemap (/sitemap-ports.xml, PORTS.updated in public/ports.js)');
const today = new Date().toISOString().slice(0, 10);
const realDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s && s <= today;
ok(realDate(PORTS.updated), `PORTS.updated is a real date, not in the future: ${PORTS.updated}`);
const idx = (await run('/sitemap.xml', CURL)).body;
ok(new RegExp(`<sitemap><loc>https://ipterm\\.net/sitemap-ports\\.xml</loc><lastmod>${PORTS.updated}</lastmod></sitemap>`).test(idx),
  '/sitemap.xml lists /sitemap-ports.xml with that <lastmod>');
const sm = await run('/sitemap-ports.xml', CURL), urls = [...sm.body.matchAll(/<url><loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g)];
const want = ['/port', ...PORTS.list().map(n => '/port/' + n)].map(p => 'https://ipterm.net' + p);
ok(PORTS.list().length === 42 && urls.length === 43 && urls.map(u => u[1]).join() === want.join() && (sm.body.match(/<url>/g) || []).length === 43,
  `/sitemap-ports.xml lists /port and all ${PORTS.list().length} port pages (${urls.length} URLs)`);
ok(urls.every(u => u[2] === PORTS.updated), `... each with <lastmod>${PORTS.updated}</lastmod>`);
ok(sm.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') && sm.body.trimEnd().endsWith('</urlset>'),
  '... in a well-formed urlset');
const pages = (await run('/sitemap-pages.xml', CURL)).body;
ok(!/\/port(\/|<)/.test(pages) && /<url><loc>https:\/\/ipterm\.net\/<\/loc><\/url>/.test(pages) && !pages.includes('<lastmod>'),
  '/sitemap-pages.xml lists no port page, and no <lastmod> (its pages change with live data)');
let quiet = true, indexed = true;
for (const u of urls) {
  const r = await run(u[1].replace('https://ipterm.net', ''), { ua: GOOG });
  if (r.kinds.length) quiet = false;
  if (r.status !== 200 || head(r.body).noindex) indexed = false;
}
ok(quiet && indexed, `Googlebot gets all ${urls.length} as indexable pages, with no outside request`);
ok(handbook.includes('/sitemap-ports.xml') && handbook.includes('PORTS.updated') && read('public/ports.js').includes('const UPDATED ='),
  'docs/handbook.md describes the ports sitemap and its date (UPDATED in public/ports.js)');

console.log("-- the IANA row on port pages (portPage in src/worker.js, portAbout in public/app.js)");
const IANA_URL = n => `https://www.iana.org/assignments/service-names-port-numbers?search=${n}`, WPI = n => `https://whatportis.com/ports/${n}`;
const rowOf = (a, key) => (new RegExp(`<dt>${key}</dt><dd>(.*?)</dd>`).exec(a) || [])[1];
// whatportis.com/ports/<n> answered 404 for these on 2026-10-25 (the others 200, or 308 to a page that did)
const NO_WPI = [8096, 28015, 51413, 64738];
const links = n => ` · <a href="${IANA_URL(n)}" rel="noopener">IANA registry</a>` + (NO_WPI.includes(n) ? '' : ` · <a href="${WPI(n)}" rel="noopener">whatportis</a>`);
let allRows = true;
for (const n of PORTS.list()) {
  const a = article((await run('/port/' + n, { ua: GOOG })).body), i = PORTS.iana(n), key = i && i.names.length > 1 ? 'IANA names' : 'IANA name';
  if (!i || rowOf(a, key) !== i.text.replace(/&/g, '&amp;') + links(n)) { allRows = false; ok(false, `/port/${n}: IANA row ${JSON.stringify(rowOf(a, key))}`); }
}
ok(allRows, `every one of the ${PORTS.list().length} port pages has its IANA row, linked to IANA's registry and, but for ${NO_WPI.length}, whatportis.com (rel="noopener")`);
const noWpi = PORTS.list().filter(n => !PORTS.refs(n).some(([label]) => label === 'whatportis'));
const wpiDate = (/const NO_WHATPORTIS = \{ checked: '([^']*)'/.exec(read('public/ports.js')) || [])[1];
ok(noWpi.join() === NO_WPI.join() && PORTS.refs(64738).length === 1 && PORTS.refs(64738)[0][0] === 'IANA registry' && realDate(wpiDate),
  `whatportis is left out for ${noWpi.join(', ')} only, where it has no page (NO_WHATPORTIS in public/ports.js, checked ${wpiDate}); IANA stays`);
ok(handbook.includes('NO_WHATPORTIS') && NO_WPI.every(n => handbook.includes(String(n))), 'docs/handbook.md names the ports whatportis has no page for');
for (const [n, text] of [[22, 'ssh (TCP)'], [53, 'domain (TCP and UDP)'], [80, 'http, www, www-http (TCP)'], [1194, 'openvpn (UDP)'], [3389, 'ms-wbt-server (TCP)'],
  [3478, 'stun, turn, stun-behavior (TCP and UDP)'], [25565, 'not registered with IANA'], [51820, 'not registered with IANA'],
  [64738, 'not registered with IANA'], [8096, 'not registered with IANA']]) {
  const a = article((await run('/port/' + n, { ua: GOOG })).body), key = text.includes(',') ? 'IANA names' : 'IANA name';
  ok(rowOf(a, key) === text + links(n), `/port/${n}: ${key} ${text}`);
}
const other = article((await run('/port/9999', { ua: GOOG })).body);
ok(other.includes('Port 9999') && !other.includes('IANA') && PORTS.iana(9999) === null, '/port/9999, not in the list: no IANA row (only listed ports were checked against the registry)');

const node = (tag, text = '') => ({ tag, text, kids: [], append(...xs) { this.kids.push(...xs); }, appendChild(x) { this.kids.push(x); } });
const textOf = x => (x == null ? '' : typeof x === 'string' ? x : (x.text || '') + (x.kids || []).map(textOf).join(''));
const anchors = x => (!x || typeof x !== 'object' ? [] : [...(x.tag === 'a' ? [x] : []), ...(x.kids || []).flatMap(anchors)]);
let kvRows = [], titled = '';
// (fixLine, the corrections line after the table, is checked in tools/check_corrections.mjs)
const portAbout = Function('PORTSLIB', 'setUrl', 'portTitle', 'el', 'out', 'shareBar', 'kv', 'cmdButton', 'document', 'announce', 'next', 'fixLine',
  slice(app, '  async function portAbout(n) {', '  async function portCheck(n) {') + 'return portAbout;')(
  PORTS, () => {}, () => '', (tag, cls, text) => node(tag, text), node('#out'), () => null, r => { kvRows = r; }, t => node('button', t),
  { createDocumentFragment: () => node('#fragment') }, () => {}, () => {}, () => {});
for (const [n, key, text] of [[22, 'IANA name', 'ssh (TCP)'], [3478, 'IANA names', 'stun, turn, stun-behavior (TCP and UDP)'], [25565, 'IANA name', 'not registered with IANA'],
  [64738, 'IANA name', 'not registered with IANA']]) {
  await portAbout(n);
  const row = kvRows.find(r => r[0] === key), as = anchors(row && row[1]), wpi = !NO_WPI.includes(n);
  ok(row && textOf(row[1]) === `${text} · IANA registry ↗` + (wpi ? ' · whatportis ↗' : '') && as.length === (wpi ? 2 : 1) && as[0].href === IANA_URL(n) &&
    (!wpi || as[1].href === WPI(n)) && as.every(x => x.rel === 'noopener' && x.target === '_blank'), `the terminal's port ${n} --info: ${key} ${JSON.stringify(textOf(row && row[1]))}`);
}
await portAbout(9999);
ok(!kvRows.some(r => /^IANA/.test(r[0])), "the terminal's port 9999 --info: no IANA row");

console.log('-- titles and descriptions: IP pages (ipPage in src/worker.js, ipTitle in public/app.js)');
const ipTitle = Function('RESLIB', slice(app, '  const ipTitle =', '  function localTime(') + 'return ipTitle;')(globalThis.IPTERM_RESOLVERS);
for (const [what, ip, opts, title, lead] of [
  ['an address with its hostname', '74.1.2.3', { ua: CHROME, ...NAV }, '74.1.2.3 IP lookup: Comcast Cable Communications, LLC (AS7922), c-74-1-2-3.hsd1.fl.comcast.net | ipterm',
    '74.1.2.3 is a public IPv4 address operated by Comcast Cable Communications, LLC (AS7922), located in Coral Springs, Florida, United States.'],
  ['no hostname', '74.1.2.4', { ua: CHROME, ...NAV }, '74.1.2.4 IP lookup: Comcast Cable Communications, LLC (AS7922) | ipterm',
    '74.1.2.4 is a public IPv4 address operated by Comcast Cable Communications, LLC (AS7922), located in Coral Springs, Florida, United States.'],
  ['an AS number with no name', '74.1.2.5', { ua: CHROME, ...NAV }, '74.1.2.5 IP lookup: AS7922 | ipterm', '74.1.2.5 is a public IPv4 address operated by AS7922, located in United States.'],
  ["Googlebot's IPinfo Lite answer", '74.1.2.6', { ua: GOOG }, '74.1.2.6 IP lookup: Comcast Cable Communications, LLC (AS7922) | ipterm',
    '74.1.2.6 is a public IPv4 address operated by Comcast Cable Communications, LLC (AS7922), located in United States.'],
]) {
  const r = await run('/' + ip, opts), h = head(r.body);
  ok(h.title === title && ipTitle(ip, r.data) === title, `${what}: ${JSON.stringify(h.title)}, the same in the terminal`);
  fits(`  ${ip}`, h, lead);
}
const any = await run('/104.16.132.229', { ua: CHROME, ...NAV }), ah = head(any.body);
ok(ah.title === '104.16.132.229 IP lookup: Cloudflare, Inc. (AS13335) | ipterm' && ipTitle('104.16.132.229', any.data) === ah.title, `an anycast address: ${JSON.stringify(ah.title)}`);
fits('  104.16.132.229', ah, '104.16.132.229 is a public IPv4 address operated by Cloudflare, Inc. (AS13335), anycast (served from many locations).');
ok(!/located in|approximate/.test(ah.desc) && !/located in|IP location is approximate/.test(article(any.body)),
  '  ... and neither its description nor its page says "located in" or "approximate" (IPinfo gives one of its many locations)');
// A public DNS resolver's page is the resolver's (public/resolvers.js), with no place whatever IPinfo says: from Core
// (8.8.4.4, with a city) or from IPinfo Lite, which Googlebot gets, with no anycast flag and 1.1.1.1 in Australia.
// Neither names a place, while another address's Lite answer keeps its country (74.1.2.6 above). Google filters
// nothing, so its title says no "filtering".
const res = await run('/8.8.4.4', { ua: CHROME, ...NAV }), rh = head(res.body);
ok(rh.title === '8.8.4.4 · Google Public DNS: addresses, DoH and DoT | ipterm' && ipTitle('8.8.4.4', res.data) === rh.title,
  `a resolver, from IPinfo Core: ${JSON.stringify(rh.title)}, the same in the terminal`);
fits('  8.8.4.4', rh, "8.8.4.4 is Google's public DNS resolver. Also 8.8.8.8, IPv6 2001:4860:4860::8888.");
const lite = await run('/1.1.1.1', { ua: GOOG }), lh = head(lite.body);
ok(lite.kinds.includes('lite') && !lite.kinds.includes('core') && lh.title === '1.1.1.1 · Cloudflare DNS: addresses, DoH, DoT and filtering | ipterm' &&
  lh.desc === "1.1.1.1 is Cloudflare's public DNS resolver. Secondary 1.0.0.1, IPv6 2606:4700:4700::1111. DoH, DoT, filtering variants and live routing." &&
  /Anycast: answered from many locations\./.test(article(lite.body)) && rowOf(article(lite.body), 'location') === 'Australia',
  `a resolver, from IPinfo Lite (/1.1.1.1 for Googlebot): ${JSON.stringify(lh.desc)}, the location row kept`);
for (const [what, r] of [['8.8.4.4', res], ['1.1.1.1 for Googlebot', lite]]) {
  ok(!/located in|approximate|Mountain View|Australia/.test(head(r.body).title + head(r.body).desc + (/<p class="ln">[^<]*<\/p>/.exec(article(r.body)) || [''])[0]),
    `  ... ${what}: no place in its title, description or summary`);
}
// A non-public address's title names its kind in the word people search for (kindWord in public/cidr.js), and the
// terminal's lookup() titles its tab the same way.
const terminalNonPublic = "setUrl('/' + ipText, `${ipText} · ${CIDRLIB.kindWord(cls)} IPv${p.v} address | ipterm`)";
ok(app.includes(terminalNonPublic), "the terminal's lookup() titles a non-public address with kindWord(), as ipPage() does");
for (const [ip, kind, word, lead] of [
  ['192.168.1.1', 'private', 'private', '192.168.1.1 is a non-public IPv4 address in the RFC 1918 private range (192.168.0.0/16). If it is your router'],
  ['10.0.0.1', 'private', 'private', '10.0.0.1 is a non-public IPv4 address in the RFC 1918 private range (10.0.0.0/8).'],
  ['100.64.0.1', 'cgnat', 'carrier-grade NAT (shared)', '100.64.0.1 is a non-public IPv4 address in the carrier-grade NAT range (100.64.0.0/10).'],
  ['127.0.0.1', 'loopback', 'loopback', '127.0.0.1 is a non-public IPv4 address in the loopback range (127.0.0.0/8).'],
  ['169.254.1.1', 'link-local', 'link-local', '169.254.1.1 is a non-public IPv4 address in the link-local range (169.254.0.0/16).'],
  ['192.0.2.1', 'docs', 'documentation', '192.0.2.1 is a non-public IPv4 address in the documentation range TEST-NET-1 (192.0.2.0/24, RFC 5737).'],
  ['198.18.0.1', 'benchmark', 'benchmarking', '198.18.0.1 is a non-public IPv4 address in the benchmarking range (198.18.0.0/15, RFC 2544).'],
  ['224.0.0.251', 'multicast', 'multicast', '224.0.0.251 is a non-public IPv4 address in the multicast range (224.0.0.0/4).'],
  ['192.88.99.2', 'reserved', 'reserved', '192.88.99.2 is a non-public IPv4 address: the 6a44 relay anycast address (192.88.99.2).'],
  ['192.0.0.9', 'reserved', 'reserved', '192.0.0.9 is a non-public IPv4 address: the Port Control Protocol anycast address (192.0.0.9, RFC 7723).'],
  ['192.0.0.10', 'reserved', 'reserved', '192.0.0.10 is a non-public IPv4 address: the TURN anycast address (192.0.0.10, RFC 8155).'],
  ['::', 'unspecified', 'non-public', ':: is a non-public IPv6 address: the unspecified address (::).'],
  ['::1', 'loopback', 'loopback', '::1 is a non-public IPv6 address: the loopback address (::1).'],
  ['2001:1::1', 'reserved', 'reserved', '2001:1::1 is a non-public IPv6 address: the Port Control Protocol anycast address (2001:1::1, RFC 7723).'],
  ['2001:1::2', 'reserved', 'reserved', '2001:1::2 is a non-public IPv6 address: the TURN anycast address (2001:1::2, RFC 8155).'],
  ['2001:1::3', 'reserved', 'reserved',
    '2001:1::3 is a non-public IPv6 address: the DNS-SD Service Registration Protocol anycast address (2001:1::3, RFC 9665).'],
  ['3fff::1', 'docs', 'documentation', '3fff::1 is a non-public IPv6 address in the documentation range (3fff::/20, RFC 9637).'],
  ['5f00::1', 'reserved', 'reserved', '5f00::1 is a non-public IPv6 address in the SRv6 SID prefix (5f00::/16, RFC 9602).'],
  ['fd00::1', 'ula', 'private', 'fd00::1 is a non-public IPv6 address in the unique local range (fc00::/7). If it is your router'],
]) {
  const r = await run('/' + ip, { ua: GOOG }), h = head(r.body), v = ip.includes(':') ? 'IPv6' : 'IPv4';
  fits(`a non-public address, /${ip}`, h, lead);
  ok(h.title === `${ip} · ${word} ${v} address | ipterm` && CIDR.kindWord(kind) === word && CIDR.special(parseIp(ip))[0] === kind &&
    article(r.body).includes(`<span class="tag">${v}</span> <span class="tag">${kind}</span>`) && !r.kinds.length,
    `  ... titled ${JSON.stringify(h.title)} as the terminal titles it, tagged ${kind}, with no outside request`);
}
// The indexed ones (SITEMAP_PATHS) are router and other well-known addresses: each titled by its kind, the RFC 1918
// ones "private", the word their searches use.
const curatedNonPublic = [...pages.matchAll(/<loc>https:\/\/ipterm\.net\/([0-9a-f.:]+)<\/loc>/g)].map(x => x[1]).filter(ip => parseIp(ip) && classify(parseIp(ip))[0] !== 'public');
let curatedTitled = curatedNonPublic.length > 10;
for (const ip of curatedNonPublic) {
  const h = head((await run('/' + ip, { ua: GOOG })).body), kind = CIDR.special(parseIp(ip))[0];
  if (h.title !== `${ip} · ${CIDR.kindWord(kind)} IPv${parseIp(ip).v} address | ipterm` || h.noindex || (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ip) && kind !== 'private')) {
    curatedTitled = false; ok(false, `/${ip}: ${JSON.stringify(h.title)}${h.noindex ? ', noindex' : ''}`);
  }
}
ok(curatedTitled, `the ${curatedNonPublic.length} indexed non-public pages are titled by their kind, the RFC 1918 ones "private" (${curatedNonPublic.join(', ')})`);
ok(['private', 'ula', 'loopback', 'link-local', 'cgnat', 'docs', 'benchmark', 'multicast', 'reserved', 'unspecified', 'public', 'nonsense'].map(CIDR.kindWord).join() ===
  'private,private,loopback,link-local,carrier-grade NAT (shared),documentation,benchmarking,multicast,reserved,non-public,non-public,non-public',
  'kindWord: "private" for RFC 1918 and unique local space, a word of its own for each other kind, "non-public" otherwise');
const bench = article((await run('/198.18.0.1', { ua: GOOG })).body), rfc = article((await run('/192.168.1.1', { ua: GOOG })).body);
ok(bench.includes('It cannot be reached or located from the internet.') && !bench.includes('local networks') && rfc.includes('used inside local networks'),
  "the page of a benchmarking address doesn't call it a local network's; a private one's still does");

console.log('-- titles and descriptions: ASN pages (asnPage in src/worker.js, asn in public/app.js)');
let asnTitle = '';
const asnCmd = Function('line', 'announce', 'live', 'apiAsn', 'DEMO_ASN', 'setUrl', 'renderAsn', 'sponsor', 'next', 'performance',
  slice(app, '  async function asn(raw, pre) {', '  /* ---------- subnet calculator') + 'return asn;')(
  () => {}, () => {}, true, async () => ({}), {}, (p, t) => { asnTitle = t; }, async () => {}, async () => {}, () => {}, { now: () => 0 });
for (const [as, title, lead] of [
  ['AS64500', 'AS64500 Example Networks, Inc.: ASN, IP ranges and upstreams | ipterm', 'AS64500 (Example Networks, Inc.) is an autonomous system registered with ARIN.'],
  ['AS64501', 'AS64501 The Very Long Name of an Example Regional Internet and Cable Television Provider Cooperative, Ltd.: ASN, IP ranges and upstreams | ipterm',
    'AS64501 (The Very Long Name of an Example Regional Internet and Cable Television Provider Cooperative, Ltd.) is an autonomous system'],
]) {
  const r = await run('/' + as, { ua: GOOG }), h = head(r.body);
  await asnCmd(as, { data: r.data });
  ok(h.title === title && asnTitle === title, `/${as}: ${JSON.stringify(h.title)}, the same in the terminal`);
  fits(`  /${as}`, h, lead);
}
const asPage = await run('/AS64500', { ua: GOOG });
ok(article(asPage.body).includes('Its main upstream networks are AS1299 (Upstream AS1299), AS3356 (Upstream AS3356) and AS174 (Upstream AS174).') &&
  !head(asPage.body).desc.includes('Upstream AS'), '  ... its page still names its upstreams in full; the description, which has no room, leaves them out');

console.log('-- titles and descriptions: /cidr pages (cidrPage in src/worker.js, cidrTitle in public/app.js)');
const cidrTitle = Function(slice(app, '  const cidrTitle =', '  async function cidr(raw, pre) {') + 'return cidrTitle;')();
for (const [px, title, lead] of [
  ['10.0.0.1/32', '10.0.0.1/32 subnet: 255.255.255.255, a single address | ipterm', '10.0.0.1/32 has netmask 255.255.255.255'],
  ['10.0.0.0/31', '10.0.0.0/31 subnet: 255.255.255.254, 2 usable hosts | ipterm', '10.0.0.0/31 has netmask 255.255.255.254'],
  ['192.168.0.0/16', '192.168.0.0/16 subnet: 255.255.0.0, 65,534 usable hosts | ipterm', '192.168.0.0/16 has netmask 255.255.0.0'],
  ['198.18.0.0/15', '198.18.0.0/15 subnet: 255.254.0.0, 131,070 usable hosts | ipterm', '198.18.0.0/15 has netmask 255.254.0.0'],
  ['2001:db8::/32', '2001:db8::/32 IPv6 subnet | ipterm', '2001:db8::/32 is an IPv6 block of 2^96'],
  ['3fff::/20', '3fff::/20 IPv6 subnet | ipterm', '3fff::/20 is an IPv6 block of 2^108'],
]) {
  const r = await run('/cidr/' + px, { ua: GOOG }), h = head(r.body);
  ok(h.title === title && cidrTitle(r.data) === title && !/\b1 usable hosts\b/.test(r.body), `/cidr/${px}: ${JSON.stringify(h.title)}, the same in the terminal`);
  fits(`  /cidr/${px}`, h, lead);
}
const routedPage = await run('/cidr/87.121.0.0/16', { ua: CHROME, ...NAV });
fits('a routed prefix, /cidr/87.121.0.0/16 (a browser, so RIPEstat is asked)', head(routedPage.body), '87.121.0.0/16 is announced in BGP by AS64500 (Example Networks, Inc.). RPKI: valid.');
// Beside the routing, the description still gives the block's size, where the range's words leave no room for it.
for (const [px, size] of [['2606:4700::/32', ' 2606:4700::/32 is an IPv6 block of 2^96 addresses.'], ['2001::/23', ' 2001::/23 is an IPv6 block of 2^105 addresses'],
  ['192.88.99.0/24', ' 192.88.99.0/24 has netmask 255.255.255.0']]) {
  const h = head((await run('/cidr/' + px, { ua: CHROME, ...NAV })).body);
  fits(`a routed prefix, /cidr/${px}`, h, `${px} is announced in BGP by AS64500 (Example Networks, Inc.). RPKI: valid.${size}`);
}
// A range's words are its entry's only for a block the entry holds: a wider block starts with it, and a /0 is the
// whole address space (never "the unspecified address" for ::/0, the IPv6 default route).
const summaryOf = a => unesc((/<p class="ln">([^<]*)<\/p>/.exec(a) || [])[1]);
for (const [px, row, says] of [
  ['::/0', 'whole IPv6 address space', 'It is the whole IPv6 address space.'],
  ['0.0.0.0/0', 'whole IPv4 address space', 'It is the whole IPv4 address space.'],
  ['::/96', 'starts with the unspecified address (::)', 'It starts with the unspecified address (::).'],
  ['::/127', 'starts with the unspecified address (::)', 'It starts with the unspecified address (::).'],
  ['::/128', 'unspecified address (::)', 'It is the unspecified address (::).'],
  ['10.0.0.0/7', 'starts with the RFC 1918 private range (10.0.0.0/8)', 'It starts with the RFC 1918 private range (10.0.0.0/8).'],
  ['10.0.0.0/8', 'RFC 1918 private range (10.0.0.0/8)', 'It is in the RFC 1918 private range (10.0.0.0/8).'],
  ['0.0.0.0/7', 'starts with the "this network" block (0.0.0.0/8)', 'It starts with the "this network" block (0.0.0.0/8).'],
]) {
  const r = await run('/cidr/' + px, { ua: GOOG }), a = article(r.body), h = head(r.body), sum = summaryOf(a);
  ok(sum.endsWith(' ' + says) && unesc(rowOf(a, 'range')) === row && r.data.rangeNote === row && h.desc.length <= 155 && h.og === h.desc,
    `/cidr/${px}: "${says}", range ${JSON.stringify(row)}; description ${JSON.stringify(h.desc)}`);
}

console.log('-- descriptions of the other pages (only those that ran past 160 characters were changed)');
for (const n of [...PORTS.list(), 9999]) {
  const h = head((await run('/port/' + n, { ua: GOOG })).body), s = PORTS.get(n);
  if (!(h.desc && h.desc.length <= 155 && h.og === h.desc && h.desc.startsWith(s ? s.use.slice(0, 20) : 'Check whether TCP port'))) ok(false, `/port/${n}: ${h.desc && h.desc.length} ${JSON.stringify(h.desc)}`);
}
ok(true, 'every port page (and /port/9999): 155 characters or less, starting with what the port is for');
for (const t of ['whois', 'dns', 'mail', 'grade', 'cidr', 'port', 'api', 'leaktest']) {
  const h = head((await run('/' + t, { ua: GOOG })).body);
  ok(h.desc && h.desc.length <= 155 && h.og === h.desc, `/${t}: ${h.desc && h.desc.length} characters`);
}
const DNSLEAK = { DNSLEAK_ZONE: 'dl.example.test', DNSLEAK_API: 'https://dlapi.example.test', DNSLEAK_KEY: 'k'.repeat(32) };
const lt = head((await run('/leaktest', { ua: GOOG }, DNSLEAK)).body);
ok(lt.desc && lt.desc.length <= 155 && lt.desc.startsWith('Free DNS leak test'), `/leaktest with the DNS test set up: ${lt.desc && lt.desc.length} characters`);
for (const [path, lead] of [['/dns/example.test', 'example.test resolves to 93.184.215.14'], ['/whois/74.1.2.3', '74.1.2.3 is registered to Comcast Cable Communications, LLC'],
  ['/whois/example-check.org', 'example-check.org was registered on 2007-10-09 through Example Registrar, Inc.'],
  ['/mail/example.test', 'example.test gets'], ['/grade/example.test', "example.test gets"]]) {
  const r = await run(path, { ua: CHROME, ...NAV });
  fits(path, head(r.body), lead);
}
// The guides (tools/build_guides.py): a desc that runs past 160 characters has a shorter meta, which is the
// description, og:description and the Article's.
for (const f of readdirSync(new URL('public/guides/', root))) {
  const b = read('public/guides/' + f).replace(/&#x27;/g, "'"), h = head(b);
  const art = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(b)[1])['@graph'][0].description;
  ok(h.desc && h.desc.length <= 160 && h.og === h.desc && art === h.desc, `/guides/${f.replace(/\.html$/, '')}: ${h.desc && h.desc.length} characters`);
}

console.log('-- special-purpose addresses: the subnet calculator, the IP page and the terminal agree (public/cidr.js SPECIAL)');
// IANA's IPv4 and IPv6 Special-Purpose Address Registries as of 2026-10-25: [block, name, globally reachable].
const REGISTRY = [
  ['0.0.0.0/8', 'This network', 'False'], ['0.0.0.0/32', 'This host on this network', 'False'], ['10.0.0.0/8', 'Private-Use', 'False'],
  ['100.64.0.0/10', 'Shared Address Space', 'False'], ['127.0.0.0/8', 'Loopback', 'False'], ['169.254.0.0/16', 'Link Local', 'False'],
  ['172.16.0.0/12', 'Private-Use', 'False'], ['192.0.0.0/24', 'IETF Protocol Assignments', 'False'], ['192.0.0.0/29', 'IPv4 Service Continuity Prefix', 'False'],
  ['192.0.0.8/32', 'IPv4 dummy address', 'False'], ['192.0.0.9/32', 'Port Control Protocol Anycast', 'True'],
  ['192.0.0.10/32', 'Traversal Using Relays around NAT Anycast', 'True'], ['192.0.0.170/32', 'NAT64/DNS64 Discovery', 'False'],
  ['192.0.0.171/32', 'NAT64/DNS64 Discovery', 'False'], ['192.0.2.0/24', 'Documentation (TEST-NET-1)', 'False'], ['192.31.196.0/24', 'AS112-v4', 'True'],
  ['192.52.193.0/24', 'AMT', 'True'], ['192.88.99.0/24', 'Deprecated (6to4 Relay Anycast)', ''], ['192.88.99.2/32', '6a44-relay anycast address', 'False'],
  ['192.168.0.0/16', 'Private-Use', 'False'], ['192.175.48.0/24', 'Direct Delegation AS112 Service', 'True'], ['198.18.0.0/15', 'Benchmarking', 'False'],
  ['198.51.100.0/24', 'Documentation (TEST-NET-2)', 'False'], ['203.0.113.0/24', 'Documentation (TEST-NET-3)', 'False'], ['240.0.0.0/4', 'Reserved', 'False'],
  ['255.255.255.255/32', 'Limited Broadcast', 'False'],
  ['::1/128', 'Loopback Address', 'False'], ['::/128', 'Unspecified Address', 'False'], ['::ffff:0:0/96', 'IPv4-mapped Address', 'False'],
  ['64:ff9b::/96', 'IPv4-IPv6 Translat.', 'True'], ['64:ff9b:1::/48', 'IPv4-IPv6 Translat.', 'False'], ['100::/64', 'Discard-Only Address Block', 'False'],
  ['100:0:0:1::/64', 'Dummy IPv6 Prefix', 'False'], ['2001::/23', 'IETF Protocol Assignments', 'False'], ['2001::/32', 'TEREDO', 'N/A'],
  ['2001:1::1/128', 'Port Control Protocol Anycast', 'True'], ['2001:1::2/128', 'Traversal Using Relays around NAT Anycast', 'True'],
  ['2001:1::3/128', 'DNS-SD Service Registration Protocol Anycast', 'True'], ['2001:2::/48', 'Benchmarking', 'False'], ['2001:3::/32', 'AMT', 'True'],
  ['2001:4:112::/48', 'AS112-v6', 'True'], ['2001:10::/28', 'Deprecated (previously ORCHID)', ''], ['2001:20::/28', 'ORCHIDv2', 'True'],
  ['2001:30::/28', 'Drone Remote ID Protocol Entity Tags (DETs) Prefix', 'True'], ['2001:db8::/32', 'Documentation', 'False'], ['2002::/16', '6to4', 'N/A'],
  ['2620:4f:8000::/48', 'Direct Delegation AS112 Service', 'True'], ['3fff::/20', 'Documentation', 'False'], ['5f00::/16', 'Segment Routing (SRv6) SIDs', 'False'],
  ['fc00::/7', 'Unique-Local', 'False'], ['fe80::/10', 'Link-Local Unicast', 'False'],
];
// And from IANA's IPv4 and IPv6 Address Space registries: multicast, global unicast and a block reserved by the IETF.
const SPACE = [['224.0.0.0/4', 'Multicast', 'False'], ['ff00::/8', 'Multicast', 'False'], ['2000::/3', 'Global Unicast', 'True'], ['4000::/3', 'Reserved by IETF', 'False']];
// ipterm's reading (the comment above SPECIAL in public/cidr.js): not globally reachable means not public, except
// 2001::/23 as a whole (left out, since most of what is assigned in it is reachable); reachable, N/A (Teredo, 6to4)
// and the deprecated rows with no flags (192.88.99.0/24, still announced; 2001:10::/28, inside 2001::/23) are public,
// but for the anycast addresses of PCP and TURN (in 192.0.0.0/24 and 2001::/23) and DNS-SD SRP (in 2001::/23) that
// IANA marks globally reachable: they stay non-public, as IPinfo calls them bogons and has no data for them.
const KEPT = ['192.0.0.9/32', '192.0.0.10/32', '2001:1::1/128', '2001:1::2/128', '2001:1::3/128'];
const publicByIana = ([block, , gr]) => (gr !== 'False' || block === '2001::/23') && !KEPT.includes(block);
// What the IP page says about one address: its reason when it isn't public (the lookup's 400), or null.
async function ipPageSays(ip) {
  const r = await run(`/api/lookup?ip=${encodeURIComponent(ip)}`, CURL), d = r.data || {};
  return d.bogon ? d.range : r.status === 200 && d.ip ? null : `(unexpected ${r.status})`;
}
const lastOf = d => (d.v === 4 ? d.broadcast : d.last);
let agree = 0;
for (const row of [...REGISTRY, ...SPACE]) {
  const [block, name] = row, d = CIDR.calc(block), pub = publicByIana(row);
  for (const ip of [...new Set([d.network, lastOf(d)])]) {
    const full = CIDR.calc(ip), [kind, note] = classify(parseIp(ip)), says = await ipPageSays(ip);
    const same = (full.range === 'public') === pub && (says === null) === pub && (kind === 'public') === pub &&
      (pub || (says === full.rangeNote && note.startsWith(full.rangeNote)));
    if (same) agree++;
    else ok(false, `${ip} (in ${block}, ${name}): calculator ${full.range} "${full.rangeNote}", IP page ${says === null ? 'public' : JSON.stringify(says)}, terminal ${kind}; expected ${pub ? 'public' : 'not public'}`);
  }
  if ((d.range === 'public') !== pub) ok(false, `${block} (${name}): the calculator says ${d.range}, expected ${pub ? 'public' : 'not public'}`);
}
ok(agree > REGISTRY.length + SPACE.length, `every IANA special-purpose block (${REGISTRY.length}) and ${SPACE.length} of the address space, first and last address: ` +
  `the calculator, the IP page and the terminal agree (${agree} addresses)`);
for (const [block, kind, note] of CIDR.SPECIAL) {
  const d = CIDR.calc(block);
  if (d.range !== kind || d.rangeNote !== note) ok(false, `the calculator on ${block}: ${d.range} "${d.rangeNote}", the table says ${kind} "${note}"`);
}
ok(CIDR.SPECIAL.every(([b]) => [...REGISTRY, ...SPACE].some(([r]) => r === b)), `every block in the table (${CIDR.SPECIAL.length}) is one of IANA's`);
for (const [px, kind, says] of [['198.18.0.0/15', 'benchmark', /benchmarking/], ['192.88.99.0/24', 'public', /6to4 relay anycast.*RFC 7526/], ['3fff::/20', 'docs', /documentation range \(3fff::\/20/],
  ['192.0.0.9/32', 'reserved', /^Port Control Protocol anycast address \(192\.0\.0\.9, RFC 7723\)$/], ['192.0.0.10/32', 'reserved', /^TURN anycast address \(192\.0\.0\.10, RFC 8155\)$/],
  ['2001:1::1/128', 'reserved', /^Port Control Protocol anycast address \(2001:1::1, RFC 7723\)$/], ['2001:1::2/128', 'reserved', /^TURN anycast address \(2001:1::2, RFC 8155\)$/],
  ['2001:1::3/128', 'reserved', /^DNS-SD Service Registration Protocol anycast address \(2001:1::3, RFC 9665\)$/]]) {
  const d = CIDR.calc(px);
  ok(d.range === kind && says.test(d.rangeNote), `the calculator on ${px}: ${d.range}, "${d.rangeNote}"`);
}
for (const px of ['198.18.0.0/15', '192.0.0.9/32', '192.0.0.10/32', '2001:1::1/128', '2001:1::2/128', '2001:1::3/128']) {
  const page = await run('/cidr/' + px, { ua: CHROME, ...NAV }), a = article(page.body), kind = CIDR.calc(px).range;
  ok(a.includes(`<span class="tag">${kind}</span>`) && !a.includes('href="/whois/') && !page.kinds.length,
    `/cidr/${px}: tagged ${kind}, with no registry link and no routing lookup (no outside request)`);
}
for (const [px, kind] of [['10.0.0.0/7', 'private'], ['192.168.0.0/15', 'private'], ['100.0.0.0/9', 'public'], ['2001::/16', 'public'], ['2001:1::/48', 'public'], ['64:ff9b::/64', 'reserved'], ['4000::/3', 'reserved']]) {
  ok(CIDR.calc(px).range === kind, `a block wider than a special range goes by where it starts, as before: ${px} is ${kind}`);
}
ok(CIDR.rangeIn('loopback address (::1)') === 'the loopback address (::1)' && CIDR.rangeIn('documentation range (2001:db8::/32, RFC 3849)').startsWith('in the ') &&
  CIDR.rangeIs('whole IPv4 address space') === 'is the whole IPv4 address space' && CIDR.rangeIs(CIDR.calc('10.0.0.0/7').rangeNote).startsWith('starts with the '),
  'one-address entries read "the ...", ranges "in the ...", a /0 "the whole ...", a wider block "starts with the ..." (rangeIn, rangeIs)');

console.log("-- range words in messages: said once, after a colon, never in parentheses within parentheses");
const nested = s => /\([^()]*\(/.test(s || '');
for (const [path, opts, get, want] of [
  ['/api/lookup?ip=192.168.1.1', CURL, r => r.data.error, '192.168.1.1 is not a public address, so there is nothing to look up: it is in the RFC 1918 private range (192.168.0.0/16).'],
  ['/api/lookup?ip=::1', CURL, r => r.data.error, '::1 is not a public address, so there is nothing to look up: it is the loopback address (::1).'],
  ['/api/lookup?ip=192.0.0.9', CURL, r => r.data.error,
    '192.0.0.9 is not a public address, so there is nothing to look up: it is the Port Control Protocol anycast address (192.0.0.9, RFC 7723).'],
  ['/192.0.0.10/text', CURL, r => r.body.trim(), '192.0.0.10 is not a public address, so there is nothing to look up: it is the TURN anycast address (192.0.0.10, RFC 8155).'],
  ['/api/lookup?ip=2001:1::3', CURL, r => r.data.error,
    '2001:1::3 is not a public address, so there is nothing to look up: it is the DNS-SD Service Registration Protocol anycast address (2001:1::3, RFC 9665).'],
  ['/api/lookup?ip=::ffff:808:808', CURL, r => r.data.error,
    '::ffff:808:808 is not a public address, so there is nothing to look up: it is in the IPv4-mapped range (::ffff:0:0/96); look up the IPv4 address instead.'],
  ['/192.168.1.1/asn', CURL, r => r.body.trim(), '192.168.1.1 is not a public address, so there is nothing to look up: it is in the RFC 1918 private range (192.168.0.0/16).'],
  ['/api/whois?q=198.18.0.1', CURL, r => r.data.error, '198.18.0.1 is not a public address, so no registry holds a record for it: it is in the benchmarking range (198.18.0.0/15, RFC 2544).'],
  ['/whois/198.18.0.1', { ua: GOOG }, r => summaryOf(article(r.body)),
    '198.18.0.1 is a non-public address, so no internet registry holds a record for it: it is in the benchmarking range (198.18.0.0/15, RFC 2544).'],
  ['/api/route?q=10.0.0.1', CURL, r => r.data.error, "10.0.0.1 is not a public address, so it isn't routed on the internet: it is in the RFC 1918 private range (10.0.0.0/8)."],
  ['/api/route?q=198.18.0.0/15', CURL, r => r.data.error,
    "198.18.0.0/15 is not public address space, so it isn't routed on the internet: it is in the benchmarking range (198.18.0.0/15, RFC 2544)."],
  ['/api/route?q=10.0.0.0/7', CURL, r => r.data.error, "10.0.0.0/7 is not public address space, so it isn't routed on the internet: it starts with the RFC 1918 private range (10.0.0.0/8)."],
  ['/api/route?q=192.88.99.2/31', CURL, r => r.data.error,
    "192.88.99.2/31 is not public address space, so it isn't routed on the internet: it starts with the 6a44 relay anycast address (192.88.99.2)."],
  ['/api/port?n=22', { ...CURL, 'cf-connecting-ip': '10.0.0.1' }, r => r.data.summary,
    'not tested: 10.0.0.1 is not a public address, so nothing on the internet can reach it: it is in the RFC 1918 private range (10.0.0.0/8).'],
]) {
  const r = await run(path, opts), got = get(r);
  ok(got === want && !nested(got) && !r.kinds.length, `${path}: ${JSON.stringify(got)}`);
}
// The DNS leak test's text answer: a non-public resolver is never looked up, and its words follow a colon.
const leak = await run(`/api/dnsleak?t=${'a'.repeat(20)}&format=text`, CURL, DNSLEAK), leakLines = leak.body.split('\n');
ok(['10.0.0.1  non-public: RFC 1918 private range (10.0.0.0/8)', '198.18.0.1  non-public: benchmarking range (198.18.0.0/15, RFC 2544)',
  'fd00::53  non-public: unique local range (fc00::/7)'].every(l => leakLines.some(x => x.trimEnd().endsWith(l))) &&
  !leakLines.some(nested) && leak.kinds.join() === 'dnsleak', `/api/dnsleak?format=text: ${JSON.stringify(leakLines.filter(l => l.includes('non-public')).map(l => l.replace(/^resolvers/, '').trim()))}`);
const whoisLine = slice(app, '    if (p && classify(p)[0] !== \'public\') {\n      setUrl(\'/whois/\'', "      next([`lookup ${q}`");
ok(whoisLine.includes('so no internet registry holds a record for it: it is ${CIDRLIB.rangeIn(CIDRLIB.special(p)[1])}.') && !/\(\$\{classify/.test(whoisLine),
  "the terminal's whois of a non-public address words it as the whois page does (rangeIn)");

console.log("-- IPinfo's bogons (ipPage, ipText, ipinfoCore and provider in src/worker.js; ipTitle and render in public/app.js)");
// The anycast addresses IPinfo calls bogons are non-public (above), so never looked up. 192.88.99.1 is public in the
// table, but IPinfo calls it a bogon. Googlebot first: it gets IPinfo Lite, and would read a browser's Core answer from the cache.
const BOGON_LEAD = '192.88.99.1 is an IPv4 address in the former 6to4 relay anycast range (192.88.99.0/24, deprecated by RFC 7526).';
const BOGON_TITLE = '192.88.99.1 IP lookup: IPinfo lists it as a bogon | ipterm';
const IPINFO_SAYS = 'IPinfo lists it as a bogon: an address not expected on the public internet';
for (const [what, opts, api] of [['Googlebot', { ua: GOOG }, 'lite'], ['a browser', { ua: CHROME, ...NAV }, 'core']]) {
  const r = await run('/192.88.99.1', opts), h = head(r.body), a = article(r.body);
  fits(`/192.88.99.1 for ${what}, IPinfo ${api === 'lite' ? 'Lite' : 'Core'} answering bogon`, h, BOGON_LEAD);
  ok(r.status === 200 && h.title === BOGON_TITLE && ipTitle('192.88.99.1', r.data) === h.title && h.noindex &&
    a.includes('<span class="tag">IPv4</span> <span class="tag">bogon</span>') && summaryOf(a) === `${BOGON_LEAD} ${IPINFO_SAYS}.` &&
    unesc(rowOf(a, 'range')) === 'former 6to4 relay anycast range (192.88.99.0/24, deprecated by RFC 7526)' &&
    !/in the \.|undefined|null|vpn \/ proxy|public IPv4 address/.test(a) && [...r.kinds].sort().join() === ['dns', api].sort().join(),
    `  ... titled ${JSON.stringify(h.title)} (the terminal's title too), tagged bogon, in IPinfo's name; asked only ${r.kinds.join(' and ')}`);
}
for (const [what, envPlus, source] of [['IPinfo Core', {}, 'ipinfo-core'], ["IPinfo's free API (no IPINFO_TOKEN)", { IPINFO_TOKEN: '' }, 'ipinfo']]) {
  const r = await run('/api/lookup?ip=192.88.99.1', CURL, envPlus), d = r.data || {};
  ok(r.status === 200 && Object.keys(d).sort().join() === 'bogon,hostname,ip,source,version' && d.bogon === true && d.source === source &&
    !r.kinds.some(k => k === 'proxycheck' || k === 'rdap'), `/api/lookup?ip=192.88.99.1 from ${what}: ${JSON.stringify(d)}, no proxycheck.io and no registry`);
}
const bt = await run('/192.88.99.1/text', CURL);
ok(bt.status === 200 && new RegExp(`^bogon +${IPINFO_SAYS}$`, 'm').test(bt.body) && !/vpn \/ proxy/.test(bt.body) && /^source +IPinfo Core$/m.test(bt.body),
  `/192.88.99.1/text: ${JSON.stringify(bt.body.split('\n').filter(l => /^(bogon|source)/.test(l)))}, no vpn / proxy line`);
ok(worker.includes(`const IPINFO_BOGON = '${IPINFO_SAYS}';`) && app.includes(`const IPINFO_BOGON = '${IPINFO_SAYS}';`), "the Worker and the terminal word IPinfo's bogon the same");
// The terminal's lookup of it (render in public/app.js, on stubs): tagged bogon, the range's words and IPinfo's, no VPN line.
let drawn = [];
const tags = [];
const renderIp = Function('classify', 'el', 'SRC', 'shareBar', 'out', 'geoBlock', 'connection', 'vpnText', 'computed', 'kv', 'announce', 'IPINFO_BOGON', 'window',
  slice(app, '  async function render(p, ipText, d, isSelf) {', '  /* ---------- sponsored line') + 'return render;')(
  classify, (tag, cls, text) => { if (/^tag/.test(cls || '')) tags.push(text); return { append() {} }; }, {}, () => null, { appendChild() {} }, () => null,
  () => null, () => 'not checked', () => [], rows => { drawn = rows; }, () => {}, IPINFO_SAYS, { IPTERM_CIDR: CIDR });
await renderIp(parseIp('192.88.99.1'), '192.88.99.1', (await run('/api/lookup?ip=192.88.99.1', CURL)).data, false);
const drew = k => (drawn.find(r => r[0] === k) || [])[1];
ok(tags.includes('bogon') && drew('range') === 'former 6to4 relay anycast range (192.88.99.0/24, deprecated by RFC 7526)' && drew('bogon') === IPINFO_SAYS && !drew('vpn / proxy'),
  `the terminal's lookup 192.88.99.1: tags ${JSON.stringify(tags)}, range and bogon rows, no vpn / proxy row`);

console.log('-- markup from upstream (staticBlock and Markup in src/worker.js)');
// IPinfo answers 74.1.2.9 with { html: "<b ...>x</b>" } for its network name, domain and place (Lite, Core and the free API)
for (const [what, opts, envPlus, asn] of [['IPinfo Lite (Googlebot)', { ua: GOOG }, {}, 'AS7922'], ['IPinfo Core (a browser)', { ua: CHROME, ...NAV }, {}, 'AS7922'],
  ["IPinfo's free API", { ua: CHROME, ...NAV }, { IPINFO_TOKEN: '' }, null]]) {         // the free API's AS number is in org
  const r = await run('/' + ODD, opts, envPlus), d = r.data || {};
  ok(r.status === 200 && !r.body.includes('id="injected"') && !r.body.includes('[object Object]') && d.asn === asn &&
    ['hostname', 'org', 'asDomain', 'city', 'region', 'country', 'countryCode', 'continent', 'timezone'].every(k => d[k] == null),
    `/${ODD} from ${what}: no markup on the page, and each such field null (${JSON.stringify({ org: d.org, asDomain: d.asDomain, country: d.country })})`);
}
const SB = Function(slice(worker, 'function staticBlock(', '/* ---------- robots') + slice(worker, 'const esc = ', '\n') + '\nreturn { staticBlock, Markup };')();
const sb = SB.staticBlock('h', [], [['upstream', { html: '<b>x</b>' }], ['text', '<b>x</b>'], ['ours', new SB.Markup('<a href="/x">x</a>')]], 's');
ok(!sb.includes('<b>') && sb.includes('<dt>upstream</dt><dd>[object Object]</dd>') && sb.includes('<dt>text</dt><dd>&lt;b&gt;x&lt;/b&gt;</dd>') &&
  sb.includes('<dt>ours</dt><dd><a href="/x">x</a></dd>'), 'staticBlock: { html: "<b>x</b>" } and "<b>x</b>" are escaped text, only Markup is printed as markup');

// IANA's own files, when given: the copies above and the names in public/ports.js against them.
function parseCsv(s) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
for (const file of process.argv.slice(2)) {
  const [hd, ...rows] = parseCsv(readFileSync(file, 'utf8')), col = k => hd.indexOf(k);
  if (col('Service Name') >= 0) {
    console.log(`-- public/ports.js against ${file}`);
    const [N, P, T] = ['Service Name', 'Port Number', 'Transport Protocol'].map(col);
    const names = (n, proto) => [...new Set(rows.filter(r => r[P] === String(n) && r[T] === proto && r[N]).map(r => r[N]))];
    for (const n of PORTS.list()) {
      const s = PORTS.get(n), protos = s.proto === 'tcp+udp' ? ['tcp', 'udp'] : [s.proto], got = protos.map(p => names(n, p).join(' '));
      ok(got.every(g => g === got[0]) && got[0] === PORTS.iana(n).names.join(' '), `${n}/${s.proto}: IANA has ${JSON.stringify(got[0])}, ports.js ${JSON.stringify(PORTS.iana(n).names.join(' '))}`);
    }
  } else if (col('Address Block') >= 0) {
    console.log(`-- the registry copy above against ${file}`);
    const [B, G] = ['Address Block', 'Globally Reachable'].map(col);
    const blocks = rows.filter(r => r[B]).flatMap(r => r[B].split(',').map(b => [b.replace(/\s*\[\d+\]/, '').trim(), (r[G] || '').replace(/\s*\[\d+\]/, '').trim()]));
    for (const [b, gr] of blocks) {
      const mine = REGISTRY.find(x => x[0] === b);
      ok(mine && mine[2] === gr, `${b}: globally reachable ${JSON.stringify(gr)}, the copy has ${mine ? JSON.stringify(mine[2]) : 'no row'}`);
    }
    const v = blocks.some(([b]) => b.includes(':')) ? ':' : '.';
    ok(REGISTRY.filter(([b]) => b.includes(':') === (v === ':')).every(([b]) => blocks.some(x => x[0] === b)), `... and the copy has no ${v === ':' ? 'IPv6' : 'IPv4'} row the file lacks`);
  } else ok(false, `${file}: not one of IANA's port or special-purpose registry CSVs`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
