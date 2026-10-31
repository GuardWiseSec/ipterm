// Checks that an outside service that never answers gets the Worker's own words before the terminal stops waiting
// (DEADLINE, fetchRetry() and rdapFetch() in src/worker.js), that a registry that fails is named whatever the failure,
// and that the terminal's own time limit doesn't blame the visitor's connection (getJson in public/app.js). No server
// and no network: the whole Worker runs in Node with fetch stubbed, and a server that "never answers" holds each
// request until the request's own time limit aborts it, as a silent server does. The stub follows redirects the way
// the platform's fetch does (unless a request says redirect: 'manual'), and the answer's url is the last server asked.
// The deadlines are real, so this takes about 9 seconds (the slow cases run side by side).
//
// 1. Registries that fail quickly, first (the silent ones below pause their servers): each is named, in the whois
//    answer within the deadline, after fetchRetry's one retry, with HTTP 502 and the failure's own words. ARIN
//    answering 525 (Cloudflare's failed TLS handshake) "failed to answer (HTTP 525)", in JSON, as text and on the page;
//    the .ng registry answering 503 twice, also on the report card's registration line; AFRINIC resetting the
//    connection twice "couldn't be reached"; APNIC answering 429 twice; and ARIN's redirect to a RIPE NCC server that
//    answers 503 names RIPE NCC, the server that answered. An answer cut off after its headers (the connection lost
//    mid-read) "couldn't be reached" too, while one that isn't JSON (a maintenance page) is one bad record, not the
//    registry's silence. None of them pauses its server: ARIN answering 525 and then a record gives the record through
//    the retry, right after the 525s, and AFRINIC is asked again. A redirect that answers (LACNIC to NIC.br) gives
//    NIC.br's record, and no RDAP request goes out with redirect: 'manual'. ARIN's failures also ask RIPEstat for its
//    copy of ARIN's record (arinRelay, checked in tools/check_relay.mjs): here RIPEstat has no match for any address,
//    so ARIN's failure stands, as quickly; a silent ARIN (2.) leaves no time for it, and RIPEstat isn't asked.
// 2. Silent registries, side by side. whois of a domain whose registry is silent (.ng: IANA's list sends it to
//    rdap.nic.net.ng, which answered nothing on 2026-10-25): /api/whois answers 502 within the deadline, well inside
//    the terminal's 9 seconds, after one request to that server (no second try, no second name), naming the .ng
//    registry, its server and whose fault it is. A silent ARIN is "ARIN's whois server"; LACNIC's redirect to a silent
//    NIC.br names LACNIC, the server asked, since redirects are no longer followed by hand; a server that sends its
//    headers and then nothing is silent too (and paused, below). A registry that answers in 2 seconds, or fails once
//    (a 503) and then answers, still gives the record; and with IANA's file silent, IANA gets 3 seconds of the
//    deadline and rdap.org (and the registry it redirects to) the rest.
// 3. dig and routing: a resolver or RIPEstat that never answers is a 502 within the deadline, one try per query.
// 4. Then the silent servers' message as text and on the page, and the report card's registration line, at once: a
//    silent server is left alone for a minute (per isolate).
// 5. The terminal (getJson and RETRYABLE, read out of public/app.js): its own 9-second abort says ipterm didn't answer
//    and that a registry or data source may be down, with no word about the visitor's connection; a TypeError (and an
//    abort while the browser is offline) says it couldn't reach ipterm; both, and the Worker's registry messages, offer
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

const calls = [];                                        // every outside request's URL, in order, each redirect's too
const sent = [];                                         // every fetch the Worker made: { url, redirect } as it asked
const asked = prefix => calls.filter(u => u.startsWith(prefix)).length;
const seen = new Map(), nth = u => { seen.set(u, (seen.get(u) || 0) + 1); return seen.get(u); };   // the how-manyth time u is asked
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A server that never answers: the request stays open until its signal (the Worker's time limit) aborts it.
const never = init => new Promise((_, no) => {
  const s = init && init.signal;
  if (!s) return;                                        // a request with no time limit would hang: the case's own timer says so
  if (s.aborted) no(s.reason); else s.addEventListener('abort', () => no(s.reason), { once: true });
});
const record = ip => reply({ objectClassName: 'ip network', handle: 'NET-TEST', name: 'TEST-NET', startAddress: ip, endAddress: ip,
  cidr0_cidrs: [{ v4prefix: ip, length: 32 }], events: [{ eventAction: 'registration', eventDate: '2004-06-01T00:00:00Z' }], entities: [] });
const moved = (to, status = 307) => new Response(null, { status, headers: { location: to } });
// An answer whose headers come and whose body stops partway: cut off at once (the connection lost mid-read), or, given
// the request's init, left open until the request's time limit aborts it, as a server that goes silent mid-answer.
const partial = init => new Response(new ReadableStream({ start(c) {
  c.enqueue(new TextEncoder().encode('{"objectClassName":"ip network",'));
  const s = init && init.signal;
  if (!init) c.error(new TypeError('Network connection lost.'));
  else if (s) { if (s.aborted) c.error(s.reason); else s.addEventListener('abort', () => c.error(s.reason), { once: true }); }
} }), { status: 200, headers: { 'content-type': 'application/rdap+json' } });
// What each server answers, redirects included (fetch below follows them).
async function serve(u, init) {
  let m;
  if ((m = /^https:\/\/data\.iana\.org\/rdap\/(ipv4|ipv6|asn|dns)\.json$/.exec(u))) {
    if (m[1] === 'asn') return never(init);              // IANA's ASN file never comes: whois falls back to rdap.org
    return reply({ services: {
      ipv4: [[['63.0.0.0/8', '66.0.0.0/8', '67.0.0.0/8', '68.0.0.0/8', '69.0.0.0/8', '71.0.0.0/8'], ['https://rdap.arin.net/registry/']],
        [['200.0.0.0/8', '201.0.0.0/8'], ['https://rdap.lacnic.net/rdap/']], [['41.0.0.0/8'], ['https://rdap.afrinic.net/rdap/']],
        [['1.0.0.0/8'], ['https://rdap.apnic.net/']], [['64.0.0.0/8'], ['https://rdap.slow.test/']], [['65.0.0.0/8'], ['https://rdap.flaky.test/']],
        [['62.0.0.0/8'], ['https://rdap.stall.test/']]],
      ipv6: [], asn: [], dns: [[['ng'], ['https://rdap.nic.net.ng/']]],
    }[m[1]] });
  }
  // The .ng registry: busy.ng answers 503 every time; anything else, nothing at all
  if ((m = /^https:\/\/rdap\.nic\.net\.ng\/domain\/(.+)$/.exec(u))) return m[1] === 'busy.ng' ? reply({ errorCode: 503 }, 503) : never(init);
  // ARIN: 63/8 never answers, 66/8 is a failed TLS handshake every time (Cloudflare's 525), 67/8 once and then the
  // record, 68/8 is sent on to a RIPE NCC server that answers 503 every time, 69/8's answer is cut off after its
  // headers, and 71/8's is a maintenance page
  if ((m = /^https:\/\/rdap\.arin\.net\/registry\/ip\/((\d+)\..+)$/.exec(u))) {
    if (m[2] === '66' || (m[2] === '67' && nth(u) === 1)) return new Response('error code: 525', { status: 525 });
    if (m[2] === '67') return record(m[1]);
    if (m[2] === '68') return moved('https://rdap.db.ripe.net/ip/' + m[1], 301);
    if (m[2] === '69') return partial();
    if (m[2] === '71') return new Response('<html>down for maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return never(init);
  }
  if (u.startsWith('https://rdap.stall.test/')) return partial(init);   // its headers, then nothing
  if (u.startsWith('https://rdap.db.ripe.net/')) return reply({ errorCode: 503 }, 503);
  // LACNIC sends Brazil's addresses to NIC.br's own server, as rdap.lacnic.net does (a 307): NIC.br never answers for
  // 200/8, and answers 201/8 with the record
  if ((m = /^https:\/\/rdap\.lacnic\.net\/rdap\/(ip\/.+)$/.exec(u))) return moved('https://rdap.registro.br/' + m[1]);
  if ((m = /^https:\/\/rdap\.registro\.br\/ip\/((\d+)\..+)$/.exec(u))) return m[2] === '201' ? record(m[1]) : never(init);
  if (u.startsWith('https://rdap.afrinic.net/')) throw new TypeError('fetch failed');   // a refused or reset connection
  if (u.startsWith('https://rdap.apnic.net/')) return reply({ errorCode: 429 }, 429);
  if ((m = /^https:\/\/rdap\.org\/(.+)$/.exec(u))) return moved('https://rdap.test/' + m[1], 302);
  if ((m = /^https:\/\/rdap\.test\/autnum\/(\d+)$/.exec(u))) {
    return reply({ objectClassName: 'autnum', handle: 'AS' + m[1], name: 'TEST-AS', startAutnum: Number(m[1]), endAutnum: Number(m[1]), entities: [] });
  }
  if ((m = /^https:\/\/rdap\.slow\.test\/ip\/(.+)$/.exec(u))) { await sleep(2000); return record(m[1]); }
  if ((m = /^https:\/\/rdap\.flaky\.test\/ip\/(.+)$/.exec(u))) return nth(u) === 1 ? reply({ errorCode: 503 }, 503) : record(m[1]);
  if (u.startsWith('https://cloudflare-dns.com/')) {
    if (/name=[^&]*silent/.test(u)) return never(init);
    return reply({ Status: 0, Answer: [] });             // every other name: no records
  }
  // RIPEstat: no match for ARIN's record (arinRelay), so whois reports ARIN's failure; routing never answers
  if (u.startsWith('https://stat.ripe.net/data/whois/')) return reply({ data: { authorities: ['arin'], records: [[{ key: 'No match found for + ! x', value: '' }]] } });
  if (u.startsWith('https://stat.ripe.net/')) return never(init);
  return new Response('not stubbed in tools/check_timeouts.mjs', { status: 404 });
}
// fetch as the platform does it: redirects followed (20 at most) unless the request says redirect: 'manual' (or
// 'error'), each hop counted in calls, and the answer's url the last server asked.
globalThis.fetch = async (input, init = {}) => {
  let u = typeof input === 'string' ? input : input.url;
  sent.push({ url: u, redirect: init.redirect });
  for (let hop = 0; ; hop++) {
    calls.push(u);
    const r = await serve(u, init);
    const to = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!to || init.redirect === 'manual') return Object.defineProperty(r, 'url', { value: u });
    if (init.redirect === 'error' || hop === 20) throw new TypeError('fetch failed: redirect');
    u = new URL(to, u).href;
  }
};
const keepAlive = setInterval(() => {}, 1000);           // Node's AbortSignal.timeout doesn't hold the process open by itself

const env = { ASSETS: { fetch: async () => new Response(INDEX, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } };
const { default: W } = await import('../src/worker.js');

const CURL = 'curl/8.7.1';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const TERMINAL = { accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };
const API = { ua: CHROME, ...TERMINAL };
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
const quick = r => r.ms >= 300 && r.ms < 2000;                          // the retry's pause, and well inside the deadline
const secs = ms => (ms / 1000).toFixed(1) + ' s';
const regLine = card => ((card.data.checks || []).find(c => c.section === 'registration') || {}).text || '';

const NG = "The .ng registry's whois server (rdap.nic.net.ng) didn't answer. That's on their side; try again later.";
const ARIN = "ARIN's whois server (rdap.arin.net) didn't answer. That's on their side; try again later.";
const LACNIC = "LACNIC's whois server (rdap.lacnic.net) didn't answer. That's on their side; try again later.";
const ARIN525 = "ARIN's whois server (rdap.arin.net) failed to answer (HTTP 525). That's on their side; try again in a moment.";
const NG503 = "The .ng registry's whois server (rdap.nic.net.ng) failed to answer (HTTP 503). That's on their side; try again in a moment.";
const RESET = "AFRINIC's whois server (rdap.afrinic.net) couldn't be reached. That's on their side; try again in a moment.";
const APNIC429 = "APNIC's whois server (rdap.apnic.net) failed to answer (HTTP 429). That's on their side; try again in a moment.";
const RIPE503 = "RIPE NCC's whois server (rdap.db.ripe.net) failed to answer (HTTP 503). That's on their side; try again in a moment.";
const CUT = "ARIN's whois server (rdap.arin.net) couldn't be reached. That's on their side; try again in a moment.";
const STALL = "The registry's whois server (rdap.stall.test) didn't answer. That's on their side; try again later.";
const SOURCE = "A data source didn't respond. Try again in a moment.";

console.log('-- registries that fail quickly: named, within the deadline, after the retry, and not paused (rdapFetch, RegistryFailed)');
const [r525, busy, reset, r429, ripe, nicbrOk, cut, notJson] = await Promise.all([
  run('/api/whois?q=66.1.2.3', API),
  run('/api/whois?q=busy.ng', API),
  run('/api/whois?q=41.1.2.3', API),
  run('/api/whois?q=1.2.3.4', API),
  run('/api/whois?q=68.1.2.3', API),
  run('/api/whois?q=201.1.2.3', API),
  run('/api/whois?q=69.1.2.3', API),
  run('/api/whois?q=71.1.2.3', API),
]);
ok(r525.status === 502 && r525.data.error === ARIN525 && quick(r525) && asked('https://rdap.arin.net/registry/ip/66.') === 2 &&
  asked('https://stat.ripe.net/data/whois/data.json?resource=66.1.2.3%2F32') === 1,
  `whois 66.1.2.3 (ARIN's handshake fails, a 525, twice): ${r525.status} after ${secs(r525.ms)}, ${asked('https://rdap.arin.net/registry/ip/66.')} requests, ` +
  `then RIPEstat's copy (no match here), ${JSON.stringify(r525.data.error)}`);
ok(busy.status === 502 && busy.data.error === NG503 && quick(busy) && asked('https://rdap.nic.net.ng/domain/busy.ng') === 2,
  `whois busy.ng (the .ng registry answers 503 twice): ${busy.status} after ${secs(busy.ms)}, ${JSON.stringify(busy.data.error)}`);
ok(reset.status === 502 && reset.data.error === RESET && quick(reset) && asked('https://rdap.afrinic.net/') === 2,
  `whois 41.1.2.3 (AFRINIC resets the connection twice, a TypeError): ${reset.status} after ${secs(reset.ms)}, ${JSON.stringify(reset.data.error)}`);
ok(r429.status === 502 && r429.data.error === APNIC429 && quick(r429) && asked('https://rdap.apnic.net/') === 2,
  `whois 1.2.3.4 (APNIC answers 429 twice): ${r429.status} after ${secs(r429.ms)}, ${JSON.stringify(r429.data.error)}`);
ok(ripe.status === 502 && ripe.data.error === RIPE503 && quick(ripe) && asked('https://rdap.arin.net/registry/ip/68.') === 2 && asked('https://rdap.db.ripe.net/') === 2,
  `whois 68.1.2.3 (ARIN redirects to a RIPE NCC server that answers 503): names the server that answered, ${JSON.stringify(ripe.data.error)}`);
ok(nicbrOk.status === 200 && nicbrOk.data.found === true && nicbrOk.data.registry === 'NIC.br' && asked('https://rdap.registro.br/ip/201.') === 1,
  `whois 201.1.2.3 (LACNIC redirects to NIC.br, which answers): ${nicbrOk.status}, the record from ${nicbrOk.data.registry}`);
ok(cut.status === 502 && cut.data.error === CUT && cut.ms < 2000 && asked('https://rdap.arin.net/registry/ip/69.') === 1,
  `whois 69.1.2.3 (ARIN's answer cut off after its headers): ${cut.status} after ${secs(cut.ms)}, ${JSON.stringify(cut.data.error)}`);
ok(notJson.status === 502 && notJson.data.error === SOURCE && notJson.ms < 2000,
  `whois 71.1.2.3 (ARIN answers a maintenance page, not JSON): one bad record, not the registry's silence: ${JSON.stringify(notJson.data.error)}`);
const r525ok = await run('/api/whois?q=67.1.2.3', API);
ok(r525ok.status === 200 && r525ok.data.found === true && asked('https://rdap.arin.net/registry/ip/67.') === 2,
  `whois 67.1.2.3 right after (ARIN answers 525, then the record): ${r525ok.status}, found ${r525ok.data.found} through the retry, so ARIN wasn't paused`);
const text525 = await run('/whois/66.1.2.3?format=text');
ok(text525.status === 502 && text525.body === ARIN525 + '\n', `curl /whois/66.1.2.3?format=text: ${text525.status}, ${JSON.stringify(text525.body)}`);
const page525 = await run('/whois/66.1.2.3', { ua: CHROME, ...NAV });
ok(page525.status === 502 && page525.initial && page525.initial.error === ARIN525 && article(page525.body).includes(`<p class="ln">${esc(ARIN525)}</p>`),
  `the /whois/66.1.2.3 page: ${page525.status}, the same words on the page and for the terminal it boots (initial.error)`);
const resetText = await run('/whois/41.1.2.3?format=text');
ok(resetText.status === 502 && resetText.body === RESET + '\n' && asked('https://rdap.afrinic.net/') === 4,
  `curl /whois/41.1.2.3?format=text: ${JSON.stringify(resetText.body)}, AFRINIC asked again (not paused)`);
const busyCard = await run('/api/grade?domain=busy.ng', API);
ok(busyCard.status === 200 && regLine(busyCard) === "the registry record couldn't be read (rdap.nic.net.ng failed to answer: HTTP 503), so expiry and the transfer lock weren't checked",
  `grade busy.ng's registration line names the server and the status: ${JSON.stringify(regLine(busyCard))}`);

console.log('-- silent registries, side by side (src/worker.js rdapFetch, whoisRoute, dnsData, routeLookup)');
const [ng, arin, lacnic, stall, slow, flakyR, viaOrg, dig, route] = await Promise.all([
  run('/api/whois?q=unijos.edu.ng', API),
  run('/api/whois?q=63.1.2.3', API),
  run('/whois/200.160.2.3'),
  run('/api/whois?q=62.1.2.3', API),
  run('/api/whois?q=64.1.2.3', API),
  run('/api/whois?q=65.1.2.3', API),
  run('/api/whois?q=AS64500', API),
  run('/api/dns?name=silent.example.com', API),
  run('/api/route?q=1.1.1.0/24', API),
]);
const ngAsked = asked('https://rdap.nic.net.ng/domain/unijos');
ok(ng.status === 502 && ng.data.error === NG, `whois unijos.edu.ng (the .ng server never answers): ${ng.status}, ${JSON.stringify(ng.data.error)}`);
ok(inTime(ng) && ng.ms < TERMINAL_WAIT, `... after ${secs(ng.ms)}: the deadline, well inside the terminal's ${TERMINAL_WAIT / 1000} s (it took about 17 s before)`);
ok(ngAsked === 1, `... after one request to rdap.nic.net.ng, not two tries or a second name (and busy.ng's 503s paused nothing): ${ngAsked}`);
ok(arin.status === 502 && arin.data.error === ARIN && inTime(arin) && asked('https://rdap.arin.net/registry/ip/63.') === 1 &&
  !asked('https://stat.ripe.net/data/whois/data.json?resource=63.'),
  `whois 63.1.2.3 (ARIN never answers): ${arin.status} after ${secs(arin.ms)}, one request and none to RIPEstat (no time left for it), ${JSON.stringify(arin.data.error)}`);
ok(lacnic.status === 502 && lacnic.data.error === LACNIC && inTime(lacnic) && asked('https://rdap.lacnic.net/rdap/ip/200.') === 1 && asked('https://rdap.registro.br/ip/200.') === 1,
  `curl /whois/200.160.2.3 (LACNIC redirects to NIC.br, which never answers): ${lacnic.status} after ${secs(lacnic.ms)}, names LACNIC, the server asked: ${JSON.stringify(lacnic.data.error)}`);
ok(stall.status === 502 && stall.data.error === STALL && inTime(stall) && asked('https://rdap.stall.test/') === 1,
  `whois 62.1.2.3 (its server sends the headers, then nothing): ${stall.status} after ${secs(stall.ms)}, one request, ${JSON.stringify(stall.data.error)}`);
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
const rdapSent = sent.filter(s => /^https:\/\/rdap\./.test(s.url)), manual = rdapSent.filter(s => s.redirect === 'manual');
ok(rdapSent.length >= 20 && !manual.length && !/redirect/.test(slice(worker, 'async function rdapFetch(', '\n}\n')),
  `rdapFetch leaves redirects to fetch: none of ${rdapSent.length} RDAP requests said redirect: 'manual' (${manual.map(s => s.url).join(', ') || 'none'})`);

console.log('-- then the same message as text and on the page, at once: the silent server is left alone a minute');
const before = calls.length;
const text = await run('/whois/unijos.edu.ng?format=text');
ok(text.status === 502 && text.body === NG + '\n' && text.ms < 500, `curl /whois/unijos.edu.ng?format=text: ${text.status} after ${text.ms} ms, ${JSON.stringify(text.body)}`);
const page = await run('/whois/unijos.edu.ng', { ua: CHROME, ...NAV });
ok(page.status === 502 && page.initial && page.initial.error === NG && article(page.body).includes(`<p class="ln">${esc(NG)}</p>`) && page.ms < 500,
  `the /whois/unijos.edu.ng page: ${page.status} after ${page.ms} ms, the same words on the page and for the terminal it boots (initial.error)`);
const arinText = await run('/whois/63.1.2.3?format=text');
ok(arinText.status === 502 && arinText.body === ARIN + '\n' && arinText.ms < 500, `curl /whois/63.1.2.3?format=text: ${arinText.ms} ms, ${JSON.stringify(arinText.body)}`);
const lacnicText = await run('/whois/200.160.2.3?format=text');
ok(lacnicText.status === 502 && lacnicText.body === LACNIC + '\n' && lacnicText.ms < 500,
  `curl /whois/200.160.2.3?format=text: ${lacnicText.ms} ms, ${JSON.stringify(lacnicText.body)} (LACNIC, the origin asked, is the one paused)`);
const stallText = await run('/whois/62.1.2.3?format=text');
ok(stallText.status === 502 && stallText.body === STALL + '\n' && stallText.ms < 500,
  `curl /whois/62.1.2.3?format=text: ${stallText.ms} ms, ${JSON.stringify(stallText.body)} (silent mid-answer, so paused too)`);
const card = await run('/api/grade?domain=unijos.edu.ng', API);
ok(card.status === 200 && regLine(card) === "the registry record couldn't be read (rdap.nic.net.ng didn't answer), so expiry and the transfer lock weren't checked" &&
  card.ms < 2000, `grade unijos.edu.ng's registration line names the server, after ${card.ms} ms: ${JSON.stringify(regLine(card))}`);
ok(calls.slice(before).every(u => !['https://rdap.nic.net.ng/', 'https://rdap.arin.net/', 'https://rdap.lacnic.net/', 'https://rdap.stall.test/'].some(p => u.startsWith(p))),
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
for (const t of [TIMEOUT_TEXT, NETWORK_TEXT, NG, ARIN, LACNIC, ARIN525, NG503, RESET, APNIC429, "A data source didn't respond. Try again in a moment.",
  "The port check didn't finish. Try again in a moment.", 'Too many lookups from your address. Wait a minute and try again.']) ok(RETRYABLE.test(t), `retry is offered after: ${t}`);
ok(!RETRYABLE.test('Not a valid IP address, AS number or domain. Examples: whois 8.8.8.8, whois AS13335, whois example.com'), '... and not after a typo');
ok(app.includes("d.error !== 'no-api' && !d.unreached") && !/network error/i.test(app),
  'the boot check reads unreached (preview mode, as before), and nothing in app.js says "network error" any more');

const hb = read('docs/handbook.md').replace(/\s+/g, ' ');
ok(hb.includes('node tools/check_timeouts.mjs') && hb.includes('`DEADLINE` (6.5 seconds') && DEADLINE === 6500 &&
  [NG, ARIN525, TIMEOUT_TEXT, NETWORK_TEXT].every(t => hb.includes(t)) && hb.includes("couldn't be reached"),
  "docs/handbook.md describes the deadline, the registry's and the terminal's messages, and this check");
clearInterval(keepAlive);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
