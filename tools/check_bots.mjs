// Checks that bots never spend the IPinfo Core or proxycheck.io budgets (isBot() in src/worker.js), nor start a
// RIPEstat routing lookup, and the page rules that keep crawlers off a network's first address and from one prefix's
// page to the next. No server and no network: the whole Worker runs in Node, with IPINFO_PLAN = "core", an
// IPINFO_TOKEN and a PROXYCHECK_KEY set, its budget counter (env.BUDGET) stubbed to throw when a bot asks it for a
// lookup, and fetch stubbed to answer as IPinfo, proxycheck.io, RDAP, DNS and RIPEstat would and to note every
// request. So it spends nothing, and runs the same anywhere.
//
// 1. Who is a bot: isBot() read out of src/worker.js, on user agents of crawlers, link previews, AI and SEO bots and
//    headless browsers (bots), and of browsers, phones (a Cubot's included) and command-line tools (people).
// 2. What a bot gets: Googlebot, a link preview, GPTBot and an unnamed client asking for an address's page without
//    Sec-Fetch-* headers, GPTBot on /api/lookup, ClaudeBot on /<ip>/json, an HTML client on ?format=json and Googlebot
//    rendering leaktest (/api/check) get IPinfo Lite, no VPN check and no registry date, and never reach the budget
//    counter, IPinfo Core, proxycheck.io or a registry. A browser navigation (Sec-Fetch-Mode: navigate), the terminal's
//    own fetch (Sec-Fetch-Site: same-origin), curl and leaktest in a browser still get Core and proxycheck.io, but not
//    leaktest's lookup of the other IP version (?lite=1): IPinfo Lite only, its network all leaktest compares. Then
//    Googlebot gets the Core answer someone else's lookup cached, with its VPN check and registry date, for free.
// 3. The pages: whois of a registry block's first address links the block's /cidr page, not the address (the Worker's
//    page and the terminal's renderWhois() in public/app.js), and other addresses keep their lookup link, curated ones
//    too, and so do addresses registered on their own (a /32 or /128 record), while an IPv6 /32 is a block. A
//    network's first address (IPv4 x.x.x.0, IPv6 with the low 64 bits zero) has a noindex page that keeps its own
//    canonical and leads with its registered block when the lookup has it, while other addresses are indexed.
// 4. Routing (routeData): Googlebot, bingbot, GPTBot and an unnamed client asking for an uncached public /cidr page
//    get the calculation and a note, with no RIPEstat request; once a browser navigation has looked it up, they get
//    it from the cache. The terminal's /api/route, curl and a script still ask RIPEstat; a private /cidr page is the
//    same for a bot and a person and asks nothing; /route/<public> for a bot asks nothing (a redirect, or a 403 for
//    JSON); the public /cidr pages in SITEMAP_PATHS keep live routing for bots, and only those. On a page left
//    without routing for a bot (bot: true), which a browser too old to send Sec-Fetch-* gets too, the terminal (cidr in
//    public/app.js) asks /api/route once: that browser's request gets the routing and the page's own note (.route-bot)
//    goes, so it never says "open the page in a browser" above routing; Googlebot's renderer gets a 403, or nothing at
//    all when it obeys robots.txt, and the note stays, with no "network error" in its place.
// 5. Links: the Worker's ASN page links ten of its largest prefixes (up to four IPv6) and lists the rest as text, its
//    /cidr page has no links for "splits into" and "part of", and the terminal (public/app.js renderAsn, renderCidr,
//    cidr and next, run against a stand-in DOM) makes the same ASN prefixes ordinary links and the rest nofollow, and
//    its "splits into", "part of" and next: links nofollow when they open a public block, ordinary otherwise.
// 6. A busy shared address (selfInfo): with a LOOKUP_LIMITER that refuses everything, the homepage still carries the
//    visitor's IP (in the page and in the data whoami is drawn from), and /json, /text, /?format=text, the terminal's
//    /api/lookup and the visitor's own address by number answer 200 with hostname null and no reverse DNS asked, never
//    "Too many lookups"; lookups of other addresses, /hostname and leaktest's /api/check still get the 429.
// 7. proxycheck.io's catch-all "anonymous" flag alone, on an anycast address answered as Google Public DNS is
//    (8.8.4.4 here): the JSON keeps the flags, and the text answer, the IP page and the terminal (vpnText in
//    public/app.js) say "not a known VPN, proxy or Tor service" and name the catch-all flag, never "anonymizing"; the
//    terminal's map (locate, geoNote) gives an anycast address no radius, and an ordinary one keeps its 50 km. Without
//    IPINFO_TOKEN and PROXYCHECK_KEY (IPinfo's free API, as under wrangler dev), the address still carries the anycast
//    flag, so the map and the connection line say the same.
//
//   node tools/check_bots.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const worker = read('src/worker.js'), app = read('public/app.js'), INDEX = read('public/index.html');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_bots.mjs`);
  return src.slice(a, b);
}

const GOOG = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const GOOG_RENDER = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const CLAUDE = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CUBOT = 'Mozilla/5.0 (Linux; Android 10; CUBOT P30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const CURL = 'curl/8.7.1';
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const NAV = { accept: HTML, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const TERMINAL = { accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };

console.log('-- who is a bot (isBot in src/worker.js)');
const B = Function(slice(worker, 'const CLI_UA =', 'class RateLimited') + 'return { isBot };')();
const bot = (ua, headers = {}) => B.isBot(new Request('https://ipterm.net/', { headers: { 'user-agent': ua, ...headers } }), ua);
for (const ua of [GOOG, GOOG_RENDER, SLACK, GPT, CLAUDE, 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'CCBot/2.0 (https://commoncrawl.org/faq/)',
  'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
  'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)', 'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)',
  'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)', 'anthropic-ai', 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  // AI assistants fetching for a person's question are bots too (docs/handbook.md and public/llms.txt say so)
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36', 'Scrapy/2.11 (+https://scrapy.org)']) {
  ok(bot(ua, NAV) && bot(ua, { accept: '*/*' }), `a bot, even navigating or asking for JSON: ${ua.slice(0, 90)}`);
}
for (const ua of [CHROME, CUBOT, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36']) {
  ok(!bot(ua, NAV) && !bot(ua, TERMINAL) && !bot(ua, { accept: HTML, 'sec-fetch-site': 'same-origin' }) && !bot(ua, { accept: HTML, 'x-ipterm': 'port' }), `a person when navigating or in the terminal: ${ua.slice(0, 90)}`);
  ok(bot(ua, { accept: HTML }), `a bot asking for HTML without Sec-Fetch-* or X-Ipterm: ${ua.slice(0, 90)}`);
}
for (const ua of [CURL, 'Wget/1.21.4', 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.22621.4391', 'python-requests/2.32.3', 'Go-http-client/2.0', '']) {
  ok(!bot(ua, { accept: '*/*' }), `the API (command line or script asking for JSON): ${JSON.stringify(ua.slice(0, 60))}`);
}
ok(!bot(CURL, { accept: HTML }), 'curl asking for HTML is still the command line');

// The whole Worker. Its two Cloudflare-only modules get stand-ins: nothing here builds a Durable Object or a socket.
const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_bots.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const store = new Map();                                 // caches.default, shared by every request like one data center's
globalThis.caches = { default: {
  async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, { body: await res.text(), headers: [...res.headers] }); },
} };

const calls = [];                                        // every outside request, as [kind, url]
const RECORDS = {                                        // RDAP records by address; anything else gets one of its own /32 or /128
  '75.0.0.0': ['75.0.0.0', '75.255.255.255', '75.0.0.0', 8], '75.0.0.7': ['75.0.0.0', '75.255.255.255', '75.0.0.0', 8],
  '104.21.0.0': ['104.16.0.0', '104.31.255.255', '104.16.0.0', 12], '8.8.8.8': ['8.8.8.8', '8.8.8.8', '8.8.8.8', 32],
  '2603:2000::': ['2603:2000::', '2603:2000:fff:ffff:ffff:ffff:ffff:ffff', '2603:2000::', 20],
  '2600::': ['2600::', '2600:0:ffff:ffff:ffff:ffff:ffff:ffff', '2600::', 32],
};
// RIPEstat's announced-prefixes by network, smallest first, so the ASN page's largest-first order shows: AS64500 has
// 15 IPv4 /24s, 15 IPv4 /16s and 12 IPv6 /32s; AS64501 25 IPv4 /16s and no IPv6.
const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const ANNOUNCED = {
  AS64500: [...seq(15, i => `${100 + i}.1.2.0/24`), ...seq(15, i => `${20 + i}.0.0.0/16`), ...seq(12, i => `2001:${(0x1000 + i).toString(16)}::/32`)],
  AS64501: seq(25, i => `${60 + i}.0.0.0/16`),
};
// Answered as IPinfo Core, IPinfo's free API and proxycheck.io answer for Google Public DNS: anycast and hosting, and
// proxycheck.io's catch-all "anonymous" flag with no VPN, proxy or Tor finding.
const ANYCAST = new Set(['8.8.4.4']);
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  let m;
  if ((m = /^https:\/\/api\.ipinfo\.io\/lookup\/([^?]+)/.exec(u)) && ANYCAST.has(m[1])) {
    calls.push(['core', u]);
    return reply({ ip: m[1], hostname: 'dns.google', geo: { city: 'Mountain View', region: 'California', country: 'United States', country_code: 'US',
      continent: 'North America', latitude: 38.00881, longitude: -122.11746, timezone: 'America/Los_Angeles', postal_code: '94043' },
    as: { asn: 'AS15169', name: 'Google LLC', domain: 'google.com', type: 'hosting' }, is_anycast: true, is_hosting: true });
  }
  if ((m = /^https:\/\/ipinfo\.io\/([^/?]+)\/json$/.exec(u)) && ANYCAST.has(m[1])) {
    calls.push(['ipinfo', u]);
    return reply({ ip: m[1], hostname: 'dns.google', city: 'Mountain View', region: 'California', country: 'US', loc: '38.0088,-122.1175',
      org: 'AS15169 Google LLC', postal: '94043', timezone: 'America/Los_Angeles', anycast: true });
  }
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u)) && ANYCAST.has(m[1])) {
    calls.push(['proxycheck', u]);
    return reply({ status: 'ok', [m[1]]: { network: { type: 'business' }, detections: { proxy: false, vpn: false, tor: false, hosting: false, anonymous: true, risk: 100 } } });
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lookup\/([^?]+)/.exec(u))) {
    calls.push(['core', u]);
    return reply({ ip: m[1], geo: { city: 'Coral Springs', region: 'Florida', country: 'United States', country_code: 'US', continent: 'North America',
      latitude: 26.27, longitude: -80.27, timezone: 'America/New_York', postal_code: '33065' },
    as: { asn: 'AS7922', name: 'Comcast Cable Communications, LLC', domain: 'comcast.com', type: 'isp' } });
  }
  if ((m = /^https:\/\/api\.ipinfo\.io\/lite\/([^?]+)/.exec(u))) {
    calls.push(['lite', u]);
    return reply({ ip: m[1], asn: 'AS7922', as_name: 'Comcast Cable Communications, LLC', as_domain: 'comcast.com', country_code: 'US', country: 'United States', continent: 'North America' });
  }
  if ((m = /^https:\/\/proxycheck\.io\/v3\/([^?]+)/.exec(u))) {
    calls.push(['proxycheck', u]);
    return reply({ status: 'ok', [m[1]]: { network: { type: 'residential' }, detections: { proxy: false, vpn: false, tor: false, hosting: false, anonymous: false, risk: 0 } } });
  }
  if (u.startsWith('https://cloudflare-dns.com/')) { calls.push(['dns', u]); return reply({ Status: 3, Answer: [] }); }
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    calls.push(['rdap', u]);
    return reply({ services: [[m[1] === 'ipv4' ? ['0.0.0.0/0'] : m[1] === 'ipv6' ? ['::/0'] : ['1-4294967295'], ['https://rdap.test/']]] });
  }
  if ((m = /^https:\/\/rdap\.test\/ip\/(.+)$/.exec(u))) {
    calls.push(['rdap', u]);
    const ip = decodeURIComponent(m[1]), v6 = ip.includes(':');
    const [start, end, net, len] = RECORDS[ip] || [ip, ip, ip, v6 ? 128 : 32];
    return reply({ objectClassName: 'ip network', handle: 'NET-TEST', name: 'TEST-NET', type: 'DIRECT ALLOCATION', startAddress: start, endAddress: end,
      cidr0_cidrs: [{ [v6 ? 'v6prefix' : 'v4prefix']: net, length: len }], port43: 'whois.arin.net',
      events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00-04:00' }], entities: [] });
  }
  if (u.startsWith('https://check.torproject.org/')) { calls.push(['tor', u]); return new Response('', { status: 200 }); }
  if ((m = /^https:\/\/stat\.ripe\.net\/data\/([a-z-]+)\/data\.json\?(.*)$/.exec(u))) {
    calls.push(['ripestat', u]);
    const q = new URLSearchParams(m[2]), res = q.get('resource') || '', holder = 'EXAMPLENET - Example Networks, Inc.';
    switch (m[1]) {
      case 'prefix-overview':                            // announced as asked, an address as its /24 (or /48)
        return reply({ data: { resource: res.includes('/') ? res : globalThis.IPTERM_CIDR.calc(res + (res.includes(':') ? '/48' : '/24')).cidr,
          announced: true, asns: [{ asn: 64500, holder }], block: { desc: 'RIPE NCC' }, related_prefixes: [] } });
      case 'routing-status': return reply({ data: { visibility: { v4: { ris_peers_seeing: 300, total_ris_peers: 320 }, v6: { ris_peers_seeing: 300, total_ris_peers: 320 } } } });
      case 'bgp-state': return reply({ data: { bgp_state: [{ target_prefix: res, path: [3333, 1299, 64500], source_id: '00-193.0.0.56' }] } });
      case 'rpki-validation': return reply({ data: { status: 'valid', validating_roas: [{ origin: '64500', prefix: q.get('prefix'), max_length: 24 }] } });
      case 'as-overview': return reply({ data: { holder, announced: true, block: { desc: 'Assigned by RIPE NCC' } } });
      case 'announced-prefixes': return reply({ data: { prefixes: (ANNOUNCED[res] || []).map(prefix => ({ prefix })) } });
      case 'asn-neighbours': return reply({ data: { neighbours: [], neighbour_counts: { left: 0 } } });
    }
  }
  calls.push(['other', u]);
  return new Response('not stubbed in tools/check_bots.mjs', { status: 404 });
};

let mayTake = false;                                     // the budget counter allows a lookup only when a person asks
const taken = [];
const env = {
  IPINFO_TOKEN: 'test-token', IPINFO_PLAN: 'core', PROXYCHECK_KEY: 'test-key',
  BUDGET: { idFromName: name => name, get: id => ({ async take() {
    taken.push(id);
    if (!mayTake) throw new Error(`a bot reached the ${id} budget`);
    return { ok: true };
  } }) },
  ASSETS: { fetch: async () => new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
};
const { default: W } = await import('../src/worker.js');

// One request, as the Worker sees it on ipterm.net. data: the JSON answer, or the data the page boots the terminal from.
async function run(path, { ua, me = '81.2.69.142', ...headers }) {
  calls.length = 0; taken.length = 0;
  const waits = [];
  const res = await W.fetch(new Request('https://ipterm.net' + path, { headers: { 'user-agent': ua, 'cf-connecting-ip': me, ...headers } }), env,
    { waitUntil: p => waits.push(p) });
  const body = await res.text();
  for (let n = 0; n < waits.length;) { const m = waits.length; await Promise.allSettled(waits.slice(n, m)); n = m; }   // cache writes land first
  const init = /<script type="application\/json" id="ipterm-initial">([\s\S]*?)<\/script>/.exec(body);
  let data = null, initial = null;
  try { initial = init ? JSON.parse(init[1]) : null; data = initial ? initial.data : JSON.parse(body); } catch {}
  return { status: res.status, location: res.headers.get('location'), body, data, initial, kinds: calls.map(c => c[0]), taken: [...taken] };
}
const spent = r => r.taken.length > 0 || r.kinds.some(k => k === 'core' || k === 'proxycheck');

console.log('-- what a bot gets: IPinfo Lite or the cache, never a budget (src/worker.js ipData, privacyData, blockData)');
mayTake = false;
for (const [who, path, opts] of [
  ['Googlebot', '/73.0.0.0', { ua: GOOG }],
  ['a link preview (Slackbot)', '/73.1.2.3', { ua: SLACK }],
  ['GPTBot asking for the page', '/73.2.3.4', { ua: GPT, accept: HTML }],
  ['an unnamed client asking for the page without Sec-Fetch-*', '/73.3.4.5', { ua: CHROME, accept: HTML }],
  ['GPTBot on /api/lookup', '/api/lookup?ip=73.4.5.6', { ua: GPT, accept: '*/*' }],
  ['ClaudeBot on /<ip>/json', '/73.5.6.7/json', { ua: CLAUDE, accept: '*/*' }],
  ['an unnamed client asking for HTML on ?format=json', '/73.6.7.8?format=json', { ua: CHROME, accept: HTML }],
]) {
  const r = await run(path, opts), d = r.data || {};
  ok(r.status === 200 && d.source === 'ipinfo-lite' && !d.privacy && !d.block && !spent(r) && !r.kinds.includes('rdap'),
    `${who}, ${path}: ${r.status}, source ${d.source}, ${d.privacy ? 'a VPN check' : 'no VPN check'}, ${d.block ? 'a registry date' : 'no registry date'}; ` +
    `budget counter ${JSON.stringify(r.taken)}, requests ${JSON.stringify(r.kinds)}`);
}
const leakBot = await run('/api/check', { ua: GOOG_RENDER, me: '73.7.8.9', ...TERMINAL });
const lb = (leakBot.data || {}).network || {};
ok(leakBot.status === 200 && lb.source === 'ipinfo-lite' && !lb.privacy && !spent(leakBot),
  `Googlebot rendering leaktest, /api/check: source ${lb.source}, ${lb.privacy ? 'a VPN check' : 'no VPN check'}; budget counter ${JSON.stringify(leakBot.taken)}, requests ${JSON.stringify(leakBot.kinds)}`);

console.log('-- what a person and the API get: IPinfo Core and proxycheck.io, as before');
mayTake = true;
for (const [who, path, opts] of [
  ['a browser navigation', '/74.0.0.1', { ua: CHROME, ...NAV }],
  ["the terminal's own fetch", '/api/lookup?ip=74.1.2.3', { ua: CHROME, ...TERMINAL }],
  ['curl', '/74.2.3.4', { ua: CURL, accept: '*/*' }],
  ["a Cubot phone's browser", '/74.3.4.5', { ua: CUBOT, ...NAV }],
]) {
  const r = await run(path, opts), d = r.data || {};
  ok(r.status === 200 && d.source === 'ipinfo-core' && d.privacy && d.privacy.source === 'proxycheck' &&
    r.taken.includes('ipinfo-core') && r.taken.includes('proxycheck') && r.kinds.includes('core') && r.kinds.includes('proxycheck'),
    `${who}, ${path}: source ${d.source}, ${d.privacy ? 'a VPN check' : 'no VPN check'}; budget counter ${JSON.stringify(r.taken)}`);
}
const leak = await run('/api/check', { ua: CHROME, me: '74.4.5.6', ...TERMINAL });
const lp = (leak.data || {}).network || {};
ok(leak.status === 200 && lp.source === 'ipinfo-core' && lp.privacy && leak.taken.includes('ipinfo-core') && leak.taken.includes('proxycheck'),
  `leaktest in a browser, /api/check: source ${lp.source}, ${lp.privacy ? 'a VPN check' : 'no VPN check'}`);
// Its lookup of the other IP version (public/app.js: api(other, true)) asks for the network only: ?lite=1.
const lite = await run('/api/lookup?ip=74.5.6.7&block=0&lite=1', { ua: CHROME, ...TERMINAL }), lt = lite.data || {};
ok(lite.status === 200 && lt.source === 'ipinfo-lite' && lt.asn === 'AS7922' && lt.org && !lt.privacy && !lt.block && !spent(lite) && !lite.kinds.includes('rdap'),
  `leaktest's other IP version in a browser, /api/lookup?ip=...&block=0&lite=1: source ${lt.source}, ${lt.asn} ${lt.org}, ${lt.privacy ? 'a VPN check' : 'no VPN check'}; ` +
  `budget counter ${JSON.stringify(lite.taken)}, requests ${JSON.stringify(lite.kinds)}`);
const full = await run('/api/lookup?ip=74.5.6.8&block=0&lite=0', { ua: CHROME, ...TERMINAL }), fd = full.data || {};
ok(fd.source === 'ipinfo-core' && fd.privacy && full.taken.includes('ipinfo-core'), `... while lite=0 is an ordinary lookup: source ${fd.source}, ${fd.privacy ? 'a VPN check' : 'no VPN check'}`);
ok(/const otherInfo = other \? await api\(other, true\) : null;/.test(app) && app.includes("(lite ? '&lite=1' : '')"),
  'public/app.js: leaktest looks up the other IP version with lite=1');

mayTake = false;
const later = await run('/74.0.0.1', { ua: GOOG }), ld = later.data || {};
ok(ld.source === 'ipinfo-core' && ld.city === 'Coral Springs' && ld.privacy && ld.block && !spent(later) && !later.kinds.includes('rdap'),
  `then Googlebot on /74.0.0.1 gets that lookup's Core answer, VPN check and registry date from the cache: source ${ld.source}, ` +
  `requests ${JSON.stringify(later.kinds)}, budget counter ${JSON.stringify(later.taken)}`);

console.log("-- whois of a block's first address links the block (src/worker.js whoisPage, public/app.js renderWhois)");
const seeAlso = body => (/See also: <a href="([^"]*)"/.exec(body) || [])[1];
for (const [q, want, what] of [
  ['75.0.0.0', '/cidr/75.0.0.0/8', "the first address of its registry block (75.0.0.0/8)"],
  ['2603:2000::', '/cidr/2603:2000::/20', 'an IPv6 block\'s first address'],
  ['75.0.0.7', '/75.0.0.7', 'another address in the block'],
  ['104.21.0.0', '/104.21.0.0', 'an x.x.x.0 address inside a larger registry block (104.16.0.0/12)'],
  ['8.8.8.8', '/8.8.8.8', 'a curated address, even as the whole of its block (a /32 here)'],
  ['74.9.9.9', '/74.9.9.9', 'an address registered on its own (a /32 record): a host, not a block'],
  ['2600:1::5', '/2600:1::5', 'an IPv6 address registered on its own (a /128 record)'],
  ['2600::', '/cidr/2600::/32', "an IPv6 /32's first address (a /32 is a block in IPv6)"],
]) {
  const r = await run('/whois/' + q, { ua: GOOG });
  ok(seeAlso(r.body) === want, `/whois/${q}, ${what}: links ${seeAlso(r.body)}`);
}
let rows = [];
const T = Function('CIDRLIB', 'el', 'shareBar', 'out', 'kv', 'cmdLink', 'mailLink', 'line', 'announce',
  slice(app, '  function blockStart(d) {', '  async function renderAsn(') + 'return { blockStart, renderWhois };')(
  globalThis.IPTERM_CIDR, () => ({ append() {} }), () => null, { appendChild() {} }, r => { rows = r; },
  (text, cmd, href) => ({ text, cmd, href }), x => x, () => {}, () => {});
for (const [d, want] of [
  [{ kind: 'ip', query: '75.0.0.0', cidrs: ['75.0.0.0/8'] }, '/cidr/75.0.0.0/8'],
  [{ kind: 'ip', query: '2603:2000::', cidrs: ['2603:2000::/20'] }, '/cidr/2603:2000::/20'],
  [{ kind: 'ip', query: '75.0.0.7', cidrs: ['75.0.0.0/8'] }, '/75.0.0.7'],
  [{ kind: 'ip', query: '104.21.0.0', cidrs: ['104.16.0.0/12'] }, '/104.21.0.0'],
  [{ kind: 'ip', query: '74.9.9.9', cidrs: ['74.9.9.9/32'] }, '/74.9.9.9'],
  [{ kind: 'ip', query: '2600:1::5', cidrs: ['2600:1::5/128'] }, '/2600:1::5'],
  [{ kind: 'ip', query: '2600::', cidrs: ['2600::/32'] }, '/cidr/2600::/32'],
  [{ kind: 'asn', query: 'AS13335' }, '/AS13335'],
]) {
  await T.renderWhois({ found: true, org: 'Test', ...d });
  const det = (rows.find(x => x[0] === 'details') || [])[1] || {};
  ok(det.href === want, `the terminal's whois ${d.query}: details links ${det.href}`);
}

console.log("-- a network's first address is noindex unless curated (src/worker.js ipPage, netStart)");
const robots = body => /<meta name="robots" content="noindex, follow">/.test(body);
const canonical = body => (/<link rel="canonical" href="([^"]*)">/.exec(body) || [])[1];
const page = await run('/75.0.0.0', { ua: GOOG });
ok(robots(page.body) && canonical(page.body) === 'https://ipterm.net/75.0.0.0', `/75.0.0.0: noindex, canonical ${canonical(page.body)}`);
ok(page.body.includes('Registered block: <a href="/cidr/75.0.0.0/8">'), '/75.0.0.0 leads with its registered block (from the whois above, in the cache)');
const page6 = await run('/2603:2000::', { ua: GOOG });
ok(robots(page6.body) && page6.body.includes('Registered block: <a href="/cidr/2603:2000::/20">'), '/2603:2000::: noindex, with its registered block');
for (const ip of ['73.0.0.0', '2603:2000:0:1::']) {
  const r = await run('/' + ip, { ua: GOOG });
  ok(robots(r.body) && canonical(r.body) === 'https://ipterm.net/' + ip && !r.body.includes('Registered block:'),
    `/${ip} with no registry date in the cache: noindex, no block line`);
}
for (const ip of ['75.0.0.7', '2603:2000::1', '8.8.8.8']) {
  const r = await run('/' + ip, { ua: GOOG });
  ok(r.status === 200 && !robots(r.body) && canonical(r.body) === 'https://ipterm.net/' + ip && !r.body.includes('Registered block:'),
    `/${ip}: indexed, canonical ${canonical(r.body)}`);
}

console.log('-- routing on /cidr and /route: a bot gets the cache or none, never a RIPEstat lookup (src/worker.js routeData)');
const BING = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const ripe = r => r.kinds.filter(k => k === 'ripestat').length;
const article = body => (/<article class="static" id="static">[\s\S]*?<\/article>/.exec(body) || [''])[0];
const skipped = r => /automated visitors/.test(String(((r.initial || {}).route || {}).error)) && article(r.body).includes('<p class="ln sys route-bot">Routing data skipped');
const routed = r => article(r.body).includes('is announced in BGP by AS64500');
mayTake = false;
for (const [who, px, opts] of [
  ['Googlebot', '87.121.119.0/24', { ua: GOOG }],
  ['bingbot', '87.121.120.0/24', { ua: BING }],
  ['GPTBot asking for the page', '87.121.121.0/24', { ua: GPT, accept: HTML }],
  ['an unnamed client asking for the page without Sec-Fetch-*', '87.121.122.0/24', { ua: CHROME, accept: HTML }],
  ['Googlebot on an IPv6 prefix', '2a0d:5600::/32', { ua: GOOG }],
]) {
  const r = await run('/cidr/' + px, opts), a = article(r.body);
  ok(r.status === 200 && ripe(r) === 0 && !spent(r) && a.includes(`Subnet ${px}`) && /<dt>(netmask|addresses)<\/dt>/.test(a) && skipped(r) && !routed(r),
    `${who}, uncached /cidr/${px}: ${r.status}, ${a.includes(`Subnet ${px}`) ? 'the calculation' : 'no calculation'}, ` +
    `${skipped(r) ? 'the note' : routed(r) ? 'routing' : 'no note'}, ${ripe(r)} RIPEstat requests, requests ${JSON.stringify(r.kinds)}`);
}
const navR = await run('/cidr/87.121.119.0/24', { ua: CHROME, ...NAV });
ok(navR.status === 200 && ripe(navR) >= 4 && routed(navR) && !skipped(navR),
  `a browser navigation on /cidr/87.121.119.0/24 asks RIPEstat (${ripe(navR)} requests) and shows the routing`);
for (const [who, opts] of [['Googlebot', { ua: GOOG }], ['bingbot', { ua: BING }], ['GPTBot', { ua: GPT, accept: HTML }], ['the unnamed client', { ua: CHROME, accept: HTML }]]) {
  const r = await run('/cidr/87.121.119.0/24', opts);
  ok(r.status === 200 && ripe(r) === 0 && routed(r) && !skipped(r), `then ${who} gets that routing from the cache: ${ripe(r)} RIPEstat requests`);
}
for (const [who, path, opts] of [
  ["the terminal's own fetch, /api/route", '/api/route?q=87.121.130.0/24', { ua: CHROME, ...TERMINAL }],
  ['curl, /route/<prefix>', '/route/87.121.131.0/24', { ua: CURL, accept: '*/*' }],
  ['a script, /route/<ip>?format=text', '/route/87.121.132.7?format=text', { ua: 'python-requests/2.32.3', accept: '*/*' }],
]) {
  const r = await run(path, opts);
  ok(r.status === 200 && ripe(r) >= 4 && /AS64500/.test(r.body), `${who}: ${r.status}, ${ripe(r)} RIPEstat requests`);
}
for (const [who, px] of [['RFC 1918', '10.0.0.0/22'], ['RFC 1918', '192.168.1.0/24'], ['CGNAT', '100.64.0.0/10'], ['IPv6 unique local', 'fd00::/8']]) {
  const g = await run('/cidr/' + px, { ua: GOOG }), b = await run('/cidr/' + px, { ua: CHROME, ...NAV });
  ok(g.status === 200 && b.status === 200 && ripe(g) + ripe(b) === 0 && article(g.body) === article(b.body) && article(g.body).includes(`Subnet ${px}`) &&
    !g.body.includes('Routing data skipped') && !(g.initial || {}).route, `a private (${who}) /cidr/${px}: the same page for Googlebot and a browser, no RIPEstat, no note`);
}
const rIp = await run('/route/87.121.140.9', { ua: GOOG });
ok(rIp.status === 302 && rIp.location === '/cidr/87.121.140.9/32' && ripe(rIp) === 0,
  `Googlebot on /route/87.121.140.9 (uncached): ${rIp.status} to ${rIp.location}, ${ripe(rIp)} RIPEstat requests`);
const rPx = await run('/route/87.121.141.0/24', { ua: GOOG });
ok(rPx.status === 301 && rPx.location === '/cidr/87.121.141.0/24' && ripe(rPx) === 0, `Googlebot on /route/87.121.141.0/24: ${rPx.status} to ${rPx.location}, ${ripe(rPx)} RIPEstat requests`);
for (const [who, path, opts] of [
  ['GPTBot, /route/<prefix> as JSON', '/route/87.121.142.0/24', { ua: GPT, accept: '*/*' }],
  ['ChatGPT-User, /api/route', '/api/route?q=87.121.143.7', { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', accept: '*/*' }],
  ['ClaudeBot, /route/<ip>?format=text', '/route/87.121.144.7?format=text', { ua: CLAUDE, accept: '*/*' }],
]) {
  const r = await run(path, opts);
  ok(r.status === 403 && ripe(r) === 0 && /automated visitors/.test(r.body), `${who} (uncached): ${r.status}, ${ripe(r)} RIPEstat requests, ${r.body.trim().slice(0, 80)}`);
}
await run('/route/87.121.145.9', { ua: CURL, accept: '*/*' });
const rIpC = await run('/route/87.121.145.9', { ua: GOOG });
ok(rIpC.status === 302 && rIpC.location === '/cidr/87.121.145.0/24' && ripe(rIpC) === 0,
  `once curl has looked 87.121.145.9 up, Googlebot's /route redirect goes to its route from the cache: ${rIpC.location}, ${ripe(rIpC)} RIPEstat requests`);
for (const px of ['1.1.1.0/24', '8.8.8.0/24', '9.9.9.0/24']) {
  const r = await run('/cidr/' + px, { ua: GOOG });
  ok(r.status === 200 && ripe(r) >= 4 && routed(r), `Googlebot on /cidr/${px}, listed in SITEMAP_PATHS, keeps live routing (${ripe(r)} RIPEstat requests)`);
}
const notListed = await run('/cidr/1.1.1.0/25', { ua: GOOG });
ok(ripe(notListed) === 0 && skipped(notListed), `... and only those: /cidr/1.1.1.0/25 gets ${ripe(notListed)} RIPEstat requests and the note`);

console.log("-- links: the Worker's ASN and /cidr pages (src/worker.js asnPage, asnLinked, cidrPage)");
const cidrLinks = a => [...a.matchAll(/<li><a href="\/cidr\/([^"]+)">/g)].map(m => m[1]);
const listed = a => [...a.matchAll(/<li>(?:<a href="\/cidr\/[^"]+">)?([0-9a-f.:]+\/\d+)/g)].map(m => m[1]);
for (const [as, want4, want6] of [['AS64500', 6, 4], ['AS64501', 10, 0]]) {
  const r = await run('/' + as, { ua: GOOG }), a = article(r.body), links = cidrLinks(a), all = listed(a);
  const l4 = links.filter(p => !p.includes(':')), l6 = links.filter(p => p.includes(':'));
  const a4 = all.filter(p => !p.includes(':')), a6 = all.filter(p => p.includes(':'));
  ok(r.status === 200 && l4.length === want4 && l6.length === want6 && links.length <= 10 && l4.join() === a4.slice(0, want4).join() &&
    l6.join() === a6.slice(0, want6).join() && l4.every(p => p.endsWith('/16')),
    `${as}'s page links its ${links.length} largest prefixes (IPv4 ${l4.length}, IPv6 ${l6.length}): ${links.join(' ')}`);
  ok(a4.length === 20 && a6.length === (want6 ? 10 : 0) && all.length - links.length === all.filter(p => !links.includes(p)).length,
    `${as}'s page still lists ${all.length} prefixes, ${all.length - links.length} of them as text`);
}
const pub = article((await run('/cidr/87.121.150.0/24', { ua: GOOG })).body), priv = article((await run('/cidr/10.0.0.0/22', { ua: GOOG })).body);
ok(/<dt>splits into<\/dt><dd>87\.121\.150\.0\/25 [^<]* 87\.121\.150\.128\/25<\/dd>/.test(pub) && pub.includes('<dt>part of</dt><dd>87.121.150.0/23</dd>') &&
  !pub.includes('href="/cidr/') && priv.includes('<dt>part of</dt><dd>10.0.0.0/21</dd>') && !priv.includes('href="/cidr/'),
  'the /cidr page lists "splits into" and "part of" as text, public or private (no links to follow)');

console.log("-- links: the terminal's (public/app.js renderAsn, renderCidr, cidr, next), against a stand-in DOM");
const node = (tag, text = '') => ({ tag, text, kids: [], append(...xs) { this.kids.push(...xs); }, appendChild(x) { this.kids.push(x); } });
const anchors = x => (!x || typeof x !== 'object' ? [] : [...(x.tag === 'a' ? [x] : []), ...(x.kids || []).flatMap(anchors)]);
const out = node('#out');
let kvRows = [];
// #static as the page left it: its notes for bots (.route-bot), which cidr() removes once it has asked /api/route.
let staticBot = [];
const botNotes = body => [...article(body).matchAll(/<p class="ln sys route-bot">([^<]*)<\/p>/g)]
  .map(m => ({ text: m[1], remove() { staticBot = staticBot.filter(x => x !== this); } }));
// live: the deployed site's mode (false: the preview); line and apiRoute: what cidr() prints and how it asks for routing.
const terminal = (live, line, apiRoute) => Function('CIDRLIB', 'document', 'el', 'shareBar', 'out', 'kv', 'cmdLink', 'cmdButton', 'hrefFor', 'line', 'announce', 'fmt', 'scroll',
  'setUrl', 'toolIntro', 'renderRoute', 'routeTitle', 'apiRoute', 'live', 'performance',
  slice(app, '  const cidrRel =', '  async function cidr(') + slice(app, '  async function cidr(raw, pre) {', '  /* ---------- routing (route)') +
  slice(app, '  function bitsFragment(', '  /* ---------- DNS') + slice(app, '  async function renderAsn(', '  /* ---------- help') +
  slice(app, '  let nextItems = null;', '  // A data source hiccup') + 'return { renderAsn, renderCidr, cidr, flushNext };')(
  globalThis.IPTERM_CIDR, { createDocumentFragment: () => node('#fragment'), createTextNode: s => node('#text', s),
    querySelectorAll: sel => (sel === '#static .route-bot' ? [...staticBot] : []) }, (tag, cls, text) => node(tag, text),
  () => null, out, r => { kvRows = r; }, (text, cmd, href) => Object.assign(node('a', text), { cmd, href }), (text, cmd) => Object.assign(node('button', text), { cmd }),
  cmd => '/' + cmd.trim().split(/\s+/).join('/'), line, () => {}, n => String(n), () => {},
  () => {}, () => {}, async () => {}, () => '', apiRoute, live, { now: () => 0 });
const A = terminal(false, () => {}, async () => ({ error: 'not here' }));
const rowLinks = key => anchors((kvRows.find(r => Array.isArray(r) && r[0] === key) || [])[1]);
const rels = list => list.map(a => `${a.href}${a.rel ? ' (' + a.rel + ')' : ''}`).join(' ');
for (const [as, want4, want6] of [['AS64500', 6, 4], ['AS64501', 10, 0]]) {
  await A.renderAsn((await run(`/${as}?format=json`, { ua: CURL, accept: '*/*' })).data);   // the Worker's own data, largest first
  const l4 = rowLinks('largest v4'), l6 = rowLinks('largest v6'), follow = [...l4, ...l6].filter(a => !a.rel);
  ok(l4.length === 12 && l4.slice(0, want4).every(a => !a.rel) && l4.slice(want4).every(a => a.rel === 'nofollow') &&
    l6.length === (want6 ? 6 : 0) && l6.slice(0, want6).every(a => !a.rel) && l6.slice(want6).every(a => a.rel === 'nofollow') && follow.length === 10,
    `the terminal's asn ${as}: ${follow.length} ordinary links (IPv4 ${want4}, IPv6 ${want6}), the rest nofollow: ${rels([...l4, ...l6])}`);
}
for (const [px, part, splits] of [
  ['87.121.150.0/24', 'nofollow', 'nofollow'], ['2a0d:5600::/32', 'nofollow', 'nofollow'],
  ['10.0.0.0/22', '', ''], ['192.168.0.0/16', '', ''], ['fd00::/8', '', ''],
  ['100.64.0.0/10', 'nofollow', ''],                    // its supernet, 100.0.0.0/9, is public address space
]) {
  await A.renderCidr(globalThis.IPTERM_CIDR.calc(px));
  const p = rowLinks('part of'), s = rowLinks('splits into');
  ok(p.length === 1 && s.length === 2 && p.every(a => (a.rel || '') === part) && s.every(a => (a.rel || '') === splits),
    `the terminal's cidr ${px}: part of ${rels(p)}; splits into ${rels(s)}`);
}
const nextLine = () => out.kids[out.kids.length - 1];
for (const [px, route, want] of [
  ['87.121.150.0/24', { error: 'Routing data skipped' }, 'nofollow'],
  ['87.121.150.0/24', { status: 'announced', prefix: '87.121.150.0/24', origins: [{ asn: 'AS64500' }] }, 'nofollow'],
  ['10.0.0.0/22', null, ''],
]) {
  await A.cidr('', { data: globalThis.IPTERM_CIDR.calc(px), ...(route ? { route } : {}) });
  A.flushNext();
  const links = anchors(nextLine()), c = links.filter(a => a.cmd && a.cmd.startsWith('cidr ')), other = links.filter(a => !(a.cmd && a.cmd.startsWith('cidr ')));
  ok(c.length >= 1 && c.every(a => (a.rel || '') === want) && other.every(a => !a.rel),
    `the terminal's next: after cidr ${px}${route ? (route.error ? ' (no routing)' : ' (routed)') : ''}: ${rels(links)}`);
}

console.log("-- the terminal asks for routing a page left out for a bot (public/app.js cidr): a browser too old for Sec-Fetch-*");
const SAFARI15 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1';
let printed = [], asked = [];
const say = (text, cls) => { const n = { textContent: text, className: 'ln ' + cls, remove() { printed = printed.filter(x => x !== n); } }; printed.push(n); return n; };
// apiRoute as that browser sends it to the Worker: getJson's Accept: application/json, its user agent, no Sec-Fetch-*.
const viaWorker = ua => async q => {
  const r = await run('/api/route?q=' + encodeURIComponent(q), { ua, accept: 'application/json' });
  asked.push(`${r.status}, ${ripe(r)} RIPEstat requests`);
  return r.status === 200 ? r.data : { error: r.data.error };
};
const shown = () => printed.map(n => n.textContent).join(' | ');
for (const [who, ua, px, want] of [
  ['Safari 15, no Sec-Fetch-*', SAFARI15, '87.121.160.0/24', 200],
  ["Googlebot's renderer", GOOG_RENDER, '87.121.161.0/24', 403],
]) {
  printed = []; asked = [];
  const page = await run('/cidr/' + px, { ua, accept: HTML }), pre = page.initial || {};
  staticBot = botNotes(page.body);
  const onPage = staticBot.length;
  await terminal(true, say, viaWorker(ua)).cidr(pre.query, pre);
  ok(ripe(page) === 0 && pre.route && pre.route.bot === true && asked.length === 1 && asked[0].startsWith(String(want)) &&
    (want === 200 ? /routing: ok/.test(shown()) && /[1-9]\d* RIPEstat/.test(asked[0]) : printed.length === 0 && / 0 RIPEstat/.test(asked[0])),
    `${who}: the page's routing is left out (bot: ${pre.route && pre.route.bot}), the terminal asks /api/route once: ${asked.join('; ')}; it prints ${shown() || 'nothing'}`);
  ok(onPage === 1 && staticBot.length === (want === 200 ? 0 : 1),
    `${who}: the page's note for bots (.route-bot) ${want === 200 ? 'goes once routing has loaded' : 'stays, since no routing came'}: ${staticBot.length} of ${onPage} left`);
}
// A crawler that obeys robots.txt can't fetch /api/ at all, and getJson answers a network error: that must not
// replace the page's honest note in the page the crawler renders.
printed = []; asked = [];
staticBot = botNotes(`<article class="static" id="static"><p class="ln sys route-bot">Routing data skipped: RIPEstat isn't asked for automated visitors</p></article>`);
await terminal(true, say, async () => ({ error: 'network error. Check your connection and try again.' }))
  .cidr('', { data: globalThis.IPTERM_CIDR.calc('87.121.150.0/24'), route: { error: 'Routing data skipped', bot: true } });
ok(staticBot.length === 1 && printed.length === 0,
  `a crawler kept off /api/ by robots.txt: the page keeps its note for bots and nothing says "network error" (prints ${shown() || 'nothing'})`);
for (const [what, route, live] of [
  ['a rate-limit note', { error: 'Routing data skipped: too many lookups from your address. Wait a minute and reload.' }, true],
  ['routing', { status: 'announced', prefix: '87.121.150.0/24', origins: [{ asn: 'AS64500' }], upstreams: [] }, true],
  ["a bot's note, in the preview", { error: 'Routing data skipped', bot: true }, false],
]) {
  printed = []; asked = [];
  staticBot = route.bot ? botNotes(`<article class="static" id="static"><p class="ln sys route-bot">${route.error}</p></article>`) : [];
  const onPage = staticBot.length;
  await terminal(live, say, viaWorker(CHROME)).cidr('', { data: globalThis.IPTERM_CIDR.calc('87.121.150.0/24'), route });
  ok(asked.length === 0 && printed.length === (route.error ? 1 : 0) && staticBot.length === onPage,
    `a page with ${what}: the terminal asks nothing more, prints ${printed.length} line(s) and leaves the page's ${onPage} note(s) for bots`);
}

console.log('-- a busy shared address: your own details still come, without the hostname (src/worker.js selfInfo)');
// LOOKUP_LIMITER refuses every request here, as it does for an office, campus or carrier NAT address past 30 a minute.
const ME = '81.2.69.142';
let refused = 0;
env.LOOKUP_LIMITER = { async limit() { refused++; return { success: false }; } };
mayTake = true;
const tooMany = r => /Too many lookups/.test(r.body);
const home = await run('/', { ua: CHROME, ...NAV, me: ME }), hd = home.data || {};
ok(home.status === 200 && (home.initial || {}).kind === 'self' && hd.ip === ME && hd.hostname === null && !hd.ptrTimedOut &&
  home.body.includes(`<dd class="big">${ME}</dd>`) && !home.body.includes('<dt>hostname</dt>') && !home.kinds.includes('dns') && !tooMany(home),
  `the homepage: ${home.status}, your IP in the page and in the data the terminal draws whoami from, hostname ${hd.hostname}, no reverse DNS asked (requests ${JSON.stringify(home.kinds)})`);
for (const [what, path, opts] of [
  ['curl /json', '/json', { ua: CURL, accept: '*/*' }],
  ["whoami in the terminal, /api/lookup", '/api/lookup', { ua: CHROME, ...TERMINAL }],
  ['your address by number, /api/lookup?ip=', `/api/lookup?ip=${ME}&block=0`, { ua: CHROME, ...TERMINAL }],
  ['your address by number, /<ip>/json', `/${ME}/json`, { ua: CURL, accept: '*/*' }],
]) {
  const r = await run(path, { ...opts, me: ME }), d = r.data || {};
  ok(r.status === 200 && d.ip === ME && d.source === 'edge' && d.hostname === null && !r.kinds.includes('dns') && !tooMany(r),
    `${what}: ${r.status}, ip ${d.ip}, source ${d.source}, hostname ${d.hostname}, requests ${JSON.stringify(r.kinds)}`);
}
for (const [what, path] of [['curl /text', '/text'], ['curl /?format=text', '/?format=text']]) {
  const r = await run(path, { ua: CURL, accept: '*/*', me: ME });
  ok(r.status === 200 && new RegExp(`^your ip +${ME.replace(/\./g, '\\.')}$`, 'm').test(r.body) && !/^hostname/m.test(r.body) && !tooMany(r),
    `${what}: ${r.status}, ${JSON.stringify(r.body.split('\n')[0])}, no hostname line`);
}
ok(refused >= 7, `... and each of them asked the rate limiter, which said no (${refused} times)`);
for (const [what, path, opts] of [
  ['a lookup of another address, /api/lookup?ip=', '/api/lookup?ip=74.20.0.1', { ua: CHROME, ...TERMINAL }],
  ['a lookup of another address, /<ip>/text', '/74.20.0.2/text', { ua: CURL, accept: '*/*' }],
  ['/hostname, which asks for the reverse DNS itself', '/hostname', { ua: CURL, accept: '*/*' }],
  ["leaktest's /api/check", '/api/check', { ua: CHROME, ...TERMINAL }],
]) {
  const r = await run(path, { ...opts, me: ME });
  ok(r.status === 429 && tooMany(r) && !spent(r), `${what} keeps the limit: ${r.status}, ${r.body.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
}
env.LOOKUP_LIMITER = { async limit() { return { success: true }; } };
const allowed = await run('/json', { ua: CURL, accept: '*/*', me: ME });
ok(allowed.status === 200 && allowed.kinds.includes('dns'), `within the limit, /json asks for the reverse DNS as before (requests ${JSON.stringify(allowed.kinds)})`);
delete env.LOOKUP_LIMITER;

console.log("-- proxycheck.io's catch-all flag and anycast addresses (vpnText in src/worker.js and public/app.js, geoNote in app.js)");
const CATCHALL = 'not a known VPN, proxy or Tor service (proxycheck.io sets its catch-all "anonymous" flag, which it also gives public DNS and CDN addresses)';
mayTake = true;
const gj = await run('/8.8.4.4/json', { ua: CURL, accept: '*/*' }), g = gj.data || {};
ok(gj.status === 200 && g.flags && g.flags.anycast === true && g.privacy && g.privacy.anonymous === true && !g.privacy.vpn,
  `curl /8.8.4.4/json keeps the raw flags: anycast ${g.flags && g.flags.anycast}, privacy.anonymous ${g.privacy && g.privacy.anonymous}`);
const gt = await run('/8.8.4.4/text', { ua: CURL, accept: '*/*' });
ok(gt.body.includes('\nvpn / proxy  ' + CATCHALL + '\n') && !/anonymizing/i.test(gt.body), `curl /8.8.4.4/text: ${JSON.stringify((/^vpn \/ proxy.*$/m.exec(gt.body) || [''])[0])}`);
const gc = await run('/8.8.4.4/text?color=1', { ua: CURL, accept: '*/*' });
ok(gc.body.includes('\x1b[33mnot a known VPN, proxy or Tor service\x1b[0m (proxycheck.io sets'), '... and with ?color=1 its verdict is yellow, as a proxycheck.io flag was');
const gp = await run('/8.8.4.4', { ua: CHROME, ...NAV });
ok(article(gp.body).includes(`<dt>vpn / proxy</dt><dd>${CATCHALL.replace(/"/g, '&quot;')}</dd>`) && !/anonymizing|\u00b1/i.test(gp.body),
  "the IP page's own text says the same, with no \"anonymizing\" and no radius anywhere on the page");
const V = Function('const CITY_KM = 50, GEO = null;' + slice(app, '  const pcKnown =', "  // A lookup's block") +
  slice(app, '  function locate(', '  const worldView') + slice(app, '  function geoNote(', '  function geoBlock(') +
  'return { vpnText, pcFlag, pcWhy, locate, geoNote };')();
ok(V.vpnText(g) === CATCHALL && !/anonymizing/i.test(V.pcFlag({ anonymous: true })) && V.pcFlag({ anonymous: true, compromised: true }).startsWith('flagged by proxycheck.io as compromised'),
  `the terminal's vpn / proxy line for 8.8.4.4 is the same: ${JSON.stringify(V.vpnText(g))}`);
const city = { lat: 38, lon: -122, km: 50, level: 'city' };
const anyNote = V.geoNote(g, city, 'Mountain View, California, United States'), cityNote = V.geoNote({ flags: {} }, city, 'Coral Springs, Florida, United States');
ok(anyNote === 'anycast \u00b7 served from many locations' && !anyNote.includes('\u00b1') && cityNote === 'approximate area \u00b7 \u00b150 km' &&
  V.geoNote({}, { km: 1200, level: 'country' }, 'United States') === 'country-level only \u00b7 United States \u00b7 \u00b11,200 km',
  `the terminal's map caption: anycast ${JSON.stringify(anyNote)}; an ordinary address ${JSON.stringify(cityNote)}`);
ok(app.includes("const flagged = !anon && !!(pc && pc.anonymous);") && app.includes("`your IP ${pcWhy(pc)}, so this check can't tell whether you use a VPN.") &&
  V.pcWhy({ anonymous: true }).startsWith('has proxycheck.io\'s catch-all "anonymous" flag') &&
  app.includes("{ sum: 'unclear' }"), "leaktest still counts the catch-all flag alone as unclear, in the same words as a lookup");
const plain = { lat: 26.27, lon: -80.27 };
ok(V.locate(g).km === 0 && V.locate(plain).km === 50,
  `... and the map lights no area around the point: locate() gives 8.8.4.4 ${V.locate(g).km} km, an ordinary address ${V.locate(plain).km} km`);
// A copy with no IPINFO_TOKEN or PROXYCHECK_KEY (wrangler dev without .dev.vars) asks IPinfo's free API, which marks anycast too.
const keys = { IPINFO_TOKEN: env.IPINFO_TOKEN, PROXYCHECK_KEY: env.PROXYCHECK_KEY };
delete env.IPINFO_TOKEN; delete env.PROXYCHECK_KEY;
const fj = await run('/8.8.4.4/json', { ua: CURL, accept: '*/*' }), fr = fj.data || {};
const ft = await run('/8.8.4.4/text', { ua: CURL, accept: '*/*' });
Object.assign(env, keys);
ok(fj.status === 200 && fr.source === 'ipinfo' && JSON.stringify(fr.flags) === '{"anycast":true}' && fr.lat != null && V.locate(fr).km === 0 &&
  V.geoNote(fr, V.locate(fr), '').startsWith('anycast') && V.vpnText(fr).startsWith('not checked') && /^connection +anycast \(served from many locations\)$/m.test(ft.body),
  `without a token, IPinfo's free API: source ${fr.source}, flags ${JSON.stringify(fr.flags)}, no radius, VPN line ${JSON.stringify(V.vpnText(fr).split(' (')[0])}, ` +
  `text ${JSON.stringify((/^connection.*$/m.exec(ft.body) || [''])[0])}`);

const hb = read('docs/handbook.md');
ok(hb.includes('isBot()') && hb.includes('tools/check_bots.mjs'), 'docs/handbook.md describes isBot() and this check');
ok(hb.includes('routeData()') && hb.includes('asnLinked()') && hb.includes('nofollow'), 'docs/handbook.md describes the routing rule for bots and the links');
ok(read('public/llms.txt').includes('AI assistants and crawlers get country and network only'), 'public/llms.txt tells AI assistants what a bot gets');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
