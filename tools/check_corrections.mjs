// Checks the corrections line, the IPinfo pointer on IP pages, the GitHub issue forms and /changes. No server and no
// network: the whole Worker runs in Node, as in tools/check_pages.mjs, with its static files read from public/ and
// fetch stubbed to answer as IPinfo, proxycheck.io, DNS, RDAP and RIPEstat would and to note every request, and the
// terminal's fixLine() and ipinfoFix() run against a stand-in DOM.
//
// 1. The line: "Something wrong here? Suggest a fix on GitHub (public, needs an account) or by email." ends every
//    reference page, once: /port and every port page (one outside the list too), the tool pages but /leaktest, every
//    guide (its <!--FIX-->, filled in by the Worker), /public-dns, and a public DNS resolver's block on its IP page,
//    with the field "resolver". The GitHub link opens correction.yml in SOURCE_URL's
//    repository (wrangler.toml) with only the page's address (its title and the form's `page` field), rel="nofollow
//    noopener"; the email link is mailto:contact@ipterm.net with only the subject. Neither holds the visitor's address.
//    No line on the visitor's own results or other pages: the homepage, /leaktest, a shared leak test result, IP pages
//    (but a resolver's), /cidr and 404 pages, /guides, /privacy and /changes; in worker.js only portPage(),
//    toolRoute(), withOrigin(), resolverBlock() and publicDnsRoute() call fixLine(), and curl's text and JSON answers
//    carry none (curl gets a guide as HTML, line and all).
// 2. Copies: SELF_HOSTED, an empty SOURCE_URL or one that isn't a GitHub repository leave the line out everywhere (and
//    the footer's data-fix, and the guides' placeholder); a trailing slash on SOURCE_URL changes nothing.
// 3. The terminal: fixLine() draws the same links as the Worker for the same page (with a field too), from the
//    footer's data-fix and data-fix-mail, and nothing without them; only portAbout, portIntro, toolIntro, apiHelp,
//    resolverAbout (with the field) and publicDns call it; the server's copy (.fix) goes on boot and copy md leaves it out.
// 4. IP pages: "Location wrong? IPinfo takes corrections at ipinfo.io/corrections" where the page shows a place from
//    IPinfo Core or its free API, the same in the terminal (ipinfoFix(), only after lookup); not for an anycast address,
//    a public DNS resolver (its block has the corrections line instead), an IPinfo Lite answer (a bot's), a non-public
//    address or IPinfo's bogon.
// 5. The issue forms in .github/ISSUE_TEMPLATE: correction.yml has the fields the links fill in (page, field), a
//    required source, a "this is public, don't paste your IP" notice and a description naming every kind of page
//    whose line opens it; new-port.yml and config.yml too, with the labels correction, new-port and upstream and the
//    contact links for locations, registry records and privacy.
// 6. /changes: public/changes.js newest first with real dates, the entries that give numbers or quote the site
//    agreeing with it (the port pages' counts, the line's pages, the terminal's timeout), as a page for browsers and
//    crawlers (no outside request), plain text for curl (80 columns, the pages as full addresses), JSON with
//    ?format=json; every page it links answers; it is in /sitemap-pages.xml, /help and the footer, and names no one.
//
//   node tools/check_corrections.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const app = read('public/app.js'), worker = read('src/worker.js'), handbook = read('docs/handbook.md'), toml = read('wrangler.toml');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_corrections.mjs`);
  return src.slice(a, b);
}

const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_corrections.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const store = new Map();
globalThis.caches = { default: {
  async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, { body: await res.text(), headers: [...res.headers] }); },
} };

// IPinfo Core: an anycast resolver, and a home address with a city. The free API (no IPINFO_TOKEN) answers with a city.
const CORE = {
  '8.8.4.4': { hostname: 'dns.google', city: 'Mountain View', region: 'California', as: ['AS15169', 'Google LLC'], anycast: true },
  '104.16.132.229': { city: 'San Francisco', region: 'California', as: ['AS13335', 'Cloudflare, Inc.'], anycast: true },
  '74.1.2.3': { hostname: 'c-74-1-2-3.hsd1.fl.comcast.net', city: 'Coral Springs', region: 'Florida', as: ['AS7922', 'Comcast Cable Communications, LLC'] },
};
const BOGONS = new Set(['192.88.99.1']);
const calls = [];
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  let m;
  if ((m = /^https:\/\/api\.ipinfo\.io\/lookup\/([^?]+)/.exec(u))) {
    calls.push(['core', u]);
    if (BOGONS.has(m[1])) return reply({ ip: m[1], bogon: true });
    const c = CORE[m[1]] || CORE['74.1.2.3'];
    return reply({ ip: m[1], hostname: c.hostname,
      geo: { city: c.city, region: c.region, country: 'United States', country_code: 'US', continent: 'North America', latitude: 26.27, longitude: -80.27, timezone: 'America/New_York' },
      as: { asn: c.as[0], name: c.as[1], type: 'isp' }, ...(c.anycast ? { is_anycast: true, is_hosting: true } : {}) });
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lite\/([^?]+)/.exec(u))) {
    calls.push(['lite', u]);
    if (BOGONS.has(m[1])) return reply({ ip: m[1], bogon: true });
    return reply({ ip: m[1], asn: 'AS7922', as_name: 'Comcast Cable Communications, LLC', as_domain: 'comcast.com', country_code: 'US', country: 'United States', continent: 'North America' });
  }
  if ((m = /^https:\/\/ipinfo\.io\/([^/?]+)\/json$/.exec(u))) {
    calls.push(['ipinfo', u]);
    return reply({ ip: m[1], city: 'Coral Springs', region: 'Florida', country: 'US', loc: '26.27,-80.27', org: 'AS7922 Comcast Cable Communications, LLC', timezone: 'America/New_York' });
  }
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u))) {
    calls.push(['proxycheck', u]);
    return reply({ status: 'ok', [m[1]]: { network: { type: 'residential' }, detections: { proxy: false, vpn: false, tor: false, hosting: false, anonymous: false, risk: 0 } } });
  }
  if (/^https:\/\/cloudflare-dns\.com\/dns-query\?/.test(u)) { calls.push(['dns', u]); return reply({ Status: 3, Answer: [] }); }
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    calls.push(['rdap', u]);
    return reply({ services: [[m[1] === 'ipv4' ? ['0.0.0.0/0'] : m[1] === 'ipv6' ? ['::/0'] : m[1] === 'asn' ? ['1-4294967295'] : ['org'], ['https://rdap.test/']]] });
  }
  if (/^https:\/\/rdap\.test\/ip\//.test(u)) {
    calls.push(['rdap', u]);
    return reply({ objectClassName: 'ip network', handle: 'NET-74-0-0-0-1', name: 'COMCAST-TEST', startAddress: '74.0.0.0', endAddress: '74.255.255.255',
      cidr0_cidrs: [{ v4prefix: '74.0.0.0', length: 8 }], events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00-04:00' }], entities: [] });
  }
  if ((m = /^https:\/\/stat\.ripe\.net\/data\/([a-z-]+)\/data\.json\?(.*)$/.exec(u))) {
    calls.push(['ripestat', u]);
    const q = new URLSearchParams(m[2]), res = q.get('resource') || '';
    switch (m[1]) {
      case 'as-overview': return reply({ data: { holder: 'CLOUDFLARENET - Cloudflare, Inc.', announced: true, block: { desc: 'Assigned by ARIN' } } });
      case 'announced-prefixes': return reply({ data: { prefixes: [{ prefix: '104.16.0.0/13' }, { prefix: '2606:4700::/32' }] } });
      case 'asn-neighbours': return reply({ data: { neighbours: [{ asn: 174, type: 'left', power: 10, v4_peers: 100 }], neighbour_counts: { left: 1 } } });
      case 'prefix-overview': return reply({ data: { resource: res, announced: true, asns: [{ asn: 13335, holder: 'CLOUDFLARENET - Cloudflare, Inc.' }], block: { desc: 'ARIN' }, related_prefixes: [] } });
      case 'routing-status': return reply({ data: { visibility: { v4: { ris_peers_seeing: 300, total_ris_peers: 320 }, v6: { ris_peers_seeing: 300, total_ris_peers: 320 } } } });
      case 'bgp-state': return reply({ data: { bgp_state: [] } });
      case 'rpki-validation': return reply({ data: { status: 'valid', validating_roas: [] } });
    }
  }
  calls.push(['other', u]);
  return new Response('not stubbed in tools/check_corrections.mjs', { status: 404 });
};

// Static files the way Workers static assets serve them: /guides/x is public/guides/x.html, / is index.html.
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
// wrangler.toml's own SOURCE_URL and SELF_HOSTED, so the check sees what ipterm.net runs with
const tomlVar = k => (new RegExp(`^${k} = "([^"]*)"`, 'm').exec(toml) || [])[1];
const SOURCE_URL = tomlVar('SOURCE_URL'), REPO = 'https://github.com/GuardWiseSec/ipterm';
const env = {
  IPINFO_TOKEN: 'test-token', IPINFO_PLAN: 'core', PROXYCHECK_KEY: 'test-key', SOURCE_URL, SELF_HOSTED: tomlVar('SELF_HOSTED'),
  BUDGET: { idFromName: name => name, get: () => ({ async take() { return { ok: true }; } }) }, ASSETS,
};
const { default: W } = await import('../src/worker.js');
const PORTS = globalThis.IPTERM_PORTS, CHANGES = globalThis.IPTERM_CHANGES;

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
  return { status: res.status, type: res.headers.get('content-type') || '', headers: res.headers, body, kinds: calls.map(c => c[0]) };
}
const unesc = s => (s == null ? s : s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
const FIX_RE = /<p class="([^"]*)">Something wrong here\? <a href="([^"]*)" rel="nofollow noopener">Suggest a fix on GitHub<\/a> \(public, needs an account\) or <a href="([^"]*)">by email<\/a>\.<\/p>/g;
const fixes = body => [...body.matchAll(FIX_RE)].map(m => ({ cls: m[1], github: unesc(m[2]), email: unesc(m[3]) }));
const mentionsFix = body => /Something wrong here|issues\/new|template=correction/.test(body);
const IPINFO_LINE = '<p class="ln sys fix">Location wrong? IPinfo takes corrections at <a href="https://ipinfo.io/corrections" rel="nofollow noopener">ipinfo.io/corrections</a>.</p>';
const q = encodeURIComponent;
// What the two links must be for a page: the form, the page's address and nothing else; the subject, the same.
const wantGithub = (path, field) => `${REPO}/issues/new?template=correction.yml&title=${q(`Correction: ${path}${field ? ` (${field})` : ''}`)}` +
  `&page=${q('https://ipterm.net' + path)}` + (field ? `&field=${q(field)}` : '');
const wantEmail = (path, field) => `mailto:contact@ipterm.net?subject=${q(`Correction: https://ipterm.net${path}${field ? ` (${field})` : ''}`)}`;
function lineIs(what, body, path, cls = 'ln sys fix') {
  const f = fixes(body);
  ok(f.length === 1 && f[0].cls === cls && f[0].github === wantGithub(path) && f[0].email === wantEmail(path) && !body.includes(ME) && !f[0].github.includes(ME),
    `${what}: the line, once, linking ${f[0] ? f[0].github : 'nothing'}`);
}

console.log("-- the line on reference pages (fixLine() in src/worker.js)");
ok(SOURCE_URL === REPO && tomlVar('SELF_HOSTED') === 'false', `wrangler.toml: SOURCE_URL ${SOURCE_URL}, SELF_HOSTED ${tomlVar('SELF_HOSTED')}`);
let allPorts = true, quiet = true;
for (const p of ['/port', ...PORTS.list().map(n => '/port/' + n)]) {
  const r = await run(p, BOT), f = fixes(r.body);
  if (r.kinds.length) quiet = false;
  if (!(r.status === 200 && f.length === 1 && f[0].github === wantGithub(p) && f[0].email === wantEmail(p))) { allPorts = false; ok(false, `${p}: ${JSON.stringify(f)}`); }
}
ok(allPorts, `/port and all ${PORTS.list().length} port pages end with the line, each with its own address`);
ok(quiet, '... and still make no outside request (for Googlebot)');
lineIs('/port/22 for a browser', (await run('/port/22', NAV)).body, '/port/22');
lineIs('/port/9999, not in the list', (await run('/port/9999', NAV)).body, '/port/9999');
for (const t of ['whois', 'dns', 'mail', 'grade', 'cidr', 'api']) lineIs(`/${t}`, (await run('/' + t, NAV)).body, '/' + t);
lineIs('/public-dns', (await run('/public-dns', NAV)).body, '/public-dns', 'doc-meta');
// A public DNS resolver's page: the line closes its resolver block, naming the field, as a browser and a crawler see it
// (with a city from IPinfo Core, with none from Lite) and over IPv6.
for (const [p, h] of [['/8.8.4.4', NAV], ['/114.114.114.114', NAV], ['/1.1.1.3', BOT], ['/2620:fe::fe', NAV]]) {
  const r = await run(p, h), f = fixes(r.body);
  ok(r.status === 200 && f.length === 1 && f[0].cls === 'ln sys fix' && f[0].github === wantGithub(p, 'resolver') && f[0].email === wantEmail(p, 'resolver') &&
    !r.body.includes(IPINFO_LINE), `${p} (${h === BOT ? 'Googlebot' : 'a browser'}): the line once, about the field "resolver", and no IPinfo pointer`);
}
const guides = readdirSync(new URL('public/guides/', root)).filter(f => f.endsWith('.html')).map(f => '/guides/' + f.replace(/\.html$/, ''));
for (const g of guides) {
  const r = await run(g, NAV);
  lineIs(g, r.body, g, 'doc-meta');
  if (r.body.includes('<!--FIX-->')) ok(false, `${g}: the placeholder is left in the page`);
}
ok(guides.length >= 6 && guides.every(g => read(`public${g}.html`).includes('<!--FIX-->')) && read('tools/build_guides.py').includes('<!--FIX-->'),
  `all ${guides.length} guides carry <!--FIX--> from tools/build_guides.py`);
const portPage = (await run('/port/22', NAV)).body, link = fixes(portPage)[0];
const params = link ? [...new URL(link.github).searchParams.keys()] : [];
ok(params.join() === 'template,title,page' && new URL(link.github).searchParams.get('page') === 'https://ipterm.net/port/22' &&
  new URL(link.github).searchParams.get('title') === 'Correction: /port/22', `the GitHub link fills in only ${params.join(', ')}: the form, and the page's address`);
ok(link && [...new URLSearchParams(link.email.split('?')[1]).keys()].join() === 'subject' && link.email.startsWith('mailto:contact@ipterm.net?'),
  `the email link fills in only the subject: ${link && decodeURIComponent(link.email)}`);
ok(link && !/labels=|assignees=|projects=|milestone=/.test(link.github), "it asks for no label: GitHub answers 404 to a visitor who can't set one");

console.log("-- no line on the visitor's own results, or other pages");
for (const [p, h] of [['/', NAV], ['/leaktest', NAV], ['/leaktest/r/1bjp', NAV], ['/104.16.132.229', NAV], ['/74.1.2.3', NAV], ['/192.168.1.1', NAV],
  ['/cidr/10.0.0.0/24', NAV], ['/AS13335', NAV], ['/guides', NAV], ['/privacy', NAV], ['/changes', NAV], ['/no-such-page', NAV], ['/port/abc', NAV]]) {
  const r = await run(p, h);
  ok(!mentionsFix(r.body), `${p} (${r.status}): no corrections line`);
}
for (const p of ['/port/22', '/port', '/whois', '/api', '/changes', '/public-dns', '/public-dns?format=json', '/9.9.9.9', '/9.9.9.9/text']) {
  const r = await run(p, CURL);
  ok(!mentionsFix(r.body), `curl ${p} (${r.status}, ${r.type.split(';')[0]}): no corrections line`);
}
// A guide is a static page: curl gets the same HTML, so the line is in it (the handbook says so).
const curlGuide = await run('/guides/find-router-ip', CURL);
ok(curlGuide.type.startsWith('text/html') && fixes(curlGuide.body).length === 1, `curl /guides/find-router-ip (${curlGuide.type.split(';')[0]}): the guide's HTML, line and all`);
// The functions that call fn: each call (not its definition, nor "fn()" in a comment) and the declaration above it.
const callers = fn => [...worker.matchAll(new RegExp(`(?<!function )\\b${fn}\\((?!\\))`, 'g'))].map(m => {
  const before = worker.slice(0, m.index), d = [...before.matchAll(/\n(?:async )?function (\w+)\(|\nconst (\w+) = /g)].pop();
  return d ? d[1] || d[2] : '?';
});
ok([...new Set(callers('fixLine'))].sort().join() === 'portPage,publicDnsRoute,resolverBlock,toolRoute,withOrigin', `in worker.js only ${[...new Set(callers('fixLine'))].sort().join(', ')} call fixLine()`);
ok(/fixLine\(io, '\/' \+ ip, 'resolver'\)/.test(worker) && /fixLine\(io, '\/public-dns', null, 'doc-meta'\)/.test(worker),
  '... resolverBlock() with the field "resolver", publicDnsRoute() as a document page (doc-meta)');
ok(/tool === 'leaktest' \? '' : fixLine\(io, '\/' \+ tool\)/.test(worker), '... toolRoute() leaves /leaktest out');

console.log('-- copies run by someone else, and other SOURCE_URLs');
for (const [what, plus] of [['SELF_HOSTED = "true"', { SELF_HOSTED: 'true' }], ['SOURCE_URL empty', { SOURCE_URL: '' }],
  ['SOURCE_URL on GitLab', { SOURCE_URL: 'https://gitlab.com/someone/ipterm' }], ['SOURCE_URL a GitHub profile', { SOURCE_URL: 'https://github.com/someone' }]]) {
  const bodies = await Promise.all(['/port/22', '/whois', '/port', '/guides/find-router-ip', '/public-dns', '/9.9.9.9'].map(async p => (await run(p, NAV, plus)).body));
  ok(bodies.every(b => !mentionsFix(b) && !b.includes('data-fix') && !b.includes('<!--FIX-->')), `${what}: no line, no data-fix, no placeholder left`);
}
lineIs('SOURCE_URL with a trailing slash', (await run('/port/22', NAV, { SOURCE_URL: REPO + '/' })).body, '/port/22');

console.log("-- the terminal (fixLine() and ipinfoFix() in public/app.js)");
const node = (tag, cls = '', text = '') => ({ tag, cls, text, kids: [], append(...xs) { this.kids.push(...xs); }, appendChild(x) { this.kids.push(x); } });
const textOf = x => (x == null ? '' : typeof x === 'string' ? x : (x.text || '') + (x.kids || []).map(textOf).join(''));
const anchors = x => (!x || typeof x !== 'object' ? [] : [...(x.tag === 'a' ? [x] : []), ...(x.kids || []).flatMap(anchors)]);
// the footer as the Worker writes it, read back as the browser's dataset would give it
const foot = /<span class="foot-build"[^>]*?data-fix="([^"]*)" data-fix-mail="([^"]*)"/.exec(portPage);
ok(foot && unesc(foot[1]) === REPO && unesc(foot[2]) === 'contact@ipterm.net', `the footer says where the line goes: data-fix="${foot && foot[1]}" data-fix-mail="${foot && foot[2]}"`);
const term = footer => {
  const out = node('#out');
  const T = Function('el', 'out', 'scroll', 'document', 'location', slice(app, '  /* ---------- corrections ----------', '  /* ---------- tool intros') +
    'return { fixLine, ipinfoFix };')((tag, cls, text) => node(tag, cls, text), out, () => {},
    { querySelector: s => (s === '[data-fix]' ? footer : null) }, { origin: 'https://ipterm.net' });
  return { out, ...T };
};
const T = term(foot ? { dataset: { fix: unesc(foot[1]), fixMail: unesc(foot[2]) } } : null);
for (const p of ['/port/22', '/port', '/whois', '/api']) {
  T.out.kids.length = 0; T.fixLine(p);
  const d = T.out.kids[0], as = anchors(d);
  ok(T.out.kids.length === 1 && d.cls === 'ln sys fix' && textOf(d) === 'Something wrong here? Suggest a fix on GitHub ↗ (public, needs an account) or by email.' &&
    as.length === 2 && as[0].href === wantGithub(p) && as[0].target === '_blank' && as[0].rel === 'nofollow noopener' && as[1].href === wantEmail(p) && !as[1].target,
    `the terminal's line after ${p}: the same links as the page`);
}
// A page that names the field the line is about (the resolver pages may): the Worker's fixLinks() and the terminal agree.
const fixLinks = Function('selfHosted', 'encodePath', slice(worker, "const FIX_MAIL = '", '// The line as a paragraph') + 'return fixLinks;')(
  e => String((e && e.SELF_HOSTED) || '').toLowerCase() === 'true', p => p.split('/').map(seg => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/'));
T.out.kids.length = 0; T.fixLine('/2620:fe::fe', 'DNS-over-TLS host');
const w = fixLinks({ SOURCE_URL: REPO }, 'https://ipterm.net', '/2620:fe::fe', 'DNS-over-TLS host'), tf = anchors(T.out.kids[0]);
ok(w && tf.length === 2 && tf[0].href === w.github && tf[1].href === w.email && w.github === wantGithub('/2620:fe::fe', 'DNS-over-TLS host') &&
  new URL(w.github).searchParams.get('field') === 'DNS-over-TLS host', `with a field: both fill in field=${w && new URL(w.github).searchParams.get('field')}, nothing more`);
const none = term(null); none.fixLine('/port/22'); none.ipinfoFix({ source: 'ipinfo-core', city: 'Coral Springs' });
ok(none.out.kids.length === 1 && !none.out.kids.some(k => /Something wrong/.test(textOf(k))), 'with no data-fix in the footer (a copy), the terminal draws no line');
const appCallers = fn => [...app.matchAll(new RegExp(`(?<!function )\\b${fn}\\((?!\\))`, 'g'))].map(m => {
  const d = [...app.slice(0, m.index).matchAll(/\n {2}(?:async )?function (\w+)\(/g)].pop();
  return d ? d[1] : '?';
});
ok([...new Set(appCallers('fixLine'))].sort().join() === 'apiHelp,portAbout,portIntro,publicDns,resolverAbout,toolIntro',
  `in app.js only ${[...new Set(appCallers('fixLine'))].sort().join(', ')} call fixLine(): never whoami, leaktest or a port check`);
ok([...new Set(appCallers('ipinfoFix'))].join() === 'lookup', 'only lookup() calls ipinfoFix(), for an address someone looked up');
ok(app.includes("fixLine('/' + r.ip, 'resolver');") && app.includes('    if (res) await resolverAbout(res);\n    else if (d && !d.bogon) {\n      ipinfoFix(d);'),
  "the terminal's resolver block ends with the line about the field \"resolver\", in place of IPinfo's pointer");
ok(app.includes("stat.querySelectorAll('.head, dl, .api-ref, .badge-ref, .fix')"), "on boot the server's copy of the line goes (.fix); the terminal prints its own");
ok(app.includes("['sponsor', 'next', 'run-yours', 'badge-snip', 'fix']"), 'copy md leaves the line out');

console.log("-- IP pages point to IPinfo's corrections instead (ipinfoFixes() in src/worker.js)");
for (const [what, p, h, plus, want] of [
  ['a browser, IPinfo Core with a city', '/74.1.2.3', NAV, {}, true],
  ['the free API, no IPINFO_TOKEN', '/74.1.2.7', NAV, { IPINFO_TOKEN: '' }, true],
  ['an anycast address', '/104.16.132.229', NAV, {}, false],
  ["Googlebot's IPinfo Lite answer", '/74.1.2.6', BOT, {}, false],
  ['a private address', '/192.168.1.1', NAV, {}, false],
  ["IPinfo's bogon", '/192.88.99.1', NAV, {}, false],
]) {
  const r = await run(p, h, plus), n = r.body.split(IPINFO_LINE).length - 1;
  ok(r.status === 200 && n === (want ? 1 : 0) && !mentionsFix(r.body), `${what} (${p}): ${n ? 'points' : "doesn't point"} to IPinfo's corrections`);
}
const ipinfoFix = (d, t = term(null)) => { t.out.kids.length = 0; t.ipinfoFix(d); return t.out.kids.map(textOf).join('|'); };
const WANT = 'Location wrong? IPinfo takes corrections at ipinfo.io/corrections ↗.';
ok(ipinfoFix({ source: 'ipinfo-core', city: 'Coral Springs', country: 'United States' }) === WANT && ipinfoFix({ source: 'ipinfo', countryCode: 'US' }) === WANT,
  "the terminal's ipinfoFix() for IPinfo Core and the free API with a place");
ok(['ipinfo-lite', 'edge', 'demo'].every(s => !ipinfoFix({ source: s, city: 'X', country: 'Y' })) && !ipinfoFix({ source: 'ipinfo-core', city: 'X', flags: { anycast: true } }) &&
  !ipinfoFix({ source: 'ipinfo-core' }) && !ipinfoFix(null), '... and nothing for IPinfo Lite, your own address (edge), sample data, anycast or no place');
const a = anchors(term(null).out); const t2 = term(null); t2.ipinfoFix({ source: 'ipinfo-core', city: 'X' });
const ia = anchors(t2.out)[0];
ok(!a.length && ia && ia.href === 'https://ipinfo.io/corrections' && ia.target === '_blank' && ia.rel === 'nofollow noopener' && t2.out.kids[0].cls === 'ln sys fix',
  '... linked to https://ipinfo.io/corrections in a new tab, rel="nofollow noopener", class fix');

console.log('-- the issue forms (.github/ISSUE_TEMPLATE)');
const yml = f => (existsSync(new URL('.github/ISSUE_TEMPLATE/' + f, root)) ? read('.github/ISSUE_TEMPLATE/' + f) : '');
// A form's body items: { type, id, required, text } (the forms use one item per "  - type:" line)
const items = y => y.split(/\n {2}- type: /).slice(1).map(s => ({ type: s.split('\n')[0].trim(), id: (/\n {4}id: ([\w-]+)/.exec(s) || [])[1],
  required: /\n {6}required: true/.test(s), text: s }));
const corr = yml('correction.yml'), port = yml('new-port.yml'), conf = yml('config.yml');
for (const [f, y, label] of [['correction.yml', corr, 'correction'], ['new-port.yml', port, 'new-port']]) {
  const it = items(y), md = it.find(i => i.type === 'markdown');
  ok(/^name: \S/m.test(y) && /^description: \S/m.test(y) && /^body:$/m.test(y) && new RegExp(`^labels: \\["${label}"\\]$`, 'm').test(y),
    `${f}: a form (name, description, body), labelled ${label}`);
  ok(md && /\*\*This issue is public\.\*\* Don't paste your own IP address/.test(md.text), `${f}: says the issue is public and not to paste your own IP`);
  ok(it.some(i => i.id === 'source' && i.required), `${f}: a required source`);
  ok(it.filter(i => i.id).every(i => /^[A-Za-z0-9_-]+$/.test(i.id)) && new Set(it.filter(i => i.id).map(i => i.id)).size === it.filter(i => i.id).length &&
    it.every(i => ['markdown', 'input', 'textarea', 'dropdown'].includes(i.type)), `${f}: ids of letters, digits, - and _, each once; known field types`);
  ok(!/\t/.test(y) && y.split('\n').every(l => !/:\s*$/.test(l) || /^(body|contact_links|\s+(attributes|validations|options)):$/.test(l)) &&
    y.split('\n').every(l => /^[ -~]*$/.test(l)), `${f}: plain YAML (no tabs, no empty values, ASCII)`);
}
const ci = items(corr);
ok(ci.find(i => i.id === 'page') && ci.find(i => i.id === 'page').required && ci.find(i => i.id === 'field') && !ci.find(i => i.id === 'field').required &&
  ci.some(i => i.id === 'wrong' && i.required), 'correction.yml: the Page (required) and Field fields the links fill in, and what is wrong (required)');
ok(/`upstream`/.test(corr), 'correction.yml: names the upstream label, for data fixed at its source');
const corrAbout = (/^description: (.*)$/m.exec(corr) || [])[1] || '';
ok(['port', 'guide', 'tool page', 'public DNS resolver', '/public-dns'].every(s => corrAbout.includes(s)),
  `correction.yml: its description names every kind of page whose line opens it: "${corrAbout}"`);
ok(/^blank_issues_enabled: true$/m.test(conf) && /^contact_links:$/m.test(conf), 'config.yml: blank issues stay open, with contact links');
const links = [...conf.matchAll(/\n {2}- name: (.+)\n {4}url: (\S+)\n {4}about: (.+)/g)].map(m => ({ name: m[1], url: m[2], about: m[3] }));
ok(links.length === 4 && links.every(l => /^https:\/\//.test(l.url) && l.about.length <= 200), `config.yml: ${links.length} contact links, all https`);
ok(links.some(l => l.url === 'https://ipinfo.io/corrections' && /location/i.test(l.name)), '... locations go to IPinfo');
ok(links.some(l => l.url === 'https://www.nro.net/about/rirs/' && /whois/i.test(l.name)) && links.some(l => l.url === 'https://lookup.icann.org/' && /domain/i.test(l.name)),
  '... registry records to the registries (the RIRs, and ICANN Lookup for domains)');
ok(links.some(l => /privacy/i.test(l.name) && l.about.includes('contact@ipterm.net')), '... privacy matters to contact@ipterm.net');
ok(!/^\s*labels:/m.test(conf) && [corr, port].every(y => /^labels:/m.test(y)) && /\bupstream\b/.test(corr),
  'the labels correction, new-port and upstream are named in the forms');

console.log('-- /changes (public/changes.js)');
const list = CHANGES.list(), today = new Date().toISOString().slice(0, 10);
const realDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s && s <= today;
ok(list.length >= 7 && list.every(c => realDate(c.date) && typeof c.text === 'string' && c.text.trim() && c.pages.every(p => /^\/\S*$/.test(p))),
  `${list.length} entries, each with a real date (not in the future), its text and its pages`);
ok(list.every((c, i) => !i || list[i - 1].date >= c.date), 'newest first');
ok(['2026-10-25', '2026-10-27', '2026-10-28'].every(d => list.some(c => c.date === d)), 'seeded with 2026-10-25, 2026-10-27 and 2026-10-28');
ok(list.every(c => !/@|thanks|thank you|reported by|credit/i.test(c.text) && /^[ -~]*$/.test(c.text)), 'names no one (no handles, no thanks), in plain ASCII');
// Entries that give numbers or quote the site say what it does: the port pages' (public/ports.js), the line's pages
// (the ones above that have it), and the terminal's own words when it gets no answer (NO_ANSWER in public/app.js).
const nPorts = PORTS.list();
const unregistered = nPorts.filter(n => !PORTS.iana(n).names.length).length, whatportis = nPorts.filter(n => PORTS.refs(n).some(([l]) => l === 'whatportis')).length;
const portEntry = list.find(c => c.pages.includes('/port/22')) || { text: '' };
ok(portEntry.text.includes(`All ${nPorts.length} port pages`) && portEntry.text.includes(`"not registered with IANA" (${unregistered} of them)`) &&
  portEntry.text.includes(`whatportis.com for the ${whatportis} it has a page for`),
  `the port pages' entry agrees with public/ports.js: ${nPorts.length} pages, ${unregistered} not registered with IANA, ${whatportis} on whatportis.com`);
const lineEntry = list.find(c => c.text.includes('suggest a fix')) || { text: '' };
ok(['port pages', 'the tool pages but leaktest', 'the guides', '/public-dns', 'resolver'].every(s => lineEntry.text.includes(s)) && !/\(the port pages, \/port, the tool pages/.test(lineEntry.text),
  "the line's entry names the pages that have it: the port pages, the tool pages but leaktest, the guides, /public-dns and a resolver's block");
const waitWords = ((/ {4}timeout: `([^`]*)`/.exec(app) || [])[1] || '').replace('${GET_WAIT / 1000}', String(Number((/const GET_WAIT = (\d+);/.exec(app) || [])[1]) / 1000));
ok(waitWords && list.some(c => c.text.includes(`"${waitWords.slice(0, waitWords.indexOf(' Try again'))}"`)), `the terminal's timeout entry quotes it: "${waitWords}"`);
const page = await run('/changes', NAV), bot = await run('/changes', BOT);
const title = unesc((/<title>([^<]*)<\/title>/.exec(page.body) || [])[1]), desc = unesc((/<meta name="description" content="([^"]*)">/.exec(page.body) || [])[1]);
ok(page.status === 200 && page.type.startsWith('text/html') && title === 'Changes: fixes and new pages | ipterm' && desc && desc.length <= 155 &&
  page.body.includes('<link rel="canonical" href="https://ipterm.net/changes">') && !/noindex/.test(page.body), `a browser gets the page: "${title}", indexable`);
ok(list.every(c => page.body.includes(`<li>${c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}`)),
  '... with every entry');
const shown = [...page.body.matchAll(/<h2><time datetime="([^"]+)">\1<\/time><\/h2>/g)].map(m => m[1]);
ok(shown.join() === [...new Set(list.map(c => c.date))].join(), `... under its date, newest first: ${shown.join(', ')}`);
ok(list.every(c => c.pages.every(p => page.body.includes(`<a href="${p}">${p}</a>`))), "... linking each entry's pages");
ok(bot.status === 200 && bot.body === page.body && !bot.kinds.length && !page.kinds.length, 'Googlebot gets the same page, and neither makes an outside request');
ok(!/sponsor|aff_sub|proton/i.test(page.body), 'no sponsored line');
ok((await run('/changes', NAV, { SELF_HOSTED: 'true' })).body.includes('<meta name="robots" content="noindex, follow">'), 'a copy run by someone else marks it noindex');
const txt = await run('/changes', CURL), lines = txt.body.trimEnd().split('\n');
const flat = txt.body.replace(/\n {4}(?!https:)/g, ' ');
ok(txt.status === 200 && txt.type.startsWith('text/plain') && lines[0] === 'ipterm: real fixes and new pages, newest first.' && lines.every(l => l.length <= 80) &&
  /^[\x20-\x7e\n]*$/.test(txt.body), `curl gets plain text: ${lines.length} lines, the longest ${Math.max(...lines.map(l => l.length))} columns, no escape codes`);
ok(list.every(c => flat.includes('  - ' + c.text) && c.pages.every(p => txt.body.includes('    https://ipterm.net' + p))) &&
  [...new Set(list.map(c => c.date))].every(d => lines.includes(d)), "... with every day, entry and page's full address");
const js = await run('/changes?format=json', CURL);
let jd = null; try { jd = JSON.parse(js.body); } catch {}
ok(js.status === 200 && jd && jd.changes.length === list.length && jd.changes.every((c, i) => c.date === list[i].date && c.text === list[i].text &&
  c.pages.join() === list[i].pages.map(p => 'https://ipterm.net' + p).join()), '?format=json gives the same list as JSON');
let answers = true;
for (const p of new Set(list.flatMap(c => c.pages))) {
  const r = await run(p, BOT);
  if (r.status !== 200 || /Page not found/.test(r.body)) { answers = false; ok(false, `${p}, linked from /changes: ${r.status}`); }
}
ok(answers, 'every page /changes links answers 200');
ok((await run('/sitemap-pages.xml', CURL)).body.includes('<loc>https://ipterm.net/changes</loc>'), '/sitemap-pages.xml lists /changes');
ok((await run('/help', CURL)).body.includes('ipterm.net/changes'), '/help names /changes');
ok(/<a href="\/changes">changes<\/a>/.test((await run('/', NAV)).body), 'the footer links /changes');
ok(/^\s+"!\/changes\.js",$/m.test(toml) && worker.includes("import '../public/changes.js';"), 'wrangler.toml serves /changes.js as a static file, and the Worker imports it');
ok(PORTS.updated >= '2026-10-28', `the port pages' date (PORTS.updated, their <lastmod>) moved with the line: ${PORTS.updated}`);

console.log('-- the handbook');
ok(['## Corrections and changes', 'correction.yml', 'new-port.yml', 'config.yml', '`correction`', '`new-port`', '`upstream`', 'public/changes.js', '/changes',
  'ipinfo.io/corrections', 'tools/check_corrections.mjs'].every(s => handbook.includes(s)), 'docs/handbook.md describes the line, the forms, the labels and /changes');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
