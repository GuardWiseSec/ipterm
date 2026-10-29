// Checks a lookup's block: when the registry record of the address's network was created (blockData() in
// src/worker.js), and the line a recent one adds. Two parts:
//
// 1. The logic, with no server. registryOf(), blockOf() and blockText() are read out of src/worker.js and blockLine()
//    out of public/app.js, then run on registry records dated relative to today, so these checks never go stale as
//    real blocks age: the 180-day edge, "today" and "1 day ago", records with no date or a bad one, a network given
//    as a range, and the terminal's line worded exactly like the Worker's. registryOf() gets RDAP answers shaped like
//    the RIRs' and the national registries' (IDNIC's, mirrored by APNIC; NIC.br's own) and must name each, never a
//    hostname. Then the Worker's ipText() and ipPage() and app.js's render() (what it draws on stubbed) must show a
//    recent block's line in the text answer, the page and the terminal's lookup, and an old one's nowhere. The docs
//    must name the same threshold.
// 2. Against a running copy (`wrangler dev` by default, or pass the site's address). Your own address never goes to
//    a registry: asked for by number (/<ip>/json, even with ?block=1, /api/lookup?ip=, /<ip>/text) it has no block,
//    and neither do /json and a private address; all of that is answered from Cloudflare's edge, with no IPinfo
//    lookup. wrangler dev passes CF-Connecting-IP through, so locally the script chooses who it is (8.8.8.8) and
//    follows a fresh address in Google's IPv6 block: asked for by itself (written out in full), with ?block=0 and by
//    Googlebot, it has no block, since none of them asked its registry (the crawler only reads the cache); asked for
//    by curl it gets one, with the right shape, a day count that matches its date and a text line only if `recent`
//    is true (Google's block is old, so that is no line: part 1 covers a recent one); then Googlebot gets the same
//    from the cache. That is one ordinary lookup, from IPinfo's free API (wrangler dev has no IPINFO_TOKEN unless
//    .dev.vars sets one). Live, Cloudflare sets that header itself, so the checks use your own address and leave out
//    the local ones. LOOKUPS=1 adds an ordinary lookup of 8.8.8.8, with and without ?block=0 (live, unless cached,
//    that is one IPinfo Core lookup and one proxycheck.io query of their budgets), and checks that /8.8.8.8/org
//    (IPinfo Lite, free) is still one bare line.
//
//   node tools/check_block.mjs
//   node tools/check_block.mjs https://ipterm.net
//   LOOKUPS=1 node tools/check_block.mjs
import { readFileSync } from 'node:fs';
import { ANSI, ansi } from '../src/me.js';
import '../public/resolvers.js';                 // the public DNS resolvers, which ipPage() asks about every address

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout has CRLF
const worker = read('src/worker.js'), app = read('public/app.js');
let pass = 0, fail = 0;
const ok = (good, msg) => { if (good) pass++; else fail++; console.log(`${good ? 'PASS' : 'FAIL'}  ${msg}`); };
const skip = msg => console.log(`SKIP  ${msg}`);

function slice(src, from, to) {
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  if (b < 0) throw new Error(`can't find "${from}" ... "${to}": update tools/check_block.mjs`);
  return src.slice(a, b);
}
const REGISTRY = Function(`return ${/const REGISTRY = (\{[^}]*\});/.exec(worker)[1]}`)();
// The Worker's code as it runs: the registry's name, the block, and the text answer and the page that show its line
// (shell(), the page around the block, hands back just the block).
const W = Function('REGISTRY', 'ANSI', 'ansi', 'shell', 'RESOLVERS', [slice(worker, 'const IPINFO_CREDIT =', '\n'),
  slice(worker, 'function registryOf(', 'async function rdapLookup('), slice(worker, 'const BLOCK_RECENT_DAYS', '/* ---------- domain whois'),
  slice(worker, 'const plain = ', 'function asnText('), slice(worker, 'function connectionText(', 'function cidrPage('),
  slice(worker, 'const DESC_MAX', 'let SHELL = null;'),                              // the page's description (descFit)
  slice(worker, 'function staticBlock(', '/* ---------- robots'), slice(worker, 'const esc = ', 'const safeJson'),
  // what ipPage asks of an address: is it a network's first address (netStart), curated, inside the block
  slice(worker, 'const V4 = ', 'function countryName('), slice(worker, 'let curated = null;', '// What an IPv4 address typed'),
  slice(worker, 'const SITEMAP_PATHS = [', '\n];') + '\n];', slice(worker, 'const addressesOf = ', 'const resolverPaths = '),
  slice(worker, 'function inPrefix(', '// The RDAP base'),
  'return { registryOf, blockOf, blockText, BLOCK_RECENT_DAYS, ipText, ipPage, esc };'].join('\n'))(REGISTRY, ANSI, ansi, (io, o) => o.body, globalThis.IPTERM_RESOLVERS);
// The terminal's line and its lookup, with what render() draws on stubbed: kv() gets the rows it shows.
let shown = [];
const T = Function('classify', 'el', 'SRC', 'shareBar', 'out', 'geoBlock', 'connection', 'vpnText', 'computed', 'kv', 'announce',
  slice(app, 'const REGISTRIES =', '/* ---------- sponsored line') + 'return { REGISTRIES, blockLine, render };')(
  () => ['public', null], () => ({ append() {} }), {}, () => null, { appendChild() {} }, () => null, () => null, () => 'not checked',
  () => [], rows => { shown = rows; }, () => {});
const blockLine = T.blockLine;
const blockLines = s => s.split('\n').filter(l => /^block\s/.test(l));

console.log('-- the logic (src/worker.js registryOf, blockOf and blockText, public/app.js blockLine)');
const N = W.BLOCK_RECENT_DAYS;
const today = new Date().toISOString().slice(0, 10);
const ago = n => new Date(Date.parse(today) - n * 86400000).toISOString().slice(0, 10);
const rec = (n, more = {}) => ({ found: true, registry: 'ARIN', cidrs: ['203.0.113.0/24'], range: { start: '203.0.113.0', end: '203.0.113.255' },
  registered: ago(n) + 'T12:56:11-04:00', ...more });
const TAIL = ': IP location databases often take months to catch up with new or reassigned blocks, so sites may disagree about where this address is';
const same = b => blockLine(b) === W.blockText(b);

const b = W.blockOf(rec(86));
ok(JSON.stringify(Object.keys(b)) === '["network","registry","registered","days","recent"]', 'block has network, registry, registered, days and recent');
ok(b.network === '203.0.113.0/24' && b.registry === 'ARIN' && b.registered === ago(86) && b.days === 86 && b.recent === true,
  `registered 86 days ago: ${JSON.stringify(b)}`);
ok(W.blockText(b) === `203.0.113.0/24 registered with ARIN on ${ago(86)} (86 days ago)` + TAIL, 'its line: ' + W.blockText(b));
ok(same(b), "the terminal's line is the same");
for (const [n, words] of [[0, 'today'], [1, '1 day ago'], [N, `${N} days ago`]]) {
  const x = W.blockOf(rec(n));
  ok(x.days === n && x.recent && W.blockText(x).includes(`(${words})`) && same(x), `registered ${n} day${n === 1 ? '' : 's'} ago: recent, "${words}"`);
}
const old = W.blockOf(rec(N + 1));
ok(old.days === N + 1 && old.recent === false && W.blockText(old) === null, `registered ${N + 1} days ago: not recent, no line`);
const future = W.blockOf(rec(-3));
ok(future.days === 0 && future.recent, 'a date after today (clock skew): 0 days, recent');
ok(W.blockOf(rec(10, { registered: ago(10) })).days === 10, 'a date with no time of day');
ok(W.blockOf(rec(10, { cidrs: [] })).network === '203.0.113.0 - 203.0.113.255', 'a network with no CIDR: its first and last address');
ok(W.blockOf(rec(10, { cidrs: ['203.0.113.0/25', '203.0.113.128/26'] })).network === '203.0.113.0/25, 203.0.113.128/26', 'two CIDRs, comma-separated');
const odd = W.blockOf(rec(10, { registry: 'rdap.example.net' }));
ok(W.blockText(odd).startsWith(`203.0.113.0/24 registered on ${ago(10)} (`) && same(odd), 'a registry REGISTRY doesn\'t name (a hostname, in a record cached before registryOf()): no "with ..."');
const bare = W.blockOf(rec(10, { cidrs: [], range: null, registry: null }));
ok(W.blockText(bare).startsWith('this block registered on ') && same(bare), 'no network and no registry: "this block registered on ..."');
for (const [why, w] of [['not found', { found: false }], ['no date', rec(1, { registered: null })], ['a date that is not one', rec(1, { registered: 'unknown' })],
  ['an impossible date', rec(1, { registered: '2026-13-45' })], ['no record', null]]) ok(W.blockOf(w) === null, `${why}: no block`);
ok(W.blockText(null) === null, 'no block: no line');
const nir = W.blockOf(rec(10, { registry: 'IDNIC' }));
ok(W.blockText(nir).startsWith(`203.0.113.0/24 registered with IDNIC on ${ago(10)} (`) && same(nir), 'a national registry: "with IDNIC", in the terminal too');
ok(JSON.stringify([...T.REGISTRIES].sort()) === JSON.stringify(Object.values(REGISTRY).sort()), 'the terminal names the registries the Worker does');

// registryOf(the RDAP answer, the host that answered, the base IANA's list gave)
const source = s => [{ title: 'Source', description: ['Objects returned came from source', s] }];
for (const [o, host, base, want, what] of [
  [{ port43: 'whois.arin.net' }, 'rdap.arin.net', 'https://rdap.arin.net/registry/', 'ARIN', 'ARIN'],
  [{ notices: source('RIPE'), port43: 'whois.ripe.net' }, 'rdap.db.ripe.net', 'https://rdap.db.ripe.net/', 'RIPE NCC', 'RIPE NCC (its Source notice says RIPE)'],
  [{ notices: source('APNIC'), port43: 'whois.apnic.net' }, 'rdap.apnic.net', 'https://rdap.apnic.net/', 'APNIC', "APNIC's own record (CNNIC's, VNNIC's and IRINN's space too)"],
  [{ notices: source('IDNIC'), port43: 'whois.apnic.net' }, 'idnic.rdap.apnic.net', 'https://rdap.apnic.net/', 'IDNIC', "IDNIC's record, mirrored by APNIC"],
  [{ notices: source('JPNIC') }, 'rdap.apnic.net', 'https://rdap.apnic.net/', 'JPNIC', 'a Source notice alone'],
  [{ port43: 'whois.apnic.net' }, 'krnic.rdap.apnic.net', 'https://rdap.apnic.net/', 'KRNIC', "a mirror's host alone"],
  [{ notices: source('CNNIC') }, 'rdap.apnic.net', 'https://rdap.apnic.net/', 'CNNIC', 'a source REGISTRY doesn\'t list: the name it gives'],
  [{ notices: source('<b>x</b>') }, 'rdap.apnic.net', 'https://rdap.apnic.net/', 'APNIC', 'a Source notice that is not a name: the server'],
  [{ port43: 'whois.registro.br' }, 'rdap.registro.br', 'https://rdap.lacnic.net/rdap/', 'NIC.br', "NIC.br's own server, for Brazil"],
  [{ port43: 'whois.lacnic.net' }, 'rdap.lacnic.net', 'https://rdap.lacnic.net/rdap/', 'LACNIC', "LACNIC's own record (NIC Mexico's space too)"],
  [{ port43: 'whois.afrinic.net' }, 'rdap.afrinic.net', 'https://rdap.afrinic.net/rdap/', 'AFRINIC', 'AFRINIC'],
  [{}, 'rdap.example.net', 'https://rdap.lacnic.net/rdap/', 'LACNIC', "a server it doesn't know: the registry IANA's list pointed to"],
  [{}, 'rdap.example.net', 'https://rdap.org/', null, 'one reached through rdap.org: null, never its hostname'],
]) { const got = W.registryOf(o, host, base); ok(got === want, `registry of ${what}: ${JSON.stringify(got)}`); }

console.log("-- the line in the text answer, the page and the terminal's lookup (src/worker.js ipText and ipPage, public/app.js render)");
for (const n of [86, N + 1]) {
  const x = W.blockOf(rec(n)), line = W.blockText(x), d = { ip: '203.0.113.7', version: 4, source: 'ipinfo-lite', block: x };
  const text = blockLines(W.ipText(d, {})), page = W.ipPage({}, d, 200);
  shown = [];
  try { await T.render({ v: 4 }, d.ip, d, false); } catch (e) { ok(false, `render() threw (${e.message}): stub what it now calls in tools/check_block.mjs`); }
  const term = shown.filter(r => r[0] === 'block');
  if (x.recent) {
    ok(text.length === 1 && text[0].replace(/^block\s+/, '') === line, `registered ${n} days ago: the text answer has the line`);
    ok(page.includes(`<dt>block</dt><dd>${W.esc(line)}</dd>`), `registered ${n} days ago: the page has it`);
    ok(term.length === 1 && term[0][1] === line, `registered ${n} days ago: the terminal's lookup has it`);
  } else ok(!text.length && !page.includes('<dt>block</dt>') && !term.length, `registered ${n} days ago: no line in the text answer, the page or the terminal`);
}
for (const f of ['docs/handbook.md', 'public/openapi.json', 'public/llms.txt']) ok(read(f).includes(`${N} days`), `${f} says ${N} days, like BLOCK_RECENT_DAYS`);
ok(worker.includes(`in the last ${N} days`), `/help says ${N} days`);

const B = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(B);
const GOOG = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path, { as = null, ua = 'curl/8.7.1' } = {}) {   // as: the caller's address (wrangler dev only)
  const r = await fetch(B + path, { redirect: 'manual', headers: { 'user-agent': ua, ...(as && local ? { 'cf-connecting-ip': as } : {}) } });
  return { status: r.status, body: await r.text() };
}
const json = s => { try { return JSON.parse(s); } catch { return {}; } };
const noBlock = async (path, opts) => !('block' in json((await get(path, opts)).body));
async function blockFor(addr, opts = {}) {   // a slow registry fills the cache for the next ask, so curl asks twice
  for (let i = 0; ; i++) {
    const d = json((await get(`/${addr}/json`, opts)).body);
    if (d.block || opts.ua || i) return d.block || null;
    await sleep(3000);
  }
}
function shape(addr, x, where) {
  const want = Math.round((Date.parse(today) - Date.parse(x.registered)) / 86400000);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(x.registered) && Number.isInteger(x.days) && x.days === want && x.recent === (x.days <= N) &&
    typeof x.network === 'string', `${where}: ${JSON.stringify(x)}`);
}
async function textLine(addr, x, opts) {
  const lines = blockLines((await get(`/${addr}/text`, opts)).body);
  if (x.recent) ok(lines.length === 1 && lines[0].replace(/^block\s+/, '') === W.blockText(x), `/${addr}/text has the block line: ${lines[0] || '(none)'}`);
  else ok(lines.length === 0, `/${addr}/text has no block line (not recent)`);
}

console.log(`-- against ${B}`);
let me;
try { me = (await get('/')).body.trim(); } catch (e) { skip(`no server answered at ${B} (${e.cause ? e.cause.code || e.cause.message : e.message})`); }
if (me) {
  const A = local ? '8.8.8.8' : me, as = local ? A : null;   // the caller
  for (const path of [`/${A}/json`, `/${A}/json?block=1`, `/api/lookup?ip=${A}`]) ok(await noBlock(path, { as }), `${path} (your own address, by number) has no block`);
  ok(!blockLines((await get(`/${A}/text`, { as })).body).length, `/${A}/text (your own address) has no block line`);
  ok(await noBlock('/json', { as }), '/json (your own address, from the edge only) has no block');
  ok(await noBlock('/192.168.1.1/json'), '/192.168.1.1/json (not public) has no block');
  if (local) {
    const R = '2001:4860:4860::' + (Math.random() * 0xffff | 0).toString(16), full = R.replace('::', ':0:0:0:0:');
    ok(await noBlock(`/${full}/json`, { as: R }), `${R} asking for itself (as ${full}) gets no block`);
    ok(await noBlock(`/${R}/json?block=0`, { as }), `/${R}/json?block=0 has no block`);
    ok((await blockFor(R, { as, ua: GOOG })) === null, `then a crawler asking for ${R} gets none: neither of those asked the registry, and it doesn't`);
    const y = await blockFor(R, { as });
    if (!y) ok(false, `curl asking for ${R} gets no block (ARIN didn't answer?)`);
    else {
      shape(R, y, `curl asking for ${R} gets one`);
      ok(y.network === '2001:4860::/32' && y.registry === 'ARIN', `${R} is in 2001:4860::/32, registered with ARIN`);
      await textLine(R, y, { as });
      ok(JSON.stringify(await blockFor(R, { as, ua: GOOG })) === JSON.stringify(y), 'then the crawler gets it too, from the cache');
    }
  } else skip('the registry-request checks (they need wrangler dev, which lets the caller choose its address)');
  if (process.env.LOOKUPS) {
    const one = await get('/8.8.8.8/org');
    ok(one.status === 200 && /^[^\n]+\n$/.test(one.body), `/8.8.8.8/org is one bare line: ${JSON.stringify(one.body)}`);
    const x = await blockFor('8.8.8.8');     // the second ask comes from the cache: no more of either budget
    if (x) { shape('8.8.8.8', x, '/8.8.8.8/json (a lookup)'); await textLine('8.8.8.8', x, {}); }
    else ok(false, "/8.8.8.8/json (a lookup) has no block (its registry didn't answer?)");
    ok(await noBlock('/8.8.8.8/json?block=0'), '/8.8.8.8/json?block=0 has no block');
  } else skip('LOOKUPS=1 adds an ordinary lookup of 8.8.8.8 (live, unless cached: IPinfo Core and proxycheck.io) and the one-value route');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
