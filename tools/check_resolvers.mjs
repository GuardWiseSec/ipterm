// Checks the public DNS resolvers: public/resolvers.js, the resolver block on each address's IP page, /public-dns, the
// resolvers' sitemap and the terminal's lookup and public-dns. No server and no network: the whole Worker runs in Node,
// as in tools/check_corrections.mjs, with its static files read from public/ and fetch stubbed to answer as IPinfo,
// proxycheck.io, DNS, RDAP and RIPEstat would and to note every request, and parts of public/app.js run against a
// stand-in DOM.
//
// 1. The data: every address public, in its short form (RFC 5952 for IPv6) and listed once, and found however it is
//    written; every service with an operator, variants, sources and only plain ASCII text; LAST_CHECKED a real date;
//    anycast only for the services whose operator says so, with that page among its sources; Control D's own variants
//    only; the fixes from checking the rows against their sources.
// 2. Every resolver page, as Googlebot sees it: indexable, titled and described as the resolver (RESOLVERS.title(),
//    lead(); "filtering" only for a service with a variant that filters), with no place in its title, description or
//    summary (IPinfo Lite gives every one "Australia" here), and "Anycast: answered from many locations" only where the
//    operator says so; the lookup's rows as IPinfo gives them, its location and connection rows too, as /<ip>/json
//    does; its resolver block row for row: the service, operator, variant, filtering where documented, its own
//    addresses with this one marked, DoH and DoT, "served from" and the anycast tag where the operator says so, the
//    routing link, the DNSSEC, ECS and logging lines only where documented, every other variant's addresses linked,
//    /public-dns#<id>, every source, "last checked", leaktest, and the corrections line with the field "resolver"; no
//    IPinfo pointer and no sponsored line; and no request but IPinfo Lite and reverse DNS.
// 3. Routing: a person's page asks RIPEstat nothing and links /route/<ip>; once a route lookup has cached it, the page
//    shows it, to Googlebot too, with no RIPEstat request; the curated routing list is still the three /cidr pages. A
//    page that throws while it is drawn still gets guard()'s 502 page and log line, though ipRoute's ok is async.
// 4. /public-dns: the page (every address linked once, every service's anchor, anycast where the operator says so, a
//    variant with no documented filtering by its name alone, every source, the date, leaktest, the line, indexable, no
//    outside request, the same for Googlebot, noindex on a copy), the text for curl (every address, endpoint and
//    source, no empty filtering line, 80 columns but for a long source address, plain ASCII) and the JSON
//    (public/resolvers.js).
// 5. The sitemaps: /sitemap.xml lists /sitemap-resolvers.xml with its <lastmod>; that file lists /public-dns and every
//    address, each with RESOLVERS.checked; /sitemap-pages.xml lists none of them.
// 6. The terminal: resolverAbout() draws the Worker's rows and tags in the same order for every address, links
//    /public-dns#<id> and asks for the routing live, lookup() draws it in place of IPinfo's pointer and the sponsored
//    line, ipTitle() agrees with the page, public-dns lists every address and takes a service, and the command is in
//    help, man, the aliases and the did-you-mean list.
// 7. The wiring and the docs: index.html, wrangler.toml, the Worker's import, /go, typos of the addresses (a 301 to
//    the address), the guides, /help, llms.txt, openapi.json, /changes (its count, and its titles, descriptions and
//    summaries, not the location row) and docs/handbook.md (its counts too).
//
//   node tools/check_resolvers.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const app = read('public/app.js'), worker = read('src/worker.js'), handbook = read('docs/handbook.md'), toml = read('wrangler.toml');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_resolvers.mjs`);
  return src.slice(a, b);
}

const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_resolvers.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const store = new Map();
globalThis.caches = { default: {
  async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, { body: await res.text(), headers: [...res.headers] }); },
} };

// IPinfo Core places every address in a city (Zurich), anycast or not: 114.114.114.114 isn't flagged anycast here.
// IPinfo Lite, which Googlebot gets, gives them all one country, as it gives 1.1.1.1 Australia on the live site.
const calls = [];
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  let m;
  if ((m = /^https:\/\/api\.ipinfo\.io\/lookup\/([^?]+)/.exec(u))) {
    calls.push(['core', u]);
    return reply({ ip: m[1], geo: { city: 'Zurich', region: 'Zurich', country: 'Switzerland', country_code: 'CH', continent: 'Europe', latitude: 47.37, longitude: 8.54, timezone: 'Europe/Zurich' },
      as: { asn: 'AS64500', name: 'Example Resolver Network', type: 'hosting' }, ...(m[1].startsWith('114.') ? {} : { is_anycast: true }) });
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lite\/([^?]+)/.exec(u))) {
    calls.push(['lite', u]);
    return reply({ ip: m[1], asn: 'AS64500', as_name: 'Example Resolver Network', as_domain: 'example.net', country_code: 'AU', country: 'Australia', continent: 'Oceania' });
  }
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u))) {
    calls.push(['proxycheck', u]);
    return reply({ status: 'ok', [m[1]]: { network: { type: 'hosting' }, detections: { proxy: false, vpn: false, tor: false, hosting: true, anonymous: false, risk: 0 } } });
  }
  if (/^https:\/\/cloudflare-dns\.com\/dns-query\?/.test(u)) { calls.push(['dns', u]); return reply({ Status: 3, Answer: [] }); }
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    calls.push(['rdap', u]);
    return reply({ services: [[m[1] === 'ipv4' ? ['0.0.0.0/0'] : m[1] === 'ipv6' ? ['::/0'] : m[1] === 'asn' ? ['1-4294967295'] : ['org'], ['https://rdap.test/']]] });
  }
  if (/^https:\/\/rdap\.test\//.test(u)) { calls.push(['rdap', u]); return reply({ errorCode: 404 }, 404); }
  if ((m = /^https:\/\/stat\.ripe\.net\/data\/([a-z-]+)\/data\.json\?(.*)$/.exec(u))) {
    calls.push(['ripestat', u]);
    const q = new URLSearchParams(m[2]), res = q.get('resource') || '';
    switch (m[1]) {
      case 'prefix-overview': return reply({ data: { resource: '9.9.9.0/24', announced: true, asns: [{ asn: 19281, holder: 'QUAD9-AS-1 - Quad9' }], block: { desc: 'ARIN' }, related_prefixes: [] } });
      case 'routing-status': return reply({ data: { visibility: { v4: { ris_peers_seeing: 300, total_ris_peers: 320 } } } });
      case 'bgp-state': return reply({ data: { bgp_state: [{ target_prefix: res.split('&')[0], path: [3333, 1299, 19281], source_id: '00-193.0.0.56' }] } });
      case 'rpki-validation': return reply({ data: { status: 'valid', validating_roas: [{ origin: '19281', prefix: q.get('prefix'), max_length: 24 }] } });
    }
  }
  calls.push(['other', u]);
  return new Response('not stubbed in tools/check_resolvers.mjs', { status: 404 });
};

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', txt: 'text/plain', xml: 'application/xml', css: 'text/css' };
const ASSETS = { async fetch(req) {
  const p = decodeURIComponent(new URL(req.url).pathname);
  for (const f of p === '/' ? ['index.html'] : [p.slice(1), p.slice(1) + '.html']) {
    const file = new URL('public/' + f, root);
    if (!p.includes('..') && existsSync(file) && statSync(file).isFile()) {
      return new Response(readFileSync(file), { headers: { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream' } });
    }
  }
  return new Response('Not Found', { status: 404 });
} };
const tomlVar = k => (new RegExp(`^${k} = "([^"]*)"`, 'm').exec(toml) || [])[1];
const env = {
  IPINFO_TOKEN: 'test-token', IPINFO_PLAN: 'core', PROXYCHECK_KEY: 'test-key', SOURCE_URL: tomlVar('SOURCE_URL'), SELF_HOSTED: tomlVar('SELF_HOSTED'),
  BUDGET: { idFromName: name => name, get: () => ({ async take() { return { ok: true }; } }) }, ASSETS,
};
const { default: W } = await import('../src/worker.js');
const R = globalThis.IPTERM_RESOLVERS, CIDR = globalThis.IPTERM_CIDR;

const ME = '81.2.69.142';
const GOOG = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV = { ua: CHROME, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const BOT = { ua: GOOG }, CURL = { ua: 'curl/8.7.1', accept: '*/*' };
async function run(path, { ua, ...headers }, envPlus = {}) {
  calls.length = 0;
  const waits = [];
  const res = await W.fetch(new Request('https://ipterm.net' + path, { headers: { 'user-agent': ua, 'cf-connecting-ip': ME, ...headers } }),
    { ...env, ...envPlus }, { waitUntil: p => waits.push(p) });
  const body = await res.text();
  await Promise.allSettled(waits);
  return { status: res.status, type: res.headers.get('content-type') || '', body, kinds: calls.map(c => c[0]) };
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unesc = s => (s == null ? s : s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
const pick = (re, s) => unesc((re.exec(s) || [])[1]);
const head = body => ({
  title: pick(/<title>([^<]*)<\/title>/, body), desc: pick(/<meta name="description" content="([^"]*)">/, body),
  og: pick(/<meta property="og:description" content="([^"]*)">/, body), ogTitle: pick(/<meta property="og:title" content="([^"]*)">/, body),
  h1: pick(/<h1 class="sr-only">([^<]*)<\/h1>/, body), noindex: /<meta name="robots" content="noindex/.test(body),
  canonical: pick(/<link rel="canonical" href="([^"]*)">/, body),
});
const article = body => (/<article class="static" id="static">[\s\S]*?<\/article>/.exec(body) || [''])[0];
// The resolver block: its header line, the rows of the dl after it, and the corrections line that closes it
function block(body) {
  const a = article(body), at = a.indexOf('<div class="head"><span class="hip">', a.indexOf('</dl>'));
  if (at < 0) return null;
  const rest = a.slice(at), dl = (/<dl class="kv">([\s\S]*?)<\/dl>/.exec(rest) || [])[1] || '';
  return { head: rest.slice(0, rest.indexOf('</div>') + 6), rows: [...dl.matchAll(/<dt>([^<]*)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map(m => [unesc(m[1]), m[2]]),
    fix: (/<\/dl>(<p class="ln sys fix">[\s\S]*?<\/p>)/.exec(rest) || [])[1] || '' };
}
const today = new Date().toISOString().slice(0, 10);
// The sponsored line (public/sponsors.json's link), never on a reference page. The footer's "sponsored links are
// labeled" isn't it.
const SPONSORED = /aff_sub|getproton|class="[^"]*\bsponsor\b/i;
const realDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s && s <= today;
const list = R.list(), all = list.flatMap(s => s.variants.flatMap(x => [...x.ipv4, ...x.ipv6]));
const parseIp = s => { const p = CIDR.calc(s); return p.error ? null : p; };

console.log('-- the data (public/resolvers.js)');
const file = read('public/resolvers.js');
ok(realDate(R.checked) && file.includes(`const LAST_CHECKED = '${R.checked}';`), `LAST_CHECKED is a real date, not in the future: ${R.checked}`);
ok(list.map(s => s.id).join() === 'google,cloudflare,quad9,opendns,adguard,cleanbrowsing,controld,yandex,114dns,alidns,dnssb' && list.every(s => /^[a-z0-9]+$/.test(s.id)),
  `${list.length} services, each with its own id: ${list.map(s => s.id).join(', ')}`);
ok(list.every(s => [s.service, s.short, s.brand, s.operator].every(t => typeof t === 'string' && t.trim()) && s.variants.length &&
  s.sources.length && s.sources.every(u => /^https?:\/\/[^\s"'<>]+$/.test(u)) && ['dnssec', 'ecs', 'logging'].every(k => typeof s[k] === 'string')),
  'every service has a name, a short name, an operator, variants and sources (links), and DNSSEC, ECS and logging lines or none');
// What it filters is '' where the operator says nothing of it (OpenDNS's Sandbox, AliDNS): no row, no line
const unsaid = list.flatMap(s => s.variants.filter(x => !x.filtering).map(x => `${s.id} ${x.name}`));
ok(list.every(s => s.variants.every(x => x.name.trim() && typeof x.filtering === 'string' && x.filtering === x.filtering.trim() && x.ipv4.length + x.ipv6.length > 0 &&
  (!x.doh || /^https:\/\/[a-z0-9.-]+\/\S*$/.test(x.doh)) && (!x.dot || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(x.dot)))) &&
  unsaid.join() === 'opendns Sandbox,alidns AliDNS',
  `every variant has a name, what it filters ('' only where undocumented: ${unsaid.join(', ')}) and an address; a DoH URL is https and a DoT host a host name`);
// Anycast only where the operator's own page says so, and that page is one of its sources
const anycast = list.filter(s => s.anycast);
ok(anycast.map(s => s.id).join() === 'google,cloudflare,quad9,opendns,adguard,cleanbrowsing,controld,114dns,dnssb' && anycast.every(s => s.sources.includes(s.anycast)) &&
  list.every(s => typeof s.anycast === 'string'), `anycast where the operator says so, its page among the sources: ${anycast.map(s => `${s.id} (${s.anycast})`).join(', ')}`);
const cd = list.find(s => s.id === 'controld');
ok(cd.variants.map(x => x.ipv4[0]).join() === '76.76.2.0,76.76.2.1,76.76.2.2,76.76.2.3,76.76.2.4,76.76.2.5' && !R.get('76.76.2.32') && !R.get('2606:1a40:1::46') &&
  !R.get('194.242.2.2') && !R.get('2a07:e340::9'), "Control D's own six variants only (no third-party blocklist), and Mullvad's addresses are no resolver here");
const x110 = R.get('114.114.114.110').variant, cfLog = R.get('1.1.1.1').service.logging;
ok(R.get('208.67.220.220').variant.doh === 'https://doh.umbrella.com/dns-query' && !/family/i.test(x110.name) && /schools or parents/.test(x110.filtering) &&
  !/whitelist/.test(R.get('8.8.8.8').service.ecs) && /except limited sampled log data .*indefinitely/.test(cfLog),
  `the rows as their sources give them: OpenDNS's DoH from Cisco's newest page, 114.114.114.110 "${x110.name}", Google's ECS line, Cloudflare's aggregates`);
const strings = list.flatMap(s => [s.id, s.service, s.short, s.brand, s.operator, s.dnssec, s.ecs, s.logging, s.anycast, ...s.sources,
  ...s.variants.flatMap(x => [x.name, x.filtering, x.doh, x.dot])]);
ok(strings.every(t => /^[ -~]*$/.test(t)) && [...file].every(c => /[\n -~]/.test(c) || c === '·'),
  'every value is plain ASCII, and the file has no other character but the title\'s "·"');
ok(!/see uncertain|researcher|\bTODO\b/i.test(file), 'no working notes left in the text');
// An address as the special-purpose table takes it (parseIp() in src/worker.js)
const groups = s => { const [h, t] = s.includes('::') ? s.split('::') : [s, null], hp = h ? h.split(':') : [], tp = t ? t.split(':') : [];
  return [...hp, ...Array(t === null ? 0 : 8 - hp.length - tp.length).fill('0'), ...tp].map(x => parseInt(x, 16)); };
const ipOf = s => (s.includes(':') ? { v: 6, g: groups(s) } : { v: 4, o: s.split('.').map(Number) });
const bad = all.filter(ip => { const p = parseIp(ip); return !p || p.network !== ip || p.range !== 'public' || CIDR.special(ipOf(ip))[0] !== 'public'; });
ok(all.length === 118 && new Set(all).size === all.length && !bad.length, `${all.length} addresses, each listed once, public and in its short form${bad.length ? ': not ' + bad.join(', ') : ''}`);
ok(all.every(ip => R.get(ip) && R.get(ip).ip === ip && R.get(ip.toUpperCase()).ip === ip && R.get(' ' + ip + ' ').ip === ip), '... and found as listed, in capitals and with spaces around');
ok(R.get('2606:1a40:0:0:0:0:0:0').ip === '2606:1a40::' && R.get('2606:1a40::0').ip === '2606:1a40::' && R.get('2a02:6b8::feed:0ff').ip === '2a02:6b8::feed:ff' &&
  R.get('2001:4860:4860:0000:0000:0000:0000:8888').ip === '2001:4860:4860::8888', '... however IPv6 is written: in full, with ::0, or with leading zeros');
ok(!R.get('8.8.8.9') && !R.get('not-an-ip') && !R.get('') && !R.get(null) && !R.get('2606:1a40::1:1') && !R.get('1:2:3:4:5:6:7:8:9'), 'an address that is no resolver, or no address, is none');
const plainOnes = list.filter(s => !R.filters(s)).map(s => s.id);
ok(plainOnes.join() === 'google,alidns,dnssb' && list.every(s => R.title(R.get(s.variants[0].ipv4[0])).includes('filtering') === !plainOnes.includes(s.id)),
  `"filtering" in the title only for a service with a variant that filters: not ${plainOnes.join(', ')}`);
ok(R.label('9.9.9.10 (Unsecured / No Threat Blocking)') === 'Unsecured / No Threat Blocking' && R.label('1.1.1.1') === '' && R.label('Unfiltered (p0)') === 'Unfiltered, p0',
  'a variant in a sentence: "Unsecured / No Threat Blocking", nothing for "1.1.1.1", "Unfiltered, p0"');
ok(R.others(R.get('9.9.9.9')) === 'Secondary 149.112.112.112, IPv6 2620:fe::fe.' && R.others(R.get('149.112.112.112')) === 'Primary 9.9.9.9, IPv6 2620:fe::fe.' &&
  R.others(R.get('8.8.4.4')) === 'Also 8.8.8.8, IPv6 2001:4860:4860::8888.' && R.others(R.get('114.114.115.115')) === 'Primary 114.114.114.114.' &&
  R.others(R.get('2a09::')) === 'Secondary 2a11::, IPv4 185.222.222.222.', 'the addresses set beside it: secondary or primary, "also" where the operator has no order, the other IP version');

console.log('-- every resolver page, as Googlebot sees it (ipPage, resolverText and resolverBlock in src/worker.js)');
const pages = new Map(), probs = { index: [], title: [], desc: [], place: [], rows: [], links: [], fix: [], quiet: [], extra: [] };
for (const ip of all) {
  const r = R.get(ip), s = r.service, x = r.variant, page = await run('/' + ip, BOT), h = head(page.body), b = block(page.body);
  pages.set(ip, page);
  if (page.status !== 200 || h.noindex || h.canonical !== 'https://ipterm.net/' + ip) probs.index.push(ip);
  if (h.title !== R.title(r) || h.ogTitle !== h.title || h.h1 !== h.title.replace(/ \| ipterm$/, '')) probs.title.push(ip);
  if (!h.desc || h.desc.length > 155 || !h.desc.startsWith(R.lead(r)) || h.og !== h.desc) probs.desc.push(`${ip} (${h.desc})`);
  const summary = unesc((/<p class="ln">([^<]*)<\/p>/.exec(article(page.body)) || [])[1] || '');
  if (/Australia|located in|approximate/.test(h.title + h.desc + summary) || !summary.startsWith(R.lead(r)) ||
    summary.includes('Anycast: answered from many locations.') !== Boolean(s.anycast) || /anycast/i.test(h.title + h.desc)) probs.place.push(ip);
  if (!b) { probs.rows.push(ip + ' (no block)'); continue; }
  const row = k => (b.rows.find(([key]) => key === k) || [])[1], text = k => unesc(row(k) || '');
  const own = (list, k) => (list.length ? row(k) === list.map(a => (a === ip ? `${esc(a)} (this address)` : `<a href="/${esc(a)}">${esc(a)}</a>`)).join(' · ') : row(k) === undefined);
  const want = [['service', s.service], ['operator', s.operator], ['filtering', x.filtering || undefined], ['DNS over HTTPS', x.doh || undefined], ['DNS over TLS', x.dot || undefined],
    ['DNSSEC', s.dnssec || undefined], ['client subnet', s.ecs || undefined], ['logging', s.logging || undefined],
    ['served from', s.anycast ? 'anycast: answered from many locations' : undefined], ['last checked', R.checked]];
  if (b.head !== `<div class="head"><span class="hip">${esc(s.short)}</span> <span class="tag">public DNS resolver</span>${s.anycast ? ' <span class="tag">anycast</span>' : ''}</div>` ||
    want.some(([k, v]) => (v === undefined ? row(k) !== undefined : text(k) !== v)) || text('variant') !== (s.variants.length > 1 ? x.name : '') ||
    !own(x.ipv4, 'IPv4') || !own(x.ipv6, 'IPv6') || ['status', 'note'].some(k => row(k) !== undefined) ||
    row('routing') !== `<a href="/route/${ip}" rel="nofollow">route ${ip}</a>: who announces it, RPKI and AS paths, from RIPEstat`) probs.rows.push(ip);
  const dl = b.rows.map(([, v]) => v).join('\n');
  const others = s.variants.filter(o => o !== x).flatMap(o => [...o.ipv4, ...o.ipv6]);
  if (!others.every(a => dl.includes(`<a href="/${a}">${a}</a>`)) || b.rows.filter(([k]) => k === 'other variants').length !== (others.length ? 1 : 0) ||
    !s.sources.every(u => dl.includes(`<a href="${esc(u)}" rel="noopener">`)) || !dl.includes(`<a href="/public-dns#${s.id}">public DNS resolvers</a>`) ||
    row('your resolver') !== 'See which resolver you actually use: <a href="/leaktest">leaktest</a>') probs.links.push(ip);
  if (!b.fix.includes(`field=resolver"`) || !b.fix.includes(encodeURIComponent('https://ipterm.net/' + ip)) || (page.body.match(/Something wrong here\?/g) || []).length !== 1 ||
    page.body.includes('ipinfo.io/corrections')) probs.fix.push(ip);
  if (page.kinds.some(k => k !== 'lite' && k !== 'dns')) probs.quiet.push(`${ip} ${JSON.stringify(page.kinds)}`);
  if (SPONSORED.test(page.body)) probs.extra.push(ip);
}
const said = (k, what) => ok(!probs[k].length, `${what}${probs[k].length ? ': not ' + probs[k].slice(0, 5).join(', ') + (probs[k].length > 5 ? ` and ${probs[k].length - 5} more` : '') : ''}`);
said('index', `all ${all.length} resolver pages answer Googlebot 200, indexable, canonical (network starts such as 76.76.2.0 and 2606:1a40:: too)`);
said('title', '... titled as the resolver ("9.9.9.9 · Quad9 DNS: addresses, DoH, DoT and filtering"), og:title and h1 the same');
said('desc', '... described in 155 characters or less, starting with what the address is, og:description the same');
said('place', `... with no place in the title, description or summary (IPinfo Lite says Australia), and "Anycast: answered from many locations." in the summary only for the ${anycast.length} services whose operator says so`);
said('rows', '... the resolver block: service, operator, variant, its own addresses (this one marked), DoH, DoT, routing, last checked; filtering, DNSSEC, ECS and logging only where documented; served from and the anycast tag only where the operator says anycast');
said('links', '... every other variant\'s addresses, every source (rel="noopener"), /public-dns#<id> and leaktest linked');
said('fix', '... the corrections line once, with the field "resolver", and no IPinfo pointer');
said('quiet', '... asking nothing but IPinfo Lite and reverse DNS: no Core, proxycheck.io, RIPEstat or registry');
said('extra', '... and no sponsored line');
const sample = pages.get('9.9.9.9'), sh = head(sample.body);
ok(sh.title === '9.9.9.9 · Quad9 DNS: addresses, DoH, DoT and filtering | ipterm' &&
  sh.desc === "9.9.9.9 is Quad9's public DNS resolver (Recommended / Secure). Secondary 149.112.112.112, IPv6 2620:fe::fe. DoH, DoT, filtering variants and live routing.",
  `/9.9.9.9: ${JSON.stringify(sh.title)}, ${JSON.stringify(sh.desc)}`);
const one = pages.get('1.1.1.1');
ok(head(one.body).desc === "1.1.1.1 is Cloudflare's public DNS resolver. Secondary 1.0.0.1, IPv6 2606:4700:4700::1111. DoH, DoT, filtering variants and live routing." &&
  /<dt>location<\/dt><dd>Australia<\/dd>/.test(article(one.body)) && !/<dt>connection<\/dt>/.test(article(one.body)),
  `/1.1.1.1 for Googlebot: no "located in Australia", and the lookup's rows as IPinfo Lite gives them: its location row, no connection row`);
const ho = head(pages.get('114.114.114.114').body);
ok(ho.title === '114.114.114.114 · 114DNS: addresses and filtering | ipterm', `a service with no DoH or DoT says so in its title: ${JSON.stringify(ho.title)}`);
const hg = head(pages.get('8.8.8.8').body), ha = head(pages.get('223.5.5.5').body);
ok(hg.title.endsWith(': addresses, DoH and DoT | ipterm') && ha.title.endsWith(': addresses, DoH and DoT | ipterm') &&
  hg.desc === "8.8.8.8 is Google's public DNS resolver. Also 8.8.4.4, IPv6 2001:4860:4860::8888. DoH, DoT and live routing.",
  `a service none of whose variants filters says no "filtering": ${JSON.stringify(hg.title)}, ${JSON.stringify(ha.title)}`);
const adg = pages.get('77.88.8.8'), adb = block(adg.body);
ok(!/anycast/i.test(adb.head + adb.rows.map(([k, v]) => k + v).join('')) && !/Anycast|Australia|located in/.test(unesc((/<p class="ln">([^<]*)<\/p>/.exec(article(adg.body)) || [])[1] || '')) &&
  /<dt>location<\/dt><dd>Australia<\/dd>/.test(article(adg.body)), "/77.88.8.8 (Yandex, not marked anycast): no anycast tag, row or sentence, still no place in the summary, IPinfo's location row kept");
const sb = block(pages.get('208.67.222.2').body);
ok(!sb.rows.some(([k]) => k === 'filtering') && sb.rows.some(([k, v]) => k === 'variant' && v === 'Sandbox'), "/208.67.222.2 (OpenDNS's Sandbox, whose filtering Cisco doesn't describe): no filtering row");

console.log('-- a person, and routing from the cache only (ipRoute)');
const person = await run('/114.114.114.114', NAV), pb = block(person.body);
ok(person.status === 200 && person.kinds.includes('core') && !person.kinds.includes('ripestat') && !/Zurich|located in/.test(head(person.body).desc) &&
  !person.body.includes('ipinfo.io/corrections') && pb && pb.fix.includes('field=resolver'),
  `a browser on /114.114.114.114 (IPinfo Core: Zurich, not flagged anycast): requests ${JSON.stringify([...new Set(person.kinds)])}, no place, no IPinfo pointer, the resolver's line`);
const nav9 = await run('/9.9.9.9', NAV);
ok(/<dt>connection<\/dt><dd>hosting or data center<\/dd>/.test(article(person.body)) && /<dt>connection<\/dt><dd>hosting or data center · anycast \(served from many locations\)<\/dd>/.test(article(nav9.body)),
  "... its connection row is IPinfo's, as /<ip>/json gives it: not anycast for 114.114.114.114, anycast for 9.9.9.9, which Core flags");
ok(!nav9.kinds.includes('ripestat') && (block(nav9.body).rows.find(([k]) => k === 'routing') || [])[1].startsWith('<a href="/route/9.9.9.9" rel="nofollow">'),
  'a browser on /9.9.9.9 asks RIPEstat nothing: routing is a link while nothing is cached');
const rt = await run('/route/9.9.9.9', CURL);
ok(rt.status === 200 && rt.kinds.includes('ripestat'), `curl /route/9.9.9.9 looks the routing up (RIPEstat, ${rt.kinds.filter(k => k === 'ripestat').length} requests) and caches it`);
const routed = r => ((block(r.body) || { rows: [] }).rows.find(([k]) => k === 'routing') || [])[1] || '';
const nav9b = await run('/9.9.9.9', NAV), bot9 = await run('/9.9.9.9', BOT);
ok(/^9\.9\.9\.9 is routed in 9\.9\.9\.0\/24, announced by AS19281 \(Quad9\)\..* \(<a href="\/route\/9\.9\.9\.9" rel="nofollow">route 9\.9\.9\.9<\/a>\)$/.test(unesc(routed(nav9b))) &&
  routed(bot9) === routed(nav9b) && !nav9b.kinds.includes('ripestat') && !bot9.kinds.includes('ripestat'),
  `then the page shows it, to Googlebot too, with no RIPEstat request: ${JSON.stringify(unesc(routed(bot9)).slice(0, 90))}...`);
const paths = slice(worker, 'const SITEMAP_PATHS = [', '\n];');
const curatedR = [...paths.matchAll(/'\/cidr\/([^']+)'/g)].map(x => x[1]).filter(c => CIDR.calc(c).range === 'public');
ok(worker.includes("const curatedRoutes = () => curatedR || (curatedR = new Set(SITEMAP_PATHS.filter(p => p.startsWith('/cidr/')).map(p => p.slice(6))));") &&
  curatedR.join() === '1.1.1.0/24,8.8.8.0/24,9.9.9.0/24' && !all.some(ip => paths.includes(`'/${ip}'`) || paths.includes(`'/cidr/${ip}/`)),
  'the curated routing list is still the three /cidr pages: no resolver range was added, and SITEMAP_PATHS lists no resolver address');
// A mistake in drawing the page (here RESOLVERS.title() throwing) is guard()'s to catch, as on any IP page, though
// ipRoute's ok waits for the cached routing: ipterm's 502 page and a log line, not a failed request (Cloudflare's 1101).
const title = R.title, logError = console.error, logged = [];
R.title = () => { throw new Error('a mistake in the page'); };
console.error = (...a) => logged.push(a.join(' '));
let broken;
try { broken = await run('/9.9.9.9', BOT); } catch (e) { broken = { status: 'the request failed: ' + e.message, body: '' }; }
finally { R.title = title; console.error = logError; }
ok(broken.status === 502 && unesc(broken.body).includes("A data source didn't respond.") && logged.some(l => l.includes('a mistake in the page')),
  `a page that throws while it is drawn gets guard()'s 502 page, and the log line: ${broken.status}`);

console.log('-- /public-dns (publicDnsRoute and publicDnsText in src/worker.js)');
const pd = await run('/public-dns', NAV), pdb = await run('/public-dns', BOT), ph = head(pd.body);
ok(pd.status === 200 && pd.type.startsWith('text/html') && ph.title === 'Public DNS resolvers: IP addresses, DoH, DoT and filtering | ipterm' && ph.desc && ph.desc.length <= 155 &&
  ph.og === ph.desc && ph.canonical === 'https://ipterm.net/public-dns' && !ph.noindex, `a browser gets the page: ${JSON.stringify(ph.title)}, ${JSON.stringify(ph.desc)}`);
ok(all.every(ip => pd.body.split(`<a href="/${ip}">${ip}</a>`).length === 2), `... every one of the ${all.length} addresses linked to its page, once`);
ok(list.every(s => pd.body.includes(`<tbody id="${s.id}">`) && s.sources.every(u => pd.body.includes(`<a href="${esc(u)}" rel="noopener">`)) &&
  s.variants.every(x => pd.body.includes(esc(x.filtering)) && (!x.doh || pd.body.includes(`<code>${esc(x.doh)}</code>`)) && (!x.dot || pd.body.includes(`<code>${esc(x.dot)}</code>`)))),
  '... every service anchored by its id (/public-dns#quad9), with its variants\' filtering, DoH and DoT, and every source linked');
ok(new RegExp(`Last checked ${R.checked} \\S ${list.length} services \\S ${all.length} addresses</p>`).test(pd.body) && pd.body.includes('<a href="/leaktest">leaktest</a>') &&
  pd.body.includes('A service marked anycast is one whose operator says each address is answered from many locations.') &&
  (pd.body.match(/Something wrong here\?/g) || []).length === 1 && pd.body.includes('<p class="doc-meta">Something wrong here?'),
  `... "last checked", ${list.length} services and ${all.length} addresses, what anycast means, leaktest, and the corrections line once`);
const tbody = id => (new RegExp(`<tbody id="${id}">[\\s\\S]*?</tbody>`).exec(pd.body) || [''])[0];
ok(list.every(s => tbody(s.id).includes('<br><span class="doc-meta">anycast</span>') === Boolean(s.anycast)) &&
  tbody('opendns').includes('<td>Sandbox</td>') && tbody('alidns').includes('<td>AliDNS</td>') && !pd.body.includes('<h2>Notes</h2>'),
  `... anycast marked for the ${anycast.length} services whose operator says so, a variant with no documented filtering by its name alone, and no notes`);
ok(pdb.body === pd.body && !pd.kinds.length && !pdb.kinds.length && !SPONSORED.test(pd.body), 'Googlebot gets the same page; neither makes an outside request; no sponsored line');
const copyPage = (await run('/public-dns', NAV, { SELF_HOSTED: 'true' })).body;
ok(copyPage.includes('<meta name="robots" content="noindex, follow">') && !copyPage.includes('Something wrong here'), 'a copy run by someone else: noindex, and no corrections line');
const txt = await run('/public-dns', CURL), lines = txt.body.trimEnd().split('\n');
const long = lines.filter(l => l.length > 80 && !/^ +(sources +)?https?:\/\/\S+$/.test(l));
ok(txt.status === 200 && txt.type.startsWith('text/plain') && /^[\n -~]*$/.test(txt.body) && !long.length && lines[0].startsWith('Public DNS resolvers, from each operator'),
  `curl gets plain text: ${lines.length} lines, none past 80 columns but a source address alone on its line${long.length ? ': ' + long[0] : ''}`);
ok(all.every(ip => new RegExp(`(^| )${ip.replace(/[.]/g, '\\.')}( |$)`, 'm').test(txt.body)) && list.every(s => s.sources.every(u => txt.body.includes(u)) &&
  s.variants.every(x => (!x.doh || txt.body.includes(x.doh)) && (!x.dot || txt.body.includes(x.dot)))) && !/Something wrong|issues\/new/.test(txt.body),
  '... with every address, DoH URL, DoT host and source, and no corrections line');
ok((txt.body.match(/^ {4}filtering {2}\S/gm) || []).length === list.flatMap(s => s.variants).filter(x => x.filtering).length && !/^ +filtering *$/m.test(txt.body) &&
  (txt.body.match(/^ {2}served from {2}anycast: answered from many locations$/gm) || []).length === anycast.length,
  `... a filtering line for every variant but the ${unsaid.length} with none documented, and "served from  anycast" for the ${anycast.length} services whose operator says so`);
ok((await run('/public-dns?format=text', NAV)).body === txt.body, '?format=text gives a browser the same text');
const js = await run('/public-dns?format=json', CURL);
let jd = null; try { jd = JSON.parse(js.body); } catch {}
ok(js.status === 200 && jd && jd.checked === R.checked && !('anycast' in jd) && jd.services.length === list.length && jd.services.every((s, i) => s.id === list[i].id &&
  s.operator === list[i].operator && s.sources.join() === list[i].sources.join() && s.variants.every((x, j) => { const y = list[i].variants[j];
    return x.name === y.name && x.filtering === (y.filtering || null) && x.ipv4.join() === y.ipv4.join() && x.ipv6.join() === y.ipv6.join() && x.doh === (y.doh || null) && x.dot === (y.dot || null); }) &&
  s.dnssec === (list[i].dnssec || null) && s.anycast === Boolean(list[i].anycast) && s.anycastSource === (list[i].anycast || null) && !('ends' in s) && !('note' in s)),
  '?format=json: the same list as public/resolvers.js, anycast and its source per service, with null for what isn\'t documented');

console.log('-- the sitemaps (resolverPaths and sitemapIndex in src/worker.js)');
const idx = (await run('/sitemap.xml', CURL)).body;
ok(idx.includes(`<sitemap><loc>https://ipterm.net/sitemap-resolvers.xml</loc><lastmod>${R.checked}</lastmod></sitemap>`), '/sitemap.xml lists /sitemap-resolvers.xml with RESOLVERS.checked');
const sm = (await run('/sitemap-resolvers.xml', CURL)).body, urls = [...sm.matchAll(/<url><loc>([^<]*)<\/loc><lastmod>([^<]*)<\/lastmod><\/url>/g)];
ok(urls.map(u => u[1]).join() === ['/public-dns', ...all.map(ip => '/' + ip)].map(p => 'https://ipterm.net' + p).join() && urls.every(u => u[2] === R.checked) &&
  (sm.match(/<url>/g) || []).length === urls.length && urls.length === 119 && sm.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'),
  `/sitemap-resolvers.xml: /public-dns and all ${all.length} addresses (${urls.length} URLs), each with <lastmod>${R.checked}</lastmod>`);
const pagesMap = (await run('/sitemap-pages.xml', CURL)).body;
ok(!all.some(ip => pagesMap.includes(`https://ipterm.net/${ip}</loc>`)) && !pagesMap.includes('/public-dns<'), '/sitemap-pages.xml lists none of them: each URL is in one file');
ok(!(await run('/sitemap-resolvers.xml', CURL, { SELF_HOSTED: 'true' })).body.includes('<url>'), 'a copy run by someone else lists none');

console.log('-- the terminal (resolverAbout, publicDns, lookup and ipTitle in public/app.js)');
const node = (tag, cls = '', text = '') => ({ tag, cls, text, kids: [], append(...xs) { this.kids.push(...xs); }, appendChild(x) { this.kids.push(x); },
  set textContent(v) { this.text = v; this.kids = []; }, get textContent() { return textOf(this); }, set className(v) { this.cls = v; }, get className() { return this.cls; } });
const textOf = x => (x == null ? '' : typeof x === 'string' ? x : (x.text || '') + (x.kids || []).map(textOf).join(''));
const nodes = x => (!x || typeof x !== 'object' ? [] : [x, ...(x.kids || []).flatMap(nodes)]);
function terminal(live) {
  const t = { out: node('#out'), rows: [], fixes: [], lines: [], routes: [], next: null };
  t.api = Function('el', 'out', 'kv', 'cmdLink', 'runnable', 'joined', 'joinFrag', 'apiRoute', 'live', 'fixLine', 'shareBar', 'line', 'announce', 'next', 'scroll',
    'location', 'document', 'window', slice(app, '  /* ---------- public DNS resolvers ----------', '  /* ---------- corrections ----------') +
    'return { resolverAbout, publicDns, RESLIB };')(
    (tag, cls, text) => node(tag, cls, text), t.out, async rows => { t.rows.push(rows); }, (text, cmd, href) => ({ tag: 'a', text, cmd, href }),
    (text, cmd) => ({ tag: 'button', text, cmd }), ns => { const f = node('frag'); ns.forEach((n, i) => { if (i) f.append('  ·  '); f.append(n); }); return f; },
    parts => { const f = node('frag'); parts.forEach(p => { if (p !== '' && p != null) f.append(p); }); return f; },
    q => { t.routes.push(q); return Promise.resolve({ summary: `${q} is routed in 9.9.9.0/24, announced by AS19281 (Quad9).` }); },
    live, (path, field = null) => t.fixes.push([path, field]), () => null, (text, cls) => t.lines.push([text, cls]), () => {}, (...items) => { t.next = items; }, () => {},
    { origin: 'https://ipterm.net' }, { createTextNode: s => s }, { IPTERM_RESOLVERS: R });
  return t;
}
let order = [], marks = [], sources = [];
for (const ip of all) {
  const t = terminal(false), r = R.get(ip);
  await t.api.resolverAbout(r);
  const rows = t.rows[0] || [], keys = rows.map(([k]) => k), want = block(pages.get(ip).body).rows.map(([k]) => k);
  const tags = ((t.out.kids[0] || {}).kids || []).filter(n => n.cls === 'tag').map(n => n.text).join(), wantTags = [...block(pages.get(ip).body).head.matchAll(/<span class="tag">([^<]*)</g)].map(m => m[1]).join();
  const all1 = nodes((rows.find(([k]) => k === 'all resolvers') || [])[1]).find(n => n.tag === 'a');
  if (keys.join('|') !== want.join('|') || tags !== wantTags || !all1 || all1.href !== '/public-dns#' + r.service.id || all1.cmd !== 'public-dns') {
    order.push(`${ip}: ${keys.join(',')} [${tags}] vs ${want.join(',')} [${wantTags}], ${all1 && all1.href}`);
  }
  const mine = rows.filter(([k]) => k === 'IPv4' || k === 'IPv6').map(([, v]) => textOf(v)).join(' ');
  if (!mine.includes(ip + ' (this address)') || t.fixes.join() !== [['/' + ip, 'resolver']].join()) marks.push(ip);
  const links = rows.filter(([k]) => k === 'sources' || (k === '' && rows.some(([kk]) => kk === 'sources'))).map(([, v]) => v).filter(v => v && v.tag === 'a');
  if (links.map(a => a.href).join() !== r.service.sources.join() || !links.every(a => a.target === '_blank' && a.rel === 'noopener')) sources.push(ip);
}
ok(!order.length, `resolverAbout() draws the Worker's rows and tags in the same order for all ${all.length} addresses, its "all resolvers" linking /public-dns#<id>${order.length ? ': ' + order[0] : ''}`);
ok(!marks.length, `... marks the address looked up, and ends with fixLine('/<ip>', 'resolver')${marks.length ? ': not ' + marks.slice(0, 3).join(', ') : ''}`);
ok(!sources.length, '... and links every source in a new tab (rel="noopener")');
const lt = terminal(true);
await lt.api.resolverAbout(R.get('9.9.9.9'));
await new Promise(r => setTimeout(r, 0));
const rr = (lt.rows[0].find(([k]) => k === 'routing') || [])[1];
ok(lt.routes.join() === '9.9.9.9' && textOf(rr).startsWith('9.9.9.9 is routed in 9.9.9.0/24') && nodes(rr).some(n => n.tag === 'button' && n.cmd === 'route 9.9.9.9'),
  `live, it asks for the routing (route) and fills the row in: ${JSON.stringify(textOf(rr))}`);
const quiet = terminal(false); await quiet.api.resolverAbout(R.get('9.9.9.9'));
ok(!quiet.routes.length && nodes((quiet.rows[0].find(([k]) => k === 'routing') || [])[1]).some(n => n.cmd === 'route 9.9.9.9'), '... and in the preview (not live) it asks nothing and offers route');
const lst = terminal(false); await lst.api.publicDns([]);
const looked = lst.rows.flat().flatMap(([, v]) => nodes(v)).filter(n => n.tag === 'a');
ok(lst.rows.length === list.length && all.every(ip => looked.filter(a => a.href === '/' + ip && a.cmd === 'lookup ' + ip).length === 1) && lst.fixes.join() === '/public-dns,',
  `public-dns lists the ${list.length} services and links each of the ${all.length} addresses once (lookup <ip>, /<ip>), then the corrections line`);
const q9 = terminal(false); await q9.api.publicDns(['Quad9']);
const none = terminal(false); await none.api.publicDns(['nonesuch']);
ok(q9.rows.length === 1 && q9.rows[0].length === 8 && none.rows.length === 0 && none.lines[0] && none.lines[0][1] === 'warn' && none.lines[0][0].includes('quad9'),
  'public-dns quad9 shows that one service; an unknown one says which there are');
ok(app.includes('    await render(p, ipText, d, false);\n    if (res) await resolverAbout(res);\n    else if (d && !d.bogon) {\n      ipinfoFix(d);') &&
  app.includes("      await sponsor('ip');                       // none for IPinfo's bogon"),
  "lookup() draws a resolver's lookup as IPinfo gives it, then its resolver block in place of IPinfo's pointer and the sponsored line");
const ipTitle = Function('RESLIB', slice(app, '  const ipTitle =', '  function localTime(') + 'return ipTitle;')(R);
ok(ipTitle('2606:1a40:0:0:0:0:0:0', {}) === head(pages.get('2606:1a40::').body).title && ipTitle('9.9.9.9', { org: 'X' }) === sh.title && ipTitle('74.1.2.3', { org: 'X' }) === '74.1.2.3 IP lookup: X | ipterm',
  "ipTitle() titles a resolver as its page does, however it is written, and other addresses as before");
ok(/\['public-dns \[service\]', '[^']+', 'public-dns'\]/.test(app) && /\n {4}'public-dns': \['public-dns \[service\]', "/.test(app) && app.includes("resolvers: 'public-dns', publicdns: 'public-dns'") &&
  app.includes("'port', 'public-dns', 'resolvers', 'ping'") && app.includes("case 'public-dns': return publicDns(args);") && app.includes("case 'public-dns': return '/public-dns';") &&
  /const RESULTS = new Set\(\[[^\]]*'public-dns'\]\)/.test(app), 'the command is in help and man, answers to resolvers, is in the did-you-mean list, runs, and links /public-dns');

console.log('-- the wiring and the docs');
const index = read('public/index.html');
ok(index.indexOf('<script src="/resolvers.js" defer></script>') > 0 && index.indexOf('<script src="/resolvers.js" defer></script>') < index.indexOf('<script src="/app.js" defer></script>'),
  'index.html loads /resolvers.js before app.js');
ok(/^\s+"!\/resolvers\.js",$/m.test(toml) && worker.includes("import '../public/resolvers.js';"), 'wrangler.toml serves /resolvers.js as a static file, and the Worker imports it');
for (const q of ['public-dns', 'resolvers']) {
  const r = await W.fetch(new Request('https://ipterm.net/go?q=' + q, { headers: { 'user-agent': CHROME, 'cf-connecting-ip': ME } }), env, { waitUntil() {} });
  ok(r.status === 302 && r.headers.get('location') === '/public-dns', `/go?q=${q} goes to /public-dns`);
}
// A resolver's address is curated, so its typos redirect to it as public/resolvers.js writes it, as a router address's
// do (routerTypo, curatedIps); a typo of an address in neither list is the 404 page.
const typoAt = async p => {
  const r = await W.fetch(new Request('https://ipterm.net' + p, { headers: { 'user-agent': CHROME, 'cf-connecting-ip': ME } }), env, { waitUntil() {} });
  return [r.status, r.headers.get('location')];
};
const v4 = all.filter(ip => !ip.includes(':')), typos = [];
for (const ip of v4) {
  const t = ip.replace(/\./g, ',').replace(/1/g, 'l').replace(/0/g, 'o'), [status, loc] = await typoAt('/' + t);
  if (status !== 301 || loc !== '/' + ip) typos.push(`/${t}: ${status} ${loc}`);
}
const [gs, gl] = await typoAt('/go?q=l.l.l.3'), [ns, nl] = await typoAt('/l.l.l.5');
ok(!typos.length && String(await typoAt('/9.9.9.l0')) === '301,/9.9.9.10' && gs === 302 && gl === '/1.1.1.3' && ns === 404 && nl === null,
  `typos of all ${v4.length} IPv4 resolver addresses (/9,9,9,9, /l.l.l.3, /9.9.9.l0) get a 301 to the address, /go?q=l.l.l.3 a 302, and /l.l.l.5 the 404 page${typos.length ? ': not ' + typos.slice(0, 3).join(', ') : ''}`);
for (const g of ['what-your-ip-reveals', 'ipv4-vs-ipv6']) {
  const page = await run('/guides/' + g, NAV);
  ok(page.body.includes('<a href="/public-dns">') && read('tools/build_guides.py').includes('<a href="/public-dns">'), `/guides/${g} links /public-dns (from tools/build_guides.py)`);
}
ok((await run('/help', CURL)).body.includes('ipterm.net/public-dns'), '/help names /public-dns');
const llmsLine = read('public/llms.txt').split('\n').find(l => l.includes('(https://ipterm.net/public-dns)')) || '';
ok(llmsLine && !/Mullvad|these addresses are anycast/.test(llmsLine) && llmsLine.includes('only where its operator says so'), 'public/llms.txt lists /public-dns, anycast only where the operator says so');
let oa = null; try { oa = JSON.parse(read('public/openapi.json')); } catch {}
const oaService = oa && oa.paths['/public-dns'] && oa.paths['/public-dns'].get.responses['200'].content['application/json'].schema.properties.services.items.properties;
ok(oa && oa.paths['/public-dns'].get.operationId === 'publicDns' && oaService && oaService.anycast && oaService.anycastSource && !oaService.ends && !oaService.note,
  'public/openapi.json describes /public-dns, with anycast and anycastSource per service');
const changes = globalThis.IPTERM_CHANGES.list().find(c => c.pages.includes('/public-dns') && c.text.startsWith('New: public DNS resolver pages'));
ok(changes && realDate(changes.date) && /^[ -~]*$/.test(changes.text) && changes.text.includes(`Every address of ${list.length} public DNS services`) && !/Mullvad/.test(changes.text),
  `/changes says so, with the ${list.length} services: ${changes && changes.date}`);
// What the pages do (above): no place in the title, description or summary, IPinfo's location row kept, and anycast
// only where the operator says so
ok(changes && changes.text.includes('titles, descriptions and summaries no longer name one place') && !/pages no longer name|located in|These addresses are anycast/.test(changes.text) &&
  changes.text.includes('called anycast only where its operator says so'),
  '... saying what no longer names a place (titles, descriptions and summaries), not that the pages name none, and that anycast is only where the operator says so');
const hbook = slice(handbook, '### Public DNS resolvers', '\n## Shareable pages');
ok(['### Public DNS resolvers', 'public/resolvers.js', 'LAST_CHECKED', '/sitemap-resolvers.xml', '/public-dns', 'resolverBlock()', 'tools/check_resolvers.mjs'].every(s => handbook.includes(s)) &&
  hbook.includes(`every address they document, ${all.length} in all`) && hbook.includes(`${anycast.length} of them`) && !/Mullvad|\bends\b/.test(hbook) &&
  new RegExp(`\\| \`/sitemap-resolvers\\.xml\` \\|[^\\n]*\\| ${urls.length} \\|`).test(handbook),
  `docs/handbook.md describes the data, how to check it again, the pages, the sitemap and this check, with the counts (${all.length} addresses, ${anycast.length} anycast services, ${urls.length} sitemap URLs)`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
