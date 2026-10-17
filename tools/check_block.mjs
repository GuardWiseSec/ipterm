// Checks a lookup's block: when the registry record of the address's network was created (blockData() in
// src/worker.js), and the line a recent one adds. Two parts:
//
// 1. The logic, with no server. blockOf() and blockText() are read out of src/worker.js and blockLine() out of
//    public/app.js, then run on registry records dated relative to today, so these checks never go stale as real
//    blocks age: the 180-day edge, "today" and "1 day ago", records with no date or a bad one, a network given as a
//    range, and the terminal's line worded exactly like the Worker's. The docs must name the same threshold.
// 2. Against a running copy (`wrangler dev` by default, or pass the site's address): the field's shape, a day count
//    that matches its date, and a text line exactly when `recent` is true. wrangler dev passes CF-Connecting-IP
//    through, so locally the caller "is" 8.8.8.8, and your own address asked for by number is answered from
//    Cloudflare's edge plus RDAP: no IPinfo lookup. Locally it also checks that a crawler never causes a registry
//    request (a fresh address in Google's IPv6 block has no block for Googlebot until curl has asked). Live,
//    Cloudflare sets that header itself, so the checks use your own address and leave out the crawler one.
//    LOOKUPS=1 adds an ordinary lookup of 8.8.8.8 (IPinfo: live, that is one lookup of the budget) and checks that
//    /8.8.8.8/org is still one bare line.
//
//   node tools/check_block.mjs
//   node tools/check_block.mjs https://ipterm.net
//   LOOKUPS=1 node tools/check_block.mjs
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
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
const W = Function('REGISTRY', slice(worker, 'const BLOCK_RECENT_DAYS', '/* ---------- domain whois') +
  'return { blockOf, blockText, BLOCK_RECENT_DAYS };')(REGISTRY);
const blockLine = Function(slice(app, 'const RIRS =', 'async function render(') + 'return blockLine;')();

console.log('-- the logic (src/worker.js blockOf and blockText, public/app.js blockLine)');
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
ok(W.blockText(odd).startsWith(`203.0.113.0/24 registered on ${ago(10)} (`) && same(odd), 'a registry that is not one of the five: no "with ..."');
const bare = W.blockOf(rec(10, { cidrs: [], range: null, registry: null }));
ok(W.blockText(bare).startsWith('this block registered on ') && same(bare), 'no network and no registry: "this block registered on ..."');
for (const [why, w] of [['not found', { found: false }], ['no date', rec(1, { registered: null })], ['a date that is not one', rec(1, { registered: 'unknown' })],
  ['an impossible date', rec(1, { registered: '2026-13-45' })], ['no record', null]]) ok(W.blockOf(w) === null, `${why}: no block`);
ok(W.blockText(null) === null, 'no block: no line');
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
async function blockFor(addr, ua) {   // a slow registry fills the cache for the next ask, so curl asks twice
  for (let i = 0; ; i++) {
    const d = json((await get(`/${addr}/json`, { as: addr, ua })).body);
    if (d.block || ua || i) return d.block || null;
    await sleep(3000);
  }
}
function shape(addr, x, where) {
  const want = Math.round((Date.parse(today) - Date.parse(x.registered)) / 86400000);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(x.registered) && Number.isInteger(x.days) && x.days === want && x.recent === (x.days <= N) &&
    typeof x.network === 'string', `${where}: ${JSON.stringify(x)}`);
}
async function textLine(addr, x, opts) {
  const lines = (await get(`/${addr}/text`, opts)).body.split('\n').filter(l => /^block\s/.test(l));
  if (x.recent) ok(lines.length === 1 && lines[0].replace(/^block\s+/, '') === W.blockText(x), `/${addr}/text has the block line: ${lines[0] || '(none)'}`);
  else ok(lines.length === 0, `/${addr}/text has no block line (not recent)`);
}

console.log(`-- against ${B}`);
let me;
try { me = (await get('/')).body.trim(); } catch (e) { skip(`no server answered at ${B} (${e.cause ? e.cause.code || e.cause.message : e.message})`); }
if (me) {
  const A = local ? '8.8.8.8' : me;
  const x = await blockFor(A);
  if (!x) (local ? ok(false, `/${A}/json has no block (ARIN didn't answer?)`) : skip(`/${A}/json (your address) has no block: its registry has no date, or was slow`));
  else {
    shape(A, x, `/${A}/json (as the caller)`);
    if (local) ok(x.network === '8.8.8.0/24' && x.registry === 'ARIN', '8.8.8.8 is in 8.8.8.0/24, registered with ARIN');
    await textLine(A, x, { as: A });
  }
  ok(!('block' in json((await get('/json', { as: A })).body)), '/json (your own address, from the edge only) has no block');
  ok(!('block' in json((await get('/192.168.1.1/json')).body)), '/192.168.1.1/json (not public) has no block');
  if (local) {
    const R = '2001:4860:4860::' + (Math.random() * 0xffff | 0).toString(16);
    ok((await blockFor(R, GOOG)) === null, `a crawler asking for ${R} (not cached) gets no block: no registry request`);
    const y = await blockFor(R);
    ok(!!y, `curl asking for ${R} gets one: ${JSON.stringify(y)}`);
    ok(JSON.stringify(await blockFor(R, GOOG)) === JSON.stringify(y), 'then the crawler gets it too, from the cache');
  } else skip('the crawler check (needs wrangler dev, which lets the caller choose its address)');
  if (process.env.LOOKUPS) {
    const one = await get('/8.8.8.8/org');
    ok(one.status === 200 && /^[^\n]+\n$/.test(one.body), `/8.8.8.8/org is one bare line: ${JSON.stringify(one.body)}`);
    const d = json((await get('/8.8.8.8/json')).body);
    if (d.block) { shape('8.8.8.8', d.block, '/8.8.8.8/json (a lookup)'); await textLine('8.8.8.8', d.block, {}); }
    else ok(false, '/8.8.8.8/json (a lookup) has no block');
  } else skip('LOOKUPS=1 adds an ordinary lookup (IPinfo) and the one-value route');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
