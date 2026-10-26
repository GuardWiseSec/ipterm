// Checks that an outside service that never answers gets the Worker's own words before the terminal stops waiting
// (DEADLINE, fetchRetry() and rdapFetch() in src/worker.js), and that the terminal's own time limit doesn't blame the
// visitor's connection (getJson in public/app.js). No server and no network: the whole Worker runs in Node with fetch
// stubbed, and a server that "never answers" holds each request until the request's own time limit aborts it, as a
// silent server does. The deadlines are real, so this takes about 7 seconds (the slow cases run side by side).
//
// 1. whois of a domain whose registry is silent (.ng: IANA's list sends it to rdap.nic.net.ng, which answered nothing
//    on 2026-10-25): /api/whois answers 502 within the deadline, well inside the terminal's 9 seconds, after one
//    request to that server (no second try, no second name), naming the .ng registry, its server and whose fault it
//    is. The text answer (?format=text) and the page say the same, and at once: the server is then left alone for a
//    minute (per isolate). So does the report card's registration line, in its own words.
// 2. whois of an address: a silent ARIN is "ARIN's whois server", text answer and pause too; LACNIC's redirect to a
//    silent NIC.br names NIC.br, not LACNIC; a registry that answers in 2 seconds, or fails once (a 503) and then
//    answers, still gives the record; and with IANA's file silent, IANA gets 3 seconds of the deadline and rdap.org
//    (its redirect followed by hand) the rest.
// 3. dig and routing: a resolver or RIPEstat that never answers is a 502 within the deadline, one try per query.
// 4. The terminal (getJson and RETRYABLE, read out of public/app.js): its own 9-second abort says ipterm didn't answer
//    and that a registry or data source may be down, with no word about the visitor's connection; a TypeError (and an
//    abort while the browser is offline) says it couldn't reach ipterm; both, and the Worker's registry message, offer
//    retry; the boot check reads unreached, not the text; and nothing in app.js says "network error" any more.
//
//   node tools/check_timeouts.mjs        (Node 22.15 or later: it loads the Worker through module.registerHooks)
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const worker = read('src/worker.js'), app = read('public/app.js'), INDEX = read('public/index.html');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_timeouts.mjs`);
  return src.slice(a, b);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEADLINE = Number((/^const DEADLINE = (\d+);/m.exec(worker) || [])[1]);
const TERMINAL_WAIT = Number((/^ {2}const GET_WAIT = (\d+);/m.exec(app) || [])[1]);
ok(DEADLINE > 0 && TERMINAL_WAIT > 0 && DEADLINE <= TERMINAL_WAIT - 2000,
  `the Worker's deadline (${DEADLINE} ms) is at least 2 seconds inside the terminal's (${TERMINAL_WAIT} ms)`);

// The whole Worker. Its two Cloudflare-only modules get stand-ins: nothing here builds a Durable Object or a socket.
const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'cloudflare:sockets': 'export function connect() { throw new Error("no sockets in tools/check_timeouts.mjs"); }',
};
registerHooks({ resolve: (spec, ctx, next) => (Object.hasOwn(STUBS, spec)
  ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[spec]), shortCircuit: true } : next(spec, ctx)) });

const store = new Map();                                 // caches.default, shared by every request like one data center's
globalThis.caches = { default: {
  async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, { body: await res.text(), headers: [...res.headers] }); },
} };

const calls = [];                                        // every outside request's URL, in order
const asked = prefix => calls.filter(u => u.startsWith(prefix)).length;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A server that never answers: the request stays open until its signal (the Worker's time limit) aborts it.
const never = init => new Promise((_, no) => {
  const s = init && init.signal;
  if (!s) return;                                        // a request with no time limit would hang: the case's own timer says so
  if (s.aborted) no(s.reason); else s.addEventListener('abort', () => no(s.reason), { once: true });
});
const record = ip => reply({ objectClassName: 'ip network', handle: 'NET-TEST', name: 'TEST-NET', startAddress: ip, endAddress: ip,
  cidr0_cidrs: [{ v4prefix: ip, length: 32 }], events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00Z' }], entities: [] });
let flaky = 0;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : input.url;
  calls.push(u);
  let m;
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    if (m[1] === 'asn') return never(init);              // IANA's ASN file never comes: whois falls back to rdap.org
    return reply({ services: {
      ipv4: [[['63.0.0.0/8'], ['https://rdap.arin.net/registry/']], [['200.0.0.0/8'], ['https://rdap.lacnic.net/rdap/']],
        [['64.0.0.0/8'], ['https://rdap.slow.test/']], [['65.0.0.0/8'], ['https://rdap.flaky.test/']]],
      ipv6: [], asn: [], dns: [[['ng'], ['https://rdap.nic.net.ng/']]],
    }[m[1]] });
  }
  if (u.startsWith('https://rdap.nic.net.ng/') || u.startsWith('https://rdap.arin.net/') || u.startsWith('https://rdap.registro.br/')) return never(init);
  // LACNIC sends Brazil's addresses to NIC.br's own server, as rdap.lacnic.net does (a 307)
  if ((m = /^https:\/\/rdap\.lacnic\.net\/rdap\/(ip\/.+)$/.exec(u))) return new Response(null, { status: 307, headers: { location: 'https://rdap.registro.br/' + m[1] } });
  if ((m = /^https:\/\/rdap\.org\/(.+)$/.exec(u))) return new Response(null, { status: 302, headers: { location: 'https://rdap.test/' + m[1] } });
  if ((m = /^https:\/\/rdap\.test\/autnum\/(\d+)$/.exec(u))) {
    return reply({ objectClassName: 'autnum', handle: 'AS' + m[1], name: 'TEST-AS', startAutnum: Number(m[1]), endAutnum: Number(m[1]), entities: [] });
  }
  if ((m = /^https:\/\/rdap\.slow\.test\/ip\/(.+)$/.exec(u))) { await sleep(2000); return record(m[1]); }
  if ((m = /^https:\/\/rdap\.flaky\.test\/ip\/(.+)$/.exec(u))) return flaky++ ? record(m[1]) : reply({ errorCode: 503 }, 503);
  if (u.startsWith('https://cloudflare-dns.com/')) {
    if (/name=[^&]*silent/.test(u)) return never(init);
    return reply({ Status: 0, Answer: [] });             // every other name: no records
  }
  if (u.startsWith('https://stat.ripe.net/')) return never(init);
  return new Response('not stubbed in tools/check_timeouts.mjs', { status: 404 });
};
const keepAlive = setInterval(() => {}, 1000);           // Node's AbortSignal.timeout doesn't hold the process open by itself

const env = { ASSETS: { fetch: async () => new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } };
const { default: W } = await import('../src/worker.js');

const CURL = 'curl/8.7.1';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const TERMINAL = { accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };
// One request, as the Worker sees it on ipterm.net, and how long the answer took. A case that hangs past 12 seconds
// (no time limit at all) fails instead of holding the check up.
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
const inTime = r => r.ms >= DEADLINE - 600 && r.ms <= DEADLINE + 800;   // the one try ran to the deadline, and no further
const secs = ms => (ms / 1000).toFixed(1) + ' s';

const NG = "The .ng registry's whois server (rdap.nic.net.ng) didn't answer. That's on their side; try again later.";
const ARIN = "ARIN's whois server (rdap.arin.net) didn't answer. That's on their side; try again later.";
const NICBR = "NIC.br's whois server (rdap.registro.br) didn't answer. That's on their side; try again later.";

console.log('-- silent registries, side by side (src/worker.js rdapFetch, whoisRoute, dnsData, routeLookup)');
const [ng, arin, nicbr, slow, flakyR, viaOrg, dig, route] = await Promise.all([
  run('/api/whois?q=unijos.edu.ng', { ua: CHROME, ...TERMINAL }),
  run('/api/whois?q=63.1.2.3', { ua: CHROME, ...TERMINAL }),
  run('/whois/200.160.2.3'),
  run('/api/whois?q=64.1.2.3', { ua: CHROME, ...TERMINAL }),
  run('/api/whois?q=65.1.2.3', { ua: CHROME, ...TERMINAL }),
  run('/api/whois?q=AS64500', { ua: CHROME, ...TERMINAL }),
  run('/api/dns?name=silent.example.com', { ua: CHROME, ...TERMINAL }),
  run('/api/route?q=1.1.1.0/24', { ua: CHROME, ...TERMINAL }),
]);
ok(ng.status === 502 && ng.data.error === NG, `whois unijos.edu.ng (the .ng server never answers): ${ng.status}, ${JSON.stringify(ng.data.error)}`);
ok(inTime(ng) && ng.ms < TERMINAL_WAIT, `... after ${secs(ng.ms)}: the deadline, well inside the terminal's ${TERMINAL_WAIT / 1000} s (it took about 17 s before)`);
ok(asked('https://rdap.nic.net.ng/') === 1, `... after one request to rdap.nic.net.ng, not two tries or a second name: ${asked('https://rdap.nic.net.ng/')}`);
ok(arin.status === 502 && arin.data.error === ARIN && inTime(arin) && asked('https://rdap.arin.net/') === 1,
  `whois 63.1.2.3 (ARIN never answers): ${arin.status} after ${secs(arin.ms)}, one request, ${JSON.stringify(arin.data.error)}`);
ok(nicbr.status === 502 && nicbr.data.error === NICBR && inTime(nicbr) && asked('https://rdap.lacnic.net/') === 1 && asked('https://rdap.registro.br/') === 1,
  `curl /whois/200.160.2.3 (LACNIC redirects to NIC.br, which never answers): ${nicbr.status} after ${secs(nicbr.ms)}, names NIC.br, not LACNIC: ${JSON.stringify(nicbr.data.error)}`);
ok(slow.status === 200 && slow.data.found === true && slow.ms >= 1900 && slow.ms < DEADLINE && asked('https://rdap.slow.test/') === 1,
  `a registry that takes 2 seconds still answers: ${slow.status}, found ${slow.data.found}, ${secs(slow.ms)}`);
ok(flakyR.status === 200 && flakyR.data.found === true && asked('https://rdap.flaky.test/') === 2,
  `a registry that fails once (a 503) gets its retry within the deadline: ${flakyR.status}, found ${flakyR.data.found}, ${asked('https://rdap.flaky.test/')} requests`);
ok(viaOrg.status === 200 && viaOrg.data.found === true && viaOrg.data.query === 'AS64500' && viaOrg.ms >= 2900 && viaOrg.ms < 4000 &&
  asked('https://data.iana.org/rdap/asn.json') === 1 && asked('https://rdap.org/') === 1 && asked('https://rdap.test/autnum/') === 1,
  `whois AS64500 with IANA's file silent: ${viaOrg.status}, found ${viaOrg.data.found}, after ${secs(viaOrg.ms)} (IANA's 3 seconds, one try), then rdap.org and the registry it redirects to`);
const digAsked = calls.filter(u => u.startsWith('https://cloudflare-dns.com/') && u.includes('silent.example.com')).length;
ok(dig.status === 502 && /didn't respond/.test(dig.data.error || '') && inTime(dig) && digAsked === 6,
  `dig silent.example.com (the resolver never answers): ${dig.status} after ${secs(dig.ms)} (16 s before), one try for each of its 6 types: ${digAsked}; ${JSON.stringify(dig.data.error)}`);
const ripeAsked = asked('https://stat.ripe.net/data/prefix-overview/');
ok(route.status === 502 && /didn't respond/.test(route.data.error || '') && route.ms <= DEADLINE + 800 && ripeAsked === 1,
  `route 1.1.1.0/24 (RIPEstat never answers): ${route.status} after ${secs(route.ms)} (17 s before), ${ripeAsked} prefix-overview request; ${JSON.stringify(route.data.error)}`);

console.log('-- then the same message as text and on the page, at once: the silent server is left alone a minute');
const before = calls.length;
const text = await run('/whois/unijos.edu.ng?format=text');
ok(text.status === 502 && text.body === NG + '\n' && text.ms < 500, `curl /whois/unijos.edu.ng?format=text: ${text.status} after ${text.ms} ms, ${JSON.stringify(text.body)}`);
const page = await run('/whois/unijos.edu.ng', { ua: CHROME, ...NAV });
ok(page.status === 502 && page.initial && page.initial.error === NG && article(page.body).includes(`<p class="ln">${esc(NG)}</p>`) && page.ms < 500,
  `the /whois/unijos.edu.ng page: ${page.status} after ${page.ms} ms, the same words on the page and for the terminal it boots (initial.error)`);
const arinText = await run('/whois/63.1.2.3?format=text');
ok(arinText.status === 502 && arinText.body === ARIN + '\n' && arinText.ms < 500, `curl /whois/63.1.2.3?format=text: ${arinText.ms} ms, ${JSON.stringify(arinText.body)}`);
const card = await run('/api/grade?domain=unijos.edu.ng', { ua: CHROME, ...TERMINAL });
const reg = ((card.data.checks || []).find(c => c.section === 'registration') || {}).text || '';
ok(card.status === 200 && reg === "the registry record couldn't be read (rdap.nic.net.ng didn't answer), so expiry and the transfer lock weren't checked" &&
  card.ms < 2000, `grade unijos.edu.ng's registration line names the server, after ${card.ms} ms: ${JSON.stringify(reg)}`);
ok(calls.slice(before).every(u => !u.startsWith('https://rdap.nic.net.ng/') && !u.startsWith('https://rdap.arin.net/')),
  'none of these asked the paused servers again');

console.log("-- the terminal's own time limit (public/app.js getJson, RETRYABLE)");
const G = (fetchStub, navigator = { onLine: true }) => {
  let waited = null;
  const fns = Function('fetch', 'setTimeout', 'clearTimeout', 'navigator', 'AbortController',
    slice(app, '  // A request that got no answer', '  // Addresses this page has seen as yours') + 'return { getJson, NO_ANSWER };')(
    fetchStub, (fn, ms) => { waited = ms; return setTimeout(fn, 0); }, clearTimeout, navigator, AbortController);
  return { ...fns, waited: () => waited };
};
const hang = (path, { signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(new DOMException('This operation was aborted', 'AbortError'))));
const TIMEOUT_TEXT = 'No answer from ipterm within 9 seconds: a registry or data source may be slow or down. Try again in a moment.';
const NETWORK_TEXT = "Couldn't reach ipterm. Check your connection, or try again in a moment.";
const own = G(hang), d1 = await own.getJson('/api/whois?q=unijos.edu.ng');
ok(d1.error === TIMEOUT_TEXT && d1.unreached === 'timeout' && own.waited() === 9000 && !/connection/i.test(d1.error),
  `its own 9-second abort: ${JSON.stringify(d1)}, no word about the connection`);
const down = G(async () => { throw new TypeError('Failed to fetch'); }), d2 = await down.getJson('/api/whois?q=x');
ok(d2.error === NETWORK_TEXT && d2.unreached === 'network', `a TypeError (no connection, or ipterm unreachable): ${JSON.stringify(d2)}`);
const offline = G(hang, { onLine: false }), d3 = await offline.getJson('/api/whois?q=x');
ok(d3.error === NETWORK_TEXT && d3.unreached === 'network', `its abort while the browser is offline: ${JSON.stringify(d3.error)}`);
const fine = G(async () => reply({ found: true, query: 'x' })), d4 = await fine.getJson('/api/whois?q=x');
const bad = G(async () => reply({ error: NG }, 502)), d5 = await bad.getJson('/api/whois?q=unijos.edu.ng');
const html = G(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })), d6 = await html.getJson('/api/lookup');
ok(d4.found === true && !d4.error && d5.error === NG && !d5.unreached && d6.error === 'no-api',
  "answers that came still pass as before: the data, the Worker's own error, and no-api for a page that isn't JSON");
const RETRYABLE = Function(`return ${/const RETRYABLE = (\/.*\/);/.exec(app)[1]}`)();
for (const t of [TIMEOUT_TEXT, NETWORK_TEXT, NG, ARIN, "A data source didn't respond. Try again in a moment.", "The port check didn't finish. Try again in a moment.",
  'Too many lookups from your address. Wait a minute and try again.']) ok(RETRYABLE.test(t), `retry is offered after: ${t}`);
ok(!RETRYABLE.test('Not a valid IP address, AS number or domain. Examples: whois 8.8.8.8, whois AS13335, whois example.com'), '... and not after a typo');
ok(app.includes("d.error !== 'no-api' && !d.unreached") && !/network error/i.test(app),
  'the boot check reads unreached (preview mode, as before), and nothing in app.js says "network error" any more');

const hb = read('docs/handbook.md').replace(/\s+/g, ' ');
ok(hb.includes('node tools/check_timeouts.mjs') && hb.includes('`DEADLINE` (6.5 seconds') && DEADLINE === 6500 && [NG, TIMEOUT_TEXT, NETWORK_TEXT].every(t => hb.includes(t)),
  "docs/handbook.md describes the deadline, the registry's and the terminal's messages, and this check");
clearInterval(keepAlive);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
