// Whether a network's registered holder may be a private person (GDPR caution). Many networks are registered
// to a person, and their holder name is that person's name. Shared by tools/build_asn_sitemap.mjs, which leaves
// such networks out of the ASN sitemap, and src/worker.js, whose pages for them are "noindex, follow". Plain
// JavaScript with no imports: the Worker has no build step, and the tool runs it in Node.
//
// A name may be a person's when, checked in this order:
//   1. there is no name;
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
// When in doubt it says person: "Paul Bunyan Communications" or "Independence Blue Cross" (both businesses)
// look like people, so they go too.
//
// Cost: a few microseconds per name, after about 3 ms the first time in a Worker isolate and 2 ms the second (V8
// compiling the regular expressions, then compiling them again to run fast). At startup it only builds the word sets.

// The holder's name from an AS name as RIPE NCC's asn.txt (without its ", CC") and RIPEstat's as-overview give
// it: "<HANDLE> - <Name>" (ARIN, LACNIC, AFRINIC), "<HANDLE> <Name>" (RIPE, APNIC), or the name alone.
export function holderOf(asName) {
  const body = String(asName || '').trim(), dash = body.indexOf(' - ');
  // A body of one word ("Polismyndigheten") is the name itself; "-" alone is no name.
  const holder = dash > 0 && !/\s/.test(body.slice(0, dash)) ? body.slice(dash + 3)
    : body.includes(' ') ? body.slice(body.indexOf(' ') + 1) : body.replace(/^-$/, '');
  // RIPE lines have no " - ": the first word is usually the handle (SERGIOB, PISKOT-AS), but some lines have
  // none ("University of Innsbruck"), so a first word that doesn't look like a handle is part of the name.
  const first = body.split(' ')[0];
  const handle = dash > 0 || /[-_\d]/.test(first) || (first.length > 1 && first === first.toUpperCase());
  return (handle ? holder : body).trim();
}

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
// The lists below are whole words or word beginnings, matched case-insensitively against the runs of letters in
// a name; a few entries use regular-expression syntax (l\.?l\.?c, labs?, compa[nñ]). Plain entries are looked up
// directly and the others share one small regular expression: a regular expression of hundreds of alternatives
// takes V8 milliseconds to compile, twice (to run, then to run fast), in every new Worker isolate.
const runsOf = s => (s.match(/\p{L}+/gu) || []).map(w => w.toLowerCase());
function wordList(list, whole) {
  const plain = list.filter(w => /^\p{L}+$/u.test(w)), set = new Set(plain), rest = list.filter(w => !set.has(w));
  const re = rest.length ? new RegExp('(^|[^\\p{L}])(' + rest.join('|') + ')' + (whole ? '(?![\\p{L}])' : ''), 'iu') : null;
  return { test: s => runsOf(s).some(w => (whole ? set.has(w) : plain.some(p => w.startsWith(p)))) || (re !== null && re.test(s)) };
}
const words = list => wordList(list, true);    // whole words
const stems = list => wordList(list, false);   // word beginnings
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
const GIVEN = new Set(GIVEN_NAMES);
const PLACE_BEFORE = /(?:san|santa|sao|são|st|saint|sankt|fort|port|mount|mt|lake|cape)\.?\s$/iu;
function givenName(s) {   // a given name, then another word of two letters or more
  for (const m of s.matchAll(/\p{L}+/gu)) {
    if (GIVEN.has(m[0].toLowerCase()) && /^\s+\p{L}[\p{L}'’-]/u.test(s.slice(m.index + m[0].length)) && !PLACE_BEFORE.test(s.slice(0, m.index))) return true;
  }
  return false;
}
// Countries and regions: "MTN Sudan", "Air Canada" and "SiteHost New Zealand" aren't people. The country names
// are the English ones from ICU 78 (what Intl.DisplayNames gave in Node 24), written out so that Node and the
// Worker agree and the Worker doesn't load ICU's region names; country names that are also given names (Jordan,
// Chad, Georgia, India, Israel, China, Kenya, France, Niger, Mali, Peru, Cuba, Guinea, Samoa, Tonga) are left out.
const PLACES = new Set(`north south east west central africa asia europe america americas pacific atlantic caribbean nordic baltic arab gulf
  latam emea apac brasil hongkong korea california oklahoma florida massachusetts texas ohio michigan oregon arizona colorado alabama
  alaska arkansas connecticut delaware hawaii idaho illinois iowa kansas kentucky louisiana maryland minnesota mississippi missouri
  nebraska utah vermont wisconsin wyoming tennessee
  afghanistan albania algeria andorra angola anguilla antarctica argentina armenia aruba australia austria azerbaijan
  bahamas bahrain bangladesh barbados belarus belgium belize benin bermuda bhutan bolivia botswana brazil brunei
  bulgaria burundi cambodia cameroon canada chile colombia comoros croatia curaçao cyprus czechia denmark djibouti
  dominica ecuador egypt eritrea estonia eswatini ethiopia eurozone fiji finland gabon gambia germany ghana gibraltar
  greece greenland grenada guadeloupe guam guatemala guernsey guinea-bissau guyana haiti honduras hungary iceland
  indonesia iran iraq ireland italy jamaica japan jersey kazakhstan kiribati kosovo kuwait kyrgyzstan laos latvia
  lebanon lesotho liberia libya liechtenstein lithuania luxembourg madagascar malawi malaysia maldives malta martinique
  mauritania mauritius mayotte mexico micronesia moldova monaco mongolia montenegro montserrat morocco mozambique
  namibia nauru nepal netherlands nicaragua nigeria niue norway oman pakistan palau panama paraguay philippines poland
  portugal qatar romania russia rwanda réunion sark senegal serbia seychelles singapore slovakia slovenia somalia spain
  sudan suriname sweden switzerland syria taiwan tajikistan tanzania thailand timor-leste togo tokelau tunisia
  turkmenistan tuvalu türkiye uganda ukraine uruguay uzbekistan vanuatu venezuela vietnam yemen zambia zimbabwe`.split(/\s+/));
const PLACE_PHRASES = `american samoa|antigua & barbuda|ascension island|bosnia & herzegovina|bouvet island|british indian ocean territory|
  british virgin islands|burkina faso|canary islands|cape verde|caribbean netherlands|cayman islands|
  central african republic|ceuta & melilla|christmas island|clipperton island|cocos (keeling) islands|
  congo - brazzaville|congo - kinshasa|cook islands|costa rica|côte d’ivoire|diego garcia|dominican republic|el salvador|
  equatorial guinea|european union|falkland islands|faroe islands|french guiana|french polynesia|
  french southern territories|heard & mcdonald islands|hong kong sar china|isle of man|macao sar china|marshall islands|
  myanmar (burma)|new caledonia|new zealand|norfolk island|north korea|north macedonia|northern mariana islands|
  outlying oceania|palestinian territories|papua new guinea|pitcairn islands|puerto rico|san marino|saudi arabia|
  sierra leone|sint maarten|solomon islands|south africa|south georgia & south sandwich islands|south korea|south sudan|
  sri lanka|st. barthélemy|st. helena|st. kitts & nevis|st. lucia|st. martin|st. pierre & miquelon|
  st. vincent & grenadines|svalbard & jan mayen|são tomé & príncipe|trinidad & tobago|tristan da cunha|
  turks & caicos islands|u.s. outlying islands|u.s. virgin islands|united arab emirates|united kingdom|united nations|
  united states|vatican city|wallis & futuna|western sahara|åland islands`.split(/\|\s*/);

const strongOrg = s => LEGAL.test(s) || INSTITUTION.test(s) || INSTITUTION_PART.test(s) || /^the\s/i.test(s);
const looksOrg = s => strongOrg(s) || BUSINESS.test(s) || BUSINESS_STEM.test(s) || BUSINESS_PART.test(s);

// Null when the holder name looks like an organization's, or why it may be a private person's (the rules at
// the top). Give it the name, not the whole AS name: personReason(holderOf(asName)).
export function personReason(holder) {
  if (!holder) return 'no holder name';
  for (const [re, why] of PERSON) if (re.test(holder)) return why;
  if (PARTNERSHIP.test(holder) && !LEGAL.test(holder)) return 'partnership of named people';
  for (const [re, owner, why] of PERSON_IF) { const m = re.exec(holder); if (m && !looksOrg(owner(holder, m))) return why; }
  if (givenName(holder) && !strongOrg(holder)) return "a person's name";
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
