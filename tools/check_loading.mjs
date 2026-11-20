// Checks how the pages load ("How pages load" in docs/handbook.md). No server and no network: the whole Worker runs in
// Node, as in tools/check_pages.mjs, with fetch stubbed (IPinfo places every address it is asked about; DNS answers
// nothing) and the assets binding answering from public/ with an ETag that is a hash of the file, as Cloudflare's does.
//
// 1. Libraries per page (libsFor in src/worker.js): the homepage, and the plain shell, send land.js (whoami's map); an IP
//    page sends land.js when IPinfo places the address (a city or only a country) and resolvers.js for a public DNS
//    resolver's address, even when its lookup failed; a non-public address or an IPinfo bogon neither; a whois of a
//    resolver's address resolvers.js; a port's page and /port ports.js; /leaktest and a shared result leakgrade.js;
//    every other page none of them. Every terminal page also sends cidr.js and app.js, in index.html's order, and
//    lists all four libraries' versioned addresses in #ipterm-libs for app.js to load the others from.
// 2. Versions: every link to app.css, prefs.js and the scripts (VERSIONED in src/worker.js), on terminal pages, on
//    /changes and /public-dns (docPage), and on the privacy policy, /guides and every guide (withOrigin), carries ?v=
//    and the start of that file's ETag, and no page links one bare. public/_headers keeps exactly those files a year
//    (immutable), the pages link no other script or stylesheet, wrangler.toml serves each without the Worker, and
//    sponsors.json is kept five minutes. Without ETags the deployed version's id stands in, and with neither the links
//    stay bare (only these checks' other stand-ins for the binding have neither).
// 3. A static page's ETag is the file's plus a hash of the versions: If-None-Match with it gets a 304 with no body;
//    the file's own ETag (what a browser kept from before) or another gets the whole page. A file that isn't a page
//    keeps its own ETag and gets its 304 the same way.
// 4. Fonts: the terminal, the privacy policy, /guides, every guide and docPage's pages preload IBM Plex Mono 400 and
//    VT323, files that exist, before the stylesheet.
// 5. The prompt without a script: the form goes to /go with the command as q, and /go sends it on (8.8.8.8 to /8.8.8.8).
// 6. public/app.js: lib() loads a library once, from the page's versioned address (a bare /<file>.js if the page lists
//    none or something else), says null when it fails and tries again next time; hrefFor() links a port as
//    PORTS.parse reads one, without ports.js; man leaktest reads its rubric when it runs; the homepage's server copy
//    has the terminal's [share] [copy] [md] in its head line (shareBar's order); and a page that comes with its result
//    draws it at once (fast, hold) for the kinds the Worker sends one with.
//
//   node tools/check_loading.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const app = read('public/app.js'), worker = read('src/worker.js'), INDEX = read('public/index.html'), HEADERS = read('public/_headers'), toml = read('wrangler.toml');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_loading.mjs`);
  return src.slice(a, b);
}

const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_loading.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });
globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };

const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  const m = /^https:\/\/api\.ipinfo\.io\/(?:lookup|lite)\/([^?]+)/.exec(u);
  if (m) return reply({ ip: decodeURIComponent(m[1]), geo: { city: 'Coral Springs', region: 'Florida', country: 'United States', country_code: 'US', latitude: 26.27, longitude: -80.27, timezone: 'America/New_York' },
    as: { asn: 'AS7922', name: 'Comcast Cable Communications, LLC', type: 'isp' }, asn: 'AS7922', as_name: 'Comcast Cable Communications, LLC', country_code: 'US', country: 'United States' });
  if (u.startsWith('https://cloudflare-dns.com/')) return reply({ Status: 0, Answer: [] });
  if (u.startsWith('https://data.iana.org/rdap/')) return reply({ services: [] });   // no registry: an IP page goes without its block's date
  return new Response('not stubbed in tools/check_loading.mjs', { status: 404 });
};

// The assets binding as Cloudflare's answers: /x is public/x or public/x.html, / is index.html; an ETag that is a hash
// of the file; HEAD without a body. etags: false for a binding that sends none.
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', txt: 'text/plain', xml: 'application/xml', css: 'text/css', woff2: 'font/woff2' };
const fileOf = p => {
  for (const f of p === '/' ? ['index.html'] : [p.slice(1), p.slice(1) + '.html']) {
    const file = new URL('public/' + f, root);
    if (!p.includes('..') && existsSync(file) && statSync(file).isFile()) return [f, readFileSync(file)];
  }
  return null;
};
const etagOf = buf => '"' + createHash('sha256').update(buf).digest('hex').slice(0, 32) + '"';
const assets = ({ etags = true } = {}) => ({ async fetch(req) {
  const hit = fileOf(decodeURIComponent(new URL(req.url).pathname));
  if (!hit) return new Response('Not Found', { status: 404 });
  const [f, buf] = hit, headers = { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream', ...(etags ? { etag: etagOf(buf) } : {}) };
  return new Response(req.method === 'HEAD' ? null : buf, { headers });
} });
const BUDGET = { idFromName: name => name, get: () => ({ async take() { return { ok: true }; } }) };
const env = { IPINFO_TOKEN: 'test-token', IPINFO_PLAN: 'core', BUDGET, ASSETS: assets() };
const { default: W } = await import('../src/worker.js');
const R = globalThis.IPTERM_RESOLVERS, PORTS = globalThis.IPTERM_PORTS;

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
async function run(path, headers = {}, worker = W, e = env) {
  const res = await worker.fetch(new Request('https://ipterm.net' + path, { headers: { 'user-agent': CHROME, 'cf-connecting-ip': '81.2.69.142', ...NAV, ...headers } }),
    e, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

// The versions the Worker should link: the start of each file's ETag
const VERSIONED = JSON.parse((/const VERSIONED = (\[[^\]]*\]);/.exec(worker) || [])[1].replace(/'/g, '"'));
const ver = f => etagOf(fileOf('/' + f)[1]).replace(/[^0-9a-z]/gi, '').slice(0, 12);
// the deferred scripts (prefs.js, which isn't, is checked with app.css below)
const scripts = body => [...body.matchAll(/<script src="\/([a-z]+)\.js(?:\?v=([0-9a-z]+))?" defer><\/script>/g)].map(m => ({ name: m[1], v: m[2] || null, defer: true }));
const libsJson = body => { try { return JSON.parse((/<script type="application\/json" id="ipterm-libs">([^<]*)<\/script>/.exec(body) || [])[1]); } catch { return null; } };
const bare = body => [...body.matchAll(/(?:src|href)="\/([a-z]+\.(?:js|css))(\?[^"]*)?"/g)].filter(m => VERSIONED.includes(m[1]) && !(m[2] || '').startsWith('?v=')).map(m => m[0]);

console.log('-- which libraries a page sends (libsFor in src/worker.js)');
const libsFor = Function('RESOLVERS', slice(worker, 'function libsFor(initial) {', '\n}\n') + '\n}\nreturn libsFor;')(R);
const res8 = R.get('8.8.8.8') && !R.get('74.1.2.3');
ok(res8, 'resolvers.js knows 8.8.8.8 and not 74.1.2.3 (the cases below rely on it)');
const placed = { lat: 26.27, lon: -80.27, countryCode: 'US' };
const CASES = [
  ['the plain shell', null, ['land']], ['the homepage', { kind: 'self', data: { ip: '81.2.69.142' } }, ['land']],
  ['an address IPinfo places', { kind: 'ip', query: '74.1.2.3', data: placed }, ['land']],
  ['an address placed in a country only', { kind: 'ip', query: '74.1.2.3', data: { countryCode: 'US' } }, ['land']],
  ['an address IPinfo has no place for', { kind: 'ip', query: '74.1.2.3', data: {} }, []],
  ['a resolver\'s address', { kind: 'ip', query: '8.8.8.8', data: placed }, ['land', 'resolvers']],
  ['a resolver\'s address whose lookup failed', { kind: 'ip', query: '8.8.8.8', error: 'IPinfo did not answer' }, ['resolvers']],
  ['a non-public address', { kind: 'ip', query: '192.168.1.1', data: { bogon: true, range: 'private network (RFC 1918)' } }, []],
  ['an IPinfo bogon', { kind: 'ip', query: '192.88.99.1', data: { bogon: true } }, []],
  ['a whois of a resolver\'s address', { kind: 'whois', query: '8.8.8.8', data: { kind: 'ip', query: '8.8.8.8' } }, ['resolvers']],
  ['a whois of another address', { kind: 'whois', query: '74.1.2.3', data: { kind: 'ip', query: '74.1.2.3' } }, []],
  ['a whois of a domain', { kind: 'whois', query: 'example.com', data: { kind: 'domain', query: 'example.com' } }, []],
  ['a port\'s page', { kind: 'port', query: '22' }, ['ports']], ['/port', { kind: 'tool', tool: 'port' }, ['ports']],
  ['/leaktest', { kind: 'tool', tool: 'leaktest' }, ['leakgrade']], ['a shared leak test result', { kind: 'leakshare', code: '1bjp' }, ['leakgrade']],
  ...['dns', 'mail', 'grade', 'asn', 'cidr'].map(k => [`a ${k} page`, { kind: k, query: 'example.com', data: {} }, []]),
  ['/whois', { kind: 'tool', tool: 'whois' }, []], ['a 404', { kind: 'notfound', path: '/x' }, []],
];
for (const [what, init, want] of CASES) ok(JSON.stringify(libsFor(init)) === JSON.stringify(want), `${what}: ${want.join(', ') || 'none'} (got ${libsFor(init).join(', ') || 'none'})`);

const ORDER = scripts(INDEX).map(s => s.name);
ok(ORDER.join() === 'land,cidr,ports,resolvers,leakgrade,app' && scripts(INDEX).every(s => s.defer),
  `public/index.html lists every library, deferred, cidr.js and app.js among them: ${ORDER.join(', ')}`);
const PAGES = [['/', ['land']], ['/74.1.2.3', ['land']], ['/8.8.8.8', ['land', 'resolvers']], ['/192.168.1.1', []], ['/port/22', ['ports']], ['/port', ['ports']],
  ['/leaktest', ['leakgrade']], ['/leaktest/r/1bjp', ['leakgrade']], ['/dns/example.test', []], ['/no-such-page', []]];
for (const [path, want] of PAGES) {
  const r = await run(path), got = scripts(r.body), names = got.map(s => s.name);
  const expect = ORDER.filter(n => n === 'cidr' || n === 'app' || want.includes(n));
  const lj = libsJson(r.body);
  ok(names.join() === expect.join() && got.every(s => s.defer && s.v === ver(s.name + '.js')) && !!lj &&
    ['land', 'ports', 'resolvers', 'leakgrade'].every(n => lj[n] === `/${n}.js?v=${ver(n + '.js')}`) && Object.keys(lj).length === 4,
    `${path} (${r.status}) sends ${names.join(', ')}, each versioned, and #ipterm-libs lists the four libraries`);
}

console.log('-- versioned links (assetVersions and assetLinks in src/worker.js) and their cache rules (public/_headers)');
const guides = readdirSync(new URL('public/guides/', root)).filter(f => f.endsWith('.html')).map(f => '/guides/' + f.slice(0, -5));
const LINKED = [...PAGES.map(p => p[0]), '/changes', '/public-dns', '/privacy', '/guides', ...guides, '/go?q=%3F%3F'];
for (const path of LINKED) {
  const r = await run(path), links = [...r.body.matchAll(/(?:src|href)="\/(prefs\.js|app\.css)\?v=([0-9a-z]+)"/g)];
  ok(r.status < 500 && bare(r.body).length === 0 && links.length === 2 && links.every(m => m[2] === ver(m[1])),
    `${path}: prefs.js and app.css with their versions, and no bare link${bare(r.body).length ? ': ' + bare(r.body).join(' ') : ''}`);
}
// public/_headers: a year for exactly the versioned files (and the fonts, whose names never change), five minutes for sponsors.json
const rules = [...HEADERS.matchAll(/^(\/\S*)\n((?:[ \t]+.*\n?)*)/gm)].map(m => [m[1], m[2]]);
const year = rules.filter(([, h]) => /Cache-Control: public, max-age=31536000, immutable/.test(h)).map(([p]) => p);
ok(year.filter(p => p !== '/fonts/*').sort().join() === VERSIONED.map(f => '/' + f).sort().join(),
  `public/_headers keeps exactly the versioned files a year: ${year.join(' ')}`);
ok(rules.some(([p, h]) => p === '/sponsors.json' && /^\s+Cache-Control: public, max-age=300\s*$/m.test(h)), 'public/_headers keeps /sponsors.json five minutes');
const skip = [...toml.matchAll(/"!(\/[^"]+)"/g)].map(m => m[1]);
ok(VERSIONED.every(f => skip.includes('/' + f)), 'wrangler.toml serves every versioned file without the Worker (run_worker_first), so public/_headers applies');
const htmlFiles = ['index.html', 'privacy.html', 'guides.html', ...guides.map(g => g.slice(1) + '.html')];
const linked = new Set(htmlFiles.flatMap(f => [...read('public/' + f).matchAll(/(?:src|href)="\/([^"?#]+\.(?:js|css))"/g)].map(m => m[1])));
ok([...linked].every(f => VERSIONED.includes(f)), `the pages in public/ link no script or stylesheet that isn't versioned: ${[...linked].join(', ')}`);
ok(worker.includes('if (tags.every(Boolean)) ASSET_V = v;'), 'the versions are kept for the isolate only when every file had an ETag');
// Without ETags: the deployed version's id; with neither, bare links
const { default: W2 } = await import('../src/worker.js?no-etags');
const noTag = { ...env, ASSETS: assets({ etags: false }), CF_VERSION_METADATA: { id: '7d4c1f0e-9a2b-4c3d-8e5f-0123456789ab', tag: 'abc1234' } };
const r2 = await run('/8.8.8.8', {}, W2, noTag);
ok(scripts(r2.body).every(s => s.v === '7d4c1f0e9a2b') && /href="\/app\.css\?v=7d4c1f0e9a2b"/.test(r2.body), 'with no ETags, the links carry the deployed version\'s id');
const r3 = await run('/8.8.8.8', {}, W2, { ...env, ASSETS: assets({ etags: false }) });
ok(scripts(r3.body).every(s => !s.v) && /href="\/app\.css"/.test(r3.body) && libsJson(r3.body).land === '/land.js', '... and with neither, they stay bare');

console.log('-- a static page\'s ETag (withOrigin in src/worker.js)');
const priv = await run('/privacy'), tag = priv.headers.get('etag'), own = etagOf(fileOf('/privacy')[1]);
ok(priv.status === 200 && tag && tag.startsWith(own.slice(0, -1) + '-') && /-[0-9a-f]{8}"$/.test(tag), `/privacy's ETag is the file's plus the versions' hash: ${tag}`);
const same = await run('/privacy', { 'if-none-match': tag });
ok(same.status === 304 && same.body === '' && same.headers.get('etag') === tag, '... If-None-Match with it: 304, no body');
const old = await run('/privacy', { 'if-none-match': own }), other = await run('/privacy', { 'if-none-match': '"abc"' });
ok(old.status === 200 && old.body.includes('/app.css?v=') && other.status === 200, '... with the file\'s own ETag (kept from before) or another: the whole page, linking the current app.css');
const xml = await run('/BingSiteAuth.xml'), xtag = xml.headers.get('etag'), x304 = await run('/BingSiteAuth.xml', { 'if-none-match': xtag });
ok(xml.status === 200 && xtag === etagOf(fileOf('/BingSiteAuth.xml')[1]) && x304.status === 304, 'a file that isn\'t a page keeps its own ETag, and gets its 304');

console.log('-- font preloads');
const PRELOAD = f => `<link rel="preload" href="/fonts/${f}" as="font" type="font/woff2" crossorigin>`;
const FONTS = ['ibm-plex-mono-latin-400-normal.woff2', 'vt323-latin-400-normal.woff2'];
ok(FONTS.every(f => existsSync(new URL('public/fonts/' + f, root))), 'both preloaded fonts exist in public/fonts/');
for (const path of ['/', '/8.8.8.8', '/privacy', '/guides', ...guides, '/changes', '/public-dns']) {
  const b = (await run(path)).body, css = b.indexOf('<link rel="stylesheet"');
  ok(FONTS.every(f => b.includes(PRELOAD(f)) && b.indexOf(PRELOAD(f)) < css), `${path} preloads IBM Plex Mono 400 and VT323 before the stylesheet`);
}
ok(read('tools/build_guides.py').includes(FONTS.map(PRELOAD).join('\n')), 'tools/build_guides.py writes both preloads into every guide');

console.log('-- the prompt without a script');
ok(/<form class="prompt" id="line" action="\/go" method="get" autocomplete="off">/.test(INDEX) && /<input id="cmd" name="q" /.test(INDEX),
  'the prompt goes to /go, with the command as q');
const go = await run('/go?q=8.8.8.8');
ok(go.status === 302 && /\/8\.8\.8\.8$/.test(go.headers.get('location') || ''), `/go?q=8.8.8.8 sends it on to /8.8.8.8 (${go.status} ${go.headers.get('location')})`);
ok(app.includes("form.addEventListener('submit', e => {\n    e.preventDefault();"), 'with app.js running, submitting the prompt stays on the page');

console.log('-- public/app.js');
// lib() against a stand-in document: each script element "loads" on the next turn and sets its global, unless told to fail
const made = [];
function fakeDoc(win, failing) {
  return {
    getElementById: () => ({ textContent: JSON.stringify({ land: '/land.js?v=abc123', ports: 'https://elsewhere.example/ports.js' }) }),
    createElement: () => {
      const s = { remove() { s.removed = true; } };
      made.push(s);
      setTimeout(() => { if (failing.has(s.src)) s.onerror(); else { win[{ '/land.js?v=abc123': 'IPTERM_GEO', '/ports.js': 'IPTERM_PORTS' }[s.src] || 'X'] = { loaded: s.src }; s.onload(); } }, 0);
      return s;
    },
    head: { appendChild() {} },
  };
}
const win = {}, failing = new Set(['/ports.js']);
const lib = Function('window', 'document', slice(app, '  const LIB_SRC =', '  /* ---------- dot-matrix map') + 'return lib;')(win, fakeDoc(win, failing));
const [a1, a2] = await Promise.all([lib('land', 'IPTERM_GEO'), lib('land', 'IPTERM_GEO')]);
ok(a1 && a1.loaded === '/land.js?v=abc123' && a1 === a2 && made.length === 1, 'lib() loads a library once, from the address #ipterm-libs gives');
ok(await lib('land', 'IPTERM_GEO') === a1 && made.length === 1, '... and not again once its global is there');
const p1 = await lib('ports', 'IPTERM_PORTS');
ok(p1 === null && made[1].src === '/ports.js' && made[1].removed, 'an address that isn\'t /<file>.js becomes /<file>.js; a load that fails says null and takes its element out');
failing.clear();
const p2 = await lib('ports', 'IPTERM_PORTS');
ok(p2 && p2.loaded === '/ports.js' && made.length === 3, '... and the next call tries again');
ok(['let GEO = window.IPTERM_GEO || null;', "const needGeo = () => lib('land', 'IPTERM_GEO').then(g => (GEO = g));",
  'let PORTSLIB = window.IPTERM_PORTS || null;', "const needPorts = () => lib('ports', 'IPTERM_PORTS').then(x => (PORTSLIB = x));",
  'let RESLIB = window.IPTERM_RESOLVERS || null;', "const needResolvers = () => lib('resolvers', 'IPTERM_RESOLVERS').then(x => (RESLIB = x));",
  'let LEAKLIB = window.IPTERM_LEAK || null;', "const needLeak = () => lib('leakgrade', 'IPTERM_LEAK').then(x => (LEAKLIB = x));"].every(s => app.includes(s)),
  'each library has a loader that sets what the terminal reads (GEO, PORTSLIB, RESLIB, LEAKLIB)');
ok(app.includes("const libs = !pre && Promise.all([needGeo(), needResolvers()]);") && app.includes("const libs = !pre && p && needResolvers();") &&
  app.includes("await Promise.all([getJson('/api/check'), webrtcIps(), cfTrace(), needLeak()]);") && app.includes('const L = await needLeak(), r = L && L.decode(code);') &&
  app.includes("async function portCmd(args) {\n    await needPorts();") && app.includes("case 'public-dns': await needResolvers(); return publicDns(args);") &&
  app.includes("if (name === 'leaktest') await needLeak();") && /q = line\('querying…', 'sys'\), geo = needGeo\(\);/.test(app),
  'lookup, whois, leaktest, a shared result, port, public-dns, man leaktest and whoami load what they need, typed lookups while the API answers');
const hrefFor = Function('parseIp', 'domainOf', 'mailArgs', 'looksLikeDomain', 'recordName', 'CIDRLIB', 'looksLikeCidr', 'ipPath', 'LEAKLIB',
  slice(app, '  function hrefFor(cmd) {', '  /* ---------- next: suggested follow-ups') + 'return hrefFor;')(() => null, s => s, () => ({}), () => false, () => false, null, () => false, s => '/' + s, null);
const ports = ['0', '1', '22', '080', '65535', '65536', '99999', '22x', '-1', '1e3', '00022', '000022', '0000443', '+22'];
ok(ports.every(a => hrefFor('port ' + a) === (PORTS.parse(a) ? '/port/' + PORTS.parse(a) : null)) && hrefFor('port') === '/port',
  `hrefFor() links a port exactly when PORTS.parse reads one, without ports.js (${ports.map(a => `${a}: ${hrefFor('port ' + a)}`).join(', ')})`);
ok(/leaktest: \['leaktest {3}or {3}leaktest --result <code>', "[^\n]*\n {6}\['leaktest'\], \['whoami', 'share'\], \['\/leaktest\/r\/1bjp', '\/leaktest\/r\/1bjp\?format=text'\], \(\) => \[/.test(app) &&
  app.includes("if (m && m[5]) rows.push(...(typeof m[5] === 'function' ? m[5]() : m[5]));"), 'man leaktest reads its rubric from leakgrade.js when it runs, not when app.js starts');
const home = (await run('/')).body, homeHead = (/<div class="static" id="static" data-nosnippet>[\s\S]*?<div class="head">([\s\S]*?)<\/div>/.exec(home) || [])[1] || '';
const barOrder = [...slice(app, '  function shareBar(r) {', '  // Whether the Markdown leaves you out').matchAll(/btn\('([a-z]+)'/g)].map(m => m[1]);
ok(barOrder.join() === 'share,copy,md' && homeHead.endsWith('<span class="share js-only" aria-hidden="true">' + barOrder.map(b => `<span class="share-btn">${b}</span>`).join('') + '</span>'),
  "the homepage's server copy ends its head line with the terminal's [share] [copy] [md], hidden without scripts");
const kinds = JSON.parse((/const RESULT_KINDS = (\[[^\]]*\]);/.exec(app) || [])[1].replace(/'/g, '"'));
ok(kinds.join() === 'ip,asn,whois,dns,mail,grade,cidr' && app.includes("const withResult = selfP || (init && (['port', 'leakshare'].includes(init.kind) || (RESULT_KINDS.includes(init.kind) && init.query)));") &&
  app.includes('fast = hold = !!withResult;') && (app.match(/echo\(cmd\); addHist\(cmd\); settle\(mark\);/g) || []).length === 3 && (app.match(/\n {6}end\(mark\);/g) || []).length === 3,
  'a page that comes with its result (the homepage, a lookup\'s page, a port\'s page, a shared leak test result) draws it at once and stays put meanwhile');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
