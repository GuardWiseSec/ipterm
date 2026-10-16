// Builds src/asn-sitemap.js: the largest routed networks (ASNs), ranked by the IPv4 address space they
// announce, for the /sitemap-asn-*.xml files. There is no build step, so the output is checked in. Rerun it
// every few months (the ranking moves slowly) and commit the result:
//   npm run asn-sitemap                         # downloads the two public files below
//   node tools/build_asn_sitemap.mjs --ris riswhoisdump.IPv4.gz --names asn.txt   # or use local copies
//   node tools/build_asn_sitemap.mjs --top 20000 --show-excluded                   # more, and review what was left out
//   (--show-kept prints what was kept, --caida uses CAIDA's file below, --min-peers changes the cutoff of 10)
//
// Sources (public, no key):
//   - RIPE NCC RIS, the routing data behind RIPEstat: https://www.ris.ripe.net/dumps/riswhoisdump.IPv4.gz
//     (one line per origin AS and prefix, with how many RIS peers see it)
//   - RIPE NCC's AS names, the holder names RIPEstat shows: https://ftp.ripe.net/ripe/asnames/asn.txt
//   - or, with --caida, CAIDA's RouteViews prefix-to-AS file (the newest in
//     https://publicdata.caida.org/datasets/routing/routeviews-prefix2as/), instead of RIS
//
// Ranking: each AS's announced IPv4 space counts every address once (overlapping prefixes merged), from
// prefixes between /8 and /24 that at least 10 RIS peers see (RIPEstat's own low-visibility cutoff),
// leaving out non-public space and private, reserved and documentation AS numbers.
//
// Private individuals are left out (GDPR caution): a network is left out when it isn't in the AS names list,
// or its holder name may be a person's. src/holder-heuristic.js has the rules (a given name followed by another
// word, "sole trader" and similar, partnerships of named people, two to six plain words with no sign of an
// organization ...); the Worker uses the same rules to mark those networks' pages "noindex, follow". When in
// doubt it leaves a network out: "Paul Bunyan Communications" or "Independence Blue Cross" (both businesses)
// look like people, so they go too. The pages of networks left out still work; they just aren't in the
// sitemap. What was left out is only printed (--show-excluded), never saved to a file.
import { writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { holderOf, personReason } from '../src/holder-heuristic.js';

const root = new URL('..', import.meta.url);
const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = name => args.includes(name);
const TOP = Number(opt('--top', '10000'));
const MIN_PEERS = Number(opt('--min-peers', '10'));
if (!Number.isInteger(TOP) || TOP < 1 || TOP > 200000) throw new Error('--top must be a whole number from 1 to 200000');

const RIS_URL = 'https://www.ris.ripe.net/dumps/riswhoisdump.IPv4.gz';
const NAMES_URL = 'https://ftp.ripe.net/ripe/asnames/asn.txt';
const CAIDA_DIR = 'https://publicdata.caida.org/datasets/routing/routeviews-prefix2as/';

async function load(local, url, gz) {
  let buf;
  if (local) buf = readFileSync(local);
  else {
    const r = await fetch(url, { headers: { 'user-agent': 'ipterm build_asn_sitemap (https://github.com/GuardWiseSec/ipterm)' } });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf.length > 200 * 1024 * 1024) throw new Error(`${local || url}: larger than 200 MB, refusing`);
  return (gz || (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf, { maxOutputLength: 1024 * 1024 * 1024 }) : buf).toString('latin1');
}

// Public AS numbers only: not 0, AS_TRANS, documentation, private or reserved ones.
const publicAsn = n => n >= 1 && n <= 4199999999 && n !== 23456 && !(n >= 64496 && n <= 131071);

const v4int = s => { const o = s.split('.').map(Number); return o.some(x => x > 255) ? null : ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3]; };
const NON_PUBLIC = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]
  .map(([a, l]) => [v4int(a), 2 ** (32 - l)]);
const nonPublic = (start, size) => NON_PUBLIC.some(([s, n]) => start < s + n && s < start + size);

// Lines one at a time, without splitting a 40 MB file into a million strings at once.
function* eachLine(text) {
  for (let i = 0; i < text.length;) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    yield text.slice(i, j).trim();
    i = j + 1;
  }
}

// origin -> its prefixes as [start, end) intervals, flat: [s1, e1, s2, e2, ...]
const space = new Map();
function addPrefix(asn, net, len) {
  if (!publicAsn(asn) || len < 8 || len > 24) return false;
  const start = v4int(net), size = 2 ** (32 - len);
  if (start == null || start % size !== 0 || nonPublic(start, size)) return false;
  if (!space.has(asn)) space.set(asn, []);
  space.get(asn).push(start, start + size);
  return true;
}

let source, routes = 0;
if (flag('--caida')) {
  let file = opt('--caida');
  if (!file) {
    const log = await load(null, CAIDA_DIR + 'pfx2as-creation.log', false);
    const last = log.trim().split('\n').pop().split('\t')[2];
    if (!/^\d{4}\/\d{2}\/routeviews-rv2-\d{8}-\d{4}\.pfx2as\.gz$/.test(last || '')) throw new Error('unexpected pfx2as-creation.log line: ' + last);
    file = null; source = CAIDA_DIR + last;
  } else source = file;
  const text = await load(file, source, true);
  for (const line of eachLine(text)) {                    // 1.0.0.0<TAB>24<TAB>13335, or 13335_209242 (several origins)
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\t(\d{1,2})\t([\d_]{1,80})$/.exec(line);
    if (!m) continue;                                     // AS sets ({...}) and anything odd are skipped
    for (const a of m[3].split('_')) if (addPrefix(Number(a), m[1], Number(m[2]))) routes++;
  }
  source = `CAIDA RouteViews prefix-to-AS (${source.split('/').pop()})`;
} else {
  const file = opt('--ris');
  const text = await load(file, RIS_URL, true);
  const when = /generated at (.+? UTC \d{4})/.exec(text.slice(0, 600));
  for (const line of eachLine(text)) {                    // <origin> <TAB> <prefix> <TAB> <seen by #peers>
    const m = /^(\d{1,10})\t(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\t(\d{1,6})$/.exec(line);
    if (m && Number(m[4]) >= MIN_PEERS && addPrefix(Number(m[1]), m[2], Number(m[3]))) routes++;
  }
  source = `RIPE NCC RIS (riswhoisdump.IPv4.gz${when ? ', ' + when[1] : ''}, prefixes seen by ${MIN_PEERS}+ peers)`;
}

function addresses(flat) {                                // unique addresses: overlaps counted once
  const iv = [];
  for (let i = 0; i < flat.length; i += 2) iv.push([flat[i], flat[i + 1]]);
  iv.sort((x, y) => x[0] - y[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [s, e] of iv) { if (s > ce) { if (ce > cs) total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e; }
  return ce > cs ? total + ce - cs : total;
}

// asn.txt: "<asn> <HANDLE> - <Holder name>, <CC>" (ARIN, LACNIC, AFRINIC) or "<asn> <HANDLE> <Holder name>, <CC>".
const names = new Map();
for (const line of eachLine(await load(opt('--names'), NAMES_URL, false))) {
  const m = /^(\d{1,10}) (.{0,300}?)(?:, ([A-Z]{2}))?$/.exec(line);
  if (m) names.set(Number(m[1]), { line, holder: holderOf(m[2]) });   // the handle split: src/holder-heuristic.js
}

const ranked = [...space].map(([asn, iv]) => ({ asn, addresses: addresses(iv) })).sort((a, b) => b.addresses - a.addresses || a.asn - b.asn);
const kept = [], excluded = new Map(), shown = [], keptShown = [];
let unnamed = 0;
for (const r of ranked) {
  if (kept.length >= TOP) break;
  const n = names.get(r.asn);
  const why = n ? personReason(n.holder) : 'not in the AS names list';
  if (!n) unnamed++;
  if (why) { excluded.set(why, (excluded.get(why) || 0) + 1); shown.push(`${why.padEnd(28)} AS${r.asn}  ${r.addresses}  ${n ? n.line : ''}`); continue; }
  kept.push(r);
  keptShown.push(`AS${r.asn}  ${r.addresses}  ${n.line}`);
}
if (kept.length < TOP) console.warn(`only ${kept.length} networks qualified (asked for ${TOP})`);

const date = new Date().toISOString().slice(0, 10);
const smallest = kept.length ? kept[kept.length - 1].addresses : 0;
const leftTotal = [...excluded.values()].reduce((a, b) => a + b, 0);
const lines = [];
for (let i = 0; i < kept.length; i += 16) lines.push('  ' + kept.slice(i, i + 16).map(r => r.asn).join(', ') + ',');
const out = `// Generated by tools/build_asn_sitemap.mjs on ${date}. Do not edit: run \`npm run asn-sitemap\` and commit the result.
// The ${kept.length.toLocaleString('en-US')} largest routed networks by announced IPv4 space, largest first, for /sitemap-asn-*.xml.
// Source: ${source}; holder names from RIPE NCC's AS names (asn.txt).
// The smallest kept announces ${smallest.toLocaleString('en-US')} addresses. Of the ${(kept.length + leftTotal).toLocaleString('en-US')} largest, ${leftTotal.toLocaleString('en-US')} were left out because
// the holder might be a private person or isn't clearly an organization (GDPR caution; see the tool).
export const ASN_SITEMAP_DATE = '${date}';
export const ASN_SITEMAP = [
${lines.join('\n')}
];
`;
const dest = new URL('src/asn-sitemap.js', root);
writeFileSync(dest, out);
console.log(`source: ${source}, ${routes.toLocaleString('en-US')} routes, ${space.size.toLocaleString('en-US')} origin ASNs`);
console.log(`kept ${kept.length.toLocaleString('en-US')}; left out ${leftTotal.toLocaleString('en-US')} on the way (${[...excluded].map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})`);
console.log(`largest AS${kept[0] && kept[0].asn} (${kept[0] && kept[0].addresses.toLocaleString('en-US')} addresses), smallest kept ${smallest.toLocaleString('en-US')} addresses`);
console.log(`wrote ${fileURLToPath(dest)}: ${out.length.toLocaleString('en-US')} bytes`);
if (flag('--show-excluded')) console.log('\nleft out (printed only, not saved):\n' + shown.join('\n'));
if (flag('--show-kept')) console.log('\nkept:\n' + keptShown.join('\n'));
