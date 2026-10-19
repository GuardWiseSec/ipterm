// Checks that bots never spend the IPinfo Core or proxycheck.io budgets (isBot() in src/worker.js), and the two page
// rules that keep crawlers off a network's first address. No server and no network: the whole Worker runs in Node,
// with IPINFO_PLAN = "core", an IPINFO_TOKEN and a PROXYCHECK_KEY set, its budget counter (env.BUDGET) stubbed to
// throw when a bot asks it for a lookup, and fetch stubbed to answer as IPinfo, proxycheck.io, RDAP and DNS would and
// to note every request. So it spends nothing, and runs the same anywhere.
//
// 1. Who is a bot: isBot() read out of src/worker.js, on user agents of crawlers, link previews, AI and SEO bots and
//    headless browsers (bots), and of browsers, phones (a Cubot's included) and command-line tools (people).
// 2. What a bot gets: Googlebot, a link preview, GPTBot and an unnamed client asking for an address's page without
//    Sec-Fetch-* headers, GPTBot on /api/lookup, ClaudeBot on /<ip>/json, an HTML client on ?format=json and Googlebot
//    rendering leaktest (/api/check) get IPinfo Lite, no VPN check and no registry date, and never reach the budget
//    counter, IPinfo Core, proxycheck.io or a registry. A browser navigation (Sec-Fetch-Mode: navigate), the terminal's
//    own fetch (Sec-Fetch-Site: same-origin), curl and leaktest in a browser still get Core and proxycheck.io. Then
//    Googlebot gets the Core answer someone else's lookup cached, with its VPN check and registry date, for free.
// 3. The pages: whois of a registry block's first address links the block's /cidr page, not the address (the Worker's
//    page and the terminal's renderWhois() in public/app.js), and other addresses keep their lookup link, curated ones
//    too, and so do addresses registered on their own (a /32 or /128 record), while an IPv6 /32 is a block. A
//    network's first address (IPv4 x.x.x.0, IPv6 with the low 64 bits zero) has a noindex page that keeps its own
//    canonical and leads with its registered block when the lookup has it, while other addresses are indexed.
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
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async input => {
  const u = typeof input === 'string' ? input : input.url;
  let m;
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
  let data = null;
  try { data = init ? JSON.parse(init[1]).data : JSON.parse(body); } catch {}
  return { status: res.status, body, data, kinds: calls.map(c => c[0]), taken: [...taken] };
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

const hb = read('docs/handbook.md');
ok(hb.includes('isBot()') && hb.includes('tools/check_bots.mjs'), 'docs/handbook.md describes isBot() and this check');
ok(read('public/llms.txt').includes('AI assistants and crawlers get country and network only'), 'public/llms.txt tells AI assistants what a bot gets');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
