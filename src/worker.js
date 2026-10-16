// ipterm: Cloudflare Worker that serves the terminal page, the shareable IP and ASN pages, and the API.
//
// Routes (pages answer browsers with HTML and curl/scripts with JSON)
//   GET /                   the terminal, with your IP already in the page (curl/wget get it as plain text)
//   GET /ip                 your IP as plain text
//   GET /json               your IP details as JSON
//   GET /help               the command-line reference as plain text (browsers are sent to /api)
//   GET /asn, /org, /cc, /city, /tz, /colo   one value for your own address as plain text, from request.cf
//                           (no outside call); /hostname is the one that asks DNS (reverse lookup)
//   GET /<ip>               page for any IPv4/IPv6 address        (add ?format=json to force JSON)
//   GET /<ip>/<field>       one value for any public address as plain text: asn, org, cc, country, continent,
//                           hostname. IPinfo Lite only (never Core or proxycheck.io), so no budget is spent
//   GET /AS<number>         page for any autonomous system (ASN)  (add ?format=json to force JSON)
//   GET /api/lookup?ip=     IP details as JSON (no ip = yourself), used by the terminal
//   GET /api/asn?asn=       ASN details as JSON, used by the terminal
//   GET /whois/<ip|ASN|domain> registry record via RDAP: owner, address block and abuse contact for
//                           addresses and networks; registrar, dates, status and name servers for domains
//   GET /api/whois?q=       the same as JSON, used by the terminal
//   GET /dns/<name>[/TYPE]  DNS records for a domain (summary, or one record type) via Cloudflare's resolver
//   GET /api/dns?name=&type= the same as JSON, used by the terminal
//   GET /cidr/<ip>/<prefix> subnet calculator page (also /api/cidr?q=); pure calculation, no outside calls
//   GET /port/<n>           page explaining port n with a button to check it (browsers); command-line tools get
//                           the check itself. It only ever tests your own address (see "port check" below)
//   GET /api/port?n=        the check as JSON, used by the terminal (same-origin or command-line clients only)
//   GET /whois, /dns, /cidr, /leaktest, /port, /api  landing page for each tool (usage and examples); /api is
//                           the API docs, and command-line clients get the /help text there instead
//   GET /api/check          your own IP plus how IPinfo classifies it (VPN, hosting...), for the privacy check
//   GET /robots.txt, /sitemap.xml
//   ?format=text            on /, /json, /<ip>, /AS<number>, /dns/..., /whois/..., /cidr/... and their /api/
//                           forms: the same answer as aligned key/value lines (like the terminal) instead of JSON
//   /openapi.json, /llms.txt  static files describing the API (served without running the Worker)
//   anything else: a static file if one exists, a domain-shaped path (/example.com) redirects to its
//   DNS page, and the rest gets a 404 page in the terminal's style
//   Plain-text answers never carry a sponsored line, and those with IPinfo data credit IPinfo.
//
// Data
//   Your own details: Cloudflare's request.cf (free, unlimited).
//   Other IPs: IPinfo. Set the IPINFO_TOKEN secret to use IPinfo Lite (free, unlimited,
//   country + ASN). Without a token it falls back to IPinfo's public endpoint
//   (city-level, ~1,000 requests/day, shared rate limit).
//   ASNs: RIPEstat (free, public, no key).
//   Registry records (whois): RDAP from the regional internet registries (addresses, networks) and the
//   domain registries and registrars (domains), all found via IANA's bootstrap files.
//   Reverse DNS: Cloudflare DNS-over-HTTPS.
//
// Hardening
//   - Upstream lookups are cached; cache misses are rate limited per visitor IP (LOOKUP_LIMITER).
//   - Cross-site browser access (CORS) is off unless PUBLIC_API = "true".
//   - Private and other non-public addresses never reach a provider.
//   - Every value placed into HTML is escaped; embedded JSON cannot close its script tag.
//   - Every response carries a strict Content-Security-Policy and related headers.

import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import '../public/cidr.js';                       // shared subnet calculator (also served to the page)
import '../public/ports.js';                      // what common ports are for (also served to the page)
const CIDR = globalThis.IPTERM_CIDR;
const PORTS = globalThis.IPTERM_PORTS;

const CLI_UA = /^(curl|wget|httpie|xh|fetch|libfetch|aria2)\b|powershell/i;
// Link-preview fetchers for chat apps and social sites. Many send "Accept: */*", so without this a
// shared link would preview as JSON. Named bots only: anything else without text/html still gets JSON.
const PREVIEW_UA = /facebookexternalhit|WhatsApp|Slackbot|Discordbot|TelegramBot|Twitterbot|LinkedInBot|Applebot|redditbot|Mastodon\/|Bluesky|Cardyb|Embedly|Iframely/i;
const ASN_RE = /^as(\d{1,10})$/i;

class RateLimited extends Error {}

export default {
  async fetch(request, env, ctx) {
    return secure(await route(request, env, ctx), env);
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const me = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';
  let path;
  try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; } catch { path = url.pathname; }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.method === 'OPTIONS' && publicApi(env)) return new Response(null, { status: 204 });
    return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, HEAD' });
  }

  const html = wantsHtml(request, url, ua);
  // plain: ?format=text, the same data as aligned key/value lines instead of JSON
  const io = { request, env, ctx, url, me, plain: url.searchParams.get('format') === 'text' };

  const self = () => guard(() => selfInfo(io), d => reply(io, d, 200, {}, ipText), (msg, status) => reply(io, { error: msg }, status));
  if (path === '/' && io.plain) return self();
  if (path === '/') return CLI_UA.test(ua) ? text(me + '\n') : homePage(io);
  if (path === '/ip') return text(me + '\n');
  if (path === '/help') return html ? redirect('/api') : helpText(io);
  if (Object.hasOwn(SELF_FIELDS, path.slice(1).toLowerCase())) return selfField(io, path.slice(1).toLowerCase());
  if (path === '/robots.txt') return robots(url);
  if (path === '/sitemap.xml') return sitemap(url);

  if (path === '/json' || (path === '/api/lookup' && !url.searchParams.get('ip'))) return self();
  if (path === '/api/lookup') return ipRoute(io, url.searchParams.get('ip').trim(), false);
  if (path === '/api/check') return guard(() => checkData(io), d => json(d));
  if (path === '/api/asn') return asnRoute(io, String(url.searchParams.get('asn') || '').trim(), false);
  if (Object.hasOwn(TOOLS, path.slice(1).toLowerCase())) return toolRoute(io, path.slice(1).toLowerCase(), html);
  if (path === '/api/port') return portRoute(io, url.searchParams.get('n'), false);
  if (path.startsWith('/port/')) return portRoute(io, path.slice(6), html);
  if (path === '/api/whois') return whoisRoute(io, String(url.searchParams.get('q') || '').trim(), false);
  if (path.startsWith('/whois/')) return whoisRoute(io, path.slice(7), html);
  if (path === '/api/cidr') return cidrRoute(io, url.searchParams.get('q'), false);
  if (path.startsWith('/cidr/')) return cidrRoute(io, path.slice(6), html);
  if (path === '/api/dns') return dnsRoute(io, url.searchParams.get('name'), url.searchParams.get('type'), false);
  if (path.startsWith('/dns/')) { const [n, t] = path.slice(5).split('/'); return dnsRoute(io, n, t, html); }

  const bare = path.slice(1);
  if (bare && parseIp(bare)) return ipRoute(io, bare, html);
  if (ASN_RE.test(bare)) return asnRoute(io, bare, html);
  const field = /^([0-9a-f.:]{2,45})\/([a-z]{1,20})$/i.exec(bare);   // /8.8.8.8/asn
  if (field && parseIp(field[1])) return ipField(io, field[1], field[2].toLowerCase());
  if (path.startsWith('/api/')) return reply(io, { error: 'Unknown API route. Available: /api/lookup, /api/asn, /api/whois, /api/dns, /api/cidr, /api/port. See /help.' }, 404);

  const res = await env.ASSETS.fetch(request);
  if (res.status !== 404) return withOrigin(res, url);
  // Someone typed a domain straight after the slash (ipterm.net/github.com): send them to its DNS page.
  const dom = !bare.includes('/') && !FILE_EXT.test(bare) ? normalizeDomain(bare) : null;
  if (dom) return redirect('/dns/' + dom);
  if (!html) return reply(io, { error: 'Not found. See /help for what curl and scripts can ask for.' }, 404);
  return notFoundPage(io, path);
}

// Paths that look like files, not domains (scanners probe for these constantly).
const FILE_EXT = /\.(html?|php\d?|aspx?|jsp|cgi|pl|py|sh|js|mjs|css|map|json|xml|txt|md|ya?ml|ini|env|conf|cfg|bak|old|sql|db|log|zip|gz|tgz|rar|7z|tar|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|pdf|mp[34]|webm|mov|wav)$/i;

/* ---------- tool landing pages and 404 ---------- */

const TOOLS = {
  whois: {
    title: 'Whois lookup: who owns a domain, IP address or network | ipterm', heading: 'Whois lookup',
    desc: 'Free whois lookup for domains, IP addresses and networks (ASNs). See the registrar, registration and expiry dates, name servers, the owning organization and the abuse contact, straight from the registries over RDAP.',
    usage: 'whois <ip, ASN or domain>',
    examples: [['whois example.com', '/whois/example.com'], ['whois github.com', '/whois/github.com'], ['whois 8.8.8.8', '/whois/8.8.8.8'], ['whois AS13335', '/whois/AS13335']],
  },
  dns: {
    title: 'DNS lookup: A, AAAA, MX, NS, TXT and CAA records | ipterm', heading: 'DNS lookup',
    desc: "Free DNS lookup for any domain: addresses (A and AAAA), mail servers (MX), name servers, TXT and CAA records, who hosts the site and whether DNSSEC validates. Enter an IP address for reverse DNS. Answers come from Cloudflare's public resolver.",
    usage: 'dig <domain> [type]',
    examples: [['dig example.com', '/dns/example.com'], ['dig gmail.com MX', '/dns/gmail.com/MX'], ['dig github.com TXT', '/dns/github.com/TXT'], ['dig 8.8.8.8', '/dns/8.8.8.8']],
  },
  leaktest: {
    title: 'VPN leak test: WebRTC, IPv6 and time zone check | ipterm', heading: 'VPN and privacy leak test',
    desc: "Check whether your browser gives away more than your IP address: WebRTC leaks, IPv6 leaks that bypass a VPN, a device time zone that doesn't match your IP's location, and whether your IP is recognized as a VPN. Runs in your browser in a few seconds; nothing is stored.",
    usage: 'leaktest',
    checks: ['WebRTC: does your browser reveal a public IP other than the one websites see?',
      'IPv6: does your IPv6 traffic go through a different network than your VPN?',
      "Time zone: does your device's clock match your IP's location?",
      'VPN detection: is your IP recognized as a VPN, proxy, Tor or data center?'],
    examples: [],
  },
  cidr: {
    title: 'Subnet calculator: CIDR, netmask and usable host range | ipterm', heading: 'Subnet calculator',
    desc: 'Free IPv4 and IPv6 subnet calculator. Enter a range like 10.0.0.0/22 or an address with a netmask to get the network and broadcast addresses, netmask, wildcard mask, usable host range and host count.',
    usage: 'cidr <range>',
    examples: [['cidr 192.168.1.0/24', '/cidr/192.168.1.0/24'], ['cidr 10.0.0.0/22', '/cidr/10.0.0.0/22'], ['cidr 172.16.0.0/12', '/cidr/172.16.0.0/12'], ['cidr 2001:db8::/48', '/cidr/2001:db8::/48']],
  },
  port: {
    title: 'Port checker: is a port open on my IP? | ipterm', heading: 'Port checker',
    desc: 'Free open port checker: see whether a TCP port is open on your own IP address, for port forwarding, game servers, Plex, SSH or Remote Desktop. ipterm connects to the address you visit from, one port at a time, and explains why a port may be closed.',
    usage: 'port <number>',
    examples: [['port 25565', '/port/25565'], ['port 32400', '/port/32400'], ['port 22', '/port/22'], ['port 3389', '/port/3389']],
  },
  api: {
    title: 'ipterm API: IP address lookups from curl and scripts | ipterm', heading: 'API and command line',
    desc: 'Use ipterm from curl and scripts, with no key and no sign-up: your IP as plain text, one value at a time (/asn, /city, /tz), and any IP address, network, DNS name, registry record or subnet as JSON or aligned text.',
    usage: 'curl ipterm.net/help',
    examples: [],
  },
};

function toolRoute(io, tool, html) {
  const t = TOOLS[tool];
  if (!html) {
    if (tool === 'api') return helpText(io);              // command-line clients get the reference itself
    if (!t.examples.length) return reply(io, { error: 'This check runs in your browser. Open the page in a browser to run it.', usage: t.usage }, 400);
    return reply(io, { error: `${tool === 'port' ? 'Add a port number' : 'Add something to look up'}, like ${t.examples[0][1]}`, usage: t.usage, examples: t.examples.map(e => e[1]) }, 400);
  }
  const list = t.examples.map(([c, href]) => `<li><a href="${esc(href)}">${esc(c)}</a></li>`).join('');
  const extra = (list ? `<p class="ln sys">Examples:</p><ul class="static-list">${list}</ul>` : '') +
    (t.checks ? `<p class="ln sys">What it checks:</p><ul class="static-list">${t.checks.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : '') +
    (tool === 'cidr' ? `<p class="ln sys">Guide: <a href="/guides/subnet-cheat-sheet">Subnet mask cheat sheet</a></p>` : '') +
    (tool === 'port' ? `<p class="ln sys">It only ever tests the address you connect from, so it can't be pointed at anyone else's.</p>${portIndex()}` : '') +
    // The full reference for visitors without JavaScript and for crawlers; the terminal prints its own (`api`).
    (tool === 'api' ? `<pre class="doc-pre api-ref"><code>${esc(helpBody(io.url.host))}</code></pre>` +
      `<p class="ln sys">Machine-readable: <a href="/openapi.json">OpenAPI description</a> · <a href="/llms.txt">llms.txt</a> · plain text: <code>curl ${esc(io.url.host)}/help</code></p>` +
      `<p class="ln sys">IP address data powered by <a href="https://ipinfo.io" rel="noopener">IPinfo</a>.</p>` : '');
  return shell(io, { status: 200, path: '/' + tool, title: t.title, desc: t.desc, initial: { kind: 'tool', tool },
    body: staticBlock(t.heading, [tool], [['usage', t.usage]], t.desc, extra) });
}

// What the visitor probably meant, from the first part of the path.
function suggestFor(path) {
  const seg = path.split('/').filter(Boolean);
  const first = seg[0] || '';
  const p = parseIp(first);
  if (p) { const ip = canonIp(p); return { cmd: 'lookup ' + ip, href: '/' + ip }; }
  if (ASN_RE.test(first)) return { cmd: 'asn ' + first.toUpperCase(), href: '/' + first.toUpperCase() };
  const dom = !FILE_EXT.test(first) && normalizeDomain(first);
  if (dom) return { cmd: 'lookup ' + dom, href: '/dns/' + dom };
  if (/^guides?$/i.test(first)) return { cmd: null, href: '/guides', label: 'all guides' };
  return null;
}

function notFoundPage(io, path) {
  const shown = path.length > 80 ? path.slice(0, 80) + '…' : path;
  const sug = suggestFor(path);
  const links = (sug ? `<p class="ln sys">Did you mean <a href="${esc(sug.href)}">${esc(sug.cmd || sug.label)}</a>?</p>` : '') +
    `<p class="ln sys">Go to <a href="/">the terminal</a> to see your IP address, or browse <a href="/guides">the guides</a>.</p>`;
  return shell(io, { status: 404, path: shown, title: 'Page not found | ipterm', initial: { kind: 'notfound', path: shown, suggest: sug },
    body: staticBlock('Page not found', ['404'], [], `There is no page at ${shown}.`, links) });
}

// Static pages carry %ORIGIN% placeholders in canonical links, share tags and structured data.
async function withOrigin(res, url) {
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const t = await res.text();
  if (!t.includes('%ORIGIN%')) return new Response(t, res);
  return new Response(t.replaceAll('%ORIGIN%', () => url.origin), res);
}

function wantsHtml(request, url, ua) {
  if (/^(json|text)$/.test(url.searchParams.get('format') || '') || CLI_UA.test(ua)) return false;
  return PREVIEW_UA.test(ua) || (request.headers.get('accept') || '').includes('text/html');
}

/* ---------- routes ---------- */

// One spelling per address (IPv6 in RFC 5952 short form), so every way of writing an address shares
// one cache entry and one upstream lookup.
function canonIp(p) { return p.v === 4 ? p.o.join('.') : CIDR.calc(p.g.map(x => x.toString(16)).join(':')).network; }
const sameIp = (a, b) => { const x = parseIp(String(a || '').trim()), y = parseIp(String(b || '').trim()); return !!x && !!y && canonIp(x) === canonIp(y); };

async function ipRoute(io, q, html) {
  const p = parseIp(String(q || '').trim());
  if (!p) return reply(io, { error: 'Not a valid IPv4 or IPv6 address.' }, 400);
  const ip = canonIp(p);
  if (sameIp(q, io.me) && !html) return guard(() => selfInfo(io), d => reply(io, d, 200, {}, ipText), (msg, status) => reply(io, { error: msg }, status));

  const reason = nonPublicReason(p);
  if (reason) {
    const d = { ip, version: p.v, bogon: true, range: reason };
    return html ? ipPage(io, d, 200) : reply(io, { error: `${ip} is not a public address (${reason}), so there is nothing to look up.`, ...d }, 400);
  }
  return guard(
    () => withPrivacy(io, ip, ipData(io, ip, p)),
    // Browsers may reuse an answer for 5 minutes; the Worker's own cache (6 hours) keeps repeats cheap.
    d => html ? ipPage(io, d, 200) : reply(io, d, 200, { 'cache-control': 'public, max-age=300' }, ipText),
    (msg, status) => html ? ipPage(io, { ip, version: p.v, error: msg }, status) : reply(io, { error: msg }, status),
  );
}

function cidrRoute(io, q, html) {
  const d = CIDR.calc(String(q || '').replace(/-(\d{1,3})$/, '/$1'));   // also accept 10.0.0.0-22
  if (d.error) return html ? cidrPage(io, { error: d.error, input: q }, 400) : reply(io, { error: d.error }, 400);
  return html ? cidrPage(io, d, 200) : reply(io, d, 200, { 'cache-control': 'public, max-age=86400' }, cidrText);
}

// Adds proxycheck.io's VPN / proxy opinion, unless IPinfo already flagged the address (then a
// second query adds little, and the free allowance is better spent on unflagged ones).
async function withPrivacy(io, ip, pending) {
  const d = await pending;
  if (!d || d.bogon || (d.flags && d.flags.anonymous)) return d;
  const privacy = await privacyData(io, ip);
  return privacy ? { ...d, privacy } : d;
}

function ipData(io, ip, p, opts = {}) {
  // The plan is part of the cache key, so switching IPinfo plans takes effect at once instead of
  // serving older (e.g. country-only) answers until they expire. opts.lite: never use Core.
  const core = !opts.lite && io.env.IPINFO_TOKEN && String(io.env.IPINFO_PLAN || '').toLowerCase() === 'core';
  const plan = io.env.IPINFO_TOKEN ? (core ? 'core' : 'lite') : 'public';
  return cached(io, `ip/${plan}/${ip}`, 21600, async () => {
    const [geo, hostname] = await Promise.all([provider(ip, io.env, { core, who: visitorKey(io.me) }), ptr(ip)]);
    const d = { ip, version: p.v, ...geo, hostname: hostname || geo.hostname || null };
    if (core && geo.source !== 'ipinfo-core') d._ttl = geo._visitorCap ? 60 : 600;   // Lite fallbacks are kept briefly
    delete d._visitorCap;
    return d;
  });
}

async function dnsRoute(io, rawName, rawType, html) {
  const type = rawType ? String(rawType).toUpperCase().slice(0, 12) : null;
  const bad = error => html ? dnsPage(io, { name: clip(rawName), types: type ? [type] : [], error }, 400) : reply(io, { error }, 400);
  if (type && !DNS_TYPES[type]) return bad(`Unsupported record type "${type}". Try one of: ${Object.keys(DNS_TYPES).join(', ')}`);
  const p = parseIp(String(rawName || '').trim());
  if (p) {                                                  // an IP address: reverse lookup (PTR)
    if (type && type !== 'PTR') return bad('For an IP address, only PTR (reverse DNS) applies.');
    const ip = canonIp(p);
    return guard(() => cached(io, 'dns/ptr/' + ip, 300, () => dnsData(io, reverseName(p), ['PTR'], ip)),
      d => html ? dnsPage(io, d, 200) : reply(io, d, 200, { 'cache-control': 'public, max-age=300' }, dnsText),
      (msg, status) => reply(io, { error: msg }, status));
  }
  const name = normalizeDomain(rawName);
  if (!name) return bad('Not a valid domain name. Example: example.com');
  const types = type ? [type] : SUMMARY_TYPES;
  return guard(
    () => cached(io, `dns/${name}/${types.join(',')}`, 300, () => dnsData(io, name, types)),
    // A nonexistent domain is a valid DNS answer: JSON says so with 200; the HTML page uses 404 so it isn't indexed.
    d => html ? dnsPage(io, d, d.status === 'NXDOMAIN' ? 404 : 200) : reply(io, d, 200, { 'cache-control': 'public, max-age=300' }, dnsText),
    (msg, status) => html ? dnsPage(io, { name, types, error: msg }, status) : reply(io, { error: msg }, status),
  );
}

const clip = s => String(s || '').slice(0, 100);
async function whoisRoute(io, q, html) {
  const asnM = ASN_RE.exec(q);
  const p = asnM ? null : parseIp(q);
  if (!asnM && !p) {
    const name = normalizeDomain(q);
    if (!name) {
      const error = 'Not a valid IP address, AS number or domain. Examples: whois 8.8.8.8, whois AS13335, whois example.com';
      return html ? whoisPage(io, { query: clip(q), kind: 'domain', error }, 400) : reply(io, { error }, 400);
    }
    return guard(
      () => cached(io, 'whois/' + name, 21600, () => domainLookup(name, io.url.origin)),
      d => html ? whoisPage(io, d, d.found ? 200 : 404) : reply(io, d, d.found ? 200 : 404, { 'cache-control': 'public, max-age=300' }, whoisText),
      (msg, status) => html ? whoisPage(io, { query: name, kind: 'domain', error: msg }, status) : reply(io, { error: msg }, status),
    );
  }
  if (asnM && (Number(asnM[1]) < 1 || Number(asnM[1]) > 4294967295)) {
    return html ? whoisPage(io, { query: clip(q), kind: 'asn', error: 'Not a valid AS number.' }, 400) : reply(io, { error: 'Not a valid AS number.' }, 400);
  }
  const query = asnM ? 'AS' + Number(asnM[1]) : canonIp(p);
  if (p) {
    const reason = nonPublicReason(p);
    if (reason) {
      const d = { query, kind: 'ip', found: false, bogon: true, range: reason };
      return html ? whoisPage(io, d, 200) : reply(io, { error: `${query} is not a public address (${reason}), so no registry holds a record for it.`, ...d }, 400);
    }
  }
  return guard(
    () => cached(io, 'whois/' + query, 86400, () => rdapLookup(asnM ? { asn: Number(asnM[1]) } : { ip: query, p }, io.url.origin)),
    d => html ? whoisPage(io, d, d.found ? 200 : 404) : reply(io, d, d.found ? 200 : 404, { 'cache-control': 'public, max-age=300' }, whoisText),
    (msg, status) => html ? whoisPage(io, { query, kind: asnM ? 'asn' : 'ip', error: msg }, status) : reply(io, { error: msg }, status),
  );
}

async function asnRoute(io, q, html) {
  const m = ASN_RE.exec(q) || /^(\d{1,10})$/.exec(q);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 4294967295) {
    const error = 'Not a valid AS number. Example: AS13335';
    return html ? asnPage(io, { asn: clip(q), error }, 400) : reply(io, { error }, 400);
  }
  return guard(
    () => cached(io, 'asn/' + n, 21600, () => asnData(n)),
    d => html ? asnPage(io, d, d.found ? 200 : 404) : reply(io, d, d.found ? 200 : 404, { 'cache-control': 'public, max-age=300' }, asnText),
    (msg, status) => html ? asnPage(io, { asn: 'AS' + n, number: n, error: msg }, status) : reply(io, { error: msg }, status),
  );
}

/* ---------- port check ----------
   "Is this port open on my IP?" The Worker opens a TCP connection to the address the request came from
   (cf-connecting-ip, which Cloudflare sets itself) on the one port asked for, and reports whether it was
   accepted, refused or got no answer. It never tests any other address, sends nothing over the
   connection, closes it at once and keeps nothing. Guards:
   - only the ipterm page itself (a same-origin request) or a command-line tool can start a check, so
     other sites can't make visitors' browsers start one and crawlers never do;
   - the /port/<n> pages explain the port and offer a button; nothing is tested on page load;
   - PORT_LIMITER allows 10 checks a minute per address (per /64 for IPv6).
   What testing on Cloudflare showed (wrangler dev --remote):
   - IPv6 works, but only as a bracketed literal ("[2001:db8::1]"); a bare IPv6 literal is refused.
   - connect() refuses port 25 itself ("Connections to port 25 are prohibited").
   - Cloudflare's own addresses (WARP, 1.1.1.1) are refused at once, so they are recognized beforehand.
   - A port that is dropped (what most home routers do with anything not forwarded) never opens.
   - A visitor who reaches ipterm over IPv6 gets their IPv6 address tested, where a router's IPv4 port
     forward doesn't apply: the answer says so and points to `curl -4`, which tests IPv4. */
const PORT_TIMEOUT = 5000;
// Cloudflare's own networks (WARP, the 1.1.1.1 app, iCloud Private Relay's Cloudflare exits), which
// Workers can't connect to, and its published ranges in case the network number is missing.
const CLOUDFLARE_ASNS = new Set([13335, 209242]);
const CLOUDFLARE_RANGES = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13',
  '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
// Providers that usually share IPv4 addresses between customers (carrier-grade NAT), so no port forward
// can work. Mobile networks in general do; these are the common home-internet cases.
const CGNAT_ASNS = { 14593: 'Starlink', 21928: 'T-Mobile', 22394: 'Verizon Wireless', 6167: 'Verizon Wireless', 20057: 'AT&T Mobility' };

// Fetches from the page itself say so (Sec-Fetch-Site); older browsers send Origin on cross-site requests.
function sameOrigin(request, url) {
  const site = request.headers.get('sec-fetch-site');
  return site ? site === 'same-origin' : request.headers.get('origin') === url.origin;
}

async function portRoute(io, raw, html) {
  const n = PORTS.parse(raw);
  if (n == null) {
    const error = 'Not a port number. Ports run from 1 to 65535, and the check takes one at a time, like /port/22';
    return html ? portPage(io, { input: clip(raw), error }, 400) : reply(io, { error }, 400);
  }
  if (html) return portPage(io, { port: n }, 200);       // explains the port; only its button runs the check
  if (!sameOrigin(io.request, io.url) && !CLI_UA.test(io.request.headers.get('user-agent') || '')) {
    return reply(io, { error: `The port check runs from the ipterm terminal or a command-line tool such as curl: curl -4 ${io.url.host}/port/${n}`, port: n }, 403);
  }
  if (io.request.method !== 'GET') return reply(io, { error: 'Use GET to run a port check.' }, 405, { allow: 'GET' });
  try {
    return reply(io, await portCheck(io, n), 200, {}, portText);
  } catch (e) {
    if (e instanceof RateLimited) {
      const r = reply(io, { error: 'Too many port checks from your address (10 a minute). Wait a minute and try again.' }, 429);
      r.headers.set('retry-after', '60');
      return r;
    }
    console.error('[ipterm] port check failed:', String((e && e.message) || e));   // never the visitor's address
    return reply(io, { error: "The port check didn't finish. Try again in a moment." }, 502);
  }
}

async function portCheck(io, n) {
  const svc = PORTS.get(n), p = parseIp(io.me);
  const service = svc ? { name: svc.name, proto: svc.proto, use: svc.use, tips: svc.tips, risk: svc.risk } : null;
  const base = p ? { ip: canonIp(p), version: p.v, port: n, protocol: 'tcp', service } : { ip: null, version: null, port: n, protocol: 'tcp', service };
  const untested = (reason, summary, notes = []) => ({ ...base, state: 'untestable', reason, summary, notes });
  if (!p) return untested('no-address', "not tested: the request didn't say which address it came from.");
  const range = nonPublicReason(p), asn = Number((io.request.cf || {}).asn) || null;
  if (range && /carrier-grade/.test(range)) {
    return untested('cgnat', `not tested: ${base.ip} is in the carrier-grade NAT range (100.64.0.0/10). Your provider shares public addresses between many customers, so nothing on the internet can reach this one and no port forward can work. Ask your provider for a public IPv4 address, or use IPv6 or a tunnel such as Tailscale or Cloudflare Tunnel.`);
  }
  if (range) return untested('not-public', `not tested: ${base.ip} is not a public address (${range}), so nothing on the internet can reach it.`);
  if (n === 25) return untested('port-25', "not tested: Cloudflare, which runs ipterm, doesn't allow connections to port 25 (email), to stop spam. Most home internet providers block port 25 too.");
  if (CLOUDFLARE_ASNS.has(asn) || CLOUDFLARE_RANGES.some(r => inPrefix(p, r) >= 0)) {
    return untested('cloudflare', `not tested: ${base.ip} belongs to Cloudflare, so you are probably using Cloudflare WARP, the 1.1.1.1 app or iCloud Private Relay. ipterm runs on Cloudflare, which can't connect to its own addresses: turn the VPN or relay off and check again.`);
  }
  await portLimit(io);
  const r = await probePort(p.v === 6 ? `[${base.ip}]` : base.ip, n);
  if (r.state === 'untestable') return untested('refused', `not tested: Cloudflare, which runs ipterm, refused to connect to port ${n}.`);
  return { ...base, state: r.state, ms: r.ms, summary: portSummary(r.state, n, svc), notes: portNotes(io, base, r.state, svc, asn) };
}

async function portLimit(io) {
  if (!io.env.PORT_LIMITER) return;
  let ok = true;
  try { ok = (await io.env.PORT_LIMITER.limit({ key: limitKey(io.me) })).success; } catch { ok = true; }   // fail open, like LOOKUP_LIMITER
  if (!ok) throw new RateLimited();
}

// Open: the handshake completed. Closed: the address refused it (a reset). No answer: nothing came back
// in time, which is what a router does with a port it doesn't forward. Nothing is ever sent.
async function probePort(hostname, port) {
  const t0 = Date.now();
  let sock, timer;
  try { sock = connect({ hostname, port }); } catch { return { state: 'untestable' }; }   // refused before connecting
  sock.closed.catch(() => {});
  try {
    const state = await Promise.race([
      sock.opened.then(() => 'open', () => 'closed'),
      new Promise(res => { timer = setTimeout(() => res('no-answer'), PORT_TIMEOUT); }),
    ]);
    return { state, ms: state === 'no-answer' ? PORT_TIMEOUT : Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    try { sock.close().catch(() => {}); } catch {}
  }
}

function portSummary(state, n, svc) {
  const what = `TCP port ${n}` + (svc ? ` (${svc.name})` : '');
  if (state === 'open') return `open: your address accepted a connection on ${what}.`;
  if (state === 'closed') return `closed: your address refused the connection on ${what}. It got through, but nothing there accepted it: no program is listening on that port, or a firewall turned it away.`;
  return `no answer: nothing replied on ${what} within ${PORT_TIMEOUT / 1000} seconds. A router or firewall is dropping it, or the port isn't forwarded to any device.`;
}

// Shared by the terminal and the text answer, so both explain a result in the same words.
function portNotes(io, d, state, svc, asn) {
  const notes = [], n = d.port, v6 = d.version === 6;
  if (svc && svc.proto === 'udp') notes.push(`${svc.name} uses UDP, which this check can't test: the result is about TCP port ${n} only.`);
  else if (svc && svc.proto === 'tcp+udp') notes.push(`${svc.name} also uses UDP, which this check can't test.`);
  if (v6) {
    notes.push(`You reached ipterm over IPv6, so this tested your IPv6 address. A router's port forward only applies to IPv4; over IPv6 the router's firewall has to allow the port to the device instead. To test your IPv4 address, run: curl -4 ${io.url.host}/port/${n}`);
  }
  if (state === 'open') {
    notes.push(svc && svc.risk ? svc.risk : 'Anyone on the internet can reach this port, not just you: make sure whatever answers is meant to be public and has a strong password.');
    return notes;
  }
  notes.push(v6 ? `To open it: the program must be running and listening on port ${n}, the device's firewall must allow it, and the router's IPv6 firewall must let it through to the device.`
    : `To open it: the program must be running and listening on port ${n}, the device's firewall must allow it, and the router must forward TCP port ${n} to the device's local IP address (give the device a fixed local IP so the forward keeps working).`);
  if (svc && svc.tips) notes.push(`${svc.name}: ${svc.tips}`);
  if (!v6) {
    const isp = CGNAT_ASNS[asn];
    notes.push((isp ? `${isp} usually shares IPv4 addresses between customers (carrier-grade NAT), which would explain this. ` : '') +
      `If your router's internet (WAN) address isn't ${d.ip}, or is between 100.64.0.0 and 100.127.255.255, your provider uses carrier-grade NAT: the router has no public address of its own, so no port forward can reach it. Ask your provider for a public IPv4 address, or use IPv6 or a tunnel such as Tailscale or Cloudflare Tunnel.`);
  }
  return notes;
}

function portText(d) {
  const s = d.service;
  return kvText([
    ['port', `${d.port}/tcp` + (s ? `  ${s.name}` : '')],
    ['your address', d.ip ? `${d.ip} (IPv${d.version}, the address this request came from)` : null],
    ['result', d.summary], ['used for', s && s.use], ['notes', d.notes || []],
  ]);
}

// Links to every port with its own explainer: the /port landing page and the foot of each port page.
function portIndex(skip = null) {
  const items = PORTS.list().filter(n => n !== skip)
    .map(n => `<li><a href="/port/${n}">${n} ${esc(PORTS.get(n).name)}</a></li>`).join('');
  return `<p class="ln sys">Common ports:</p><ul class="static-list">${items}</ul>`;
}

// What a port is for and why it may be closed, plus how to check it. The check itself never runs here:
// the terminal offers a button, so crawlers and link previews never start one.
function portPage(io, d, status) {
  if (d.error) {
    return shell(io, { status, path: '/port/' + String(d.input || '').slice(0, 20), title: 'Port checker | ipterm',
      initial: { kind: 'port', query: String(d.input || ''), error: d.error }, body: staticBlock('Port checker', ['port'], [], d.error) });
  }
  const n = d.port, s = PORTS.get(n), path = '/port/' + n, host = io.url.host;
  const title = s ? `Port ${n} (${s.name}): check if it's open on your IP | ipterm` : `Port ${n}: check if it's open on your IP | ipterm`;
  const desc = s ? `${s.use} Check whether TCP port ${n} is open on your own IP address, and see why it may be closed.`
    : `Check whether TCP port ${n} is open on your own IP address: ipterm connects to the address you visit from and reports open, closed or no answer.`;
  const summary = (s ? s.use + ' ' : '') + `ipterm can check whether TCP port ${n} is open on your own IP address: it connects to the address you visit from, on this one port, and reports open, closed or no answer. Nothing is stored.` +
    (s && s.proto === 'udp' ? ` ${s.name} uses UDP, which the check can't test.` : '');
  const rows = s ? [['protocol', PORTS.protoText(s.proto)], ['why it may be closed', s.tips], ['caution', s.risk]] : [['protocol', 'TCP']];
  const p = t => `<p class="ln">${t}</p>`;
  const extra = `<p class="ln sys">Check it: type <code>port ${n}</code> in the terminal, or from a command line run <code>curl -4 ${esc(host)}/port/${n}</code>. It only tests the address you connect from, one port at a time.</p>` +
    `<p class="ln sys">For a port to be open, all of these must be true:</p>` +
    p(`1. A program is running and listening on port ${n} (on all addresses, not only 127.0.0.1).`) +
    p("2. The device's firewall allows the port.") +
    p(`3. The router forwards TCP port ${n} to the device's local IP address, which should be fixed (a DHCP reservation).`) +
    p("4. Your provider gives the router a public IPv4 address. If the router's internet (WAN) address isn't the one websites see, or is in 100.64.0.0/10 (100.64.x.x to 100.127.x.x), you are behind carrier-grade NAT and no port forward can work: ask for a public IP, or use IPv6 or a tunnel such as Tailscale or Cloudflare Tunnel.") +
    p(`5. Over IPv6 there is no port forwarding: the router's IPv6 firewall has to allow the port to the device. If your browser connects over IPv6, the check tests your IPv6 address; <code>curl -4</code> tests IPv4.`) +
    portIndex(n);
  return shell(io, { status, path, title, desc, noindex: !s, initial: { kind: 'port', query: n },
    body: staticBlock(s ? `Port ${n} · ${s.name}` : `Port ${n}`, ['port', s ? s.proto : 'tcp'], rows, summary, extra) });
}

/* ---------- the command line: plain text for curl ----------
   /help (and /api, for command-line clients) is the reference. One value for your own address comes
   straight from request.cf (only /hostname asks anybody: Cloudflare's resolver). One value for another
   address uses IPinfo Lite only, never Core or proxycheck.io, so these never touch the paid or daily
   budgets. ?format=text turns any lookup into aligned key/value lines, like the terminal. None of it
   carries a sponsored line. */

const IPINFO_CREDIT = 'IP address data powered by IPinfo (https://ipinfo.io)';
// /asn, /cc ... for your own address (/cc, not /country: that path is kept free for country pages)
const SELF_FIELDS = { asn: 'asn', org: 'org', cc: 'countryCode', city: 'city', tz: 'timezone', colo: 'colo', hostname: 'hostname' };
// /8.8.8.8/asn ... for any public address
const IP_FIELDS = { asn: 'asn', org: 'org', cc: 'countryCode', country: 'country', continent: 'continent', hostname: 'hostname' };

// What a script gets from a lookup route: JSON, or with ?format=text the same answer formatted by
// toText. An error is just its message, with the same status as the JSON would have.
function reply(io, d, status = 200, extra = {}, toText = null) {
  if (!io.plain) return json(d, status, extra);
  return text(d.error ? d.error + '\n' : toText(d), extra['cache-control'] || 'no-store', status, extra);
}

// One value and a newline. A missing value is an empty line with HTTP 404, so `curl -f` fails cleanly.
const one = (v, cache = 'no-store', extra = {}) => (v != null && String(v).trim()
  ? text(plain(v) + '\n', cache, 200, extra) : text('\n', cache, 404, extra));
const textError = (msg, status) => text(msg + '\n', 'no-store', status);

function selfField(io, name) {
  if (name !== 'hostname') return one(edgeInfo(io)[SELF_FIELDS[name]]);
  return guard(async () => {                             // reverse DNS asks a resolver, so it counts toward the rate limit
    await limit(io);
    const h = await ptr(io.me);
    if (h === undefined) throw new Error('dns: reverse lookup did not answer');
    return h;
  }, h => one(h), textError);
}

function ipField(io, q, name) {
  if (!Object.hasOwn(IP_FIELDS, name)) {
    const why = Object.hasOwn(SELF_FIELDS, name)
      ? `${name} is only available for your own address (curl ${io.url.host}/${name}). Other addresses get country and network data.`
      : `Unknown field "${name}".`;
    return textError(`${why} Fields for any address: ${Object.keys(IP_FIELDS).join(', ')}`, 404);
  }
  const p = parseIp(q), ip = canonIp(p), reason = nonPublicReason(p);
  if (reason) return textError(`${ip} is not a public address (${reason}), so there is nothing to look up.`, 400);
  return guard(
    () => ipData(io, ip, p, { lite: true }),              // Lite only, and no withPrivacy(): no Core or proxycheck.io budget
    d => one(name === 'country' ? d.country || countryName(d.countryCode) : d[IP_FIELDS[name]], 'public, max-age=300',
      name === 'hostname' ? {} : { 'x-attribution': IPINFO_CREDIT }),   // a second line would break $(curl ...)
    textError,
  );
}

// Terminal-safe text: an upstream value (a TXT record, a registry's name field) could carry escape
// sequences that rewrite the reader's terminal, or bidi controls that reorder what it shows.
const plain = v => String(v).replace(/[\t\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '?');

// [key, value] rows as aligned lines. Empty values are skipped; an array gets one line per item.
function kvText(rows, footer = []) {
  const keep = rows.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
  const w = Math.max(0, ...keep.map(([k]) => k.length)) + 2;
  const out = [];
  for (const [k, v] of keep) (Array.isArray(v) ? v : [v]).forEach((x, i) => out.push(((i ? '' : k).padEnd(w) + plain(x)).trimEnd()));
  return out.join('\n') + '\n' + (footer.length ? '\n' + footer.join('\n') + '\n' : '');
}

const SOURCE_NAMES = { edge: "Cloudflare's edge", 'ipinfo-lite': 'IPinfo Lite', 'ipinfo-core': 'IPinfo Core', ipinfo: 'IPinfo' };
function ipText(d) {
  const self = d.source === 'edge';
  const ctry = d.country ? d.country + (d.countryCode ? ` [${d.countryCode}]` : '') : d.countryCode;
  return kvText([
    [self ? 'your ip' : 'ip', d.ip], ['version', d.version ? 'IPv' + d.version : null], ['hostname', d.hostname],
    ['network', [d.asn, d.org].filter(Boolean).join('  ')], ['domain', d.asDomain],
    ['location', [d.city, d.region, ctry].filter(Boolean).join(', ')], ['continent', d.city ? null : d.continent], ['postal', d.postal],
    ['coordinates', d.lat != null && d.lon != null ? `${d.lat}, ${d.lon}` : null], ['time zone', d.timezone],
    ['connection', connectionText(d)], ['vpn / proxy', self ? null : vpnText(d)],
    ['edge', d.colo ? `${d.colo} (the Cloudflare data center that answered you)` : null],
    ['source', (SOURCE_NAMES[d.source] || d.source || '') + (d.privacy ? ' + proxycheck.io' : '')],
  ], /^ipinfo/.test(d.source || '') ? [IPINFO_CREDIT] : []);
}

function asnText(d) {
  if (!d.found) return `${d.asn} has no registered holder or announced prefixes in RIPEstat.\n`;
  const n = x => Number(x || 0).toLocaleString('en-US');
  const v4 = d.v4 || { prefixes: [] }, v6 = d.v6 || { prefixes: [] };
  const bits = v4.addresses >= 256 ? 32 - Math.floor(Math.log2(v4.addresses)) : null;
  const show4 = v4.prefixes.slice(0, 12), show6 = v6.prefixes.slice(0, 6);
  const more = (v4.count || 0) - show4.length + (v6.count || 0) - show6.length;
  return kvText([
    ['asn', d.asn], ['network', d.name || d.holder], ['handle', d.handle], ['registry', d.registry],
    ['announced', d.announced ? 'yes, visible in global routing' : 'no prefixes announced right now'],
    ['IPv4 prefixes', n(v4.count)], ['IPv4 space', v4.addresses != null ? n(v4.addresses) + ' addresses' + (bits ? ` (about a /${bits})` : '') : null],
    ['IPv6 prefixes', n(v6.count)], ['largest v4', show4], ['largest v6', show6],
  ], more > 0 ? [`${n(more)} more prefixes not shown (the JSON lists up to 50 of each).`] : []);
}

function dnsText(d) {
  const single = d.types && d.types.length === 1 ? d.types[0] : null, R = d.records || {};
  const val = (t, r) => (t === 'MX' ? mxText(r) : t === 'SOA' && r.admin ? `${r.value} ${r.admin} serial ${r.serial}`
    : t === 'SRV' && r.port != null ? `${r.priority} ${r.weight} ${r.port} ${r.value}` : r.value) + (single && r.ttl != null ? `  (ttl ${r.ttl}s)` : '');
  const rows = [['name', d.name], ['status', d.status], ['alias of', (d.cname || []).join(' -> ')]];
  for (const t of d.types || []) {
    const list = (R[t] || []).map(r => val(t, r));
    rows.push([t, list.length ? list : d.status === 'NOERROR' && (single || ['A', 'MX', 'NS'].includes(t)) ? 'none' : null]);
  }
  const host = d.hosting && d.hosting.org;
  if (host) rows.push(['hosted by', `${d.hosting.org}${d.hosting.asn ? ` (${d.hosting.asn})` : ''}${d.hosting.country ? ', ' + d.hosting.country : ''}`]);
  if (!parseIp(d.name)) rows.push(['DNSSEC', d.dnssec ? 'validated' : 'not validated']);
  return kvText(rows, host ? [IPINFO_CREDIT] : []);
}

function whoisText(d) {
  if (!d.found) return (d.message || `No registry record was found for ${d.query}.`) + '\n';
  const date = s => (s ? String(s).slice(0, 10) : null), abuse = d.abuse || {};
  if (d.kind === 'domain') {
    const left = d.expires ? dayDiff(d.expires) : null;
    return kvText([
      ['query', d.query !== d.domain ? d.query : null], ['domain', d.unicodeName ? `${d.domain} (${d.unicodeName})` : d.domain],
      ['registrar', d.registrar && d.registrar.name ? d.registrar.name + (d.registrar.ianaId ? ` (IANA ID ${d.registrar.ianaId})` : '') : null],
      ['registered', date(d.registered)],
      ['expires', d.expires ? date(d.expires) + (left != null ? (left < 0 ? ` (expired ${-left} days ago)` : ` (in ${left} days)`) : '') : null],
      ['last changed', date(d.updated)], ['status', d.status || []], ['name servers', d.nameservers || []],
      ['DNSSEC', d.dnssec == null ? null : d.dnssec ? 'signed' : 'not signed'],
      ['registrant', d.registrant ? d.registrant + (d.registrantCountry ? ` (${d.registrantCountry})` : '') : 'not published (redacted for privacy)'],
      ['abuse email', abuse.email], ['abuse phone', abuse.phone], ['registry', d.registry], ['rdap', d.rdapUrl],
    ]);
  }
  return kvText([
    ['query', d.query], ['owner', d.org], ['network name', d.name], ['handle', d.handle && !/ - /.test(d.handle) ? d.handle : null],
    ['registry', d.registry], ['address block', d.cidrs || []], ['range', d.range ? `${d.range.start} - ${d.range.end}` : null],
    ['ASN range', d.asnRange && d.asnRange.start !== d.asnRange.end ? `AS${d.asnRange.start} - AS${d.asnRange.end}` : null],
    ['type', d.type], ['country', d.country], ['registered', date(d.registered)], ['last changed', date(d.updated)], ['description', d.description],
    ['abuse email', abuse.email], ['abuse contact', !abuse.email && abuse.handle ? `${abuse.handle} (email not published in RDAP; see the registry)` : null],
    ['abuse phone', abuse.phone], ['rdap', d.rdapUrl],
  ]);
}

function cidrText(d) {
  const list = a => (a ? a.join(', ') : null);
  if (d.v !== 4) {
    return kvText([['network', d.cidr], ['first address', d.network], ['last address', d.last], ['addresses', `${d.totalPow} = ${d.totalText}`],
      ['/64 subnets', d.subnets64], ['expanded', d.expanded], ['splits into', list(d.halves)], ['part of', d.supernet], ['range', d.rangeNote]]);
  }
  // network | host bits: the split falls after the prefix-th bit, skipping the dots between octets
  const split = d.prefix > 0 && d.prefix < 32 ? d.prefix + Math.floor((d.prefix - 1) / 8) : null;
  const bits = split != null ? `${d.bits.slice(0, split)} | ${d.bits.slice(split).replace(/^\./, '')}` : d.bits;
  return kvText([
    ['network', d.cidr], ['netmask', d.netmask], ['wildcard', d.wildcard], ['broadcast', d.prefix <= 30 ? d.broadcast : null],
    ['usable hosts', `${d.first} - ${d.last}`],
    ['host count', `${d.usableText} usable, ${d.totalText} addresses` + (d.prefix === 31 ? ' (point-to-point, RFC 3021)' : '')],
    ['your address', d.hostIndex ? `${d.ip} is address #${CIDR.fmt(d.hostIndex)} in this network` : null],
    ['bits', bits], ['splits into', list(d.halves)], ['contains', d.slash24s > 2 ? `${CIDR.fmt(d.slash24s)} x /24 networks` : null],
    ['part of', d.supernet], ['range', d.rangeNote], ['legacy class', d.legacyClass ? `${d.legacyClass} (classful addressing is historical)` : null],
  ]);
}

// The command-line reference: `curl <host>/help`, and /api for command-line clients.
function helpText(io) {
  return text(helpBody(io.url.host), 'public, max-age=3600', 200, { vary: 'Accept, User-Agent' });
}

function helpBody(h) {
  const block = (title, rows) => {
    const w = Math.max(...rows.map(([c, what]) => (what == null ? 0 : c.length))) + 3;
    return [title, ...rows.map(([c, what]) => ('  ' + (what == null ? c : c.padEnd(w) + what)).trimEnd())].join('\n');
  };
  return [
    `ipterm: IP lookups from the command line. No key, no sign-up, no cookies.`,
    block("YOUR OWN ADDRESS (from Cloudflare's edge: no third-party lookup)", [
      [`curl ${h}`, 'your IP address'],
      [`curl ${h}/json`, 'your IP, network and location as JSON'],
      [`curl ${h}/asn`, "your network's AS number"],
      [`curl ${h}/org`, "your network's name"],
      [`curl ${h}/cc`, 'your country code (ISO 3166-1)'],
      [`curl ${h}/city`, 'your city'],
      [`curl ${h}/tz`, 'your time zone'],
      [`curl ${h}/colo`, 'the Cloudflare data center that answered you'],
      [`curl ${h}/hostname`, 'your reverse DNS name'],
    ]),
    block('ANY ADDRESS', [
      [`curl ${h}/8.8.8.8`, 'owner, network and location as JSON'],
      [`curl ${h}/8.8.8.8/country`, 'one value: asn, org, cc, country,'],
      ['', 'continent or hostname'],
    ]),
    block('NETWORKS, DNS, REGISTRY RECORDS, SUBNETS', [
      [`curl ${h}/AS13335`, 'a network and its address blocks'],
      [`curl ${h}/dns/example.com`, 'DNS records; add /MX for one type'],
      [`curl ${h}/whois/github.com`, 'registry record: domain, IP or ASN'],
      [`curl ${h}/cidr/10.0.0.0/22`, 'subnet calculator'],
    ]),
    block('PORT CHECK (YOUR OWN ADDRESS ONLY, 10 A MINUTE)', [
      [`curl -4 ${h}/port/22`, 'is TCP port 22 open on your IP?'],
      ['-4 tests your IPv4 address, where router port forwards apply.'],
    ]),
    block('TEXT INSTEAD OF JSON', [
      ['Add ?format=text to any lookup for aligned lines, like the web terminal.'],
      ['Quote the URL so the shell leaves the ? alone:'],
      [`curl '${h}/8.8.8.8?format=text'`],
    ]),
    block('NOTES', [
      ['One-value answers are one line. A missing value is an empty line with'],
      [`HTTP 404, so  curl -fs ${h}/city  exits non-zero.`],
      ['30 uncached lookups a minute per address, then HTTP 429.'],
      [`No cookies or tracking, and nothing about you is stored: ${h}/privacy`],
      [`OpenAPI: ${h}/openapi.json   For AI tools: ${h}/llms.txt`],
      [`Browsers: ${h} is a terminal; this reference is at ${h}/api`],
    ]),
    `${IPINFO_CREDIT}. Networks: RIPEstat.\nRegistry records: RDAP. DNS: Cloudflare's 1.1.1.1.`,
  ].join('\n\n') + '\n';
}

// Runs a data step and maps rate limiting and provider failures to friendly responses.
// Outside services occasionally hiccup. Every upstream call gets a time limit and one retry
// (after a short pause) on network errors, timeouts, 5xx and 429 responses.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchRetry(url, init = {}, label = 'upstream', timeout = 8000) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (attempt === 0 && (r.status >= 500 || r.status === 429)) { last = new Error(`${label} HTTP ${r.status}`); await sleep(400); continue; }
      return r;
    } catch (e) {
      last = e;
      if (attempt === 0) { await sleep(400); continue; }
    }
  }
  throw new Error(`${label}: ${(last && last.message) || last}`);
}

async function guard(step, ok, fail = (msg, status) => json({ error: msg }, status)) {
  try {
    return ok(await step());
  } catch (e) {
    if (e instanceof RateLimited) {
      const r = await fail('Too many lookups from your address. Wait a minute and try again.', 429);
      r.headers.set('retry-after', '60');
      return r;
    }
    // Visible with `npx wrangler tail` (or Workers Logs if enabled). Never logs the visitor's IP or the API token.
    console.error('[ipterm] upstream failure:', String((e && e.message) || e).replace(/token=[^&\s]+/g, 'token=***'));
    return fail('A data source didn\'t respond. Try again in a moment.', 502);
  }
}

/* ---------- data ---------- */

async function cached(io, key, ttl, produce) {
  const cache = caches.default;
  const req = new Request(`${io.url.origin}/__cache/${key}`);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  await limit(io);                       // only cache misses cost an upstream call
  const data = await produce();
  if (data && typeof data._ttl === 'number') { ttl = data._ttl; delete data._ttl; }   // a result can ask to be kept shorter
  io.ctx.waitUntil(cache.put(req, new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
  })));
  return data;
}

// One IPv6 connection usually owns a whole /64 (18 quintillion addresses), so IPv6 visitors are
// limited per /64; otherwise rotating the address would dodge the limit entirely.
function limitKey(ip) {
  const p = parseIp(ip);
  if (!p) return ip;
  return p.v === 4 ? p.o.join('.') : p.g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
}

// For the hourly per-visitor shares of the paid/free data budgets, IPv6 is grouped wider, by /56:
// many home connections get a whole /56 (256 /64s), which would otherwise mean 256 shares. Phones
// that happen to share a carrier's /56 share one allowance, and past it just get country-level data.
// The per-minute rate limit stays per /64.
function visitorKey(ip) {
  const p = parseIp(ip);
  if (!p || p.v === 4) return limitKey(ip);
  return p.g.slice(0, 3).map(x => x.toString(16)).join(':') + ':' + (p.g[3] & 0xff00).toString(16) + '::/56';
}

async function limit(io) {
  if (!io.env.LOOKUP_LIMITER || !io.me) return;
  let ok = true;
  try { ok = (await io.env.LOOKUP_LIMITER.limit({ key: limitKey(io.me) })).success; } catch { ok = true; } // fail open
  if (!ok) throw new RateLimited();
}

// Privacy check (leaktest): your own details from Cloudflare plus IPinfo's classification of your
// address (VPN/proxy/Tor, hosting, mobile). Only runs when a visitor asks for the check.
async function checkData(io) {
  const self = await selfInfo(io);
  const p = parseIp(io.me);
  let network = null;
  if (p && !nonPublicReason(p)) {
    try {
      // proxycheck.io is asked every time here (not only when IPinfo is unsure): it can name the VPN.
      const ip = canonIp(p);
      const [d, privacy] = await Promise.all([ipData(io, ip, p), privacyData(io, ip)]);
      network = { source: d.source || null, asn: d.asn || null, org: d.org || null, asType: d.asType || null, flags: d.flags || null, privacy: privacy || null };
    } catch (e) { if (e instanceof RateLimited) throw e; }   // classification is a bonus; the check still runs
  }
  return { ...self, network };
}

async function selfInfo(io, quick = false) {
  await limit(io);
  const hostname = await ptr(io.me, quick);
  const { ip, version, source, ...rest } = edgeInfo(io);
  return {
    ip, version, source,
    hostname: hostname || null,
    ...(hostname === undefined && quick ? { ptrTimedOut: true } : {}),   // the page offers a reverse lookup instead
    ...rest,
  };
}

// Your own details as Cloudflare's edge sees them (request.cf): no outside call, so no rate limit.
function edgeInfo(io) {
  const cf = io.request.cf || {}, ip = io.me, p = parseIp(ip);
  return {
    ip,
    version: p ? p.v : null,
    source: 'edge',
    asn: cf.asn ? 'AS' + cf.asn : null,
    org: cf.asOrganization || null,
    city: cf.city || null,
    region: cf.region || null,
    postal: cf.postalCode || null,
    countryCode: cf.country || null,
    country: countryName(cf.country),
    continent: cf.continent || null,
    lat: num(cf.latitude),
    lon: num(cf.longitude),
    timezone: cf.timezone || null,
    colo: cf.colo || null,
  };
}

const txt = (v, n = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const asnOf = v => (typeof v === 'string' && /^AS\d{1,10}$/i.test(v) ? v.toUpperCase() : null);

// IPinfo Core (paid): city-level location plus connection flags. Shape documented at
// https://ipinfo.io/developers/core-api: { ip, hostname, geo: {...}, as: {...}, is_* flags }.
async function ipinfoCore(ip, env) {
  // One attempt with a time limit: if Core has any trouble, the caller falls back to Lite.
  const r = await fetch(`https://api.ipinfo.io/lookup/${ip}`,   // ip is already validated and canonical
    { headers: { authorization: `Bearer ${env.IPINFO_TOKEN}`, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (r.status === 401 || r.status === 403 || r.status === 429) { if (r.body) r.body.cancel(); return { refused: r.status }; }
  if (!r.ok) { if (r.body) r.body.cancel(); throw new Error('ipinfo core ' + r.status); }
  const d = await r.json();
  const g = d && typeof d.geo === 'object' && d.geo ? d.geo : {}, a = d && typeof d.as === 'object' && d.as ? d.as : {};
  const lat = num(g.latitude), lon = num(g.longitude);
  const flag = k => (d[k] === true ? true : undefined);
  return {
    source: 'ipinfo-core',
    hostname: txt(d.hostname, 255),
    asn: asnOf(a.asn), org: txt(a.name), asDomain: txt(a.domain, 255),
    asType: ['isp', 'hosting', 'business', 'education', 'government'].includes(a.type) ? a.type : null,
    city: txt(g.city), region: txt(g.region), countryCode: /^[A-Z]{2}$/i.test(g.country_code || '') ? g.country_code.toUpperCase() : null, country: txt(g.country),
    continent: txt(g.continent), postal: txt(g.postal_code, 20), timezone: txt(g.timezone, 64),
    lat: lat != null && Math.abs(lat) <= 90 ? lat : null, lon: lon != null && Math.abs(lon) <= 180 ? lon : null,
    flags: { mobile: flag('is_mobile'), hosting: flag('is_hosting'), anonymous: flag('is_anonymous'), anycast: flag('is_anycast'), satellite: flag('is_satellite') },
  };
}

/* Budget for paid IPinfo Core lookups. One Durable Object (named "ipinfo-core") keeps the count for
   every Cloudflare location, per day (UTC) and per hour, so a scraper can use at most one hour's
   share, and never more than one day's share of the monthly quota. Once a limit is reached, lookups
   use IPinfo Lite (country and network) until the next hour or day. Only fresh lookups count:
   lookups of other addresses and leaktest's check of your own address. Cached results, whoami,
   DNS and whois never do. */
export class LookupBudget extends DurableObject {
  // who: the visitor's rate-limit key (IP or IPv6 /64); perVisitor: their share per hour (0 = no cap).
  // The object uses its own clock, so a late-arriving request can't roll the counters back.
  async take(daily, hourly, who = null, perVisitor = 0, now = Date.now()) {
    const iso = new Date(now).toISOString(), day = iso.slice(0, 10), hour = iso.slice(0, 13);
    const s = this.ctx.storage;                          // calls are processed one at a time, so this can't double-count
    const [savedDay, count, savedHour, hcount] = [await s.get('day'), await s.get('count'), await s.get('hour'), await s.get('hcount')];
    const used = savedDay === day ? Number(count) || 0 : 0;
    const usedHour = savedHour === hour ? Number(hcount) || 0 : 0;
    if (used >= daily) return { ok: false, reason: 'day', used, daily, hourly, day, hour };
    if (hourly > 0 && usedHour >= hourly) return { ok: false, reason: 'hour', used, usedHour, daily, hourly, day, hour };
    if (who && perVisitor > 0) {
      // Per-visitor counts live in memory only and reset every hour. The address itself is never kept:
      // only a salted hash, and the salt is replaced every hour, so hours can't be linked together.
      if (this.vHour !== hour || !this.visitors || this.visitors.size > 50000) {
        this.vHour = hour; this.visitors = new Map(); this.salt = crypto.getRandomValues(new Uint8Array(16)).join(',');
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.salt + '|' + who));
      const key = [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
      const v = this.visitors.get(key) || 0;
      if (v >= perVisitor) return { ok: false, reason: 'visitor', used, usedHour, daily, hourly, day, hour };
      this.visitors.set(key, v + 1);
    }
    await s.put({ day, count: used + 1, hour, hcount: usedHour + 1 });
    return { ok: true, used: used + 1, usedHour: usedHour + 1, daily, hourly, day, hour };
  }
  async status(now = Date.now()) {
    const iso = new Date(now).toISOString();
    const s = this.ctx.storage, [d, c, h, hc] = [await s.get('day'), await s.get('count'), await s.get('hour'), await s.get('hcount')];
    return { day: iso.slice(0, 10), used: d === iso.slice(0, 10) ? Number(c) || 0 : 0, usedHour: h === iso.slice(0, 13) ? Number(hc) || 0 : 0 };
  }
}

// Whole numbers only ("4500"); anything else (empty, negative, decimals, "abc", "1e400") uses the default.
const intVar = (v, def) => { const t = String(v ?? '').trim(); return /^\d{1,9}$/.test(t) ? Number(t) : def; };

let budgetBlockedUntil = 0;                              // per-instance memo: skip the check until the hour/day rolls over
async function coreAllowed(env, who = null, now = Date.now()) {
  const daily = intVar(env.IPINFO_DAILY_BUDGET, 4500);
  if (daily === 0) return false;                         // "0" turns Core off
  if (!env.BUDGET) return true;                          // no budget configured: no cap
  if (now < budgetBlockedUntil) return false;
  const hourly = intVar(env.IPINFO_HOURLY_BUDGET, Math.ceil((daily / 24) * 2));   // default: twice an even share; "0" = no pacing
  const perVisitor = intVar(env.IPINFO_VISITOR_HOURLY, 30);                       // "0" = no per-visitor cap
  try {
    const r = await env.BUDGET.get(env.BUDGET.idFromName('ipinfo-core')).take(daily, hourly, who, perVisitor);
    if (!r.ok && r.reason === 'visitor') return 'visitor';   // just this visitor: no memo, no log
    if (!r.ok) {
      const d = new Date(now);
      budgetBlockedUntil = r.reason === 'hour'
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      console.error(r.reason === 'hour'
        ? `[ipterm] IPinfo Core hourly budget used (${r.hourly}); using IPinfo Lite until the next hour`
        : `[ipterm] IPinfo Core daily budget used (${r.daily}); using IPinfo Lite until midnight UTC`);
    }
    return r.ok;
  } catch (e) {
    console.error('[ipterm] budget check failed, using IPinfo Lite:', String((e && e.message) || e));
    return false;                                        // if the counter is unreachable, don't risk the paid quota
  }
}

let coreRefusedUntil = 0;                                // per-instance memo: Core said no (quota or token), try again later
async function provider(ip, env, opts = {}) {
  const now = Date.now();
  let fallback = null;                                   // why Core wasn't used; decides how long the Lite answer is cached
  if (opts.core && env.IPINFO_TOKEN) {
    const allowed = now >= coreRefusedUntil ? await coreAllowed(env, opts.who) : false;
    if (allowed === true) {
      try {
        const core = await ipinfoCore(ip, env);
        if (core && !core.refused) return core;
        coreRefusedUntil = now + 10 * 60 * 1000;
        console.error(`[ipterm] IPinfo Core refused the request (HTTP ${core && core.refused}): quota used up or token not on Core; using IPinfo Lite for 10 minutes`);
      } catch (e) {
        coreRefusedUntil = now + 60 * 1000;               // outage or timeout: pause Core for a minute
        console.error('[ipterm] IPinfo Core unavailable, using IPinfo Lite for a minute:', String((e && e.message) || e));
      }
    } else if (allowed === 'visitor') fallback = 'visitor';
  }
  if (env.IPINFO_TOKEN) {
    const r = await fetchRetry(`https://api.ipinfo.io/lite/${ip}?token=${env.IPINFO_TOKEN}`, {}, 'ipinfo lite');
    if (!r.ok) throw new Error('ipinfo lite ' + r.status);
    const d = await r.json();
    return {
      ...(fallback === 'visitor' ? { _visitorCap: true } : {}),
      source: 'ipinfo-lite',
      asn: typeof d.asn === 'string' && /^AS\d{1,10}$/i.test(d.asn) ? d.asn.toUpperCase() : null,
      org: d.as_name || null,
      asDomain: d.as_domain || null,
      countryCode: d.country_code || null,
      country: d.country || null,
      continent: d.continent || null,
      bogon: d.bogon || undefined,
    };
  }
  const r = await fetchRetry(`https://ipinfo.io/${ip}/json`, { headers: { accept: 'application/json' } }, 'ipinfo');
  if (!r.ok) throw new Error('ipinfo ' + r.status);
  const d = await r.json();
  const [lat, lon] = (d.loc || '').split(',').map(Number);
  const m = /^(AS\d{1,10})\s+(.*)$/.exec(typeof d.org === 'string' ? d.org : '');
  return {
    source: 'ipinfo',
    hostname: d.hostname || null,
    asn: m ? m[1] : null,
    org: m ? m[2] : d.org || null,
    city: d.city || null,
    region: d.region || null,
    postal: d.postal || null,
    countryCode: d.country || null,
    country: countryName(d.country),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    timezone: d.timezone || null,
    bogon: d.bogon || undefined,
  };
}

/* ---------- VPN / proxy second opinion: proxycheck.io ----------
   Optional (set the PROXYCHECK_KEY secret). Asked for leaktest's check of your own address, and for
   lookups IPinfo hasn't already flagged. The free plan allows 1,000 queries a day, so it has its own
   budget (PROXYCHECK_DAILY_BUDGET, default 900) in the same counter as IPinfo Core, and answers are
   cached (clean addresses an hour, flagged ones 15 minutes, as proxycheck.io recommends). Past the
   budget, or if proxycheck.io has any trouble, results simply come from IPinfo alone. tag=0 asks
   proxycheck.io not to keep the query in the account's log. */
let pcBlockedUntil = 0, pcRefusedUntil = 0;
async function proxycheckAllowed(env, who, now = Date.now()) {
  const daily = intVar(env.PROXYCHECK_DAILY_BUDGET, 900);
  if (daily === 0 || now < pcBlockedUntil) return false;
  if (!env.BUDGET) return true;
  const hourly = intVar(env.PROXYCHECK_HOURLY_BUDGET, Math.ceil((daily / 24) * 2));
  const perVisitor = intVar(env.PROXYCHECK_VISITOR_HOURLY, 10);
  try {
    const r = await env.BUDGET.get(env.BUDGET.idFromName('proxycheck')).take(daily, hourly, who, perVisitor);
    if (!r.ok && r.reason !== 'visitor') {
      const d = new Date(now);
      pcBlockedUntil = r.reason === 'hour'
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      console.error(`[ipterm] proxycheck.io ${r.reason === 'hour' ? 'hourly' : 'daily'} budget used; VPN checks use IPinfo alone until it resets`);
    }
    return r.ok;
  } catch (e) {
    console.error('[ipterm] proxycheck budget check failed:', String((e && e.message) || e));
    return false;
  }
}

// Reads proxycheck.io's v3 answer. Every field is checked, since it ends up on the page.
// Returns { refused: true } for a refusal sent with HTTP 200, null for anything unreadable.
function parseProxycheck(j, ip) {
  if (!j || typeof j !== 'object') return null;
  if (j.status === 'denied') return { refused: true };
  if (j.status === 'error') return null;
  let e = Object.hasOwn(j, ip) ? j[ip] : null;
  if (!e || typeof e !== 'object') e = Object.entries(j).find(([k, v]) => k !== 'status' && v && typeof v === 'object' && v.detections)?.[1];
  if (!e || typeof e.detections !== 'object' || !e.detections) return null;
  const det = Object.create(null);                       // no prototype: a "__proto__" key is just a key
  for (const [k, v] of Object.entries(e.detections)) det[k.toLowerCase()] = v;
  const yes = k => det[k] === true || det[k] === 'yes';
  const vpn = yes('vpn'), proxy = yes('proxy'), tor = yes('tor'), compromised = yes('compromised');
  // The live v3 API sends risk inside detections; the published OpenAPI spec puts it on the address's
  // own entry, beside detections. Read both, so a move to match the spec doesn't drop it.
  const risk = num(det.risk ?? e.risk);
  const op = e.operator && typeof e.operator === 'object' ? txt(e.operator.name, 60) : null;
  const nt = e.network && typeof e.network === 'object' && typeof e.network.type === 'string' ? e.network.type.toLowerCase() : null;
  return {
    source: 'proxycheck',
    netType: ['residential', 'business', 'wireless', 'hosting'].includes(nt) ? nt : null,
    // proxycheck.io's own flag, or any VPN, proxy, Tor or compromised finding. It picks the cache time,
    // but isn't a VPN verdict on its own: see pcKnown() and vpnText().
    anonymous: yes('anonymous') || vpn || proxy || tor || compromised,
    vpn, proxy, tor, compromised, hosting: yes('hosting'),
    operator: op && /^[\p{L}\p{N} .,&'()+\-]+$/u.test(op) ? op : null,
    risk: risk != null && risk >= 0 && risk <= 100 ? Math.round(risk) : null,
  };
}

async function privacyData(io, ip) {
  const env = io.env, now = Date.now();
  if (!env.PROXYCHECK_KEY) return null;
  const req = new Request(`${io.url.origin}/__cache/pc/${ip}`);
  try {
    const hit = await caches.default.match(req);
    if (hit) return await hit.json();
  } catch { /* cache trouble: just ask */ }
  if (now < pcRefusedUntil) return null;
  // The visitor's rate limit applies here too: an IPinfo answer may have come from the cache, and
  // without this, repeating a lookup would reach the budget counter on every request.
  try { await limit(io); } catch { return null; }
  if (await proxycheckAllowed(env, visitorKey(io.me)) !== true) return null;
  const refuse = (why, minutes) => {
    pcRefusedUntil = now + minutes * 60 * 1000;
    console.error(`[ipterm] proxycheck.io ${why}; VPN checks use IPinfo alone for ${minutes} minute${minutes > 1 ? 's' : ''}`);
    return null;
  };
  let r;
  try {
    r = await fetch(`https://proxycheck.io/v3/${ip}?key=${encodeURIComponent(env.PROXYCHECK_KEY)}&tag=0`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
  } catch (e) {
    return refuse('did not answer (' + String((e && e.name) || 'error') + ')', 1);   // timeout or network trouble
  }
  if (r.status === 401 || r.status === 403 || r.status === 429) {
    if (r.body) r.body.cancel();
    return refuse(`refused the request (HTTP ${r.status}): check the key or the daily allowance`, 10);
  }
  if (r.status >= 500) { if (r.body) r.body.cancel(); return refuse(`is having trouble (HTTP ${r.status})`, 1); }
  // Anything else odd is about this one address: skip it, without pausing the check for everyone.
  if (!r.ok) { if (r.body) r.body.cancel(); console.error(`[ipterm] proxycheck.io answered HTTP ${r.status} for one address`); return null; }
  let d = null;
  try { d = parseProxycheck(await readJson(r, 200_000), ip); } catch { d = null; }
  if (d && d.refused) return refuse('refused the request (status "denied"): check the key or the daily allowance', 10);
  if (!d) { console.error('[ipterm] proxycheck.io sent an unreadable answer for one address'); return null; }
  io.ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify(d), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${d.anonymous ? 900 : 3600}` },
  })));
  return d;
}

async function asnData(n) {
  const base = 'https://stat.ripe.net/data';
  const get = async u => { const r = await fetchRetry(u, {}, 'ripestat'); if (!r.ok) throw new Error('ripestat ' + r.status); return (await r.json()).data || {}; };
  const [ov, pf] = await Promise.all([
    get(`${base}/as-overview/data.json?resource=AS${n}&sourceapp=ipterm`),
    get(`${base}/announced-prefixes/data.json?resource=AS${n}&sourceapp=ipterm`),
  ]);
  const holder = typeof ov.holder === 'string' ? ov.holder : '';
  const hm = /^(\S+) - (.+)$/.exec(holder);
  const reg = /Assigned by (\w+)/i.exec((ov.block && ov.block.desc) || '');
  const all = (pf.prefixes || []).map(x => x && x.prefix).filter(x => typeof x === 'string' && /^[0-9a-f.:]+\/\d{1,3}$/i.test(x));
  const v4 = all.filter(x => !x.includes(':')), v6 = all.filter(x => x.includes(':'));
  const byLen = (a, b) => Number(a.split('/')[1]) - Number(b.split('/')[1]) || a.localeCompare(b, 'en', { numeric: true });
  return {
    asn: 'AS' + n,
    number: n,
    found: Boolean(holder) || all.length > 0,
    holder: holder || null,
    handle: hm ? hm[1] : null,
    name: hm ? hm[2] : holder || null,
    registry: reg ? reg[1].toUpperCase() : null,
    announced: Boolean(ov.announced),
    v4: { count: v4.length, addresses: v4Addresses(v4), prefixes: v4.sort(byLen).slice(0, 50) },
    v6: { count: v6.length, prefixes: v6.sort(byLen).slice(0, 50) },
    source: 'ripestat',
  };
}

// Unique IPv4 addresses covered by a set of prefixes (overlaps counted once).
function v4Addresses(prefixes) {
  const iv = [];
  for (const s of prefixes) {
    const [a, l] = s.split('/'); const p = parseIp(a); const len = Number(l);
    if (!p || p.v !== 4 || len > 32) continue;
    const start = p.o[0] * 16777216 + p.o[1] * 65536 + p.o[2] * 256 + p.o[3];
    iv.push([start, start + 2 ** (32 - len)]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [s, e] of iv) {
    if (s > ce) { if (ce > cs) total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e;
  }
  if (ce > cs) total += ce - cs;
  return total;
}

// Reverse DNS through Cloudflare's DNS-over-HTTPS resolver. Returns null when there is no PTR record
// and undefined when the resolver didn't answer. quick (the homepage): one short try, so a slow
// resolver never holds up the first paint.
async function ptr(ip, quick = false) {
  const p = parseIp(ip);
  if (!p) return null;
  const name = p.v === 4
    ? [...p.o].reverse().join('.') + '.in-addr.arpa'
    : p.g.map(x => x.toString(16).padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa';
  const url = `https://cloudflare-dns.com/dns-query?name=${name}&type=PTR`, init = { headers: { accept: 'application/dns-json' } };
  try {
    const r = quick ? await fetch(url, { ...init, signal: AbortSignal.timeout(400) }) : await fetchRetry(url, init, 'dns', 3000);
    const d = await r.json();
    const a = (d.Answer || []).find(x => x.type === 12);
    return a ? String(a.data).replace(/\.$/, '') : null;
  } catch {
    return undefined;
  }
}

/* ---------- DNS ---------- */
// Answers come from Cloudflare's public resolver (1.1.1.1) over DNS-over-HTTPS (JSON API).

const DNS_TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, DS: 43, DNSKEY: 48, HTTPS: 65, CAA: 257 };
const DNS_NAMES = Object.fromEntries(Object.entries(DNS_TYPES).map(([k, v]) => [v, k]));
const SUMMARY_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA'];
const RCODES = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };

function normalizeDomain(q) {
  q = String(q || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (!q || q.length > 253 || /[\s:@\\]/.test(q) || parseIp(q)) return null;
  let host;
  try { host = new URL('http://' + q + '/').hostname; } catch { return null; }   // international names -> punycode
  const label = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
  if (!new RegExp(`^(?:${label}\\.)+(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,63}$`).test(host) || host.length > 253) return null;
  return host;
}

function reverseName(p) {
  return p.v === 4 ? [...p.o].reverse().join('.') + '.in-addr.arpa'
    : p.g.map(x => x.toString(16).padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa';
}

async function doh(name, type) {
  const r = await fetchRetry(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: 'application/dns-json' } }, 'dns');
  if (!r.ok) throw new Error('dns HTTP ' + r.status);
  return r.json();
}

const short = (s, n = 500) => String(s).slice(0, n);
const host = s => short(String(s).replace(/\.$/, ''), 255);
// An MX record pointing at "." is a null MX (RFC 7505): the domain accepts no mail. ('' is the same
// record as parsed before the "." was kept, still possible in a cached answer.) Matches app.js.
const nullMx = r => r.value === '.' || r.value === '';
const mxText = r => `${r.priority} ` + (nullMx(r) ? '. (accepts no mail: null MX)' : r.value);
function parseRecord(type, data) {
  data = String(data);
  switch (type) {
    case 'MX': { const m = /^(\d+)\s+(\S+)$/.exec(data); return m ? { priority: Number(m[1]), value: m[2] === '.' ? '.' : host(m[2]) } : { value: short(data) }; }
    case 'NS': case 'CNAME': case 'PTR': return { value: host(data) };
    case 'TXT': {                                          // one record may be split into several quoted strings
      const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
      const v = parts ? parts.map(x => x.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : data;
      return { value: short(v, 1000) };
    }
    case 'SOA': {
      const f = data.split(/\s+/);
      return f.length >= 7 ? { value: host(f[0]), admin: host(f[1]), serial: Number(f[2]) || f[2], refresh: Number(f[3]), retry: Number(f[4]), expire: Number(f[5]), minimum: Number(f[6]) } : { value: short(data) };
    }
    case 'SRV': { const f = data.split(/\s+/); return f.length === 4 ? { priority: Number(f[0]), weight: Number(f[1]), port: Number(f[2]), value: host(f[3]) } : { value: short(data) }; }
    default: return { value: short(data) };
  }
}

async function dnsData(io, name, types, forIp) {
  const res = await Promise.all(types.map(t => doh(name, t)));
  const d = { name: forIp || name, query: name, types, status: 'NOERROR', dnssec: false, cname: [], records: {}, source: 'cloudflare-dns' };
  res.forEach((r, i) => {
    const t = types[i];
    const st = r.Status ?? 0;
    if (st === 3) d.status = 'NXDOMAIN';
    else if (st !== 0 && d.status === 'NOERROR') d.status = RCODES[st] || 'ERROR';
    if (r.AD) d.dnssec = true;
    for (const a of r.Answer || []) {
      const tn = DNS_NAMES[a.type] || String(a.type);
      if (tn === 'CNAME' && t !== 'CNAME') { const v = host(a.data); if (!d.cname.includes(v)) d.cname.push(v); continue; }
      if (tn !== t) continue;
      const list = (d.records[t] = d.records[t] || []);
      if (list.length < 25) list.push({ ttl: a.TTL, ...parseRecord(t, a.data) });
    }
  });
  if (d.records.MX) d.records.MX.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const first = (d.records.A || [])[0] || (d.records.AAAA || [])[0];
  const fp = first && parseIp(first.value);
  if (fp && !nonPublicReason(fp)) {                         // who hosts it: reuse the cached IP lookup
    try {
      const info = await ipData(io, canonIp(fp), fp, { lite: true });   // "hosted by" only needs the network: no Core budget
      d.hosting = { ip: info.ip, asn: info.asn || null, org: info.org || null, country: info.country || info.countryCode || null };
    } catch (e) { /* hosting is a nice-to-have */ }
  }
  return d;
}

/* ---------- RDAP (whois) ---------- */
// RDAP is the registries' structured replacement for whois. IANA's bootstrap files say which
// regional registry (ARIN, RIPE NCC, APNIC, LACNIC, AFRINIC) holds each address block and ASN.

const BOOT = {};
async function bootstrap(kind, origin) {               // kind: ipv4 | ipv6 | asn | dns
  if (BOOT[kind]) return BOOT[kind];
  const key = new Request(`${origin}/__cache/rdap-bootstrap/${kind}`);
  const hit = await caches.default.match(key);
  let data;
  if (hit) data = await hit.json();
  else {
    const r = await fetchRetry(`https://data.iana.org/rdap/${kind}.json`, {}, 'iana bootstrap', 6000);
    if (!r.ok) throw new Error('bootstrap ' + r.status);
    data = await r.json();
    await caches.default.put(key, new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
    }));
  }
  BOOT[kind] = (data.services || []).map(([ranges, urls]) => ({
    ranges,
    base: (urls.find(u => u.startsWith('https://')) || urls[0] || '').replace(/\/?$/, '/'),
  }));
  return BOOT[kind];
}

function inPrefix(p, prefix) {
  const [net, lenS] = prefix.split('/'); const len = Number(lenS); const q = parseIp(net);
  if (!q || q.v !== p.v) return -1;
  const a = p.v === 4 ? p.o : p.g, b = q.v === 4 ? q.o : q.g, width = p.v === 4 ? 8 : 16;
  let bits = len;
  for (let i = 0; i < a.length && bits > 0; i++) {
    const take = Math.min(width, bits), mask = ((1 << take) - 1) << (width - take);
    if ((a[i] & mask) !== (b[i] & mask)) return -1;
    bits -= take;
  }
  return len;
}

async function rdapBase(target, origin) {
  if (target.asn) {
    for (const s of await bootstrap('asn', origin)) {
      for (const r of s.ranges) { const [lo, hi] = r.split('-').map(Number); if (target.asn >= lo && target.asn <= (hi || lo)) return s.base; }
    }
    return null;
  }
  let best = null, bestLen = -1;
  for (const s of await bootstrap(target.p.v === 4 ? 'ipv4' : 'ipv6', origin)) {
    for (const r of s.ranges) { const l = inPrefix(target.p, r); if (l > bestLen) { bestLen = l; best = s.base; } }
  }
  return best;
}

const REGISTRY = { arin: 'ARIN', ripe: 'RIPE NCC', apnic: 'APNIC', lacnic: 'LACNIC', afrinic: 'AFRINIC' };
const RDAP_INIT = { headers: { accept: 'application/rdap+json, application/json' } };

// Shared readers for RDAP objects. Entities nest (ARIN puts abuse under the org; registrars put it
// under the registrar), so they are flattened first. Contact details live in jCard (vcardArray).
function flatEntities(list) { const out = []; (function walk(l) { for (const e of l || []) { if (e && typeof e === 'object') { out.push(e); walk(e.entities); } } })(list); return out; }
const vprop = (e, k) => ((e.vcardArray || [])[1] || []).find(x => Array.isArray(x) && x[0] === k) || null;
const vget = (e, k) => { const prop = vprop(e, k); return prop ? prop[3] : null; };
const vstr = v => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.filter(x => typeof x === 'string').join(' ').trim() : '') || null;
const hasRole = (e, role) => Array.isArray(e.roles) && e.roles.includes(role);
const clean = (s, n = 200) => (s ? String(s).slice(0, n) : null);
// Plain addresses only: no "?", "&" or "=" (which would add fields to a mailto: link). Length is
// checked before the pattern so a hostile registry can't feed it a huge string.
const EMAIL_RE = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
const validEmail = e => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
function contact(e) {                                    // { email, phone, handle } with the email validated
  if (!e) return null;
  const email = vstr(vget(e, 'email')), tel = vstr(vget(e, 'tel'));
  return {
    email: validEmail(email) ? email : null,
    phone: tel ? tel.replace(/^tel:/i, '').slice(0, 40) : null,
    handle: clean(e.handle),
  };
}
const eventDate = (o, a) => { const e = (Array.isArray(o && o.events) ? o.events : []).find(x => x && x.eventAction === a); return e && typeof e.eventDate === 'string' ? e.eventDate.slice(0, 40) : null; };
async function readJson(r, max = 1_000_000) {           // registries are trusted, but not that trusted
  const declared = Number(r.headers.get('content-length'));
  if (declared > max) { if (r.body) r.body.cancel(); throw new Error('rdap response too large'); }
  if (!r.body) return JSON.parse(await r.text());
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (;;) {                                             // stop reading as soon as the cap is passed
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel(); throw new Error('rdap response too large'); }
    parts.push(value);
  }
  const buf = new Uint8Array(n); let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return JSON.parse(new TextDecoder().decode(buf));
}

async function rdapLookup(target, origin) {
  const query = target.asn ? 'AS' + target.asn : target.ip;
  const kind = target.asn ? 'asn' : 'ip';
  const tail = target.asn ? 'autnum/' + target.asn : 'ip/' + target.ip;
  let base;
  try { base = await rdapBase(target, origin); }
  catch (e) {
    console.error('[ipterm] IANA bootstrap unavailable, using rdap.org:', String((e && e.message) || e));
    base = 'https://rdap.org/';
  }
  if (!base) return { query, kind, found: false };
  const url = base + tail;
  const r = await fetchRetry(url, RDAP_INIT, 'rdap');
  if (r.status === 404) return { query, kind, found: false };
  if (!r.ok) throw new Error('rdap ' + r.status);
  const o = await readJson(r);

  const ents = flatEntities(o.entities);
  const str = vstr, has = hasRole;
  const registrants = ents.filter(e => has(e, 'registrant'));
  const org = registrants.find(e => vget(e, 'kind') === 'org') || registrants[0] || ents.find(e => has(e, 'administrative'));
  const abuse = ents.find(e => has(e, 'abuse'));
  const ev = a => eventDate(o, a);
  const remark = (o.remarks || []).find(x => !x.title || /^description$/i.test(x.title));
  const host = (() => { try { return new URL(r.url || url).hostname; } catch { return ''; } })();
  const reg = Object.keys(REGISTRY).find(k => host.includes(k));

  return {
    query, kind, found: true, source: 'rdap',
    registry: reg ? REGISTRY[reg] : host || null,
    handle: clean(o.handle),
    name: clean(o.name),
    type: clean(o.type),
    country: clean(o.country),
    range: kind === 'ip' && o.startAddress ? { start: clean(o.startAddress), end: clean(o.endAddress) } : null,
    asnRange: kind === 'asn' && o.startAutnum ? { start: o.startAutnum, end: o.endAutnum } : null,
    cidrs: (o.cidr0_cidrs || []).map(c => `${c.v4prefix || c.v6prefix}/${c.length}`).filter(c => /^[0-9a-f.:]+\/\d{1,3}$/i.test(c)).slice(0, 8),
    org: clean(org && (str(vget(org, 'fn')) || str(vget(org, 'org')) || org.handle)),
    abuse: contact(abuse),
    registered: ev('registration'),
    updated: ev('last changed'),
    description: remark ? clean((remark.description || []).filter(x => typeof x === 'string').join(' · ')) : null,
    rdapUrl: url,
  };
}

/* ---------- domain whois (RDAP) ---------- */
// Domains have two layers: the registry that runs the extension (Verisign for .com, PIR for .org)
// and the registrar the owner bought it from. The registry answers with dates, status and name
// servers, and links to the registrar's own RDAP record, which usually adds the abuse contact and
// whatever owner details are published (most are redacted for privacy since GDPR).

// Names reserved for local or special use (RFC 6761 and friends): no registry holds them.
const SPECIAL_TLDS = new Set(['local', 'localhost', 'test', 'invalid', 'example', 'internal', 'lan', 'home', 'corp', 'arpa', 'onion', 'alt', 'localdomain', 'intranet', 'private']);
const DOMAIN_REGISTRIES = [[/verisign/, 'Verisign'], [/publicinterestregistry|\.pir\.org/, 'Public Interest Registry'], [/nominet/, 'Nominet'],
  [/identitydigital|donuts/, 'Identity Digital'], [/charlestonroadregistry|registry\.google/, 'Google Registry'], [/centralnic/, 'CentralNic'],
  [/afilias/, 'Identity Digital'], [/godaddy|registry\.co/, 'GoDaddy Registry'], [/cira\.ca/, 'CIRA'], [/auda|\.au\//, 'auDA']];
const PRIVACY_RE = /redact|privacy|withheld|not disclosed|data protected|gdpr|proxy|statutory masking|non-public|not available/i;

async function domainBase(name, origin) {               // longest matching TLD in IANA's dns.json
  let best = null, bestLen = 0;
  for (const s of await bootstrap('dns', origin)) {
    for (const t of s.ranges) {
      const tl = String(t).toLowerCase();
      if ((name === tl || name.endsWith('.' + tl)) && tl.length > bestLen) { best = s.base; bestLen = tl.length; }
    }
  }
  return best;
}

// The registrar link comes from registry data, so only follow it to an ordinary public https host.
function safeRdapLink(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
    const h = u.hostname.replace(/\.$/, '');
    if (!h.includes('.') || parseIp(h.replace(/^\[|\]$/g, '')) || /(^|\.)(localhost|local|internal|arpa)$/i.test(h)) return null;
    return u.href;
  } catch { return null; }
}

function registryName(url) {
  let h = ''; try { h = new URL(url).hostname; } catch {}
  const m = DOMAIN_REGISTRIES.find(([re]) => re.test(h) || re.test(url));
  return m ? m[1] : (h || null);
}

function nsName(v) {
  const n = String(v || '').toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9])?$/.test(n) && n.includes('.') ? n : null;
}

async function domainLookup(name, origin) {
  const tld = name.split('.').pop();
  const base0 = { query: name, kind: 'domain', domain: name, tld };
  if (SPECIAL_TLDS.has(tld) || name.endsWith('.home.arpa')) {
    return { ...base0, found: false, reason: 'special',
      message: `.${tld} is reserved for local or special use, so no public registry holds ${name}.` };
  }
  let base, viaFallback = false;
  try { base = await domainBase(name, origin); }
  catch (e) {
    console.error('[ipterm] IANA bootstrap unavailable, using rdap.org:', String((e && e.message) || e));
    base = 'https://rdap.org/'; viaFallback = true;
  }
  if (!base) {
    return { ...base0, found: false, reason: 'no-rdap',
      message: `The .${tld} registry doesn't publish RDAP, so ipterm can't read its records. Its own website usually has a whois search.` };
  }

  // The registry only knows registered names: www.example.co.uk -> try example.co.uk, then co.uk.
  const labels = name.replace(/^www\./, '').split('.');
  const tries = [];
  for (let i = Math.max(0, labels.length - 3); i <= labels.length - 2; i++) tries.push(labels.slice(i).join('.'));
  if (!tries.length) tries.push(name);
  let o = null, url = null, used = null;
  for (const c of tries) {
    url = base + 'domain/' + c;                          // c is a validated, punycoded host name
    const r = await fetchRetry(url, RDAP_INIT, 'rdap');
    if (r.status === 404 || r.status === 400) { if (r.body) r.body.cancel(); continue; }
    if (!r.ok) throw new Error('rdap ' + r.status);
    o = await readJson(r); used = c; break;
  }
  const registry = viaFallback ? null : registryName(base);
  if (!o) {
    return { ...base0, domain: tries[0], found: false, reason: viaFallback ? 'unknown' : 'not-registered', registry,
      message: viaFallback ? `No registry record was found for ${name}.`
        : `The ${registry || '.' + tld} registry has no record of ${tries[0]}. It is most likely unregistered (or reserved).` };
  }

  // Follow the registrar's RDAP record when the registry links to it (best effort, short timeout).
  let rr = null;
  const rel = (Array.isArray(o.links) ? o.links : []).find(l => l && l.rel === 'related' && typeof l.href === 'string' &&
    (l.type ? /json/i.test(l.type) : /\/domain\//i.test(l.href)));
  const relUrl = rel && safeRdapLink(rel.href);
  if (relUrl && relUrl !== url) {
    try {
      // redirect: 'manual' so the checks above can't be sidestepped by a redirect elsewhere
      const r2 = await fetch(relUrl, { ...RDAP_INIT, redirect: 'manual', signal: AbortSignal.timeout(4000) });
      if (r2.status === 200) rr = await readJson(r2, 500_000); else if (r2.body) r2.body.cancel();
    } catch (e) { /* registrar details are a bonus; the registry record stands on its own */ }
  }
  return parseDomain(o, rr, { ...base0, domain: used, registry, rdapUrl: url, registrarRdapUrl: rr ? relUrl : null });
}

function parseDomain(o, rr, d) {
  const regEnts = flatEntities(o.entities), rrEnts = rr ? flatEntities(rr.entities) : [];
  const all = [...regEnts, ...rrEnts];
  const registrar = all.find(e => hasRole(e, 'registrar'));
  const ianaId = registrar && (Array.isArray(registrar.publicIds) ? registrar.publicIds : [])
    .find(x => x && /iana/i.test(String(x.type || '')) && /^\d{1,7}$/.test(String(x.identifier || '')));
  // abuse: prefer the registrar's own record, then the registry's copy
  const abuse = rrEnts.find(e => hasRole(e, 'abuse')) || regEnts.find(e => hasRole(e, 'abuse'));
  // registrant: usually only in the registrar's record, usually redacted
  const regt = rrEnts.find(e => hasRole(e, 'registrant')) || regEnts.find(e => hasRole(e, 'registrant'));
  let registrant = null, registrantCountry = null;
  if (regt) {
    const nm = vstr(vget(regt, 'org')) || vstr(vget(regt, 'fn'));
    if (nm && !PRIVACY_RE.test(nm)) registrant = clean(nm, 120);
    const adr = vprop(regt, 'adr');
    const cc = adr && ((adr[1] && typeof adr[1].cc === 'string' && adr[1].cc) || (Array.isArray(adr[3]) && typeof adr[3][6] === 'string' && adr[3][6]));
    if (cc && !PRIVACY_RE.test(cc) && /^[\p{L} .'-]{2,60}$/u.test(cc.trim())) registrantCountry = cc.trim();
  }
  const ev = a => eventDate(o, a) || eventDate(rr, a);
  const ldh = nsName(o.ldhName) || d.domain;
  const uni = typeof o.unicodeName === 'string' && o.unicodeName.toLowerCase() !== ldh ? clean(o.unicodeName.toLowerCase(), 253) : null;
  const status = [...new Set((Array.isArray(o.status) ? o.status : []).filter(x => typeof x === 'string').map(x => x.trim().toLowerCase().slice(0, 60)))].slice(0, 12);
  const ns = [...new Set((Array.isArray(o.nameservers) ? o.nameservers : []).map(n => nsName(n && n.ldhName)).filter(Boolean))].slice(0, 13);
  const sd = o.secureDNS && typeof o.secureDNS === 'object' ? o.secureDNS : null;
  return {
    query: d.query, kind: 'domain', found: true, source: 'rdap',
    domain: ldh, unicodeName: uni, tld: d.tld, registry: d.registry,
    registrar: registrar ? { name: clean(vstr(vget(registrar, 'fn')) || vstr(vget(registrar, 'org')) || registrar.handle, 120), ianaId: ianaId ? String(ianaId.identifier) : null } : null,
    registered: ev('registration'), expires: ev('expiration'), updated: ev('last changed'),
    status, nameservers: ns,
    dnssec: sd ? sd.delegationSigned === true : null,
    registrant, registrantCountry, registrantHidden: !registrant,
    abuse: contact(abuse),
    rdapUrl: d.rdapUrl, registrarRdapUrl: d.registrarRdapUrl,
  };
}

/* ---------- pages ---------- */

let SHELL = null;
async function loadShell(io) {
  if (SHELL) return SHELL;
  const r = await io.env.ASSETS.fetch(new Request(new URL('/', io.url)));
  const t = await r.text();
  if (r.ok && t.includes('<!--STATIC-->')) SHELL = t;
  return t;
}

// Fills the terminal page with a title, description, share tags, a static summary that works
// without JavaScript (and for search engines), and the data the terminal boots from. Pages other
// than the homepage get their own h1 (the title without " | ipterm") in place of the generic one.
// noindex: a working page that search engines should skip (ports without an explainer of their own).
async function shell(io, { status = 200, title, desc, path = '/', body = '', initial = null, cache = null, noindex = false }) {
  let h = await loadShell(io);
  const canonical = io.url.origin + (path === '/' ? '/' : encodePath(path));
  // Replacements use functions: with a plain string, "$`", "$'" and "$&" in page text (which can come
  // from a URL or upstream data) would be expanded into copies of the page.
  if (title) h = h.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`);
  if (desc) h = h.replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(desc)}">`);
  const ogTitle = title || 'ipterm · IP address lookup';
  const ogDesc = desc || 'See your IP address, network and approximate location, or look up any IP or ASN.';
  const head = [
    status < 400 ? `<link rel="canonical" href="${esc(canonical)}">` : '',   // error pages aren't indexed, so no canonical
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="ipterm">`,
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(ogDesc)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:image" content="${esc(io.url.origin)}/og.png">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    path === '/' ? homeJsonLd(io.url.origin) : status < 400 ? breadcrumbJsonLd(io.url.origin, path) : '',
    (status >= 400 && status !== 429) || noindex ? `<meta name="robots" content="noindex">` : '',
  ].filter(Boolean).join('\n');
  if (path !== '/') h = h.replace(/\s*<p class="intro">[\s\S]*?<\/p>/, '');   // the plain-English line is for the homepage
  const h1 = path !== '/' && title ? title.replace(/\s*\|\s*ipterm$/, '') : null;
  if (h1) h = h.replace(/<h1 class="sr-only">[^<]*<\/h1>/, () => `<h1 class="sr-only">${esc(h1)}</h1>`);
  // The homepage terminal shows the reader's own address (a crawler's, when a crawler renders it): never a snippet.
  if (path === '/') h = h.replace('<div id="out"', () => '<div id="out" data-nosnippet');
  h = h.replace('<!--SEO-->', () => head).replace('<!--STATIC-->', () => body).replaceAll('%ORIGIN%', () => io.url.origin);
  if (initial) h = h.replace('<!--INITIAL-->', () => `<script type="application/json" id="ipterm-initial">${safeJson(initial)}</script>`);
  return new Response(h, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache || (status === 200 ? 'public, max-age=300' : 'no-store'),
      vary: 'Accept, User-Agent',
    },
  });
}

// The homepage answers "what is my IP" in its HTML: the number is there on first paint (and without
// JavaScript), and the terminal draws the same data without asking the API again. The page is
// personal, so no shared cache may keep it. If the lookup fails (rate limited, say), the plain shell
// goes out and the terminal asks for itself, as before. So does a prefetch or prerender: it may come
// through a proxy (Chrome's private prefetch proxy, from search results) or be shown minutes later,
// and either way the address it would carry might not be the visitor's.
async function homePage(io) {
  const cache = 'private, no-store';
  const purpose = io.request.headers.get('sec-purpose') || io.request.headers.get('purpose') || '';
  if (io.request.method === 'HEAD' || /prefetch|prerender/i.test(purpose)) return shell(io, { status: 200, cache });
  let d = null;
  try { d = await selfInfo(io, true); } catch {}
  const p = d && parseIp(d.ip);
  if (!p) return shell(io, { status: 200, cache });
  return shell(io, { status: 200, cache, initial: { kind: 'self', data: d }, body: homeStatic(d, p) });
}

// The top of what the terminal draws for whoami (boot lines, heading, an empty map frame of the same
// size, then the same rows in the same order down to the location), so swapping it for the live
// terminal doesn't move anything. Parts that only make sense with scripts (the map frame, the other IP
// version still "checking") are hidden without them (app.css). Kept out of search snippets, since a
// crawler would see its own address here. Matches boot() and render() in app.js.
function homeStatic(d, p) {
  const ctry = d.country ? d.country + (d.countryCode ? ` [${d.countryCode}]` : '') : d.countryCode;
  const place = [d.city, d.region, ctry].filter(Boolean).join(', ');
  const city = d.lat != null && d.lon != null;
  const map = city || d.countryCode
    ? `<figure class="geo" aria-hidden="true"><canvas></canvas><figcaption class="geo-cap"><span>${esc(city ? 'approximate area' : 'country-level only · ' + (d.country || d.countryCode))}</span></figcaption></figure>`
    : '';
  const link = (href, text) => `<a class="cmd" href="${esc(encodePath(href))}">${esc(text)}</a>`;
  const row = (k, html, cls = '') => `<dt${cls ? ` class="${cls}${cls === 'js-only' ? '' : 'l'}"` : ''}>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${html}</dd>`;
  const pub = !nonPublicReason(p);
  const asn = /^AS\d{1,10}$/.test(d.asn || '') ? d.asn : null;
  const host = d.hostname ? (normalizeDomain(d.hostname) ? link('/dns/' + d.hostname, d.hostname) : esc(d.hostname))
    : d.ptrTimedOut ? 'reverse DNS was slow to answer: ' + link('/dns/' + d.ip, 'dig ' + d.ip) : null;
  const net = (asn ? link('/' + asn, asn) : d.asn ? esc(d.asn) : '') + (d.org ? (d.asn ? '  ' : '') + esc(d.org) : '');
  return `<div class="static" id="static" data-nosnippet>` +
    `<div class="ln sys">ipterm 0.2 · IP address lookup</div><div class="ln sys">type help for commands, or enter any IP address, domain or ASN</div>` +
    `<div class="ln echo"><span class="ps1">guest@ipterm:~$ </span>whoami</div>` +
    `<div class="head"><span class="hip">whoami</span><span class="tag">IPv${p.v}</span><span class="tag ${pub ? 'pub' : 'priv'}">${pub ? 'public' : 'non-public'}</span><span class="tag">cloudflare edge</span></div>` +
    map + `<dl class="kv">` + row('your ip', esc(d.ip), 'big') +
    row('', 'This is your public IP address: the number websites and apps see when you connect. Its location is roughly where your internet provider is, not your home.', 'plain') +
    row(p.v === 4 ? 'IPv6' : 'IPv4', '<span class="ttl">checking…</span>', 'js-only') +
    (host ? row('hostname', host) : '') + (net ? row('network', net) : '') +
    (net && pub ? row('registry', link('/whois/' + d.ip, 'whois ' + d.ip)) : '') +
    (place ? row('location', esc(place)) : '') + `</dl></div>`;
}

function homeJsonLd(origin) {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'ipterm', url: origin + '/' },
      { '@type': 'WebApplication', name: 'ipterm', url: origin + '/', applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript for the terminal; results are also available as plain pages and JSON.',
        description: 'Terminal-style lookup for your IP address, any IPv4 or IPv6 address, and any network (ASN).',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
    ],
  };
  return `<script type="application/ld+json">${safeJson(ld)}</script>`;
}

// Search-result breadcrumbs: ipterm › tool › this page (/whois/example.com), or ipterm › this page
// for IP and ASN pages. A data block, not a script, so the CSP doesn't need to allow it.
function breadcrumbJsonLd(origin, path) {
  const [first, ...rest] = path.split('/').filter(Boolean);
  const tool = Object.hasOwn(TOOLS, first) ? first : null;
  const crumbs = [['ipterm', '/']];
  if (tool) crumbs.push([TOOLS[tool].heading, '/' + tool]);
  if (!tool || rest.length) crumbs.push([tool ? (tool === 'port' ? 'port ' : '') + rest.join(tool === 'cidr' ? '/' : ' ') : first, path]);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: origin + encodePath(p) })),
  };
  return `<script type="application/ld+json">${safeJson(ld)}</script>`;
}

// Plain-language summary of IPinfo Core's flags (only present on the Core plan).
function connectionText(d) {
  const f = d.flags || {}, out = [];
  if (f.hosting || d.asType === 'hosting') out.push('hosting or data center');
  if (f.mobile) out.push('mobile network');
  if (f.satellite) out.push('satellite');
  if (f.anycast) out.push('anycast (served from many locations)');
  if (!out.length && d.asType === 'isp') out.push('home or business internet provider');
  return out.length ? out.join(' · ') : null;
}

// VPN / proxy verdict. Only Core and proxycheck.io check for it, and a clean result is not proof:
// VPN providers keep adding fresh addresses that no list knows yet. Kept in step with app.js
// (pcKnown, pcFlag, vpnKind, vpnText there).
// "yes" needs Core's flag or a specific proxycheck.io finding: VPN, proxy, Tor or a named service.
// proxycheck.io's own "anonymous" is a catch-all ("any kind of anonymising service (proxy, VPN,
// TOR, etc.)" in its API reference) that is also set on addresses that are none of those, such as
// Google Public DNS (8.8.8.8). Alone, it gets a hedged line, and so does "compromised" (seen
// performing attacks, which doesn't by itself mean the address relays anyone's traffic).
const pcKnown = pc => !!(pc && pc.anonymous && (pc.vpn || pc.proxy || pc.tor || pc.operator));
const pcFlag = pc => (pc.compromised ? 'flagged by proxycheck.io as compromised (seen performing attacks)' : 'flagged as anonymizing by proxycheck.io') +
  ', but not as a known VPN, proxy or Tor service';
const vpnKind = pc => (pcKnown(pc) ? (pc.tor ? 'Tor' : pc.vpn ? 'VPN' : pc.proxy ? 'proxy' : 'VPN, proxy or Tor') : 'VPN, proxy or Tor');
function vpnText(d) {
  const core = d.source === 'ipinfo-core' && d.flags ? d.flags : null, pc = d.privacy || null;
  if (!core && !pc) return 'not checked (detailed data unavailable for this lookup)';
  if ((core && core.anonymous) || pcKnown(pc)) return `yes: a known ${vpnKind(pc)} address` + (pc && pc.operator ? ` (${pc.operator})` : '');
  if (pc && pc.anonymous) return pcFlag(pc);
  const hosting = (core && core.hosting) || d.asType === 'hosting' || (pc && pc.hosting);
  return 'not on known VPN or proxy lists' + (hosting
    ? ', but it is a hosting network, which VPN servers usually use'
    : ' (not a guarantee: new VPN servers are often unlisted)');
}

function ipPage(io, d, status) {
  const ip = d.ip, v = 'IPv' + d.version;
  const path = '/' + ip;
  if (d.error) {
    return shell(io, { status, path, title: `${ip} | ipterm`, initial: { kind: 'ip', query: ip, error: d.error },
      body: staticBlock(`${ip}`, [v], [], d.error) });
  }
  if (d.bogon) {
    const priv = /RFC 1918|unique local/.test(d.range || '');
    const summary = `${ip} is a non-public ${v} address in the ${d.range}. It is used inside local networks and cannot be reached or located from the internet.` +
      (priv ? ` If it is your router's address, open http://${d.version === 6 ? '[' + ip + ']' : ip} in a browser on the same network to reach its settings.` : '');
    return shell(io, { status, path, title: `${ip} · private ${v} address | ipterm`, desc: summary,
      initial: { kind: 'ip', query: ip, data: d }, body: staticBlock(ip, [v, 'private'], [['range', d.range]], summary,
        `<p class="ln sys">Guides: <a href="/guides/find-router-ip">How to find your router's IP address</a> · <a href="/guides/private-ip-ranges">Private IP address ranges explained</a></p>`) });
  }
  const place = [d.city, d.region, d.country || d.countryCode].filter(Boolean).join(', ');
  const owner = [d.org, d.asn ? `(${d.asn})` : ''].filter(Boolean).join(' ');
  const summary = `${ip} is a public ${v} address` + (owner ? ` operated by ${owner}` : '') + (place ? `, located in ${place}` : '') +
    (d.hostname ? `. Hostname: ${d.hostname}` : '') + '. IP location is approximate.';
  const title = [ip, d.hostname, owner || null].filter(Boolean).join(' · ') + ' | ipterm';
  const rows = [
    ['hostname', d.hostname], ['network', owner], ['domain', d.asDomain], ['location', place],
    ['coordinates', d.lat != null && d.lon != null ? `${d.lat}, ${d.lon}` : null], ['time zone', d.timezone],
    ['connection', connectionText(d)], ['vpn / proxy', vpnText(d)],
  ];
  const links = (/^AS\d{1,10}$/i.test(d.asn || '') ? `<p class="ln sys">More from this network: <a href="/${esc(d.asn)}">${esc(d.asn)}${d.org ? ' ' + esc(d.org) : ''}</a></p>` : '') +
    `<p class="ln sys">Registry record: <a href="/whois/${esc(ip)}">whois ${esc(ip)}</a> (owner and abuse contact)</p>` +
    `<p class="ln sys">Guide: <a href="/guides/what-your-ip-reveals">What your IP address reveals (and what it doesn't)</a></p>`;
  return shell(io, { status, path, title, desc: summary, initial: { kind: 'ip', query: ip, data: d },
    body: staticBlock(ip, [v, 'public'], rows, summary, links) });
}

function cidrPage(io, d, status) {
  if (d.error) {
    return shell(io, { status, path: '/cidr/' + String(d.input || '').slice(0, 60), title: 'Subnet calculator | ipterm',
      initial: { kind: 'cidr', query: String(d.input || ''), error: d.error }, body: staticBlock('Subnet calculator', ['cidr'], [], d.error) });
  }
  const path = '/cidr/' + d.cidr;                        // canonical: the network address, not the host that was typed
  let summary, title, rows;
  if (d.v === 4) {
    summary = `${d.cidr} has netmask ${d.netmask} (wildcard ${d.wildcard}), ${d.totalText} addresses and ${d.usableText} usable host${d.usable === 1 ? '' : 's'}` +
      (d.prefix <= 30 ? ` from ${d.first} to ${d.last}, with broadcast address ${d.broadcast}` : '') + `. It is in the ${d.rangeNote}.`;
    title = `${d.cidr} subnet: ${d.netmask}, ${d.usableText} usable hosts | ipterm`;
    rows = [['network', d.cidr], ['netmask', d.netmask], ['wildcard', d.wildcard], ['broadcast', d.prefix <= 30 ? d.broadcast : null],
      ['usable hosts', `${d.first} – ${d.last}`], ['host count', `${d.usableText} usable · ${d.totalText} addresses`],
      ['splits into', d.halves && d.halves.join(' · ')], ['part of', d.supernet], ['range', d.rangeNote], ['legacy class', d.legacyClass]];
  } else {
    summary = `${d.cidr} is an IPv6 block of ${d.totalPow} (${d.totalText}) addresses, from ${d.network} to ${d.last}` +
      (d.subnets64 ? `, containing ${d.subnets64} /64 subnet${d.subnets64 === '1' ? '' : 's'}` : '') + `. It is in ${d.rangeNote}.`;
    title = `${d.cidr} IPv6 subnet | ipterm`;
    rows = [['network', d.cidr], ['first address', d.network], ['last address', d.last], ['addresses', `${d.totalPow} = ${d.totalText}`],
      ['/64 subnets', d.subnets64], ['expanded', d.expanded], ['splits into', d.halves && d.halves.join(' · ')], ['part of', d.supernet], ['range', d.rangeNote]];
  }
  const links = `<p class="ln sys">Guide: <a href="/guides/subnet-cheat-sheet">Subnet mask cheat sheet</a>` +
    (d.range === 'public' ? ` · Registry: <a href="/whois/${esc(d.network)}">whois ${esc(d.network)}</a>` : '') + `</p>`;
  return shell(io, { status, path, title, desc: summary, initial: { kind: 'cidr', query: d.cidr, data: d },
    body: staticBlock(`Subnet ${d.cidr}`, ['cidr', 'IPv' + d.v, d.range], rows, summary, links) });
}

function dnsPage(io, d, status) {
  const name = d.name, single = d.types && d.types.length === 1 ? d.types[0] : null;
  const path = '/dns/' + name + (single && !(single === 'PTR' && parseIp(name)) ? '/' + single : '');
  if (d.error || d.status === 'NXDOMAIN' || (d.status && d.status !== 'NOERROR')) {
    const msg = d.error || (d.status === 'NXDOMAIN' ? `${name} does not exist (NXDOMAIN): no DNS records were found.` : `The DNS lookup for ${name} returned ${d.status}.`);
    return shell(io, { status, path, title: `${name} DNS | ipterm`, initial: { kind: 'dns', query: name, qtype: single, ...(d.status ? { data: d } : { error: msg }) },
      body: staticBlock(`DNS: ${name}`, ['dns'], [], msg) });
  }
  const R = d.records || {}, vals = t => (R[t] || []).map(r => (t === 'MX' ? mxText(r) : r.value));
  const mail = (R.MX || []).filter(r => !nullMx(r)).map(r => r.value);
  const list = (a, n = 3) => a.slice(0, n).join(', ') + (a.length > n ? ` and ${a.length - n} more` : '');
  let summary;
  if (parseIp(name)) summary = R.PTR ? `The reverse DNS (PTR) name for ${name} is ${list(vals('PTR'))}.` : `${name} has no reverse DNS (PTR) record.`;
  else {
    // The first clause names the domain (a one-type page, /dns/gmail.com/MX, has no A records to lead with).
    const parts = [], add = (first, later) => parts.push(parts.length ? later : first);
    if (R.A || R.AAAA) parts.push(`${name} resolves to ${list([...vals('A'), ...vals('AAAA')])}`);
    if (d.cname && d.cname.length) add(`${name} is an alias of ${d.cname[0]}`, `it is an alias of ${d.cname[0]}`);
    if (R.MX) add(mail.length ? `Mail for ${name} is handled by ${list(mail, 2)}` : `${name} accepts no mail (null MX)`,
      mail.length ? `mail is handled by ${list(mail, 2)}` : 'it accepts no mail (null MX)');
    if (R.NS) add(`The name servers for ${name} are ${list(vals('NS'), 2)}`, `name servers are ${list(vals('NS'), 2)}`);
    // Other one-type pages (TXT, CAA, SOA...): how many there are, rather than claiming there are none.
    const n = single && !['A', 'AAAA', 'MX', 'NS'].includes(single) && R[single] ? R[single].length : 0;
    if (n) add(`${name} has ${n} ${single} record${n === 1 ? '' : 's'}`, `it has ${n} ${single} record${n === 1 ? '' : 's'}`);
    summary = (parts.length ? parts.join('; ') : `${name} has no ${single || 'common'} records`) + '.' +
      (d.hosting && d.hosting.org ? ` Hosted by ${d.hosting.org}${d.hosting.asn ? ` (${d.hosting.asn})` : ''}.` : '') +
      (d.dnssec ? ' DNSSEC: validated.' : '');
  }
  const rows = [];
  if (d.cname && d.cname.length) rows.push(['alias of', d.cname.join(' → ')]);
  for (const t of d.types) if (R[t]) rows.push([t, vals(t).join(' · ')]);
  if (d.hosting && d.hosting.org) rows.push(['hosted by', `${d.hosting.org}${d.hosting.asn ? ' (' + d.hosting.asn + ')' : ''}`]);
  rows.push(['DNSSEC', d.dnssec ? 'validated' : 'not validated']);
  const links = (d.hosting ? `<p class="ln sys">First address: <a href="/${esc(d.hosting.ip)}">${esc(d.hosting.ip)}</a> · <a href="/whois/${esc(d.hosting.ip)}">whois</a></p>` : '') +
    (!parseIp(name) ? `<p class="ln sys">Registration: <a href="/whois/${esc(name)}">whois ${esc(name)}</a> (registrar, dates, status)</p>` : '');
  const typesTitle = single ? `${single} record` : 'DNS records';
  return shell(io, { status, path, title: `${name} ${typesTitle}` + (R.A ? ` · ${R.A[0].value}` : '') + ' | ipterm', desc: summary,
    initial: { kind: 'dns', query: name, qtype: single, data: d },
    body: staticBlock(`DNS: ${name}${single ? ' ' + single : ''}`, ['dns', d.dnssec ? 'dnssec' : 'unsigned'], rows, summary, links) });
}

function whoisPage(io, d, status) {
  if (d.kind === 'domain' && d.found) return domainWhoisPage(io, d, status);
  const q = d.query, path = '/whois/' + q;
  const date = s => (s ? String(s).slice(0, 10) : null);
  if (d.error || d.bogon || !d.found) {
    const msg = d.error || (d.bogon ? `${q} is a non-public address (${d.range}), so no internet registry holds a record for it.`
      : d.message || `No registry record was found for ${q}.`);
    const keep = d.bogon || (d.kind === 'domain' && !d.error);     // let the terminal explain it in its own words
    return shell(io, { status, path, title: `whois ${q} | ipterm`, initial: { kind: 'whois', query: q, ...(keep ? { data: d } : { error: msg }) },
      body: staticBlock(`whois ${q}`, ['whois'], [], msg, d.bogon ? `<p class="ln sys">Guide: <a href="/guides/private-ip-ranges">Private IP address ranges explained</a></p>` : '') });
  }
  const block = (d.cidrs || []).join(', ') || (d.range ? `${d.range.start} – ${d.range.end}` : null);
  const summary = `${q} is registered` + (d.org ? ` to ${d.org}` : '') + (d.registry ? ` through ${d.registry}` : '') +
    (block && d.kind === 'ip' ? `, as part of ${block}` : '') + '.' +
    (d.abuse && d.abuse.email ? ` Abuse reports go to ${d.abuse.email}.` : '');
  const rows = [
    ['owner', d.org], ['network name', d.name], ['handle', d.handle && !/ - /.test(d.handle) ? d.handle : null], ['registry', d.registry],
    ['address block', block], ['range', d.range ? `${d.range.start} – ${d.range.end}` : null], ['type', d.type], ['country', d.country],
    ['registered', date(d.registered)], ['last changed', date(d.updated)],
    ['abuse email', d.abuse && d.abuse.email], ['abuse phone', d.abuse && d.abuse.phone], ['description', d.description],
  ];
  const back = d.kind === 'asn' ? `<a href="/${esc(q)}">${esc(q)} network details</a>` : `<a href="/${esc(q)}">${esc(q)} location and network</a>`;
  return shell(io, { status, path, title: `whois ${q}` + (d.org ? ` · ${d.org}` : '') + ' | ipterm', desc: summary,
    initial: { kind: 'whois', query: q, data: d },
    body: staticBlock(`whois ${q}`, ['whois', d.registry || 'rdap'], rows, summary,
      `<p class="ln sys">See also: ${back} · <a href="/guides/what-is-an-asn">What is an ASN?</a></p>`) });
}

const dayDiff = s => { const t = Date.parse(s); return Number.isFinite(t) ? Math.round((t - Date.now()) / 86400000) : null; };
function domainWhoisPage(io, d, status) {
  const q = d.domain, path = '/whois/' + q;
  const date = s => (s ? String(s).slice(0, 10) : null);
  const reg = d.registrar && d.registrar.name;
  const left = d.expires ? dayDiff(d.expires) : null;
  const ns = d.nameservers || [];
  const summary = `${q} was registered` + (d.registered ? ` on ${date(d.registered)}` : '') + (reg ? ` through ${reg}` : '') +
    (d.expires ? ` and ${left != null && left < 0 ? 'expired' : 'expires'} on ${date(d.expires)}` : '') + '.' +
    (ns.length ? ` Its name servers are ${ns.slice(0, 2).join(' and ')}${ns.length > 2 ? ` (and ${ns.length - 2} more)` : ''}.` : '') +
    (d.registrant ? ` Registrant: ${d.registrant.replace(/\.$/, '')}.` : ' Owner details are not published.') +
    (d.abuse && d.abuse.email ? ` Abuse reports go to ${d.abuse.email}.` : '');
  const rows = [
    ['domain', d.unicodeName ? `${q} (${d.unicodeName})` : q], ['registrar', reg ? reg + (d.registrar.ianaId ? ` (IANA ID ${d.registrar.ianaId})` : '') : null],
    ['registered', date(d.registered)], ['expires', d.expires ? date(d.expires) + (left != null ? (left < 0 ? ` (expired ${-left} days ago)` : ` (in ${left} days)`) : '') : null],
    ['last changed', date(d.updated)], ['status', (d.status || []).join(' · ')], ['name servers', ns.join(' · ')],
    ['DNSSEC', d.dnssec == null ? null : d.dnssec ? 'signed' : 'not signed'],
    ['registrant', d.registrant ? d.registrant + (d.registrantCountry ? ` (${d.registrantCountry})` : '') : 'not published (redacted for privacy)'],
    ['abuse email', d.abuse && d.abuse.email], ['abuse phone', d.abuse && d.abuse.phone], ['registry', d.registry],
  ];
  return shell(io, { status, path, title: `whois ${q}` + (reg ? ` · ${reg}` : '') + (d.expires ? ` · expires ${date(d.expires)}` : '') + ' | ipterm', desc: summary,
    initial: { kind: 'whois', query: q, data: d },
    body: staticBlock(`whois ${q}`, ['whois', 'domain', d.registry || 'rdap'], rows, summary,
      `<p class="ln sys">See also: <a href="/dns/${esc(q)}">DNS records for ${esc(q)}</a></p>`) });
}

function asnPage(io, d, status) {
  const path = '/' + d.asn;
  if (d.error || !d.found) {
    const msg = d.error || `${d.asn} has no registered holder or announced prefixes in RIPEstat.`;
    return shell(io, { status, path, title: `${d.asn} | ipterm`, initial: { kind: 'asn', query: d.asn, error: msg },
      body: staticBlock(d.asn, ['asn'], [], msg) });
  }
  const name = d.name || d.holder || d.asn;
  const summary = `${d.asn} (${name}) is an autonomous system` + (d.registry ? ` registered with ${d.registry}` : '') +
    `. It announces ${d.v4.count.toLocaleString('en-US')} IPv4 prefixes covering ${d.v4.addresses.toLocaleString('en-US')} addresses` +
    ` and ${d.v6.count.toLocaleString('en-US')} IPv6 prefixes.`;
  const rows = [
    ['holder', d.holder], ['registry', d.registry], ['announced', d.announced ? 'yes' : 'no'],
    ['IPv4 prefixes', d.v4.count.toLocaleString('en-US')], ['IPv4 addresses', d.v4.addresses.toLocaleString('en-US')],
    ['IPv6 prefixes', d.v6.count.toLocaleString('en-US')],
  ];
  // Prefixes link to the subnet calculator (no outside calls), not to an IP lookup of the network
  // address: crawlers following 30 links per ASN page would otherwise spend the IPinfo budget.
  const list = [...d.v4.prefixes.slice(0, 20), ...d.v6.prefixes.slice(0, 10)]
    .map(px => `<li><a href="/cidr/${esc(px)}">${esc(px)}</a></li>`).join('');
  const links = (list ? `<p class="ln sys">Largest announced prefixes:</p><ul class="static-list">${list}</ul>` : '') +
    `<p class="ln sys">Registry record: <a href="/whois/${esc(d.asn)}">whois ${esc(d.asn)}</a></p>` +
    `<p class="ln sys">Guide: <a href="/guides/what-is-an-asn">What is an ASN?</a></p>`;
  return shell(io, { status, path, title: `${d.asn} · ${name} | ipterm`, desc: summary,
    initial: { kind: 'asn', query: d.asn, data: d }, body: staticBlock(`${d.asn} · ${name}`, ['asn'], rows, summary, links) });
}

function staticBlock(heading, tags, rows, summary, extra = '') {
  const tagHtml = tags.map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
  const dl = rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<article class="static" id="static"><div class="head"><span class="hip">${esc(heading)}</span> ${tagHtml}</div>` +
    (dl ? `<dl class="kv">${dl}</dl>` : '') + `<p class="ln">${esc(summary)}</p>${extra}</article>`;
}

/* ---------- robots and sitemap ---------- */

const SITEMAP_PATHS = [
  // pages, tools and guides
  '/', '/whois', '/dns', '/cidr', '/leaktest', '/api', '/guides', '/guides/find-router-ip', '/guides/private-ip-ranges', '/guides/what-your-ip-reveals',
  '/guides/ipv4-vs-ipv6', '/guides/what-is-an-asn', '/privacy',
  // port checker: what each port is for (the pages never run a check themselves)
  '/port', '/port/22', '/port/80', '/port/443', '/port/3389', '/port/25565', '/port/32400', '/port/8080', '/port/27015', '/port/51820',
  // router and other private addresses people search for
  '/192.168.1.1', '/192.168.0.1', '/10.0.0.1', '/192.168.1.254', '/192.168.100.1', '/192.168.2.1', '/192.168.0.254',
  '/192.168.10.1', '/192.168.8.1', '/10.0.0.138', '/10.1.1.1', '/10.0.1.1', '/172.16.0.1', '/127.0.0.1', '/169.254.1.1',
  // public DNS resolvers
  '/8.8.8.8', '/8.8.4.4', '/1.1.1.1', '/1.0.0.1', '/9.9.9.9', '/149.112.112.112', '/208.67.222.222', '/208.67.220.220',
  '/94.140.14.14', '/2001:4860:4860::8888', '/2001:4860:4860::8844', '/2606:4700:4700::1111', '/2620:fe::fe',
  // well-known networks
  '/AS15169', '/AS13335', '/AS16509', '/AS14618', '/AS8075', '/AS32934', '/AS396982', '/AS14061', '/AS16276', '/AS24940',
  '/AS63949', '/AS20940', '/AS7922', '/AS701', '/AS7018', '/AS20115', '/AS22773', '/AS3356', '/AS174', '/AS2914',
  '/AS6939', '/AS1299', '/AS3257', '/AS6453', '/AS4134', '/AS4837',
  // subnet calculator
  '/guides/subnet-cheat-sheet', '/cidr/192.168.1.0/24', '/cidr/192.168.0.0/24', '/cidr/192.168.0.0/16', '/cidr/10.0.0.0/8', '/cidr/10.0.0.0/24',
  '/cidr/172.16.0.0/12', '/cidr/100.64.0.0/10', '/cidr/10.0.0.0/22', '/cidr/192.168.1.0/25', '/cidr/192.168.1.0/30', '/cidr/2001:db8::/32', '/cidr/2001:db8::/48',
  // DNS pages
  '/dns/google.com', '/dns/cloudflare.com', '/dns/github.com', '/dns/wikipedia.org', '/dns/example.com', '/dns/gmail.com/MX',
  // registry (whois) pages
  '/whois/google.com', '/whois/github.com', '/whois/cloudflare.com', '/whois/wikipedia.org', '/whois/example.com',
  '/whois/8.8.8.8', '/whois/1.1.1.1', '/whois/9.9.9.9', '/whois/208.67.222.222', '/whois/AS15169', '/whois/AS13335', '/whois/AS16509', '/whois/AS8075',
];

function robots(url) {
  return text(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url.origin}/sitemap.xml\n`, 'public, max-age=86400');
}

function sitemap(url) {
  const items = SITEMAP_PATHS.map(p => `  <url><loc>${esc(url.origin + encodePath(p))}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
  });
}

/* ---------- hardening ---------- */

const publicApi = env => String(env.PUBLIC_API || '').toLowerCase() === 'true';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.ipify.org https://api6.ipify.org",   // whoami: your address on the other IP version
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function secure(res, env) {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('content-security-policy', CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  h.set('cross-origin-opener-policy', 'same-origin');
  h.set('cross-origin-resource-policy', publicApi(env) ? 'cross-origin' : 'same-origin');
  h.set('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()');
  if (publicApi(env)) {
    h.set('access-control-allow-origin', '*');
    h.set('access-control-allow-methods', 'GET, OPTIONS');
  } else {
    h.delete('access-control-allow-origin');
    h.delete('access-control-allow-methods');
  }
  return out;
}

function nonPublicReason(p) {
  if (p.v === 4) {
    const [a, b, c] = p.o;
    if (a === 0) return '"this network" block (0.0.0.0/8)';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'RFC 1918 private range';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT range (100.64.0.0/10)';
    if (a === 127) return 'loopback range (127.0.0.0/8)';
    if (a === 169 && b === 254) return 'link-local range (169.254.0.0/16)';
    if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)';
    if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'documentation range (RFC 5737)';
    if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range (198.18.0.0/15)';
    if (a >= 224) return 'multicast or reserved range';
    return null;
  }
  const g = p.g;
  if (g.slice(0, 7).every(x => x === 0) && g[7] <= 1) return 'unspecified or loopback address';
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return 'IPv4-mapped address; look up the IPv4 address instead';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local range (fe80::/10)';
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique local range (fc00::/7)';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast range (ff00::/8)';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation range (2001:db8::/32)';
  return null;
}

/* ---------- helpers ---------- */

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function v6groups(s) {
  if (!/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
  const dbl = s.includes('::');
  const [h, t] = dbl ? s.split('::') : [s, ''];
  const hp = h ? h.split(':') : [];
  const tp = dbl && t ? t.split(':') : [];
  const fill = 8 - hp.length - tp.length;
  if (dbl ? fill < 1 : hp.length !== 8) return null;
  const g = [...hp, ...Array(dbl ? fill : 0).fill('0'), ...tp];
  if (g.length !== 8 || g.some(x => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  return g.map(x => parseInt(x, 16));
}

function parseIp(s) {
  s = (s || '').trim();
  if (V4.test(s)) return { v: 4, o: s.split('.').map(Number) };
  const g = v6groups(s);
  return g ? { v: 6, g } : null;
}

function countryName(cc) {
  if (!cc) return null;
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch { return cc; }
}

function num(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const encodePath = p => p.split('/').map(seg => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept, User-Agent', ...extra },
  });
}

function text(s, cache = 'no-store', status = 200, extra = {}) {
  return new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache, ...extra } });
}

// Same-site redirects. Some answers differ for browsers and curl (/help), hence the Vary.
function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'public, max-age=3600', vary: 'Accept, User-Agent' } });
}
