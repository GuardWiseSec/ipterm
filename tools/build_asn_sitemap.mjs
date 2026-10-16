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
// Private individuals are left out (GDPR caution). Many networks are registered to a person, and their
// holder name is that person's name. A network is left out when, checked in this order:
//   1. it isn't in the AS names list or has no holder name;
//   2. the name shows a natural person, whatever else it says: "sole proprietor(ship)", "sole trader",
//      "individual", "entrepreneur" (private, individual, auto-), "Einzelunternehmen", "e.K.", "Inh.",
//      "sahis", "autonomo", "entreprise individuelle", "EI", "EIRL", "MEI", or a patronymic (-ovich, -evna ...);
//   3. it is a partnership of named people ("spolka jawna", "s.c.", "GbR", "v.o.f.", "s.n.c.") with no other
//      legal form;
//   4. "trading as" (t/a, d/b/a) follows a person's part, or a sole-trader form (PE, FOP, IE, IP, SP, ChP,
//      FLP) comes before one: "Jonas Frey trading as Probe Networks" goes, "Hartana GmbH trading as ACS
//      Hartmann GmbH & Co. KG" stays;
//   5. a common given name is followed by another word ("Marc Pauls (AlphaCron Datensysteme)"), unless the
//      name also has a registered legal form (Inc, LLC, Ltd, GmbH, SA, BV, Oy, s.r.o. ...) or names a public
//      body or institution (university, school, foundation, ministry, district, hospital ...), which makes it
//      a company or institution named after someone: "Robert Bosch GmbH", "George Mason University";
//   6. with no sign of an organization at all (the legal forms and institutions above, or a word such as
//      network, telecom, internet, hosting, cloud or business, in several languages), the name is two to six
//      plain words, the shape of a person's name ("Kai Rottleb"). One word ("Panix", "KISTI"), digits or "&"
//      ("PG&E"), a web address, an address with several commas, spelled-out initials, or a country or region
//      ("MTN Sudan", "Air Canada") count as an organization.
// When in doubt it leaves a network out: "Paul Bunyan Communications" or "Independence Blue Cross" (both
// businesses) look like people, so they go too. The pages of networks left out still work; they just aren't
// in the sitemap. What was left out is only printed (--show-excluded), never saved to a file.
import { writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

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
  if (!m) continue;
  const body = m[2].trim(), dash = body.indexOf(' - ');
  // A body of one word ("Polismyndigheten") is the name itself; "-" alone is no name.
  const holder = dash > 0 && !/\s/.test(body.slice(0, dash)) ? body.slice(dash + 3)
    : body.includes(' ') ? body.slice(body.indexOf(' ') + 1) : body.replace(/^-$/, '');
  // RIPE lines have no " - ": the first word is usually the handle (SERGIOB, PISKOT-AS), but some lines have
  // none ("University of Innsbruck"), so a first word that doesn't look like a handle is part of the name.
  const first = body.split(' ')[0];
  const handle = dash > 0 || /[-_\d]/.test(first) || (first.length > 1 && first === first.toUpperCase());
  names.set(Number(m[1]), { line, holder: (handle ? holder : body).trim() });
}

// The heuristic described at the top.
// Signs of a natural person, whatever else the name says.
const PERSON = [
  [/\bsole\s+(proprietor(ship)?|trader|owner)\b/i, 'sole proprietor'],
  [/\bindividual\b|\bentrepreneurs?\b|\bprivate\s+person\b|\bprivatperson\b|\bauto-?entrepreneur\b|\bmicro-?entreprise\b|\bentreprise individuelle\b/i, 'individual or entrepreneur'],
  [/einzel(unternehm|firma)|\be\.\s?k\.(?=\s|,|$)|\binh(aber|\.)\s/i, 'German sole trader'],
  [/\bsahis\b|\baut[oó]nomo\b|\bditta individuale\b|\b(EI|EIRL|MEI)\b/, 'sole trader (other countries)'],
  [/\b[A-Z][a-z]+(ovich|evich|ievich|yevich|ovych|evych|yovych|ovna|evna|ievna|ivna)\b/, 'patronymic'],
];
// Partnerships of named people (Polish "spolka jawna" and "s.c.", German "GbR", Dutch "v.o.f.", Italian
// "s.n.c.") carry the partners' names. Unless another legal form is there too (Romanian "S.C. ... S.R.L.").
const PARTNERSHIP = /\bsp[oó][lł]ka\s+(jawna|cywilna)\b|\bsp\.\s?j\.?(?=\s|,|$)|(^|\s)s\.\s?c\.?(?=\s|,|$)|\bgbr\b|\bv\.o\.f\.?|\bs\.n\.c\.?(?=\s|,|$)/i;
// Signs of a person only when the owner's part has no sign of an organization: "Jonas Frey trading as Probe
// Networks" is a person, "Hartana GmbH trading as ACS Hartmann GmbH & Co. KG" is not. [pattern, owner's part]
const PERSON_IF = [
  [/\s(trading\s+as|t\/a|d\/b\/a|dba)\s/i, (h, m) => h.slice(0, m.index), 'trading as'],
  [/^(PE|FOP|FO-P|IE|IP|SP|ChP|CHP|FLP|SPD)\s+/, (h, m) => h.slice(m[0].length), 'leading sole-trader form'],
];
const words = list => new RegExp('(^|[^\\p{L}])(' + list.join('|') + ')(?![\\p{L}])', 'iu');   // whole words
const stems = list => new RegExp('(^|[^\\p{L}])(' + list.join('|') + ')', 'iu');               // word beginnings
// Strong signs of an organization: a registered legal form, or a public body or institution. Next to these, a
// person's name is the name of a company or institution (Robert Bosch GmbH, George Mason University).
const LEGAL = words([
  'inc', 'incorporated', 'corp', 'co', 'cia', 'l\\.?l\\.?c', 'l\\.?l\\.?p', 'l\\.?p', 'ltd', 'ltda', 'ltee', 'limited', 'limitada', 'plc', 'p\\.?l\\.?c', 'pty', 'pte', 'pvt',
  'g\\.?m\\.?b\\.?h', 'ggmbh', 'mbh', 'ag', 'kg', 'kgaa', 'ug', 'eg', 'se', 's\\.? ?a', 's\\.?a\\.?s', 'sasu', 's\\.?a\\.?r\\.?l', 'eurl', 's\\.?l', 's\\.?l\\.?u', 's\\.?r\\.?l', 's\\.?p\\.?a',
  's\\.? ?de ?r\\.?l', 'c\\.?v', 'sac', 'spl', 'sem', 'sapem', 'b\\.?v', 'bvba', 'n\\.?v', 'c\\.?a', 'a\\.?c', 'l\\.?c', 'cc', 'sf', 'p\\/f', 'sh\\.?a', 'sh\\.?p\\.?k', 'ab', 'oy', 'oyj', 'as', 'a\\/s',
  'asa', 'aps', 'a\\.s', 's\\.?r\\.?o', 'spol', 'sp\\.? ?z ?o\\.? ?o', 'z\\.?o\\.?o', 'z\\.?s\\.?p\\.?o', 'kft', 'zrt', 'nyrt', 'bt', 'd\\.?o\\.?o', 'dooel', 'd\\.?d', 'ad', 'ead', 'ood', 'eood',
  'jsc', 'pjsc', 'ojsc', 'cjsc', 'ooo', 'oao', 'zao', 'pao', 'ao', 'tov', 'too', 'uab', 'mb', 'sia', 'ou', 'osk', 'hf', 'ehf', 'kk', 'k\\.k', 'gk', 'bhd', 'berhad', 'sdn', 'tbk', 'pt', 'ep', 'pe',
  'e\\.?v', 'vzw', 'asbl', 'ry', 'sal', 'mepe', 'f\\.?m\\.?b\\.?a', 'w\\.?l\\.?l', 'opc', 'aor', 'emc', 'epa', 'remc', 'fcb', 's\\/a', 'sapi', 'eireli', 'scrl', 'sprl', 'srls', 'sccl', 'scoop',
  'anonim', 'fondation', 'vereniging', 'osuuskunta', 'etat', 'junta', 'forces', 'army', 'navy', 'gov', 'univ', 'dept', 'board', 'court', 'borough', 'capitol', 'commons', 'boces', 'suny', 'customs', 'revenue',
]);
const INSTITUTION = stems([
  'compan', 'compa[nñ]', 'corporat', 'corporac', 'gesellschaft', 'aktien', 'aktiebolag', 'aktsiaselts', 'aktsion', 'obshchestvo', 'haftung', 'sirket', 'etaireia', 'anonym', 'spoldziel', 'cooperat', 'genossen',
  'associa', 'asocia', 'verband', 'verein', 'societ', 'foundat', 'fundac', 'fondaz', 'stiftung', 'stichting', 'stiftelse', 'forening', 'trust', 'consorz', 'consorti', 'institut', 'istitut', 'univer', 'uniwers',
  'college', 'school', 'escola', 'escuela', 'academ', 'akadem', 'hochschul', 'fachhochschul', 'politech', 'polytech', 'teknisk', 'research', 'laborator', 'observator', 'museum', 'librar', 'bibliot',
  'minist', 'govern', 'gouvern', 'gobier', 'depart', 'council', 'kommun', 'municip', 'gemeinde', 'gemeente', 'kaupunki', 'kunta', 'ayuntamiento', 'prefeitura', 'generalitat', 'diputacion', 'landsting',
  'region', 'kanton', 'district', 'county', 'city', 'ciudad', 'cidade', 'provinc', 'prefect', 'state', 'federal', 'federat', 'commonwealth', 'nation', 'nacional', 'republic', 'agency', 'agencia', 'agence',
  'authorit', 'administr', 'verwaltung', 'legislat', 'senate', 'parliament', 'representatives', 'majesty', 'police', 'polizei', 'military', 'defen', 'hospital', 'hopita', 'hôpita', 'klinik', 'clinic',
  'health', 'helse', 'gesundheit', 'medical', 'medizin', 'medicin', 'center', 'centre', 'centro', 'centrum', 'zentrum', 'church', 'dioces', 'archdioc', 'facility', 'public', 'publiek', 'publique', 'pubbli',
]);
const INSTITUTION_PART = /ministeri|regierung|hochschul|hogskol|högskol|univers|gesellschaft|genossenschaft|verwaltung|zentrum|rundfunk|omroep/i;   // inside compound words
// Weaker signs: what the network does.
const BUSINESS = words([
  'net', 'netz', 'rede', 'redes', 'cabo', 'isp', 'ix', 'idc', 'asn', 'pcs', 'mpls', 'it', 'ict', 'iot', 'dsl', 'nap', 'thd', 'labs?', 'hosts?', 'news', 'media', 'medien', 'auto', 'shop', 'stores?',
  'club', 'sports?', 'markets?', 'marketing', 'tech', 'web', 'online', 'data', 'power', 'banks?', 'banking', 'banca', 'coop', 'stadt', 'schule', 'direct', 'general', 'link', 'wave', 'stream', 'presse',
  'salut', 'uk', 'usa', 'eu', 'nz',
]);
const BUSINESS_STEM = stems([
  'empresa', 'enterprise', 'entreprise', 'unternehm', 'merkez', 'zavod', 'business', 'partners', 'holding', 'group', 'grupo', 'gruppe', 'groupe', 'industr', 'manufact', 'project', 'teknik', 'scien', 'office',
  'bureau', 'dienst', 'command', 'pharm', 'banco', 'banque', 'bankhaus', 'insur', 'invest', 'capital', 'financ', 'international', 'global', 'european', 'headquarter', 'network', 'netzwerk', 'reseau',
  'telecom', 'telekom', 'telco', 'telefon', 'telephon', 'telekomunik', 'telecomunic', 'teledata', 'teleport', 'televi', 'telewiz', 'communica', 'comunica', 'kommunika', 'unicom', 'internet', 'provider',
  'provedor', 'proveedor', 'broadband', 'cable', 'kabel', 'kablow', 'fiber', 'fibre', 'fibra', 'optic', 'wireless', 'wifi', 'mobil', 'cellular', 'satel', 'antenne', 'hosting', 'hoster', 'cloud', 'datacent',
  'server', 'system', 'sistem', 'technolog', 'tecnolog', 'technik', 'techno', 'solution', 'solucion', 'solucoe', 'servic', 'servizi', 'servei', 'digital', 'digi', 'software', 'programm', 'computer', 'computing',
  'informat', 'organi[sz]a', 'consult', 'connect', 'bandwidth', 'transit', 'energ', 'electr', 'elektr', 'utilit', 'logist', 'airline', 'airway', 'airport', 'railway', 'retail', 'motors', 'automotive',
  'broadcast', 'radio', 'newspaper', 'publish', 'exchange', 'building', 'street', 'avenue', 'road', 'floor', 'tower', 'azienda', 'salud', 'engineer', 'interactive', 'intelligen', 'product', 'division',
  'operation', 'develop', 'managem', 'express', 'material', 'atomic', 'access', 'consumer', 'stadtwerk',
]);
const BUSINESS_PART = /dienst|zentral|wirtschaft|verarbeitung|telecom|telekom|network|hosting|internet/i;   // inside compound words
// Common given names. One followed by another word, with no legal form or public body, is an owner's name:
// "Marc Pauls (AlphaCron Datensysteme)", "Jerzy Krempa "Telpol"". (San Jose, St. John and the like are places.)
const GIVEN_NAMES = `aaron adam adrian ahmad ahmed ahmet aleksander aleksandr aleksandra aleksei alex alexander alexandre alexei alexey ali alain alberto alejandro alessandro andre andrea andreas
  andrei andrej andres andrew andrey andriy andrzej andy anna anatoly anders anthony antonio anton antti arnaud artem artur arthur ashok bart bartosz benjamin benoit bernd bernhard bjorn bogdan bojan boris
  branko brian bruno burak carlos carl carmen cedric charles chris christoph christophe christopher claudia claudio damian damien daniel daniele dariusz dave david deepak dejan denis dennis didier diego
  dieter dmitri dmitriy dmitry dominik donald dorota douglas dragan eduard eduardo elena eliana emil emily emma emre enrico enrique eric erik eugen eva evgeniy evgeny ewa fabian fabio fabrice fatih federico
  felipe felix fernando florian francesco francisco francois frank franz frederic friedrich gabriel gabriele gary gennady georg george gerd gerhard gilles giovanni giuseppe goran graciela gregory grzegorz
  guillaume gunter gustavo hamid hannah hans harald hasan hassan heinrich heinz helmut hendrik henrik henry herbert herve holger horst hugo huseyin ibrahim igor ilia ilya irina isabelle ismail ivan ivica
  jacek jack jacques jakub james jan janusz jaroslav jason javier jean jeffrey jennifer jens jerome jeroen jerzy jesus jim jiri joachim joanna jochen joe johan johann johannes john jonas jonathan jorge jose
  josef joseph joshua juan juha jukka julia julien jurgen jurgita kai kamil karim karl karol katarzyna kemal kenneth kevin khaled kirill klaus konstantin krzysztof kurt lars laura laurent leon leonid
  leszek luca lucas lucie ludovic luigi luis lukas lukasz magdalena magnus mahmoud maksim manfred manuel marc marcel marcelo marcin marco marcus marek maria marian mario mariusz mark marko markus marta
  martin mateusz mathieu matt matthew matthias matti max maxim maxime mehdi mehmet michael michal michel michelle miguel mika mikael mike mikhail milan milos miroslav mirta mohamed mohammad mohammed monika
  muhammad murat mustafa natalia nataliya nathalie nenad nick nicolas nikita nikola nikolai nikolay niels nils norbert olga oleg oleksandr oliver olivier omar omer onur oscar osman otto pablo paolo pascal
  patricia patrick patrik paul pavel pawel pedro pekka peter petr petra philipp philippe pierre pieter piotr przemyslaw radek rafael rafal rahul rainer ralf ralph ramon raul raymond reinhard rene reza ricardo
  richard robert roberto rodrigo roger roland romain ronald ruben rudolf ruslan ryan ryszard sabine samuel sander sandro sanjay sara sarah sascha scott sebastian sebastien serge sergei sergey sergio sergiy
  serkan simon slawomir sofia sophie stanislav stanislaw stefan stefano steffen stephan steve steven sunil suresh susanne svetlana sven szymon tadeusz tarek tatiana thiago thierry thomas thorsten timo
  timothy timur tobias tom tomas tomasz tony torsten tuomas tyler ulrich uwe vaclav vadim valentin valery vanessa vasily vicente victor vijay viktor ville vincent vitaliy vitaly vladimir vladislav volker
  volodymyr wojciech wolfgang walter werner wieslaw wilhelm william wouter yaroslav youssef yulia yuri yury yusuf yves zbigniew zdenek zoran`.split(/\s+/).filter(Boolean);
const GIVEN = new RegExp(`(?<![\\p{L}])(?<!(?:san|santa|sao|são|st|saint|sankt|fort|port|mount|mt|lake|cape)\\.?\\s)(${GIVEN_NAMES.join('|')})\\s+[\\p{L}][\\p{L}'’-]+`, 'iu');
// Countries and regions: "MTN Sudan", "Air Canada" and "SiteHost New Zealand" aren't people. Country names
// that are also given names (Jordan, Georgia, India ...) don't count.
const PLACES = new Set(['north', 'south', 'east', 'west', 'central', 'africa', 'asia', 'europe', 'america', 'americas', 'pacific', 'atlantic', 'caribbean', 'nordic', 'baltic', 'arab', 'gulf', 'latam',
  'emea', 'apac', 'brasil', 'hongkong', 'korea', 'california', 'oklahoma', 'florida', 'massachusetts', 'texas', 'ohio', 'michigan', 'oregon', 'arizona', 'colorado',
  'alabama', 'alaska', 'arkansas', 'connecticut', 'delaware', 'hawaii', 'idaho', 'illinois', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maryland', 'minnesota', 'mississippi',
  'missouri', 'nebraska', 'utah', 'vermont', 'wisconsin', 'wyoming', 'tennessee']);
const PLACE_PHRASES = [];
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  let n; try { n = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(String.fromCharCode(a, b)); } catch { n = null; }
  if (!n) continue;
  if (/\s/.test(n)) PLACE_PHRASES.push(n.toLowerCase()); else PLACES.add(n.toLowerCase());
}
for (const given of ['jordan', 'chad', 'georgia', 'india', 'israel', 'china', 'kenya', 'france', 'niger', 'mali', 'peru', 'cuba', 'guinea', 'samoa', 'tonga']) PLACES.delete(given);

const strongOrg = s => LEGAL.test(s) || INSTITUTION.test(s) || INSTITUTION_PART.test(s) || /^the\s/i.test(s);
const looksOrg = s => strongOrg(s) || BUSINESS.test(s) || BUSINESS_STEM.test(s) || BUSINESS_PART.test(s);
// Returns null to keep the entry, or why it is left out.
function leftOut(holder) {
  if (!holder) return 'no holder name';
  for (const [re, why] of PERSON) if (re.test(holder)) return why;
  if (PARTNERSHIP.test(holder) && !LEGAL.test(holder)) return 'partnership of named people';
  for (const [re, owner, why] of PERSON_IF) { const m = re.exec(holder); if (m && !looksOrg(owner(holder, m))) return why; }
  if (GIVEN.test(holder) && !strongOrg(holder)) return "a person's name";
  if (looksOrg(holder)) return null;
  const words = holder.replace(/[.,;]+$/, '').split(/[\s,;]+/).filter(Boolean);
  // One word ("Panix"), or one word twice ("TeleYemen TeleYemen"), is a brand or an acronym, not a person's full name.
  if (new Set(words.map(w => w.toLowerCase())).size === 1) return null;
  if (/[\d&+@/]|\.(com|net|org|io)\b/i.test(holder)) return null;
  // an address ("KuanggongLu, Pingdingshan, Henan"), or spelled-out initials ("C I C E S E")
  if ((holder.match(/,/g) || []).length >= 2 || words.every(w => w.replace(/\./g, '').length <= 2)) return null;
  const lower = holder.toLowerCase();
  if (words.some(w => PLACES.has(w.toLowerCase())) || PLACE_PHRASES.some(p => lower.includes(p))) return null;
  // Two to six plain words with no sign of an organization ("Kai Rottleb", "Sergio Bejarano Romero"): could be a person.
  if (words.length <= 6 && words.every(w => /^\p{L}[\p{L}'’.-]*$/u.test(w))) return "might be a person's name";
  return null;
}

const ranked = [...space].map(([asn, iv]) => ({ asn, addresses: addresses(iv) })).sort((a, b) => b.addresses - a.addresses || a.asn - b.asn);
const kept = [], excluded = new Map(), shown = [], keptShown = [];
let unnamed = 0;
for (const r of ranked) {
  if (kept.length >= TOP) break;
  const n = names.get(r.asn);
  const why = n ? leftOut(n.holder) : 'not in the AS names list';
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
