// Checks plain http on the live host (route() in src/worker.js). Browsers, crawlers and link previews that ask over
// http get a 301 to the same address on https; curl and scripts are answered over http as before (`curl ipterm.net`
// prints the address, and /expect's 412 still reaches `curl -fs ... || pkill`, where a 301 would exit 0); every
// address an answer builds (robots.txt, the sitemaps, a guide's %ORIGIN%, a page's canonical, og:url, og:image and
// JSON-LD) and every cache key says https whichever way the request came; and wrangler dev's hosts (127.0.0.1,
// localhost, [::1]) stay on plain http. Last, the report card of the Worker's own host: grade ipterm.net on
// ipterm.net is answered in-process (webCheck), with its security headers and the 301, and no request to
// ipterm.net; on another host, and for example.com, the site is fetched as before. No server and no network: the
// whole Worker runs in Node with its static files read from public/, and fetch stubbed (an IPinfo Lite answer, an
// empty answer to every other DNS query, reverse DNS among them, and A/AAAA plus a site answer for ipterm.net
// (HTTP 522, as live) and example.com; anything else is a 404).
//
//   node tools/check_https.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };

// The Worker's two Cloudflare-only modules get stand-ins: nothing here builds a Durable Object or a socket.
const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_https.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const keys = [];                                         // every Cache API key the Worker reads or writes
const store = new Map();
const keyOf = req => (typeof req === 'string' ? req : req.url);
globalThis.caches = { default: {
  async match(req) { keys.push(keyOf(req)); const e = store.get(keyOf(req)); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { keys.push(keyOf(req)); store.set(keyOf(req), { body: await res.text(), headers: [...res.headers] }); },
} };

const other = [];                                        // outside requests this check doesn't expect
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
// The sites the report card grades below: one public address each. Over the network, ipterm.net answers what a
// Worker's own fetch to it gets live (HTTP 522), and example.com a plain page with no security headers.
const SITES = { 'ipterm.net': { A: '104.21.48.1', AAAA: '2606:4700:3030::6815:3001', status: 522 }, 'example.com': { A: '93.184.215.14', AAAA: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', status: 200 } };
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  const m = /^https:\/\/api\.ipinfo\.io\/lite\/([^?]+)/.exec(u);
  if (m) return reply({ ip: m[1], asn: 'AS15169', as_name: 'Google LLC', as_domain: 'google.com', country_code: 'US', country: 'United States', continent: 'North America' });
  const q = /^https:\/\/cloudflare-dns\.com\/dns-query\?name=([^&]+)&type=(A|AAAA)$/.exec(u);
  if (q && Object.hasOwn(SITES, q[1])) return reply({ Status: 0, Answer: [{ name: q[1], type: q[2] === 'A' ? 1 : 28, TTL: 300, data: SITES[q[1]][q[2]] }] });
  if (u.startsWith('https://cloudflare-dns.com/')) return reply({ Status: 3, Answer: [] });
  other.push(u);
  const site = /^https?:\/\/([^/]+)\//.exec(u);
  if (site && Object.hasOwn(SITES, site[1])) return new Response(null, { status: SITES[site[1]].status });
  return new Response('not stubbed in tools/check_https.mjs', { status: 404 });
};

// Static files the way Workers static assets serve them: /guides/x is public/guides/x.html, / is index.html.
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', txt: 'text/plain', xml: 'application/xml' };
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
const env = { IPINFO_TOKEN: 'test-token', ASSETS };
const { default: W } = await import('../src/worker.js');

const GOOG = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const ME = '81.2.69.142';

// One request as the Worker sees it. cf: what Cloudflare's edge would say about the caller (/expect reads it).
async function run(url, { ua, method = 'GET', cf, envPlus = {}, ...headers } = {}) {
  keys.length = 0; other.length = 0;
  const req = new Request(url, { method, headers: { 'user-agent': ua, 'cf-connecting-ip': ME, ...headers } });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  const waits = [];
  const res = await W.fetch(req, { ...env, ...envPlus }, { waitUntil: p => waits.push(p) });
  const body = await res.text();
  await Promise.allSettled(waits);
  return { status: res.status, location: res.headers.get('location'), headers: res.headers, body, keys: [...keys], other: [...other] };
}
const show = r => `${r.status}${r.location ? ' ' + r.location : ''}`;
const meta = (re, b) => (re.exec(b) || [])[1];
const canonical = b => meta(/<link rel="canonical" href="([^"]*)">/, b);

console.log('-- http on ipterm.net: pages go to https (301), with the path and query, from one hop');
for (const [who, url, opts, want] of [
  ['Googlebot', 'http://ipterm.net/', { ua: GOOG }, 'https://ipterm.net/'],
  ['Googlebot', 'http://ipterm.net/cidr/10.0.0.0/30', { ua: GOOG }, 'https://ipterm.net/cidr/10.0.0.0/30'],
  ['Googlebot', 'http://ipterm.net/robots.txt', { ua: GOOG }, 'https://ipterm.net/robots.txt'],
  ['Googlebot', 'http://ipterm.net/sitemap-pages.xml', { ua: GOOG }, 'https://ipterm.net/sitemap-pages.xml'],
  ['Googlebot, HEAD', 'http://ipterm.net/guides/ipv4-vs-ipv6', { ua: GOOG, method: 'HEAD' }, 'https://ipterm.net/guides/ipv4-vs-ipv6'],
  ['a link preview (Slackbot)', 'http://ipterm.net/leaktest', { ua: SLACK }, 'https://ipterm.net/leaktest'],
  ['a browser navigation', 'http://ipterm.net/8.8.8.8?block=0', { ua: CHROME, ...NAV }, 'https://ipterm.net/8.8.8.8?block=0'],
  ['a browser navigation, router typo', 'http://ipterm.net/192.168.l.l', { ua: CHROME, ...NAV }, 'https://ipterm.net/192.168.l.l'],
  ['a browser navigation, port 8080', 'http://ipterm.net:8080/whois', { ua: CHROME, ...NAV }, 'https://ipterm.net/whois'],
]) {
  const r = await run(url, opts);
  ok(r.status === 301 && r.location === want && r.other.length === 0 && r.keys.length === 0, `${who}, ${url}: ${show(r)}`);
}
const vary = await run('http://ipterm.net/', { ua: GOOG });
ok(/accept/i.test(vary.headers.get('vary') || '') && /user-agent/i.test(vary.headers.get('vary') || ''), `the 301 varies on Accept and User-Agent: ${vary.headers.get('vary')}`);
ok(/max-age=31536000; includeSubDomains/.test(vary.headers.get('strict-transport-security') || ''), `... and keeps the HSTS header: ${vary.headers.get('strict-transport-security')}`);

console.log('-- http on ipterm.net: curl and scripts are answered over http, never with a redirect');
const bare = await run('http://ipterm.net/', { ua: 'curl/8.7.1', accept: '*/*' });
ok(bare.status === 200 && bare.body === ME + '\n', `curl http://ipterm.net/: ${show(bare)} ${JSON.stringify(bare.body)}`);
const cf = { asn: 13335, country: 'CH' };
const hit = await run('http://ipterm.net/expect/AS13335', { ua: 'curl/8.7.1', accept: '*/*', cf });
ok(hit.status === 200 && hit.body === 'AS13335\n', `curl http://ipterm.net/expect/AS13335 from AS13335: ${show(hit)} ${JSON.stringify(hit.body)}`);
const miss = await run('http://ipterm.net/expect/AS64500', { ua: 'curl/8.7.1', accept: '*/*', cf });
ok(miss.status === 412 && !miss.location, `curl http://ipterm.net/expect/AS64500 from AS13335: ${show(miss)}, so curl -f fails and the kill switch fires`);
const js = await run('http://ipterm.net/cidr/10.0.0.0/30', { ua: 'python-requests/2.32.3', accept: '*/*' });
ok(js.status === 200 && /"network": "10\.0\.0\.0"/.test(js.body), `a script, http://ipterm.net/cidr/10.0.0.0/30: ${show(js)}, JSON`);
const fmt = await run('http://ipterm.net/cidr/10.0.0.0/30?format=json', { ua: CHROME, ...NAV });
ok(fmt.status === 200 && /"network": "10\.0\.0\.0"/.test(fmt.body), `a browser on ?format=json over http: ${show(fmt)}, JSON (it asked for JSON, not the page)`);

console.log('-- ... and what they get names https, as do the cache keys');
const rb = await run('http://ipterm.net/robots.txt', { ua: 'curl/8.7.1', accept: '*/*' });
ok(rb.status === 200 && rb.body.includes('\nSitemap: https://ipterm.net/sitemap.xml\n'), `curl http://ipterm.net/robots.txt: ${show(rb)}, ${(/Sitemap: \S+/.exec(rb.body) || ['no Sitemap line'])[0]}`);
for (const f of ['/sitemap.xml', '/sitemap-pages.xml']) {
  const r = await run('http://ipterm.net' + f, { ua: 'curl/8.7.1', accept: '*/*' });
  const locs = [...r.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  ok(r.status === 200 && locs.length > 0 && locs.every(l => l.startsWith('https://ipterm.net/')), `curl http://ipterm.net${f}: ${show(r)}, ${locs.length} <loc>s, ${locs.filter(l => !l.startsWith('https://ipterm.net/')).length} not https`);
}
const guide = await run('http://ipterm.net/guides/ipv4-vs-ipv6', { ua: 'curl/8.7.1', accept: '*/*' });
ok(guide.status === 200 && canonical(guide.body) === 'https://ipterm.net/guides/ipv4-vs-ipv6' && !guide.body.includes('%ORIGIN%') && !guide.body.includes('http://ipterm.net'),
  `curl http://ipterm.net/guides/ipv4-vs-ipv6: ${show(guide)}, %ORIGIN% filled in, canonical ${canonical(guide.body)}`);
const one = await run('http://ipterm.net/8.8.8.8/asn', { ua: 'curl/8.7.1', accept: '*/*' });
ok(one.status === 200 && one.body === 'AS15169\n' && one.keys.length > 0 && one.keys.every(k => k.startsWith('https://ipterm.net/__cache/')),
  `curl http://ipterm.net/8.8.8.8/asn: ${show(one)}, cache keys ${JSON.stringify(one.keys)}`);
const again = await run('https://ipterm.net/8.8.8.8/asn', { ua: 'curl/8.7.1', accept: '*/*' });
ok(again.status === 200 && again.other.length === 0 && again.keys.length > 0 && again.keys.every(k => one.keys.includes(k)),
  'then curl https://ipterm.net/8.8.8.8/asn reads the same entry, with no outside request: one cache for both schemes');
// A script that doesn't ask for HTML still gets the homepage at / (only curl and the like get the bare address), so
// this is a page built for a request over http.
const home = await run('http://ipterm.net/', { ua: 'python-requests/2.32.3', accept: '*/*' });
ok(home.status === 200 && canonical(home.body) === 'https://ipterm.net/' && meta(/<meta property="og:url" content="([^"]*)">/, home.body) === 'https://ipterm.net/' &&
  meta(/<meta property="og:image" content="([^"]*)">/, home.body) === 'https://ipterm.net/og.png' && home.body.includes('"url":"https://ipterm.net/"') &&
  !home.body.includes('http://ipterm.net'), `a script, http://ipterm.net/: ${show(home)}, the homepage, canonical ${canonical(home.body)}, og:url, og:image and JSON-LD on https`);
const page = await run('https://ipterm.net/cidr/10.0.0.0/30', { ua: GOOG });
ok(page.status === 200 && canonical(page.body) === 'https://ipterm.net/cidr/10.0.0.0/30' &&
  meta(/<meta property="og:url" content="([^"]*)">/, page.body) === 'https://ipterm.net/cidr/10.0.0.0/30' &&
  meta(/<meta property="og:image" content="([^"]*)">/, page.body) === 'https://ipterm.net/og.png' &&
  page.body.includes('"item":"https://ipterm.net/cidr"') && !page.body.includes('http://ipterm.net'),
  `Googlebot after the redirect, https://ipterm.net/cidr/10.0.0.0/30: ${show(page)}, canonical, og:url, og:image and JSON-LD on https`);

console.log("-- wrangler dev's hosts keep plain http (127.0.0.1, localhost, [::1])");
for (const base of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
  const r = await run(base + '/cidr/10.0.0.0/30', { ua: GOOG });
  const rt = await run(base + '/robots.txt', { ua: 'curl/8.7.1', accept: '*/*' });
  ok(r.status === 200 && canonical(r.body) === base + '/cidr/10.0.0.0/30' && rt.body.includes(`Sitemap: ${base}/sitemap.xml`),
    `${base}/cidr/10.0.0.0/30 for Googlebot: ${show(r)}, canonical ${canonical(r.body)}; robots.txt names ${base}`);
}
// The DNS leak test's API may be plain http on this machine only (dnsleakConf(), which shares the local-host test).
const leak = api => ({ DNSLEAK_ZONE: 'dl.example.test', DNSLEAK_KEY: 'k'.repeat(32), DNSLEAK_API: api });
const csp = async api => (await run('https://ipterm.net/robots.txt', { ua: 'curl/8.7.1', envPlus: leak(api) })).headers.get('content-security-policy') || '';
ok((await csp('http://127.0.0.1:9053')).includes('https://*.dl.example.test') && (await csp('https://dlapi.example.test')).includes('https://*.dl.example.test') &&
  !(await csp('http://dlapi.example.test')).includes('dl.example.test'), 'DNSLEAK_API: https, or plain http on 127.0.0.1 only');

console.log("-- grade of the Worker's own host: its homepage answered in-process (webCheck), so its headers and the 301 show");
const card = async (base, domain) => {
  const r = await run(`${base}/api/grade?domain=${domain}`, { ua: 'curl/8.7.1', accept: '*/*' });
  let d = {}; try { d = JSON.parse(r.body); } catch {}
  const line = c => (d.checks || []).find(x => x.section === 'web' && x.check === c) || {};
  return { ...r, d, line, web: (d.web && d.web.https) || {}, sites: r.other.filter(u => /^https?:\/\/[^/]+\/$/.test(u)) };
};
const self = await card('https://ipterm.net', 'ipterm.net'), sh = self.web.headers || {};
ok(self.status === 200 && self.line('HTTPS').status === 'ok' && self.web.status === 200 && self.web.final === 'https://ipterm.net/' && self.sites.length === 0,
  `grade ipterm.net on ipterm.net: HTTPS ${self.line('HTTPS').status} (${self.line('HTTPS').text}), with no request to ipterm.net over the network (${JSON.stringify(self.sites)})`);
ok(/default-src 'none'/.test(sh['content-security-policy'] || '') && /max-age=31536000; includeSubDomains/.test(sh['strict-transport-security'] || '') &&
  sh['x-content-type-options'] === 'nosniff' && sh['referrer-policy'] === 'no-referrer' &&
  ['HSTS', 'CSP', 'nosniff', 'frames', 'referrer'].every(c => self.line(c).status === 'ok') && !(self.d.notChecked || []).includes('security headers'),
  `... and its own security headers, every header line OK: ${['HSTS', 'CSP', 'nosniff', 'frames', 'referrer'].map(c => c + ' ' + self.line(c).status).join(', ')}`);
ok(self.line('HTTP').status === 'ok' && self.d.web.http && self.d.web.http.upgrades === true && self.d.web.http.to === 'https://ipterm.net/' && !(self.d.notChecked || []).includes('HTTP redirect'),
  `... and http://ipterm.net/ redirects to HTTPS (the 301 for browsers): HTTP ${self.line('HTTP').status}, ${JSON.stringify(self.d.web.http)}`);
const away = await card('https://ipterm.example.workers.dev', 'ipterm.net');
ok(away.line('HTTPS').status === 'info' && /HTTP 522/.test(away.line('HTTPS').text || '') && away.sites.includes('https://ipterm.net/') && away.sites.includes('http://ipterm.net/'),
  `grade ipterm.net on another host: over the network as before (${JSON.stringify(away.sites)}), HTTPS ${away.line('HTTPS').status}: ${away.line('HTTPS').text}`);
const ex = await card('https://ipterm.net', 'example.com');
ok(ex.line('HTTPS').status === 'ok' && ex.line('HTTP').status === 'warn' && ex.line('HSTS').status === 'warn' && ex.sites.includes('https://example.com/') && ex.sites.includes('http://example.com/'),
  `grade example.com on ipterm.net: over the network (${JSON.stringify(ex.sites)}), HTTPS ${ex.line('HTTPS').status}, HTTP ${ex.line('HTTP').status}, HSTS ${ex.line('HSTS').status}`);

const hb = readFileSync(new URL('docs/handbook.md', root), 'utf8');
ok(hb.includes('tools/check_https.mjs') && hb.includes('Always Use HTTPS'), 'docs/handbook.md describes http and this check');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
