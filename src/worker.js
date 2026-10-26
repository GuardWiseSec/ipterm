// ipterm: Cloudflare Worker that serves the terminal page, the shareable IP and ASN pages, and the API.
//
// Routes (pages answer browsers with HTML and curl/scripts with JSON)
//   GET /                   the terminal, with your IP already in the page (curl/wget get it as plain text)
//   GET /ip                 your IP as plain text
//   GET /json               your IP details as JSON
//   GET /text               the same as aligned lines (/json?format=text without the ?)
//   GET /help               the command-line reference as plain text (browsers are sent to /api)
//   GET /asn, /org, /cc, /city, /tz, /colo   one value for your own address as plain text, from request.cf
//                           (no outside call); /hostname is the one that asks DNS (reverse lookup)
//   GET /me                 a terminal card for your own address with a Braille world map (src/me.js), from
//                           request.cf only (?w=<columns>, ?color=0, ?redact). Browsers are sent to /
//   GET /line               your IP, network, country and data center on one line (shell prompts, tmux)
//   GET /expect/<ASN|cc>    200 and the value if your address is on that network or in that country, else 412
//   GET /<ip>               page for any IPv4/IPv6 address        (add ?format=json to force JSON). Pages for
//                           non-public addresses are noindex, except the router and well-known ones in SITEMAP_PATHS;
//                           common typos of those (/192.168.l.l, /192,168,1,1) get a 301 to the address in the list.
//                           A network's first address (x.x.x.0, or an IPv6 /64's) is noindex too, unless it is listed
//   GET /<ip>/<field>       one value for any public address as plain text: asn, org, cc, country, continent,
//                           hostname. IPinfo Lite only (never Core or proxycheck.io), so no budget is spent
//   GET /<ip>/text, /<ip>/json, /AS<number>/text, /AS<number>/json   the same as ?format=text and ?format=json, without
//                           the ? that zsh takes for a wildcard in an unquoted URL. Not indexed (x-robots-tag)
//   GET /AS<number>         page for any autonomous system (ASN), with its main upstreams (add ?format=json for JSON).
//                           Pages for networks whose holder may be a private person are noindex (src/holder-heuristic.js),
//                           as are whois and /cidr pages that name one; indexed pages list such an upstream by number only
//   GET /api/lookup?ip=     IP details as JSON (no ip = yourself), used by the terminal
//   GET /api/asn?asn=       ASN details as JSON, used by the terminal
//   GET /whois/<ip|ASN|domain> registry record via RDAP: owner, address block and abuse contact for
//                           addresses and networks; registrar, dates, status and name servers for domains
//   GET /api/whois?q=       the same as JSON, used by the terminal
//   GET /dns/<name>[/TYPE]  DNS records for a domain (summary, or one record type) via Cloudflare's resolver
//   GET /api/dns?name=&type= the same as JSON, used by the terminal
//   GET /mail/<domain>      email security check: MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT and BIMI, graded A-F
//                           (?dkim=<selector> checks that DKIM selector as well as the common ones)
//   GET /api/mail?domain=&dkim= the same as JSON, used by the terminal
//   GET /grade/<domain>     domain report card, graded A-F: DNSSEC, IPv6, CAA and HTTPS records, the mail check's grade,
//                           expiry and transfer lock (RDAP), and the site's HTTPS redirect and security headers (one HEAD
//                           request to https://<domain>/ and one to http://<domain>/; see "domain report card" below)
//   GET /api/grade?domain=  the same as JSON, used by the terminal
//   GET /badge/<domain>.json  the grade as a shields.io endpoint badge ({ schemaVersion, label, message, color });
//   GET /badge/<domain>.svg   the same badge drawn by ipterm. Both cached for an hour
//   GET /cidr/<ip>/<prefix> subnet calculator page (also /api/cidr?q=). The calculation makes no outside calls; the
//                           page for a public prefix adds how it is routed (RIPEstat, see "routing" below; a bot
//                           sees it only when cached, routeData)
//   GET /route/<prefix|ip>  routing as JSON: origin network, RPKI, RIS visibility, sample AS paths (RIPEstat only,
//                           never IPinfo or proxycheck.io). Browsers are sent to the prefix's /cidr page
//   GET /api/route?q=       the same, used by the terminal (`route`)
//   GET /port/<n>           page explaining port n with a button to check it (browsers); command-line tools get
//                           the check itself. It only ever tests your own address (see "port check" below)
//   GET /api/port?n=        the check as JSON, used by the terminal (same-origin or command-line clients only)
//   GET /whois, /dns, /mail, /grade, /cidr, /leaktest, /port, /api  landing page for each tool (usage and examples); /api is
//                           the API docs, and command-line clients get the /help text there instead
//   GET /api/check          your own IP plus how IPinfo classifies it (VPN, hosting...) and whether it's a Tor exit,
//                           for the privacy check
//   GET /leaktest/r/<code>  a leak test result someone shared: the grade and per-check flags from the code alone
//                           (public/leakgrade.js), a "run yours" link, never a test run. noindex. JSON for curl
//   GET /api/dnsleak?t=     the DNS resolvers that looked up the page's random names, with their networks
//                           (same-origin or command-line clients only; off unless DNSLEAK_* is set up)
//   GET /go?q=              address-bar search: a 302 to the page for an IP, ASN, domain, range, email address,
//                           port or terminal command (OpenSearch: /opensearch.xml; the form on /api)
//   GET /robots.txt
//   GET /sitemap.xml        a sitemap index: /sitemap-pages.xml (SITEMAP_PATHS), /sitemap-ports.xml (every port page in
//                           public/ports.js, with its <lastmod>) and /sitemap-asn-<n>.xml, the largest networks in tiers
//                           (src/asn-sitemap.js, built by tools/build_asn_sitemap.mjs)
//   GET /status             for the owner: today's and this hour's IPinfo Core and proxycheck.io budget use, and
//                           each VPN server list's size and freshness. Needs the STATUS_KEY secret (x-status-key
//                           header or ?key=); without it, a 404
//   ?format=text            on /, /json, /<ip>, /AS<number>, /dns/..., /mail/..., /grade/..., /whois/..., /cidr/..., /route/..., /leaktest/r/...
//                           and their /api/ forms: the same answer as aligned key/value lines (like the terminal) instead of JSON
//   ?color=1                with a text answer: ANSI colors on the key column and the VPN / proxy verdict. Only when asked
//                           for (scripts pipe these answers into grep, awk and jq), and never on JSON
//   /openapi.json, /llms.txt, /opensearch.xml  static files describing the API and the search (served without
//                           running the Worker)
//   anything else: a static file if one exists, a domain-shaped path (/example.com) redirects to its
//   DNS page, and the rest gets a 404 page in the terminal's style
//   Plain-text answers never carry a sponsored line, and those with IPinfo data credit IPinfo.
//
// Data
//   Your own details: Cloudflare's request.cf (free, unlimited).
//   Other IPs: IPinfo. Set the IPINFO_TOKEN secret to use IPinfo Lite (free, unlimited,
//   country + ASN). Without a token it falls back to IPinfo's public endpoint
//   (city-level, ~1,000 requests/day, shared rate limit).
//   ASNs: RIPEstat (free, public, no key), including the main upstreams (asn-neighbours, read with a size cap).
//   Routing of a prefix: RIPEstat's prefix-overview, routing-status, rpki-validation and bgp-state (AS paths from
//   three RIS collectors only, rrcs=), cached six hours.
//   Registry records (whois): RDAP from the regional internet registries (addresses, networks) and the
//   domain registries and registrars (domains), all found via IANA's bootstrap files.
//   Reverse DNS: Cloudflare DNS-over-HTTPS.
//   Mail check: Cloudflare DNS-over-HTTPS, plus the domain's own MTA-STS policy file (https://mta-sts.<domain>).
//   Report card (grade): the DNS, mail and registry reads above, plus HEAD requests to the domain's own site.
//   DNS leak test: ipterm's own DNS server for DNSLEAK_ZONE (dnsleak-server/, on a VPS), plus IPinfo Lite.
//   Tor exits (leaktest): the Tor Project's exit list, cached for an hour per data center.
//   Known VPN servers: the VPN providers' own server lists (src/vpn-lists.js), and iCloud Private Relay: Apple's list of
//   its relays' addresses (src/relay-list.js), downloaded every 6 hours by the cron trigger into a Durable Object
//   (VpnServers); lookups search a copy in memory, so they cost nothing.
//
// Hardening
//   - Upstream lookups are cached; cache misses are rate limited per visitor IP (LOOKUP_LIMITER).
//   - Cross-site browser access (CORS) is off unless PUBLIC_API = "true".
//   - Private and other non-public addresses never reach a provider.
//   - Bots never spend the IPinfo Core or proxycheck.io budgets: they get the cache or IPinfo Lite (isBot). Nor do they
//     start routing lookups (RIPEstat's fair use): /cidr and /route give them cached routing or none (routeData).
//   - Redirects for router-address typos take their Location from SITEMAP_PATHS, never from the request.
//   - Over plain http, pages (browsers, crawlers, link previews) get a 301 to https on the same host; curl and scripts
//     are answered over http, and every link and cache key says https either way (route()).
//   - Every value placed into HTML is escaped; embedded JSON cannot close its script tag.
//   - Every response carries a strict Content-Security-Policy and related headers.

import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import '../public/cidr.js';                       // shared subnet calculator (also served to the page)
import '../public/ports.js';                      // what common ports are for (also served to the page)
import '../public/leakgrade.js';                  // the leak test's grade and share codes (also served to the page)
import { meCard, ME_WIDTH, ANSI, ansi } from './me.js';   // the /me card and its world map, and its colors
import { ASN_SITEMAP, ASN_SITEMAP_DATE } from './asn-sitemap.js';   // the largest networks, for /sitemap-asn-*.xml (generated)
import { holderOf, personReason } from './holder-heuristic.js';     // whether a network's holder may be a private person
import { VPN_PROVIDERS, VPN_MAX_AGE, VPN_FETCH_TIMEOUT, VPN_MAX_KEPT, toRecord, mergeRecord, packIndex, unpackIndex, isIndex, findServer } from './vpn-lists.js';
import { RELAY, parseRelayStream, packRelay, restampRelay, unpackRelay, isRelay, findRelay } from './relay-list.js';   // Apple's iCloud Private Relay list   // VPN providers' own server lists
// Pages that name a network holder who may be a private person are "noindex, follow" (GDPR caution; the rules are
// in src/holder-heuristic.js). personHeld takes an AS name as RIPEstat gives it, with its handle ("JDOE-AS Jane Doe",
// "CLOUDFLARENET - Cloudflare, Inc."); personName takes a name on its own ("Jane Doe").
const personHeld = asName => Boolean(asName) && personReason(holderOf(asName)) !== null;
const personName = name => Boolean(name) && personReason(name) !== null;
const CIDR = globalThis.IPTERM_CIDR;
const PORTS = globalThis.IPTERM_PORTS;
const LEAKG = globalThis.IPTERM_LEAK;

const CLI_UA = /^(curl|wget|httpie|xh|fetch|libfetch|aria2)\b|powershell/i;
// Link-preview fetchers for chat apps and social sites, and search engine crawlers. Many send "Accept: */*"
// (or no Accept), so without this a shared link would preview as JSON and a crawler would find JSON (or, on
// /port/<n>, a 403) instead of the page. Named bots only: anything else without text/html still gets JSON.
const PREVIEW_UA = /facebookexternalhit|WhatsApp|Slackbot|Discordbot|TelegramBot|Twitterbot|LinkedInBot|Applebot|redditbot|Mastodon\/|Bluesky|Cardyb|Embedly|Iframely/i;
const CRAWLER_UA = /Googlebot|bingbot|msnbot|BingPreview|DuckDuckBot|YandexBot|Baiduspider|Amazonbot|PetalBot|SeznamBot|Qwantbot/i;
// Bots the two lists don't name: AI and SEO crawlers (GPTBot, ClaudeBot, CCBot, Bytespider, PerplexityBot, AhrefsBot,
// SemrushBot, MJ12bot, DotBot, DataForSeoBot...), the AI assistants that fetch for a person's question (ChatGPT-User,
// Claude-User, Perplexity-User: public/llms.txt tells them), headless browsers, and anything else that calls itself a
// bot, crawler, spider or scraper. For the budgets only (isBot), never for wantsHtml: a script named "...bot" still
// gets JSON. "bot" has to end a word, and Cubot's doesn't count: it makes phones, whose browsers say "CUBOT P30".
const BOT_UA = /(?<!cu)bot\b|crawl|spider|slurp|scrap[ey]|archiver|anthropic-ai|claude-(?:user|web)|chatgpt-user|perplexity-user|meta-external|cohere-ai|google-?other|google-inspectiontool|headless|lighthouse/i;
const ASN_RE = /^as(\d{1,10})$/i;

// Who may spend the IPinfo Core and proxycheck.io budgets: people, and the API. A bot (io.bot) gets Core's and
// proxycheck.io's answers only from the cache, where someone else's lookup put them, and otherwise IPinfo Lite (free),
// with no VPN check and no registry date (ipData, privacyData and blockData see to it, so no route can forget). It gets
// country and network where a person gets a city: less detail on the same page, never different content. Nor does it
// start a RIPEstat routing lookup (routeData): a public /cidr page shows it the calculation, and the routing only when
// it is cached. The test is conservative about who is a person:
// - a named crawler or link preview, or anything in BOT_UA, is a bot whatever else it sends;
// - a client that asks for HTML (Accept: text/html, even on a ?format= or /json copy) is a person only when the request
//   looks like a browser's own: a navigation (Sec-Fetch-Mode: navigate or Sec-Fetch-Dest: document, which browsers set
//   and plain HTTP clients don't) or the terminal's fetch (Sec-Fetch-Site: same-origin, or X-Ipterm). So an unnamed
//   crawler that asks for HTML is a bot, and so is a browser too old to send Sec-Fetch-* (it gets Lite);
// - the rest, curl and other command-line tools and scripts asking for JSON, is the documented API and keeps full
//   data, within the per-visitor shares and the rate limit.
// docs/handbook.md ("Bots never spend the budgets") says the same; tools/check_bots.mjs checks it.
function isBot(request, ua) {
  if (PREVIEW_UA.test(ua) || CRAWLER_UA.test(ua) || BOT_UA.test(ua)) return true;
  const h = request.headers;
  if (CLI_UA.test(ua) || !(h.get('accept') || '').includes('text/html')) return false;
  return !(h.get('sec-fetch-mode') === 'navigate' || h.get('sec-fetch-dest') === 'document' ||
    h.get('sec-fetch-site') === 'same-origin' || h.has('x-ipterm'));
}

class RateLimited extends Error {}

export default {
  async fetch(request, env, ctx) {
    return secure(await route(request, env, ctx), env);
  },
  // The cron trigger (wrangler.toml [triggers]): refresh the VPN providers' server lists (VpnServers).
  async scheduled(controller, env, ctx) {
    if (env.VPN_SERVERS) ctx.waitUntil(env.VPN_SERVERS.get(env.VPN_SERVERS.idFromName('lists')).refresh());
  },
};

// wrangler dev's addresses, where plain http is all there is: route() doesn't send them to https, and dnsleakConf()
// takes a plain-http DNSLEAK_API there.
const localHost = u => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);

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
  // Plain http, anywhere but wrangler dev: browsers, crawlers and link previews (html) get a 301 to the same address on
  // https, so search engines keep one copy of each page. Everyone else is answered over http as before: curl doesn't
  // follow redirects, so `curl ipterm.net` would print nothing, and `curl -fs ipterm.net/expect/AS13335 || pkill ...`
  // would exit 0 on a 301 and never fire. That is why this isn't Cloudflare's "Always Use HTTPS", which can't tell
  // them apart. From here on url says https (default port), so every address an answer builds from it (canonical,
  // og:url, JSON-LD, %ORIGIN%, robots.txt, the sitemaps, the /api and badge snippets) and every cache key is the https
  // one, however the request came. sameOrigin() still holds: browsers get pages only over https, so a page's Origin is
  // the https one (and Sec-Fetch-Site, when sent, decides alone).
  if (url.protocol === 'http:' && !localHost(url)) {
    url.protocol = 'https:'; url.port = '';
    if (html) return redirect(url.href, 301);
  }
  // plain: ?format=text, the same data as aligned key/value lines instead of JSON; bot: no budget spent (isBot)
  const io = { request, env, ctx, url, me, plain: url.searchParams.get('format') === 'text', bot: isBot(request, ua) };

  const self = (o = io) => guard(() => selfInfo(o), d => reply(o, d, 200, {}, ipText), (msg, status) => reply(o, { error: msg }, status));
  if (path === '/' && io.plain) return self();
  if (path === '/') return CLI_UA.test(ua) ? text(me + '\n') : homePage(io);
  if (path === '/ip') return text(me + '\n');
  if (path === '/help') return html ? redirect('/api') : helpText(io);
  if (Object.hasOwn(SELF_FIELDS, path.slice(1).toLowerCase())) return selfField(io, path.slice(1).toLowerCase());
  if (path === '/me') return html ? redirect('/') : meRoute(io, ua);
  if (path === '/line') return selfLine(io);
  if (path === '/expect' || path.startsWith('/expect/')) return expectRoute(io, path.slice(8));
  if (path === '/robots.txt') return robots(url);
  if (path === '/sitemap.xml') return sitemapIndex(url, env);
  if (path === '/sitemap-pages.xml') return sitemap(url, env, SITEMAP_PATHS);
  if (path === '/sitemap-ports.xml') return sitemap(url, env, portPaths(), PORTS.updated);
  const asnMap = /^\/sitemap-asn-([1-9]\d{0,2})\.xml$/.exec(path);
  if (asnMap && asnSitemapFiles()[asnMap[1] - 1]) return sitemap(url, env, asnSitemapFiles()[asnMap[1] - 1].map(n => '/AS' + n));
  if (path === '/status' && await statusKeyOk(request, url, env)) return statusRoute(io);

  if (path === '/json' || (path === '/api/lookup' && !url.searchParams.get('ip'))) return self();
  if (path === '/text') return self({ ...io, plain: true });   // /?format=text with no ? for zsh to expand
  if (path === '/api/lookup') return ipRoute(io, url.searchParams.get('ip').trim(), false);
  if (path === '/api/check') return guard(() => checkData(io), d => json(d));
  if (path === '/api/dnsleak') return dnsleakRoute(io);
  if (path === '/dnsleak') return redirect('/leaktest');
  if (path === '/go') return goRoute(io, html);
  if (/^\/leaktest\/r\//i.test(path)) return leakShareRoute(io, path.slice(12), html);
  if (path === '/api/asn') return asnRoute(io, String(url.searchParams.get('asn') || '').trim(), false);
  if (Object.hasOwn(TOOLS, path.slice(1).toLowerCase())) return toolRoute(io, path.slice(1).toLowerCase(), html);
  if (path === '/api/port') return portRoute(io, url.searchParams.get('n'), false);
  if (path.startsWith('/port/')) return portRoute(io, path.slice(6), html);
  if (path === '/api/whois') return whoisRoute(io, String(url.searchParams.get('q') || '').trim(), false);
  if (path.startsWith('/whois/')) return whoisRoute(io, path.slice(7), html);
  if (path === '/api/cidr') return cidrRoute(io, url.searchParams.get('q'), false);
  if (path.startsWith('/cidr/')) return cidrRoute(io, path.slice(6), html);
  if (path === '/api/route') return routeRoute(io, url.searchParams.get('q'), false);
  if (path === '/route' || path.startsWith('/route/')) return routeRoute(io, path.slice(7), html);
  if (path === '/api/dns') return dnsRoute(io, url.searchParams.get('name'), url.searchParams.get('type'), false);
  if (path.startsWith('/dns/')) { const [n, t] = path.slice(5).split('/'); return dnsRoute(io, n, t, html); }
  if (path === '/api/mail') return mailRoute(io, url.searchParams.get('domain'), url.searchParams.get('dkim'), false);
  if (path.startsWith('/mail/')) return mailRoute(io, path.slice(6), url.searchParams.get('dkim'), html);
  if (path === '/api/grade') return gradeRoute(io, url.searchParams.get('domain'), false);
  if (path.startsWith('/grade/')) return gradeRoute(io, path.slice(7), html);
  if (path === '/badge') return redirect('/grade');
  if (path.startsWith('/badge/')) return badgeRoute(io, path.slice(7));

  const bare = path.slice(1);
  if (bare && parseIp(bare)) return ipRoute(io, bare, html);
  if (ASN_RE.test(bare)) return asnRoute(io, bare, html);
  const typo = routerTypo(bare);
  if (typo) return redirect('/' + typo, 301);
  const suffix = /^([0-9a-f.:]{2,45}|as\d{1,10})\/(text|json)$/i.exec(bare);   // /8.8.8.8/text, /AS15169/json
  if (suffix && (parseIp(suffix[1]) || ASN_RE.test(suffix[1]))) return formatRoute(io, suffix[1], suffix[2].toLowerCase());
  const field = /^([0-9a-f.:]{2,45})\/([a-z]{1,20})$/i.exec(bare);   // /8.8.8.8/asn
  if (field && parseIp(field[1])) return ipField(io, field[1], field[2].toLowerCase());
  const asWord = /^as(\d{1,10})\/([a-z]{1,20})$/i.exec(bare);         // /AS15169/txt
  if (asWord && !html) return textError(`Unknown format "${asWord[2]}". A network comes as /AS${asWord[1]}/text (aligned lines) or /AS${asWord[1]}/json.`, 404);
  if (path.startsWith('/api/')) return reply(io, { error: 'Unknown API route. Available: /api/lookup, /api/asn, /api/whois, /api/dns, /api/mail, /api/grade, /api/cidr, /api/route, /api/port. See /help.' }, 404);

  const res = await env.ASSETS.fetch(request);
  if (res.status !== 404) return withOrigin(res, url);
  // Someone typed a domain straight after the slash (ipterm.net/github.com): send them to its DNS page.
  // (An address typo that isn't curated, /10.0.0.13l, gets the 404 page and its "did you mean", not DNS.)
  const dom = !bare.includes('/') && !FILE_EXT.test(bare) && !typoIp(bare) ? normalizeDomain(bare) : null;
  if (dom) return redirect('/dns/' + dom);
  if (!html) return reply(io, { error: 'Not found. See /help for what curl and scripts can ask for.' }, 404);
  return notFoundPage(io, path);
}

// Paths that look like files, not domains (scanners probe for these constantly).
const FILE_EXT = /\.(html?|php\d?|aspx?|jsp|cgi|pl|py|sh|js|mjs|css|map|json|xml|txt|md|ya?ml|ini|env|conf|cfg|bak|old|sql|db|log|zip|gz|tgz|rar|7z|tar|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|pdf|mp[34]|webm|mov|wav)$/i;

/* ---------- tool landing pages and 404 ---------- */

// desc is the page's own summary; meta, the shorter description search results show (DESC_MAX).
const TOOLS = {
  whois: {
    title: 'Whois lookup: who owns a domain, IP address or network | ipterm', heading: 'Whois lookup',
    meta: 'Free whois lookup for domains, IP addresses and ASNs: registrar, registration and expiry dates, name servers, owner and abuse contact, over RDAP.',
    desc: 'Free whois lookup for domains, IP addresses and networks (ASNs). See the registrar, registration and expiry dates, name servers, the owning organization and the abuse contact, straight from the registries over RDAP.',
    usage: 'whois <ip, ASN or domain>',
    examples: [['whois example.com', '/whois/example.com'], ['whois github.com', '/whois/github.com'], ['whois 8.8.8.8', '/whois/8.8.8.8'], ['whois AS13335', '/whois/AS13335']],
  },
  dns: {
    title: 'DNS lookup: A, AAAA, MX, NS, TXT and CAA records | ipterm', heading: 'DNS lookup',
    meta: 'Free DNS lookup for any domain: A, AAAA, MX, NS, TXT and CAA records, who hosts the site and whether DNSSEC validates. Enter an IP address for reverse DNS.',
    desc: "Free DNS lookup for any domain: addresses (A and AAAA), mail servers (MX), name servers, TXT and CAA records, who hosts the site and whether DNSSEC validates. Enter an IP address for reverse DNS. Answers come from Cloudflare's public resolver.",
    usage: 'dig <domain> [type]',
    examples: [['dig example.com', '/dns/example.com'], ['dig gmail.com MX', '/dns/gmail.com/MX'], ['dig github.com TXT', '/dns/github.com/TXT'], ['dig 8.8.8.8', '/dns/8.8.8.8']],
  },
  mail: {
    title: 'Email security check: SPF, DMARC, DKIM and MX records | ipterm', heading: 'Email security check',
    meta: 'Free SPF, DMARC and DKIM checker for any domain: mail servers, SPF lookups counted against the limit of 10, the DMARC policy and DKIM keys, graded A to F.',
    desc: "Free SPF, DMARC and DKIM checker for any domain: its mail servers and provider, SPF with its DNS lookups counted against the limit of 10, the DMARC policy and report addresses, DKIM keys, MTA-STS, TLS-RPT and BIMI, graded A to F with a fix for each problem.",
    usage: 'mail <domain> [--dkim <selector>]',
    checks: ['MX: the mail servers and the provider behind them, or a null MX (the domain accepts no mail)',
      'SPF: one record, ending in ~all or -all, within the limit of 10 DNS lookups (includes are followed and counted)',
      'DMARC: the policy (none, quarantine or reject), its coverage, and where reports go',
      "DKIM: keys at common selectors (google, selector1, selector2, default, k1, s1), or the one you name; selectors can't be listed, so a miss is only INFO",
      'MTA-STS: the _mta-sts record and the policy file at https://mta-sts.<domain>, matched against the MX hosts',
      'TLS-RPT and BIMI: where TLS failure reports go, and the brand logo'],
    examples: [['mail gmail.com', '/mail/gmail.com'], ['mail outlook.com', '/mail/outlook.com'], ['mail github.com', '/mail/github.com'], ['mail example.com', '/mail/example.com']],
  },
  grade: {
    title: 'Domain report card: DNSSEC, security headers, email and expiry, graded A to F | ipterm', heading: 'Domain report card',
    meta: "Free domain security check, graded A to F: DNSSEC, IPv6, CAA, email, registration expiry and the website's security headers, with a fix for each problem.",
    desc: "Free domain security check, graded A to F: DNSSEC, IPv6, CAA and HTTPS records, the email security grade (SPF, DMARC, DKIM), registration expiry and transfer lock, and the website's HTTPS redirect and security headers (HSTS, CSP, X-Content-Type-Options, frame protection, Referrer-Policy), with a fix for each problem and a badge for your README.",
    usage: 'grade <domain>',
    checks: ['DNS: DNSSEC, an AAAA record (IPv6), CAA (which certificate authorities may issue certificates) and an HTTPS record',
      "Email: the mail check's grade (SPF, DMARC, DKIM, MTA-STS) and its main findings",
      'Registration: expiry (WARN within 30 days, FAIL once expired) and the transfer lock, from the registry over RDAP',
      "Website: one HEAD request to https://<domain>/ for HSTS, CSP, X-Content-Type-Options, frame protection and Referrer-Policy (a GET, its body dropped unread, if the site refuses HEAD), and one to http://<domain>/ for the redirect to HTTPS. A 403, a bot challenge or a timeout is \"couldn't check\", never a FAIL"],
    examples: [['grade github.com', '/grade/github.com'], ['grade cloudflare.com', '/grade/cloudflare.com'], ['grade example.com', '/grade/example.com'], ['grade wikipedia.org', '/grade/wikipedia.org']],
  },
  leaktest: {
    title: 'VPN and DNS leak test: DNS, WebRTC and IPv6 leaks | ipterm', heading: 'VPN and DNS leak test',
    meta: 'Free DNS leak test and VPN leak test, graded A to F: see which DNS servers look up sites for you, and whether they belong to your VPN or to your provider.',
    desc: "Free DNS leak test and VPN leak test, graded A to F: see which DNS servers look up sites for you, and whether they belong to your VPN or to your internet provider. Also checks WebRTC and IPv6 leaks that bypass a VPN, a time zone that gives you away, and whether your IP is a known VPN. Runs in your browser in a few seconds; nothing is stored.",
    usage: 'leaktest',
    checks: ['DNS: which DNS servers look up sites for you, and do they belong to your VPN, or to your internet provider?',
      'WebRTC: does your browser reveal a public IP other than the one websites see?',
      'IPv6: does your IPv6 traffic go through a different network than your VPN?',
      "Time zone: does your device's clock match your IP's location?",
      'VPN detection: is your IP recognized as a VPN, proxy, Tor or data center, or does it come through Cloudflare WARP?'],
    examples: [],
  },
  cidr: {
    title: 'Subnet calculator: CIDR, netmask and usable host range | ipterm', heading: 'Subnet calculator',
    meta: 'Free IPv4 and IPv6 subnet calculator: network and broadcast addresses, netmask, wildcard mask, usable hosts and host count, and routing for public ranges.',
    desc: 'Free IPv4 and IPv6 subnet calculator. Enter a range like 10.0.0.0/22 or an address with a netmask to get the network and broadcast addresses, netmask, wildcard mask, usable host range and host count. For a public range, see how it is routed: the origin network, RPKI and AS paths.',
    usage: 'cidr <range>',
    examples: [['cidr 192.168.1.0/24', '/cidr/192.168.1.0/24'], ['cidr 10.0.0.0/22', '/cidr/10.0.0.0/22'], ['cidr 172.16.0.0/12', '/cidr/172.16.0.0/12'], ['cidr 1.1.1.0/24', '/cidr/1.1.1.0/24']],
  },
  port: {
    title: 'Port checker: is a port open on my IP? | ipterm', heading: 'Port checker',
    meta: 'Free open port checker: see whether a TCP port is open on your own IP address, for port forwarding, game servers, Plex, SSH or Remote Desktop.',
    desc: 'Free open port checker: see whether a TCP port is open on your own IP address, for port forwarding, game servers, Plex, SSH or Remote Desktop. ipterm connects to the address you visit from, one port at a time, and explains why a port may be closed.',
    usage: 'port <number>',
    examples: [['port 25565', '/port/25565'], ['port 32400', '/port/32400'], ['port 22', '/port/22'], ['port 3389', '/port/3389']],
  },
  api: {
    title: 'ipterm API: IP address lookups from curl and scripts | ipterm', heading: 'API and command line',
    meta: 'Use ipterm from curl and scripts, with no key and no sign-up: your IP as plain text, and any IP address, network, DNS name or subnet as JSON or text.',
    desc: 'Use ipterm from curl and scripts, with no key and no sign-up: your IP as plain text, one value at a time (/asn, /city, /tz), and any IP address, network, DNS name, registry record or subnet as JSON or aligned text.',
    usage: 'curl ipterm.net/help',
    examples: [],
  },
};

// The leak test page before (or without) the DNS test server: it doesn't promise what it can't check.
const LEAKTEST_NO_DNS = {
  title: 'VPN leak test: WebRTC, IPv6 and time zone check | ipterm', heading: 'VPN and privacy leak test',
  meta: 'Check whether your browser gives away more than your IP address, graded A to F: WebRTC and IPv6 leaks, your time zone, and whether your IP is a known VPN.',
  desc: "Check whether your browser gives away more than your IP address, graded A to F: WebRTC leaks, IPv6 leaks that bypass a VPN, a device time zone that doesn't match your IP's location, and whether your IP is recognized as a VPN. Runs in your browser in a few seconds; nothing is stored.",
  checks: TOOLS.leaktest.checks.slice(1),
};

function toolRoute(io, tool, html) {
  const t = tool === 'leaktest' && !dnsleakConf(io.env) ? { ...TOOLS.leaktest, ...LEAKTEST_NO_DNS } : TOOLS[tool];
  if (!html) {
    if (tool === 'api') return helpText(io);              // command-line clients get the reference itself
    if (!t.examples.length) return reply(io, { error: 'This check runs in your browser. Open the page in a browser to run it.', usage: t.usage }, 400);
    return reply(io, { error: `${tool === 'port' ? 'Add a port number' : 'Add something to look up'}, like ${t.examples[0][1]}`, usage: t.usage, examples: t.examples.map(e => e[1]) }, 400);
  }
  const list = t.examples.map(([c, href]) => `<li><a href="${esc(href)}">${esc(c)}</a></li>`).join('');
  const extra = (list ? `<p class="ln sys">Examples:</p><ul class="static-list">${list}</ul>` : '') +
    (t.checks ? `<p class="ln sys">What it checks:</p><ul class="static-list">${t.checks.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : '') +
    (tool === 'cidr' ? `<p class="ln sys">Guide: <a href="/guides/subnet-cheat-sheet">Subnet mask cheat sheet</a></p>` : '') +
    (tool === 'mail' ? `<p class="ln sys">How the grade works (each line is OK, WARN, FAIL or INFO; INFO never counts):</p>` +
      MAIL_GRADES.map(([g, t]) => `<p class="ln">${esc(g)}: ${esc(t)}</p>`).join('') : '') +
    (tool === 'grade' ? `<p class="ln sys">How the grade works (each line is OK, WARN, FAIL or INFO; INFO never counts, and neither does a part that couldn't be checked):</p>` +
      GRADE_GRADES.map(([g, t]) => `<p class="ln">${esc(g)}: ${esc(t)}</p>`).join('') +
      `<p class="ln sys">The mail line is OK for a mail grade of A, WARN for B and FAIL for C or worse. Certificates aren't checked: ipterm's server never sees them.</p>` +
      `<p class="ln sys">Badges for a README: <code>${esc(io.url.origin)}/badge/&lt;domain&gt;.json</code> is a <a href="https://shields.io/badges/endpoint-badge" rel="noopener">shields.io endpoint</a>, so shields.io fetches it and your readers' browsers never contact ipterm; <code>${esc(io.url.origin)}/badge/&lt;domain&gt;.svg</code> is the same badge served by ipterm itself. Both are cached for an hour. Run grade &lt;domain&gt; for the Markdown.</p>` : '') +
    (tool === 'port' ? `<p class="ln sys">It only ever tests the address you connect from, so it can't be pointed at anyone else's.</p>${portIndex()}` : '') +
    (tool === 'leaktest' ? `<p class="ln sys">How the grade works (only leaks past a VPN count, so not using one never lowers it):</p>` +
      LEAKG.GRADES.map(([g, t]) => `<p class="ln">${esc(g)}: ${esc(t)}</p>`).join('') + `<p class="ln sys">${esc(LEAKG.RULES[1])}</p>` : '') +
    // The full reference for visitors without JavaScript and for crawlers; the terminal prints its own (`api`).
    (tool === 'api' ? `<pre class="doc-pre api-ref"><code>${esc(helpBody(io.url.host, io.env))}</code></pre>` +
      `<p class="ln sys">Machine-readable: <a href="/openapi.json">OpenAPI description</a> · <a href="/llms.txt">llms.txt</a> · plain text: <code>curl ${esc(io.url.host)}/help</code></p>` +
      `<div class="api-ref"><p class="ln sys">Search from here, or from the address bar: <code>${esc(io.url.host)}/go?q=8.8.8.8</code> opens the page for an IP address, domain, AS number, range, email address or port.</p>` +
      goForm('/go', 'go-form') +
      `<p class="ln sys">A search box for a wiki or intranet page (plain HTML, no script):</p><pre class="doc-pre"><code>${esc(goForm(io.url.origin + '/go'))}</code></pre></div>` +
      `<p class="ln sys">IP address data powered by <a href="https://ipinfo.io" rel="noopener">IPinfo</a>.</p>` : '');
  return shell(io, { status: 200, path: '/' + tool, title: t.title, desc: t.meta || t.desc, initial: { kind: 'tool', tool },
    body: staticBlock(t.heading, [tool], [['usage', t.usage]], t.desc, extra) });
}

// The router and well-known addresses with their own indexable pages: the IPv4 and IPv6 entries in
// SITEMAP_PATHS. Pages for other non-public addresses are noindex. Built on first use (parseIp's regex is
// defined further down).
let curated = null;
const curatedIps = () => curated || (curated = new Set(SITEMAP_PATHS.map(p => p.slice(1)).filter(s => parseIp(s))));
// A network's first address: IPv4 ending in .0, IPv6 with its low 64 bits zero. Its page places one address of a block
// that may hold millions, so unless it is curated it is "noindex, follow" (ipPage), and the block's /cidr page is the
// one to find: whois links that, not the address, for a registry block's first address (whoisPage).
const netStart = p => (p.v === 4 ? p.o[3] === 0 : p.g.slice(4).every(x => x === 0));

// What an IPv4 address typed with the usual slips would be: l, i, I, | and ! for 1, o and O for 0, commas,
// semicolons, underscores or spaces for dots, doubled dots, and zero padding (192.168.l.l, 192,168,1,1,
// 192.168.o.1, 192.168.001.001). Null when that still isn't an address.
function typoIp(s) {
  if (s.length > 24 || !/^[0-9lio.,;_ |!]+$/i.test(s)) return null;
  const t = s.toLowerCase().replace(/[li|!]/g, '1').replace(/o/g, '0').replace(/[,;_ ]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '');
  const o = t.split('.');
  if (o.length !== 4 || !o.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return o.map(Number).join('.');
}
// A typo of one of the curated addresses (/192.168.l.l, /192,168,1,1, /10.0.0.l): that address, as written in
// SITEMAP_PATHS, for a 301. The Location is always taken from the list, never from the request, so this can't
// redirect anywhere else. Anything else (a valid address, another typo) is null.
function routerTypo(bare) {
  const ip = typoIp(bare);
  if (!ip || ip === bare) return null;
  for (const c of curatedIps()) if (c === ip) return c;
  return null;
}

/* ---------- address-bar search (/go) ----------
   GET /go?q=<anything> answers with a 302 to the page for what was typed: an IP address, an AS number, a
   domain or URL, a range (or an address and netmask), an email address (its mail check), port <n>, a
   tool's name, a router address typo (192.168.l.l, as /192.168.l.l takes it), or a terminal command such as
   `dig gmail.com MX`, `whois AS13335`, `grade github.com`, `route 1.1.1.0/24` or `leaktest --result 1bjp`. Browsers reach it
   from the address bar through public/opensearch.xml, and wikis through the plain form on /api.
   The Location is put together only from values that were parsed and written out again (canonIp, "AS" and
   a number, normalizeDomain, CIDR.calc, routeTarget, PORTS.parse, the DNS type list, dkimSelector, a decoded
   leak code, a curated address from SITEMAP_PATHS), never from the input itself, and goLocation() refuses
   anything but a plain path on this site, so /go can't send anyone elsewhere: //evil.com is a 400 like any
   other input it can't read. /go itself makes no outside request. Hostile inputs: tools/check_go.sh. */
const GO_TOOLS = {
  '': '/', whoami: '/', myip: '/', me: '/', ip: '/', ifconfig: '/', ipconfig: '/', lookup: '/',
  leaktest: '/leaktest', dnsleak: '/leaktest', vpntest: '/leaktest', whois: '/whois', rdap: '/whois', dig: '/dns', dns: '/dns',
  nslookup: '/dns', mail: '/mail', email: '/mail', spf: '/mail', dmarc: '/mail', dkim: '/mail', cidr: '/cidr', subnet: '/cidr',
  ipcalc: '/cidr', route: '/cidr', bgp: '/cidr', rpki: '/cidr', port: '/port', ports: '/port', api: '/api', help: '/api', curl: '/api',
  privacy: '/privacy', guides: '/guides', grade: '/grade', report: '/grade', reportcard: '/grade', scorecard: '/grade', badge: '/grade',
};

async function goRoute(io, html) {
  const q = String(io.url.searchParams.get('q') || '');
  const loc = goLocation(goTarget(q));
  if (loc) return redirect(loc);
  const shown = clip(q.replace(/\s+/g, ' ').trim()), n = /^\d{1,10}$/.test(shown) ? Number(shown) : 0;
  // A number on its own could be a network or a port: offer both.
  const suggest = [n >= 1 && n <= 4294967295 && { cmd: 'asn AS' + n, href: '/AS' + n }, PORTS.parse(shown) && { cmd: 'port ' + n, href: '/port/' + n }].filter(Boolean);
  const error = `ipterm can't tell what "${shown}" is. Try an IP address, a domain, an AS number (AS13335), a range (10.0.0.0/22), an email address or port <number>.`;
  if (!html) return reply(io, { error, suggest: suggest.map(x => x.href), examples: ['/go?q=8.8.8.8', '/go?q=example.com', '/go?q=AS13335', '/go?q=10.0.0.0/22', '/go?q=port%2022'] }, 400);
  const links = (suggest.length ? `<p class="ln sys">Did you mean ${suggest.map(x => `<a href="${esc(x.href)}">${esc(x.cmd)}</a>`).join(' or ')}?</p>` : '') +
    `<p class="ln sys">Examples: <a href="/8.8.8.8">8.8.8.8</a> · <a href="/dns/example.com">example.com</a> · <a href="/AS13335">AS13335</a> · <a href="/cidr/10.0.0.0/22">10.0.0.0/22</a> · <a href="/port/22">port 22</a></p>` +
    goForm('/go', 'go-form');
  return shell(io, { status: 400, path: '/go', title: 'Nothing to look up | ipterm', initial: { kind: 'notfound', path: '/go', message: error, suggest },
    body: staticBlock('Nothing to look up', ['400'], [], error, links) });
}

// The search form: on /api (and the error page above), and as the snippet people paste into a wiki.
function goForm(action, cls = '') {
  return `<form${cls ? ` class="${cls}"` : ''} action="${esc(action)}" method="get" role="search">\n` +
    `  <input type="search" name="q" aria-label="IP address, domain, ASN, range or port" placeholder="8.8.8.8, example.com, AS13335 or 10.0.0.0/22" required>\n` +
    `  <button type="submit">Look up on ipterm</button>\n</form>`;
}

// The last check before a Location goes out: a path on this site, made only of characters the builders
// below produce, with no "//" or "/\" at the start (which browsers read as another host) and no dot segments.
function goLocation(path) {
  return typeof path === 'string' && path.length <= 300 && /^\/(?![/\\])[A-Za-z0-9._~:/?=%-]*$/.test(path) &&
    !/(^|\/)\.\.?(\/|\?|$)/.test(path) ? path : null;
}

// What a search is for, as the path of its page, or null.
function goTarget(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  // Control, zero-width and bidi characters never belong in a lookup.
  if (s.length > 300 || /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(s)) return null;
  if (Object.hasOwn(GO_TOOLS, s.toLowerCase())) return GO_TOOLS[s.toLowerCase()];
  const typo = routerTypo(s);                       // before the split: typoIp reads spaces as dots (192 168 1 1)
  if (typo) return '/' + typo;
  const [w0, ...args] = s.split(' '), cmd = w0.toLowerCase();
  switch (cmd) {                                    // a terminal command
    case 'lookup': case 'ip': case 'geo': case 'iplookup': return args.length === 1 ? goValue(args[0]) : null;
    case 'whois': case 'rdap': return args.length === 1 ? goWhois(args[0]) : null;
    case 'dig': case 'dns': case 'nslookup': case 'host': return args.length === 1 || args.length === 2 ? goDns(args[0], args[1]) : null;
    case 'mail': case 'email': case 'spf': case 'dmarc': case 'dkim': case 'mailcheck': return goMail(args, cmd);
    case 'cidr': case 'subnet': case 'ipcalc': return args.length === 1 || args.length === 2 ? goCidr(args.join(' ')) : null;
    case 'asn': case 'as': return args.length === 1 ? goAsn(args[0]) : null;
    case 'route': case 'bgp': case 'rpki': return args.length === 1 ? goRouteCmd(args[0]) : null;
    case 'port': case 'portcheck': return goPort(args);
    case 'grade': case 'report': case 'reportcard': case 'scorecard': case 'badge': return args.length === 1 ? goGrade(args[0]) : null;
    case 'leaktest': case 'dnsleak': case 'vpntest': {   // leaktest --result <code>: a shared result, only a valid code
      const r = args.length === 2 && /^--?result$/i.test(args[0]) && LEAKG.decode(args[1]);
      return r ? '/leaktest/r/' + r.code : null;
    }
  }
  if (args.length === 1 && parseIp(w0) && parseIp(args[0])) return goCidr(s);   // an address and a netmask
  return args.length ? null : goValue(w0);
}

// One word on its own: an AS number, a port, an address, a range, an email address, a domain or a URL.
function goValue(v) {
  if (/^as\d{1,10}$/i.test(v)) return goAsn(v);
  const port = /^(?:port[:=]|:|tcp\/)(\d{1,5})$|^(\d{1,5})\/tcp$/i.exec(v);
  if (port) return goPort([port[1] || port[2]]);
  const host = urlHost(v.replace(/^mailto:/i, '')), p = parseIp(host.replace(/\/+$/, ''));
  if (p) return '/' + canonIp(p);
  if (/\/|-\d{1,3}$/.test(host)) { const c = goCidr(host); if (c) return c; }   // 10.0.0.0/22, or 10.0.0.0-22
  const at = host.lastIndexOf('@');
  if (at > 0) { const d = normalizeDomain(host.slice(at + 1)); return d ? '/mail/' + d : null; }
  // A router address typo (lookup 192.168.l.l, http://192.168.l.l/admin) goes to the curated address, as
  // /192.168.l.l does; another address typo (10.0.0.13l) isn't a domain, as on the 404 path.
  const typo = routerTypo(host);
  if (typo) return '/' + typo;
  if (typoIp(host)) return null;
  const d = normalizeDomain(host);
  return d ? '/dns/' + d : null;
}

// route <prefix or address>: /route/, the routing (JSON for curl -L; browsers are sent on to the /cidr page that
// shows it). Space that isn't routed (10.0.0.0/8, 192.168.1.1) gets its own /cidr or address page instead.
function goRouteCmd(v) {
  const host = urlHost(v), t = routeTarget(host);
  if (!t.error) return '/route/' + t.query;
  const p = !host.includes('/') && parseIp(host);
  return p ? '/' + canonIp(p) : goCidr(host);
}

// A pasted http(s) URL's host (https://example.com/page -> example.com), or the input without IPv6 brackets.
// Other schemes (javascript:, data:, ftp://) give nothing.
function urlHost(v) {
  v = String(v || '').trim().replace(/^\[([0-9a-f:.]+)\]$/i, '$1');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v) || parseIp(v)) return v;
  if (!/^https?:\/\//i.test(v)) return '';
  try { return new URL(v).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; }
}

const goAsnNumber = v => { const m = /^(?:as)?(\d{1,10})$/i.exec(String(v)); const n = m ? Number(m[1]) : 0; return n >= 1 && n <= 4294967295 ? n : null; };
function goAsn(v) { const n = goAsnNumber(v); return n ? '/AS' + n : null; }

function goWhois(v) {
  if (/^as\d/i.test(v)) { const n = goAsnNumber(v); return n ? '/whois/AS' + n : null; }
  const host = urlHost(v), p = parseIp(host);
  if (p) return '/whois/' + canonIp(p);
  const d = normalizeDomain(host);
  return d ? '/whois/' + d : null;
}

function goDns(name, type) {
  const t = type == null ? null : String(type).toUpperCase();
  if (t && !Object.hasOwn(DNS_TYPES, t)) return null;
  const host = urlHost(name), p = parseIp(host);
  if (p) return t && t !== 'PTR' ? null : '/dns/' + canonIp(p);
  const d = normalizeDomain(host);
  return d ? '/dns/' + d + (t ? '/' + t : '') : null;
}

// mail <domain or address> [--dkim <selector>]; dkim <domain> <selector> names the selector without --dkim.
function goMail(args, cmd) {
  let dom = null, sel = null;
  for (let i = 0; i < args.length; i++) {
    const m = /^--?dkim(?:=(.*))?$/i.exec(args[i]);
    if (m) { sel = m[1] != null ? m[1] : args[++i]; if (!sel) return null; }
    else if (!dom) dom = args[i];
    else if (cmd === 'dkim' && sel == null) sel = args[i];
    else return null;
  }
  if (!dom) return null;
  const host = urlHost(dom.replace(/^mailto:/i, '')), at = host.lastIndexOf('@'), name = normalizeDomain(at >= 0 ? host.slice(at + 1) : host);
  if (!name) return null;
  if (sel == null) return '/mail/' + name;
  const s = dkimSelector(sel);
  return s ? '/mail/' + name + '?dkim=' + encodeURIComponent(s) : null;
}

// grade <domain or URL>: the report card. An address or a record name (_dmarc.gmail.com) has none.
function goGrade(v) {
  const host = urlHost(v), d = !parseIp(host) && normalizeDomain(host);
  return d && !recordName(d) ? '/grade/' + d : null;
}

function goCidr(v) {
  const d = CIDR.calc(String(v).replace(/-(\d{1,3})$/, '/$1'));   // also 10.0.0.0-22, as /cidr/ takes it
  return d.error ? null : '/cidr/' + d.cidr;
}

function goPort(args) {
  if (args.length < 1 || args.length > 2 || (args[1] && !/^(--?info|info|about)$/i.test(args[1]))) return null;
  const n = PORTS.parse(args[0]);
  return n ? '/port/' + n : null;
}

/* ---------- shared leak test results ----------
   /leaktest/r/<code>: a result someone shared after leaktest. The code is made in their browser
   (public/leakgrade.js) and holds only the grade, whether a VPN was on, and each graded check's flag
   (passed, leaked or not tested): no IP address, provider, location or resolver. This page shows that
   result with a "run yours" link and never runs the test itself: opening someone's link must not test
   your browser. Not indexed; each grade has its own share image (public/og-leak-<grade>.png, made by
   tools/build_og_leak.mjs). Nothing is looked up or stored, so it's cached like a static page. */
async function leakShareRoute(io, raw, html) {
  const r = LEAKG.decode(raw);
  if (!r) return html ? notFoundPage(io, '/leaktest/r/' + raw) : reply(io, { error: 'Not a leak test result code. They come from share after leaktest, like /leaktest/r/1bjp.' }, 404);
  const says = `This browser got ${LEAKG.article(r.grade)} on ipterm's leak test`;
  const lines = LEAKG.CHECKS.map(([k, label]) => [label, LEAKG.checkWord(r[k])]);
  const cache = 'public, max-age=86400';
  if (!html) {
    const d = { code: r.code, grade: r.grade, vpn: LEAKG.vpnWord(r.vpn), checks: Object.fromEntries(LEAKG.CHECKS.map(([k]) => [k, LEAKG.checkWord(r[k])])) };
    return reply(io, d, 200, { 'cache-control': cache }, (x, o) => kvText([['grade', x.grade], ['vpn', x.vpn], ...lines], [], o));
  }
  const desc = `${says}: ${lines.map(([l, w]) => `${l}: ${w}`).join(', ')}; ${LEAKG.vpnWord(r.vpn)}. Run yours in a few seconds; nothing is stored.`;
  const res = await shell(io, { status: 200, path: '/leaktest/r/' + r.code, title: `${says} | ipterm`, desc, noindex: true, cache,
    image: `/og-leak-${r.grade.toLowerCase()}.png`, initial: { kind: 'leakshare', code: r.code },
    body: staticBlock(says, ['leaktest', 'shared result'], [['grade', r.grade], ['VPN', LEAKG.vpnWord(r.vpn)], ...lines],
      "A result someone shared from ipterm's VPN and DNS leak test. The link holds only the grade and these lines: no IP address, provider, location or DNS resolver.",
      '<p class="ln"><a href="/leaktest">Run yours</a>: test this browser in a few seconds; nothing is stored.</p>') });
  res.headers.set('x-robots-tag', 'noindex');
  return res;
}

// What the visitor probably meant, from the first part of the path.
function suggestFor(path) {
  const seg = path.split('/').filter(Boolean);
  const first = seg[0] || '';
  const p = parseIp(first) || parseIp(typoIp(first) || '');   // a typo of an address that isn't curated: a link, not a redirect
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
  return PREVIEW_UA.test(ua) || CRAWLER_UA.test(ua) || (request.headers.get('accept') || '').includes('text/html');
}

/* ---------- routes ---------- */

// One spelling per address (IPv6 in RFC 5952 short form), so every way of writing an address shares
// one cache entry and one upstream lookup.
function canonIp(p) { return p.v === 4 ? p.o.join('.') : CIDR.calc(p.g.map(x => x.toString(16)).join(':')).network; }
const sameIp = (a, b) => { const x = parseIp(String(a || '').trim()), y = parseIp(String(b || '').trim()); return !!x && !!y && canonIp(x) === canonIp(y); };

async function ipRoute(io, q, html) {
  const p = parseIp(String(q || '').trim());
  if (!p) return reply(io, { error: 'Not a valid IPv4 or IPv6 address.' }, 400);
  const ip = canonIp(p), own = sameIp(q, io.me);
  if (own && !html) return guard(() => selfInfo(io), d => reply(io, d, 200, {}, ipText), (msg, status) => reply(io, { error: msg }, status));

  const reason = nonPublicReason(p);
  if (reason) {
    const d = { ip, version: p.v, bogon: true, range: reason };
    return html ? ipPage(io, d, 200) : reply(io, { error: `${ip} is not a public address, so there is nothing to look up: it is ${CIDR.rangeIn(reason)}.`, ...d }, 400);
  }
  // The caller's own address never goes to a registry for its date (withBlock): by number it is answered from the
  // edge (above), and its page goes without. ?block=0 leaves the date out for any address: the terminal sends it, and
  // puts it on its links and address bar, for the caller's other addresses (the other IP version, WebRTC's), which
  // look like anyone's here.
  const block = !own && onOff(io.url.searchParams.get('block')) !== false;
  // ?lite=1: the network and country only (IPinfo Lite) and no VPN check, so neither paid budget is spent; just the
  // free listings (withListings). leaktest asks this way for the caller's other IP version, whose network (and whether
  // it goes through iCloud Private Relay) is all it compares.
  const lite = onOff(io.url.searchParams.get('lite')) === true, vpnCheck = d => (lite ? withListings(io, ip, d) : withPrivacy(io, ip, d));
  // A bot (isBot) gets what the cache holds or IPinfo Lite: ipData, privacyData and blockData spend nothing for it.
  return guard(
    () => block ? withBlock(io, ip, p, ipData(io, ip, p, { lite }), vpnCheck) : vpnCheck(ipData(io, ip, p, { lite })),
    // Browsers may reuse an answer for 5 minutes; the Worker's own cache (6 hours) keeps repeats cheap.
    // ...except one that went out before its registry date arrived (blockLate): the next lookup should get the date.
    d => html ? ipPage(io, d, 200) : reply(io, d, 200, { 'cache-control': d.blockLate ? 'no-store' : 'public, max-age=300' }, ipText),
    (msg, status) => html ? ipPage(io, { ip, version: p.v, error: msg }, status) : reply(io, { error: msg }, status),
  );
}

// The calculation answers JSON and text on its own (no outside call); the page for a public prefix adds its
// routing, which /route/<prefix> also answers. A routing lookup that fails or is rate limited leaves the
// page as it was, with a note, rather than failing it, and so does a bot's when the routing isn't cached (routeData).
// That note says bot: true, so the terminal asks /api/route itself (cidr() in public/app.js): a browser too old to send
// Sec-Fetch-* gets this page too, but its JSON request is a person's. Its line is .route-bot, which the terminal
// drops once that request brings routing: a person shouldn't read "open the page in a browser" above their routing.
// A crawler running the script can't fetch /api/ (robots.txt) or gets a 403, and the line stays.
async function cidrRoute(io, q, html) {
  const d = CIDR.calc(String(q || '').replace(/-(\d{1,3})$/, '/$1'));   // also accept 10.0.0.0-22
  if (d.error) return html ? cidrPage(io, { error: d.error, input: q }, 400) : reply(io, { error: d.error }, 400);
  if (!html) return reply(io, d, 200, { 'cache-control': 'public, max-age=86400' }, cidrText);
  const t = d.range === 'public' ? routeTarget(d.cidr) : null;
  let route = null;
  if (t && !t.error) {
    try { route = (await routeData(io, t)) || { error: ROUTE_BOT + ' Open the page in a browser to see it.', bot: true }; } catch (e) {
      if (!(e instanceof RateLimited)) console.error('[ipterm] routing lookup failed:', plain(String((e && e.message) || e)));
      route = { error: e instanceof RateLimited ? 'Routing data skipped: too many lookups from your address. Wait a minute and reload.'
        : "Routing data didn't load: RIPEstat didn't answer. Try again in a moment." };
    }
  }
  return cidrPage(io, d, 200, route);
}

// /route/<prefix or ip> and /api/route?q=: the routing on its own. Browsers get the prefix's /cidr page, where
// the same data sits under the subnet calculation (an address goes to the prefix it is routed in; a bot's, only when
// that address's own routing is cached, under the address, and otherwise to its /32 or /128). A bot asking for JSON or
// text gets a 403 when the routing isn't cached (routeData).
async function routeRoute(io, raw, html) {
  const t = routeTarget(raw);
  if (html) {
    if (t.error) return redirect('/cidr');
    if (!t.ip) return redirect(encodePath('/cidr/' + t.query), 301);
    let to = `${t.query}/${t.p.v === 4 ? 32 : 128}`;
    try { const d = await routeData(io, t); if (d && d.prefix) to = d.prefix; } catch {}
    return redirect(encodePath('/cidr/' + to));
  }
  if (t.error) return reply(io, { error: t.error }, 400);
  return guard(() => routeData(io, t), d => (d ? reply(io, d, 200, { 'cache-control': 'public, max-age=300' }, routeText)
    : reply(io, { error: ROUTE_BOT + ' Ask from a browser or with curl.' }, 403)),
  (msg, status) => reply(io, { error: msg }, status));
}

// Adds the address's entry on a VPN provider's own server list (vpnServer) and on Apple's iCloud Private Relay list
// (relay), both free and local, and proxycheck.io's VPN / proxy opinion, unless IPinfo already flagged the address,
// Apple lists it, or a provider lists it as a server its users reach sites from (then a second query adds little, and
// the free allowance is better spent on unflagged ones). A bot gets only a cached proxycheck.io answer (privacyData).
async function withPrivacy(io, ip, pending) {
  const [d, listed, relay] = await Promise.all([pending, vpnServerData(io, ip), relayData(io, ip)]);
  if (!d || d.bogon) return d;
  const out = listed || relay ? { ...d, ...(listed ? { vpnServer: listed } : {}), ...(relay ? { relay } : {}) } : d;
  if ((d.flags && d.flags.anonymous) || relay || (listed && listed.role === 'exit')) return out;
  const privacy = await privacyData(io, ip);
  return privacy ? { ...out, privacy } : out;
}

// Adds the registry date of the address's network (blockData). Its registry request starts once the lookup has
// settled, so it knows whether that already counted toward the visitor's rate limit, and runs beside what comes
// next (next: withPrivacy's VPN check). Once the rest of the answer is ready it gets BLOCK_GRACE more at most; a
// slower registry finishes in the background (waitUntil) and fills the cache for the next lookup. That answer is
// marked blockLate (not enumerable, so never in the JSON), and ipRoute tells browsers not to keep it.
const BLOCK_LATE = {};
async function withBlock(io, ip, p, pending, next = d => d) {
  const block = blockData(io, ip, p, pending);           // never rejects
  io.ctx.waitUntil(block);
  const d = await pending.then(next);
  const b = await Promise.race([block, sleep(BLOCK_GRACE).then(() => BLOCK_LATE)]);
  if (d.bogon) return d;
  if (b === BLOCK_LATE) return Object.defineProperty({ ...d }, 'blockLate', { value: true });
  return b ? { ...d, block: b } : d;
}

function ipData(io, ip, p, opts = {}) {
  // The plan is part of the cache key, so switching IPinfo plans takes effect at once instead of
  // serving older (e.g. country-only) answers until they expire. opts.lite: never use Core.
  const core = !opts.lite && io.env.IPINFO_TOKEN && String(io.env.IPINFO_PLAN || '').toLowerCase() === 'core';
  // A bot (isBot) never pays for Core: it gets Core's answer only when someone else's lookup cached it, else Lite.
  if (core && io.bot) return fromCache(io, 'ip/core/' + ip).then(d => d || ipData(io, ip, p, { lite: true }));
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

// The mail records, the common DKIM selectors and a named selector are cached separately, so naming a
// selector costs one DNS query, not a whole new check (and can't be used to make ipterm fetch a domain's
// MTA-STS policy over and over). A named selector is checked as well as the common ones, never instead:
// naming a good key can't hide a weak one.
async function mailRoute(io, rawName, rawSel, html) {
  const name = normalizeDomain(rawName);
  const sel = rawSel == null || rawSel === '' ? null : dkimSelector(rawSel);
  const bad = error => html ? mailPage(io, { domain: clip(rawName), error }, 400) : reply(io, { error }, 400);
  if (!name) return bad(parseIp(String(rawName || '').trim()) ? 'The mail check needs a domain name, not an IP address. Example: mail gmail.com' : 'Not a valid domain name. Example: mail gmail.com');
  if (rawSel != null && rawSel !== '' && !sel) return bad("Not a valid DKIM selector. It is the s= value in a message's DKIM-Signature header, like google or selector1.");
  return guard(
    () => mailCheck(io, name, sel),
    // A nonexistent domain is a valid answer: JSON says so with 200; the HTML page uses 404 so it isn't indexed.
    d => html ? mailPage(io, d, d.status === 'NOERROR' ? 200 : 404) : reply(io, d, 200, { 'cache-control': 'public, max-age=300' }, mailText),
    (msg, status) => html ? mailPage(io, { domain: name, selector: sel, error: msg }, status) : reply(io, { error: msg }, status),
  );
}

// The mail check itself, shared by mail and grade, so both read the same cache entries.
async function mailCheck(io, name, sel) {
  const base = await cached(io, 'mail/' + name, 300, () => mailRecords(name));
  if (base.status !== 'NOERROR' || base.nullMx) return mailResult(base, null, sel);
  const extra = sel && !DKIM_SELECTORS.includes(sel);
  const [common, named] = await Promise.all([cached(io, `mail-dkim/${name}/*`, 300, () => dkimProbe(name, DKIM_SELECTORS)),
    extra ? cached(io, `mail-dkim/${name}/${sel}`, 300, () => dkimProbe(name, [sel])) : null]);
  return mailResult(base, named ? { selectors: [...common.selectors, sel], keys: [...common.keys, ...named.keys],
    unanswered: [...(common.unanswered || []), ...(named.unanswered || [])], subrequests: common.subrequests + named.subrequests } : common, sel);
}

// The domain report card: /grade/<domain> and /api/grade?domain=. It reuses the mail check's and whois's cache
// entries, and the whole card is cached for five minutes, like DNS.
async function gradeRoute(io, rawName, html) {
  const name = normalizeDomain(rawName);
  if (!name || recordName(name)) {
    const base = name && name.replace(/^(?:.*\.)?_[^.]*\./, '');      // the domain under the record: _dmarc.gmail.com -> gmail.com
    const error = name ? `${name} is a DNS record name, not a domain. Example: grade ${base.includes('.') ? base : 'github.com'}`
      : parseIp(String(rawName || '').trim()) ? 'The report card needs a domain name, not an IP address. Example: grade github.com' : 'Not a valid domain name. Example: grade github.com';
    return html ? gradePage(io, { domain: clip(name || rawName), error }, 400) : reply(io, { error }, 400);
  }
  return guard(
    () => gradeFor(io, name),
    // A nonexistent domain is a valid answer: JSON says so with 200; the HTML page uses 404 so it isn't indexed.
    d => html ? gradePage(io, d, d.grade ? 200 : 404) : reply(io, withBadge(d, io.url.origin), 200, { 'cache-control': 'public, max-age=300' }, (x, o) => gradeText(x, o)),
    (msg, status) => html ? gradePage(io, { domain: name, error: msg }, status) : reply(io, { error: msg }, status),
  );
}
// A fresh card is one of the visitor's lookups: its mail, DKIM and whois parts don't count again, so a card costs
// the same whatever is cached, and each token still buys one bounded card. Requests that arrive while a card is
// being made share it (within this Worker instance), so a badge on a busy page doesn't start one per fetch. A
// shared card that fails, rate limited or otherwise, was the first requester's: the others then try their own.
// waitUntil keeps a card alive for at most 30 s after its first requester leaves, and a cancelled one never settles,
// so a card is shared only that long from its start, and a waiter that reaches the end of that window tries its own.
const GRADE_SHARE_MS = 30000;
const GRADE_INFLIGHT = new Map();
function gradeFor(io, name) {
  const own = () => cached(io, 'grade/' + name, 300, () => gradeData({ ...io, paid: true }, name));
  const key = io.url.origin + '/' + name, shared = GRADE_INFLIGHT.get(key), left = shared ? shared.at + GRADE_SHARE_MS - Date.now() : 0;
  if (left > 0) return Promise.race([shared.p, sleep(left).then(() => { throw new Error('shared card gone'); })]).catch(own);
  const entry = { at: Date.now() };
  entry.p = own().finally(() => { if (GRADE_INFLIGHT.get(key) === entry) GRADE_INFLIGHT.delete(key); });   // a newer card may have taken the key
  GRADE_INFLIGHT.set(key, entry);
  io.ctx.waitUntil(entry.p.catch(() => {}));          // the others may still be waiting if this requester leaves
  return entry.p;
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
      return html ? whoisPage(io, d, 200) : reply(io, { error: `${query} is not a public address, so no registry holds a record for it: it is ${CIDR.rangeIn(reason)}.`, ...d }, 400);
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
   accepted, turned away or got no answer. It never tests any other address, sends nothing over the
   connection, closes it at once and keeps nothing. Guards:
   - only the ipterm page itself (a same-origin request) or a command-line tool can start a check, so
     other sites can't make visitors' browsers start one and crawlers never do;
   - the /port/<n> pages explain the port and offer a button; nothing is tested on page load;
   - only a public address is connected to: for IPv6, global unicast (2000::/3) without the forms that
     embed an IPv4 address (6to4, Teredo);
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
// Workers can't connect to, and its address blocks in case the network number is missing: the published
// ranges, plus the 1.1.1.1 resolver's and WARP's exits (1.1.1.0/24, 1.0.0.0/24, 104.28.0.0/16, 2a09:bac0::/29).
const CLOUDFLARE_ASNS = new Set([13335, 209242]);
const CLOUDFLARE_RANGES = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13',
  '131.0.72.0/22', '1.1.1.0/24', '1.0.0.0/24', '104.28.0.0/16',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32', '2a09:bac0::/29'];
// Only global unicast IPv6 (2000::/3) can be a visitor's address, so the check refuses everything else,
// which includes the forms that embed an IPv4 address (::/96, 64:ff9b::/96). Inside 2000::/3 it also
// refuses these: the IETF blocks (Teredo and others), 6to4 (which embeds IPv4) and documentation. The
// report card's website check uses the same rule for the addresses it would connect to.
const PORT_V6_RESERVED = ['2001::/23', '2002::/16', '3fff::/20'];
const v6Reserved = p => p.v === 6 && ((p.g[0] & 0xe000) !== 0x2000 || PORT_V6_RESERVED.some(r => inPrefix(p, r) >= 0));

// Fetches from the page itself say so (Sec-Fetch-Site), and that always wins when it is sent. Browsers
// without Sec-Fetch-* send no Origin on a same-origin GET, so the terminal also sends X-Ipterm (port or
// dnsleak), which a cross-site page can't add: it needs a CORS preflight, and ipterm never allows one
// (OPTIONS is 405 unless PUBLIC_API is on, and secure() never sends Access-Control-Allow-Headers).
function sameOrigin(request, url) {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  return request.headers.get('origin') === url.origin || /^(port|dnsleak)$/.test(request.headers.get('x-ipterm') || '');
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
  if (range) return untested('not-public', `not tested: ${base.ip} is not a public address, so nothing on the internet can reach it: it is ${CIDR.rangeIn(range)}.`);
  if (v6Reserved(p)) {
    return untested('not-public', `not tested: ${base.ip} is a reserved or transition IPv6 address (IPv4-embedded, 6to4, Teredo or IETF-reserved), so ipterm doesn't connect to it. To test your IPv4 address, run: curl -4 ${io.url.host}/port/${n}`);
  }
  const blocked = PORTS.untestable(n);                   // port 25, the only one (hence the reason code)
  if (blocked) return untested('port-25', `not tested: ${blocked}`, svc && svc.tips ? [`${svc.name}: ${svc.tips}`] : []);
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

// Open: the handshake completed. Closed: the attempt failed at once. That is usually a refusal (a reset),
// but workerd gives the same error for an ICMP "unreachable" reply or a blocked destination, so the answer
// only says it was turned away. No answer: nothing came back in time, which is what a router does with a
// port it doesn't forward. Nothing is ever sent.
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
  if (state === 'closed') return `closed: the connection to your address on ${what} was turned away at once, rather than timing out. Nothing is listening on that port, or a firewall on the device or router rejected it.`;
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
    const isp = PORTS.cgnat(asn);              // a provider known for carrier-grade NAT (public/ports.js)
    notes.push((isp ? `${isp} usually shares IPv4 addresses between customers (carrier-grade NAT), which would explain this. ` : '') +
      `If your router's internet (WAN) address isn't ${d.ip}, or is between 100.64.0.0 and 100.127.255.255, your provider uses carrier-grade NAT: the router has no public address of its own, so no port forward can reach it. Ask your provider for a public IPv4 address, or use IPv6 or a tunnel such as Tailscale or Cloudflare Tunnel.`);
  }
  return notes;
}

/* ---------- DNS leak test ----------
   Which DNS resolvers look up names for the visitor. The page (leaktest) looks up a few random,
   single-use names, <token>.<DNSLEAK_ZONE>. That zone is delegated to a small server outside Cloudflare
   (dnsleak-server/ in this repo), which answers NXDOMAIN and notes the address of each resolver that
   asked, in memory, for under two minutes. This route asks it which resolvers asked for the page's
   tokens (DNSLEAK_API, with the DNSLEAK_KEY secret; it hands them over once and forgets them), then
   names each resolver's network with IPinfo Lite: never Core, never proxycheck.io.
   Off unless DNSLEAK_ZONE, DNSLEAK_API and DNSLEAK_KEY are all set: /api/check then doesn't offer it,
   the CSP doesn't allow the zone, and leaktest says DNS leaks weren't tested. Guards:
   - only the ipterm page (same-origin) or a command-line tool can ask, as with the port check;
   - non-public resolver addresses are shown as such and never sent anywhere;
   - the ask counts as one of the visitor's 30 lookups a minute, and so does each network looked up fresh. */
const DNSLEAK_TOKEN = /^[0-9a-f]{20}$/;                  // as the page makes them and dnsleak-server accepts them
const DNSLEAK_MAX_TOKENS = 10;
// Resolvers people choose on purpose, by network, so the page can name the service and not just the company.
const DNS_SERVICES = { 13335: 'Cloudflare (1.1.1.1)', 15169: 'Google Public DNS (8.8.8.8)', 19281: 'Quad9 (9.9.9.9)', 36692: 'Cisco OpenDNS' };

function dnsleakConf(env) {
  const zone = String(env.DNSLEAK_ZONE || '').trim().toLowerCase(), key = String(env.DNSLEAK_KEY || '');
  let api = null;
  try {
    const u = new URL(String(env.DNSLEAK_API || '').trim());
    // https only; plain http just for a responder or mock on this machine under `wrangler dev`
    if (u.protocol === 'https:' || (u.protocol === 'http:' && localHost(u))) api = u.origin;
  } catch { api = null; }
  if (!api || key.length < 32 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(zone)) return null;
  return { zone, api, key };
}

async function dnsleakRoute(io) {
  const conf = dnsleakConf(io.env);
  if (!conf) return reply(io, { error: 'The DNS leak test is not set up on this server.' }, 404);
  if (!sameOrigin(io.request, io.url) && !CLI_UA.test(io.request.headers.get('user-agent') || '')) {
    return reply(io, { error: 'The DNS leak test runs from the ipterm terminal (leaktest) or a command-line tool such as curl.' }, 403);
  }
  const tokens = [...new Set(String(io.url.searchParams.get('t') || '').toLowerCase().split(',').filter(Boolean))];
  if (!tokens.length || tokens.length > DNSLEAK_MAX_TOKENS || !tokens.every(t => DNSLEAK_TOKEN.test(t))) {
    return reply(io, { error: `Give 1 to ${DNSLEAK_MAX_TOKENS} tokens of 20 hex characters, t=<token>,<token>, after looking up <token>.${conf.zone}` }, 400);
  }
  return guard(() => dnsleakData(io, conf, tokens), d => reply(io, d, 200, {}, dnsleakText), (msg, status) => reply(io, { error: msg }, status));
}

const resolverGroup = p => (p.v === 4 ? p.o.slice(0, 3).join('.') : p.g.slice(0, 3).join(':'));   // its /24 or /48

async function dnsleakData(io, conf, tokens) {
  await limit(io);                                       // the ask itself is one of the visitor's lookups
  const r = await fetch(`${conf.api}/v1/resolvers?t=${tokens.join(',')}`,   // tokens are checked hex: nothing to escape
    { headers: { 'x-dnsleak-key': conf.key, accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) { if (r.body) r.body.cancel(); throw new Error('dnsleak responder HTTP ' + r.status); }
  const j = await readJson(r, 20_000);
  const seen = Number.isInteger(j && j.seen) && j.seen >= 0 ? Math.min(j.seen, tokens.length) : 0;
  const ips = [...new Set((Array.isArray(j && j.resolvers) ? j.resolvers : []).map(x => parseIp(String(x || '')))
    .filter(Boolean).map(canonIp))].slice(0, 16);
  // One lookup per /24 (IPv6: /48): a resolver service's addresses sit side by side, and one answer covers
  // its neighbors. At most 8 networks per check. Lite only, never withPrivacy(): no Core or proxycheck.io.
  const groups = new Map();
  for (const ip of ips) { const p = parseIp(ip); if (!nonPublicReason(p) && !groups.has(resolverGroup(p))) groups.set(resolverGroup(p), [ip, p]); }
  const nets = new Map();
  await Promise.all([...groups].slice(0, 8).map(async ([g, [ip, p]]) => {
    try { nets.set(g, await ipData(io, ip, p, { lite: true })); } catch { nets.set(g, null); }   // shown without its network
  }));
  const resolvers = ips.map(ip => {
    const p = parseIp(ip), range = nonPublicReason(p);
    if (range) return { ip, private: true, range };      // never sent upstream
    const d = nets.get(resolverGroup(p)) || {}, asn = /^AS\d+$/.test(d.asn || '') ? d.asn : null;
    return { ip, asn, org: d.org || null, countryCode: d.countryCode || null, service: (asn && DNS_SERVICES[asn.slice(2)]) || null };
  });
  return { zone: conf.zone, tokens: tokens.length, seen, resolvers };
}

function dnsleakText(d, o) {
  const lines = d.resolvers.map(r => (r.private ? `${r.ip}  non-public: ${r.range}` : [r.ip, r.asn, r.service || r.org, r.countryCode].filter(Boolean).join('  ')));
  return kvText([['zone', d.zone], ['names seen', `${d.seen} of ${d.tokens}`], ['resolvers', lines.length ? lines : 'none']],
    d.resolvers.some(r => r.asn) ? [IPINFO_CREDIT] : [], o);
}

function portText(d, o) {
  const s = d.service;
  return kvText([
    ['port', `${d.port}/tcp` + (s ? `  ${s.name}` : '')],
    ['your address', d.ip ? `${d.ip} (IPv${d.version}, the address this request came from)` : null],
    ['result', d.summary], ['used for', s && s.use], ['notes', d.notes || []],
  ], [], o);
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
  const blocked = PORTS.untestable(n);                   // port 25: say so, and offer no check
  const named = s ? `Port ${n} (${s.name})` : `Port ${n}`;
  const title = blocked ? `${named}: what it's for and why ipterm can't check it | ipterm` : `${named}: check if it's open on your IP | ipterm`;
  const why = blocked && `ipterm can't check this port: ${blocked}`;
  const desc = blocked ? descFit((s ? s.use + ' ' : '') + why, s && `${s.use} ipterm can't check this port.`, why)
    : s ? descFit(`${s.use} Check whether TCP port ${n} is open on your own IP address, and see why it may be closed.`, `${s.use} Check if TCP port ${n} is open on your IP.`, s.use)
    : `Check whether TCP port ${n} is open on your own IP address: ipterm connects to the address you visit from and reports open, closed or no answer.`;
  const summary = blocked ? (s ? s.use + ' ' : '') + why : (s ? s.use + ' ' : '') + `ipterm can check whether TCP port ${n} is open on your own IP address: it connects to the address you visit from, on this one port, and reports open, closed or no answer. Nothing is stored.` +
    (s && s.proto === 'udp' ? ` ${s.name} uses UDP, which the check can't test.` : '');
  // IANA's registered name, linked to the registry and to whatportis.com (portAbout() in public/app.js shows the same)
  const iana = PORTS.iana(n);
  const ianaRow = iana && [iana.names.length > 1 ? 'IANA names' : 'IANA name', new Markup(esc(iana.text) + ' · ' +
    PORTS.refs(n).map(([label, href]) => `<a href="${esc(href)}" rel="noopener">${esc(label)}</a>`).join(' · '))];
  const rows = s ? [['protocol', PORTS.protoText(s.proto)], ianaRow, ['why it may be closed', s.tips], ['caution', s.risk]].filter(Boolean) : [['protocol', 'TCP']];
  const p = t => `<p class="ln">${t}</p>`;
  const extra = (blocked ? '' : `<p class="ln sys">Check it: type <code>port ${n}</code> in the terminal, or from a command line run <code>curl -4 ${esc(host)}/port/${n}</code>. It only tests the address you connect from, one port at a time.</p>`) +
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
// toText. An error is just its message, with the same status as the JSON would have, and goes through
// plain() like any value: it often quotes the request back. ?color=1 colors the text (kvText); it is never
// on by default, because scripts pipe these answers into grep, awk and jq.
function reply(io, d, status = 200, extra = {}, toText = null) {
  if (!io.plain) return json(d, status, extra);
  return text(d.error ? plain(d.error) + '\n' : toText(d, { color: !!onOff(io.url.searchParams.get('color')) }),
    extra['cache-control'] || 'no-store', status, extra);
}

// One value and a newline. A missing value is an empty line with HTTP 404, so `curl -f` fails cleanly.
const one = (v, cache = 'no-store', extra = {}) => (v != null && String(v).trim()
  ? text(plain(v) + '\n', cache, 200, extra) : text('\n', cache, 404, extra));
const textError = (msg, status) => text(plain(msg) + '\n', 'no-store', status);   // messages quote the request

function selfField(io, name) {
  if (name !== 'hostname') return one(edgeInfo(io)[SELF_FIELDS[name]]);
  return guard(async () => {                             // reverse DNS asks a resolver, so it counts toward the rate limit
    await limit(io);
    const h = await ptr(io.me);
    if (h === undefined) throw new Error('dns: reverse lookup did not answer');
    return h;
  }, h => one(h), textError);
}

// /me: a card for your own address with a Braille world map (src/me.js). request.cf only, like /asn: no
// outside call, no reverse DNS, no rate limit. Every value goes through plain() first. Colors are on for
// command-line tools (?color=0 or ?color=1 to choose), ?w= fits it to a terminal, ?redact hides the address.
const onOff = v => (v == null ? null : !/^(0|false|no|off)$/i.test(v));   // ?redact alone means on
function meRoute(io, ua) {
  const q = io.url.searchParams, d = edgeInfo(io);
  for (const k of Object.keys(d)) if (typeof d[k] === 'string') d[k] = plain(d[k]);
  const w = /^\d{1,4}$/.test(q.get('w') || '') ? Number(q.get('w')) : ME_WIDTH.def;   // meCard keeps it within bounds
  const card = meCard(d, { width: w, color: onOff(q.get('color')) ?? CLI_UA.test(ua), redact: !!onOff(q.get('redact')), host: io.url.host });
  return text(card, 'private, no-store', 200, { vary: 'Accept, User-Agent' });
}

// /line: "203.0.113.4 AS64500 Example ISP · US · EWR", for shell prompts and tmux status bars.
function selfLine(io) {
  const d = edgeInfo(io);
  return one([[d.ip, d.asn, d.org].filter(Boolean).join(' '), d.countryCode, d.colo].filter(Boolean).join(' · '));
}

// /expect/AS13335 (or /expect/CH, or several: /expect/AS13335,AS209242): 200 and the value when your
// address matches one, 412 when none does, so `curl -fs ipterm.net/expect/AS13335 || panic` can stop
// something when a VPN drops. From request.cf, like /asn and /cc: no outside call, no rate limit.
function expectRoute(io, raw) {
  const wants = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  const norm = wants.map(s => {
    const asn = /^(?:as)?(\d{1,10})$/i.exec(s);
    if (asn) return Number(asn[1]) >= 1 && Number(asn[1]) <= 4294967295 ? 'AS' + Number(asn[1]) : null;
    return /^[a-z][a-z0-9]$/i.test(s) ? s.toUpperCase() : null;   // ISO 3166-1 alpha-2, plus Cloudflare's T1 (Tor)
  });
  if (!wants.length || wants.length > 10 || norm.includes(null)) {
    return textError(`usage: ${io.url.host}/expect/<AS number or country code>, like /expect/AS13335 or /expect/CH, or up to 10 of them separated by commas. HTTP 200 if this request comes from one of them, 412 if not.`, 400);
  }
  const d = edgeInfo(io), hit = norm.find(v => v === d.asn || v === d.countryCode);
  if (hit) return text(hit + '\n');
  return textError(`no match: expected ${norm.join(' or ')}, but this request came from ${d.asn || 'an unknown network'} in ${d.countryCode || 'an unknown country'}`, 412);
}

// /8.8.8.8/text, /2606:4700:4700::1111/json, /AS15169/text: ?format=text and ?format=json as a path, because zsh
// takes the ? in an unquoted URL for a wildcard. The same lookup as /8.8.8.8?format=text, so the same budgets, rate
// limit, caching and Vary; the path wins over a ?format= that disagrees. Browsers get the text or JSON too, so search
// engines are told to leave these copies of the page out.
async function formatRoute(io, q, fmt) {
  const sub = { ...io, plain: fmt === 'text' };
  const res = await (ASN_RE.test(q) ? asnRoute(sub, q, false) : ipRoute(sub, q, false));
  res.headers.set('x-robots-tag', 'noindex');
  return res;
}

function ipField(io, q, name) {
  if (!Object.hasOwn(IP_FIELDS, name)) {
    const why = Object.hasOwn(SELF_FIELDS, name)
      ? `${name} is only available for your own address (curl ${io.url.host}/${name}). Other addresses get country and network data.`
      : name === 'txt' ? `Unknown field "txt": for the whole answer as aligned text, use /${q}/text.` : `Unknown field "${name}".`;
    return textError(`${why} Fields for any address: ${Object.keys(IP_FIELDS).join(', ')}; or text or json for the whole answer.`, 404);
  }
  const p = parseIp(q), ip = canonIp(p), reason = nonPublicReason(p);
  if (reason) return textError(`${ip} is not a public address, so there is nothing to look up: it is ${CIDR.rangeIn(reason)}.`, 400);
  return guard(
    () => ipData(io, ip, p, { lite: true }),              // Lite only, and no withPrivacy(): no Core or proxycheck.io budget
    d => one(name === 'country' ? d.country || countryName(d.countryCode) : d[IP_FIELDS[name]], 'public, max-age=300',
      name === 'hostname' ? {} : { 'x-attribution': IPINFO_CREDIT }),   // a second line would break $(curl ...)
    textError,
  );
}

// Terminal-safe text: an upstream value (a TXT record, a registry's name field) could carry escape
// sequences that rewrite the reader's terminal, or bidi controls that reorder what it shows.
const plain = v => String(v).replace(/[\t\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?');

// [key, value] rows as aligned lines. Empty values are skipped; an array gets one line per item. With o.color
// (?color=1) the keys get the /me card's key color, and a row's third item, if any, colors its value after plain()
// (which would turn the escape codes into ?), so the only escape sequences are these colors.
function kvText(rows, footer = [], o = {}) {
  const keep = rows.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
  const w = Math.max(0, ...keep.map(([k]) => k.length)) + 2;
  const out = [];
  for (const [k, v, tone] of keep) (Array.isArray(v) ? v : [v]).forEach((x, i) => {
    const key = i ? '' : k, val = plain(x);
    out.push((ansi(o.color, ANSI.key, key) + ' '.repeat(w - key.length) + (o.color && tone ? tone(val) : val)).trimEnd());
  });
  return out.join('\n') + '\n' + (footer.length ? '\n' + footer.join('\n') + '\n' : '');
}

const SOURCE_NAMES = { edge: "Cloudflare's edge", 'ipinfo-lite': 'IPinfo Lite', 'ipinfo-core': 'IPinfo Core', ipinfo: 'IPinfo' };
// ?color=1: the verdict that starts vpnText's line, in its color: a known VPN, proxy or Tor address bold yellow,
// a proxycheck.io flag yellow (its catch-all alone too, PC_CATCHALL), "not on known VPN or proxy lists" green,
// "not checked" dim. The rest stays plain.
const VPN_TONES = { yes: '1;33', flagged: '33', 'not a known VPN, proxy or Tor service': '33', 'not on': '32', 'not checked': ANSI.dim };
function vpnTone(s) {
  const m = /^(yes|flagged|not a known VPN, proxy or Tor service|not on|not checked)\b[^:,(]*?(?=:|,| \(|$)/.exec(s);
  return m ? ansi(true, VPN_TONES[m[1]], m[0]) + s.slice(m[0].length) : s;
}
// IPinfo calls some addresses bogons that the special-purpose table in public/cidr.js calls public (192.88.99.1, in the
// former 6to4 relay range AS6939 still announces), and answers just { bogon: true } for them, which a lookup keeps
// (ipinfoCore(), provider()). Its page, its text answer and the terminal say so in IPinfo's name, and it goes no
// further: no proxycheck.io query (withPrivacy) and no registry date (blockData).
const IPINFO_BOGON = 'IPinfo lists it as a bogon: an address not expected on the public internet';
function ipText(d, o) {
  const self = d.source === 'edge';
  const ctry = d.country ? d.country + (d.countryCode ? ` [${d.countryCode}]` : '') : d.countryCode;
  return kvText([
    [self ? 'your ip' : 'ip', d.ip], ['version', d.version ? 'IPv' + d.version : null], ['hostname', d.hostname],
    ['network', [d.asn, d.org].filter(Boolean).join('  ')], ['domain', d.asDomain],
    ['location', [d.city, d.region, ctry].filter(Boolean).join(', ')], ['continent', d.city ? null : d.continent], ['postal', d.postal],
    ['coordinates', d.lat != null && d.lon != null ? `${d.lat}, ${d.lon}` : null], ['time zone', d.timezone],
    ['block', blockText(d.block)], ['bogon', d.bogon ? IPINFO_BOGON : null],
    ['connection', connectionText(d)], ['vpn / proxy', self || d.bogon ? null : vpnText(d), vpnTone],
    ['edge', d.colo ? `${d.colo} (the Cloudflare data center that answered you)` : null],
    ['source', (SOURCE_NAMES[d.source] || d.source || '') + (d.privacy ? ' + proxycheck.io' : '') + (d.vpnServer ? ` + ${d.vpnServer.provider}'s server list` : '') +
      (d.relay ? " + Apple's iCloud Private Relay list" : '')],
  ], /^ipinfo/.test(d.source || '') ? [IPINFO_CREDIT] : [], o);
}

function asnText(d, o) {
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
    ['IPv6 prefixes', n(v6.count)], ['upstreams', upstreamText(d.upstreams)], ['largest v4', show4], ['largest v6', show6],
  ], more > 0 ? [`${n(more)} more prefixes not shown (the JSON lists up to 50 of each).`] : [], o);
}

// "AS174 Cogent Communications, LLC · AS3356 Level 3 Parent, LLC (2 of 4 seen)", or why there is no list.
function upstreamText(u) {
  if (!u) return null;
  if (u.tooMany) return 'not listed: a transit network with thousands of neighbours (its neighbours are customers and peers)';
  if (!u.list.length) return 'none seen';
  return u.list.map(x => x.asn + (x.name ? ' ' + x.name : '')).join(' · ') + (u.total > u.list.length ? `  (${u.list.length} of ${u.total.toLocaleString('en-US')} seen)` : '');
}

function dnsText(d, o) {
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
  return kvText(rows, host ? [IPINFO_CREDIT] : [], o);
}

// The mail check as lines like leaktest's: one per finding with its status, and a fix: under each
// problem, then the records it read. Shared by ?format=text and the page's static summary.
const MAIL_STATUS = { ok: 'OK', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
const mailTally = c => (c.fail || c.warn ? [c.fail && `${c.fail} FAIL`, c.warn && `${c.warn} WARN`].filter(Boolean).join(', ') : 'no problems found');
// Which selectors had a key, and which the resolver couldn't read. Matches app.js.
function dkimNote(k) {
  const un = k.unanswered || [];
  return [k.keys.length ? `found: ${k.keys.map(x => x.selector).join(', ')}` : un.length < k.selectors.length ? 'none found' : null,
    un.length ? `couldn't read: ${un.join(', ')}` : null].filter(Boolean).join('; ');
}
function mailRows(d, asText) {
  const rows = [['grade', `${d.grade}  (${mailTally(d.counts)})`]];
  let prev = null;
  for (const c of d.checks) {          // text lines up the fixes under the findings; HTML can't keep the spaces
    rows.push([c.check === prev ? '' : c.check, asText ? `${MAIL_STATUS[c.status].padEnd(4)}  ${c.text}` : `${MAIL_STATUS[c.status]} · ${c.text}`]);
    if (c.fix) rows.push(['', (asText ? '      ' : '') + `fix: ${c.fix}`]);
    prev = c.check;
  }
  const mx = d.mx.records, spf = d.spf || {}, dm = d.dmarc, m = d.mtaSts, p = m && m.policy;
  rows.push(['MX records', mx.length ? mx.map(r => mxText({ priority: r.priority, value: r.host })) : 'none']);
  if (spf.record) rows.push([spf.records > 1 ? 'SPF records' : 'SPF record', [spf.record, ...(spf.others || [])]]);
  if (spf.includes && spf.includes.length) rows.push(['SPF includes', spf.includes.slice(0, 12).join(' ') + (spf.includes.length > 12 ? ` and ${spf.includes.length - 12} more` : '')]);
  if (dm) rows.push(['DMARC record', dm.record + (dm.inherited ? `  (at _dmarc.${dm.from})` : '')]);
  if (d.dkim) rows.push(['DKIM selectors', `${d.dkim.selectors.join(', ')}  (${dkimNote(d.dkim)})`]);
  if (m) rows.push(['MTA-STS record', m.record]);
  if (p) rows.push(['MTA-STS policy', p.error ? `${p.url} ${p.error}` : `mode ${p.mode || '?'}, mx ${p.mx.join(' ') || 'none'}, max_age ${p.maxAge ?? '?'}`]);
  if (d.tlsRpt) rows.push(['TLS-RPT record', d.tlsRpt.record]);
  if (d.bimi) rows.push(['BIMI record', d.bimi.record]);
  return rows;
}

function mailText(d, o) {
  if (d.status !== 'NOERROR') return mailProblem(d) + '\n';
  return kvText([['domain', d.domain], ...mailRows(d, true)],
    ['Grades: ' + MAIL_GRADES.map(([g, t]) => `${g} ${t}`).join('; ') + '. INFO lines never count.'], o);
}
const mailProblem = d => (d.status === 'NXDOMAIN' ? `${d.domain} does not exist (NXDOMAIN), so it has no mail records.`
  : `The mail check for ${d.domain} could not run: the resolver answered ${d.status}.`);

// The report card as lines, like the mail check's: each finding with its status, the mail check's main findings
// under its line, a fix: under each problem, then what it read. Shared by ?format=text and the page.
function gradeRows(d, asText) {
  const rows = [['grade', `${d.grade}  (${gradeTally(d)})`]], pad = asText ? '      ' : '';
  let prev = null;
  for (const c of d.checks) {
    rows.push([c.check === prev ? '' : c.check, asText ? `${MAIL_STATUS[c.status].padEnd(4)}  ${c.text}` : `${MAIL_STATUS[c.status]} · ${c.text}`]);
    for (const x of c.details || []) rows.push(['', `${pad}  ${x}`]);
    if (c.fix) rows.push(['', `${pad}fix: ${c.fix}`]);
    prev = c.check;
  }
  const dn = d.dns || {}, r = d.registration, w = d.web && d.web.https;
  if (dn.addresses && dn.addresses.length) rows.push(['addresses', dn.addresses.slice(0, 6).join(' ') + (dn.addresses.length > 6 ? ` and ${dn.addresses.length - 6} more` : '')]);
  if (dn.cname && dn.cname.length) rows.push(['alias of', dn.cname.join(' -> ')]);
  if (dn.caa) rows.push([dn.caa.from !== d.domain ? `CAA (${dn.caa.from})` : 'CAA records', dn.caa.records]);
  if (r && r.registrar) rows.push(['registrar', r.registrar]);
  if (w && w.headers) rows.push(['page checked', w.final]);
  return rows;
}
function gradeText(d, o) {
  if (!d.grade) return gradeProblem(d) + '\n';
  const b = d.badge;
  return kvText([['domain', d.domain], ...gradeRows(d, true)], [
    ...(b ? ["README badge (Markdown; shields.io fetches it, so your readers' browsers never contact ipterm):", b.markdown, '',
      "or the same badge served by ipterm itself (fetched by each reader's browser):", b.markdownSvg, ''] : []),
    'Grades: ' + GRADE_GRADES.map(([g, t]) => `${g} ${t}`).join('; ') + ". INFO lines, and parts that couldn't be checked, never count."], o);
}
const gradeProblem = d => (d.status === 'NXDOMAIN' ? `${d.domain} does not exist (NXDOMAIN), so there is nothing to grade.`
  : `The report card for ${d.domain} could not run: the resolver answered ${d.status}.`);

function whoisText(d, o) {
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
    ], [], o);
  }
  return kvText([
    ['query', d.query], ['owner', d.org], ['network name', d.name], ['handle', d.handle && !/ - /.test(d.handle) ? d.handle : null],
    ['registry', d.registry], ['address block', d.cidrs || []], ['range', d.range ? `${d.range.start} - ${d.range.end}` : null],
    ['ASN range', d.asnRange && d.asnRange.start !== d.asnRange.end ? `AS${d.asnRange.start} - AS${d.asnRange.end}` : null],
    ['type', d.type], ['country', d.country], ['registered', date(d.registered)], ['last changed', date(d.updated)], ['description', d.description],
    ['abuse email', abuse.email], ['abuse contact', !abuse.email && abuse.handle ? `${abuse.handle} (email not published in RDAP; see the registry)` : null],
    ['abuse phone', abuse.phone], ['rdap', d.rdapUrl],
  ], [], o);
}

function cidrText(d, o) {
  const list = a => (a ? a.join(', ') : null);
  if (d.v !== 4) {
    return kvText([['network', d.cidr], ['first address', d.network], ['last address', d.last], ['addresses', `${d.totalPow} = ${d.totalText}`],
      ['/64 subnets', d.subnets64], ['expanded', d.expanded], ['splits into', list(d.halves)], ['part of', d.supernet], ['range', d.rangeNote]], [], o);
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
  ], [], o);
}

// The command-line reference: `curl <host>/help`, and /api for command-line clients.
function helpText(io) {
  return text(helpBody(io.url.host, io.env), 'public, max-age=3600', 200, { vary: 'Accept, User-Agent' });
}

function helpBody(h, env = {}) {
  const b = buildOf(env);
  const block = (title, rows) => {
    const w = Math.max(...rows.map(([c, what]) => (what == null ? 0 : c.length))) + 3;
    return [title, ...rows.map(([c, what]) => ('  ' + (what == null ? c : c.padEnd(w) + what)).trimEnd())].join('\n');
  };
  return [
    `ipterm: IP lookups from the command line. No key, no sign-up, no cookies.` +
      (selfHosted(env) ? `\n${h} runs its own copy of ipterm's open-source code: it is not ipterm.net.` : ''),
    block("YOUR OWN ADDRESS (from Cloudflare's edge: no third-party lookup)", [
      [`curl ${h}`, 'your IP address'],
      [`curl ${h}/me`, 'a card with a world map: IP, network, place, time'],
      [`curl ${h}/json`, 'your IP, network and location as JSON'],
      [`curl ${h}/text`, 'the same as aligned lines'],
      [`curl ${h}/asn`, "your network's AS number"],
      [`curl ${h}/org`, "your network's name"],
      [`curl ${h}/cc`, 'your country code (ISO 3166-1)'],
      [`curl ${h}/city`, 'your city'],
      [`curl ${h}/tz`, 'your time zone'],
      [`curl ${h}/colo`, 'the Cloudflare data center that answered you'],
      [`curl ${h}/hostname`, 'your reverse DNS name'],
      [`curl ${h}/line`, 'IP, network, country and data center on one line'],
    ]),
    block('THE /me CARD (QUOTE THE URL, SO THE SHELL LEAVES ? ALONE)', [
      [`curl '${h}/me?w=40'`, 'fit a narrow terminal (32 to 120 columns)'],
      [`curl "${h}/me?w=$COLUMNS"`, 'exactly as wide as this terminal'],
      [`curl '${h}/me?color=0'`, 'without colors'],
      [`curl '${h}/me?redact'`, 'with your IP hidden, for screenshots'],
    ]),
    block('SCRIPTS: IS THIS MACHINE WHERE IT SHOULD BE? (HTTP 200 YES, 412 NO)', [
      [`curl -fs ${h}/expect/AS13335`, 'on network AS13335?'],
      [`curl -fs ${h}/expect/CH`, 'in Switzerland? (a country code)'],
      [`curl -fs ${h}/expect/AS13335,CH`, 'either one? (up to 10)'],
      ['A kill switch for when a VPN drops:'],
      [`curl -fs ${h}/expect/AS13335 || pkill -f my-private-job`],
    ]),
    block('ANY ADDRESS', [
      [`curl ${h}/8.8.8.8`, 'owner, network and location as JSON'],
      [`curl ${h}/8.8.8.8/text`, 'the same as aligned lines'],
      [`curl ${h}/8.8.8.8/country`, 'one value: asn, org, cc, country,'],
      ['', 'continent or hostname'],
      ["The vpn / proxy line also checks the VPN providers' own server lists"],
      ['(Mullvad, PIA, IVPN, AirVPN): a listed address is one their users'],
      ['connect to, and sites may see them at a different address. And Apple\'s'],
      ["list of iCloud Private Relay's addresses: sites see those instead of"],
      ["the Safari user's own."],
      ['A block registered in the last 180 days gets a line saying so: location'],
      ['databases lag behind new blocks, so sites may disagree about where it is.'],
      ['Your own address never gets one: a lookup never sends it to a registry.'],
    ]),
    block('NETWORKS, DNS, MAIL, REGISTRY RECORDS, SUBNETS', [
      [`curl ${h}/AS13335`, 'a network and its address blocks'],
      [`curl ${h}/dns/example.com`, 'DNS records; add /MX for one type'],
      [`curl ${h}/mail/gmail.com`, 'email security: SPF, DMARC, DKIM, MTA-STS,'],
      ['', 'graded A-F (?dkim=<selector> for your DKIM key)'],
      [`curl ${h}/grade/github.com`, 'domain report card, graded A-F: DNSSEC, CAA,'],
      ['', 'email, expiry, HTTPS and security headers'],
      [`curl ${h}/whois/github.com`, 'registry record: domain, IP or ASN'],
      [`curl ${h}/cidr/10.0.0.0/22`, 'subnet calculator'],
      [`curl ${h}/route/1.1.1.0/24`, 'routing: origin network, RPKI, visibility,'],
      ['', 'AS paths (a prefix or an address)'],
    ]),
    block('README BADGES (THE REPORT CARD GRADE, CACHED AN HOUR)', [
      [`https://img.shields.io/endpoint?url=https://${h}/badge/github.com.json`],
      ['  shields.io draws it, so your readers never contact ipterm'],
      [`https://${h}/badge/github.com.svg`],
      ["  drawn by ipterm: each reader's browser fetches it from here"],
    ]),
    block('PORT CHECK (YOUR OWN ADDRESS ONLY, 10 A MINUTE)', [
      [`curl -4 ${h}/port/22`, 'is TCP port 22 open on your IP?'],
      ['-4 tests your IPv4 address, where router port forwards apply.'],
    ]),
    block('LEAK TEST RESULTS (THE LINK share GIVES AFTER leaktest)', [
      [`curl ${h}/leaktest/r/1bjp`, 'the grade, VPN on or not, each check'],
      ['The code holds nothing else: no IP address, provider or place.'],
    ]),
    block('TEXT INSTEAD OF JSON', [
      ['Add /text to an address or AS number for aligned lines, like the web'],
      ['terminal (/json for JSON):'],
      [`curl ${h}/AS13335/text`],
      ['Any other lookup takes ?format=text. Quote the URL so the shell leaves'],
      ['the ? alone:'],
      [`curl '${h}/dns/example.com?format=text'`],
      ['Colors for a terminal: add ?color=1. They are off unless asked for, so'],
      ['grep, awk and jq never see escape codes:'],
      [`curl '${h}/8.8.8.8/text?color=1'`],
    ]),
    block('NOTES', [
      ['One-value answers are one line. A missing value is an empty line with'],
      [`HTTP 404, so  curl -fs ${h}/city  exits non-zero.`],
      ['30 uncached lookups a minute per address, then HTTP 429. Past it, /json'],
      ['and /text still answer, only without the hostname.'],
      ["No cookies or tracking. ipterm's code stores and logs nothing about you;"],
      ['Cloudflare, which hosts it, keeps its own request analytics and security'],
      [`events: ${h}/privacy`],
      [`OpenAPI: ${h}/openapi.json   For AI tools: ${h}/llms.txt`],
      [`Browsers: ${h} is a terminal; this reference is at ${h}/api`],
      [`Address bar: ${h}/go?q=<IP, domain, ASN, range, email or port n>`],
    ]),
    `${IPINFO_CREDIT}. Networks: RIPEstat.\nRegistry records: RDAP. DNS: Cloudflare's 1.1.1.1.` +
      (b.sha || b.url ? `\nThe code we deploy: ${[b.sha, b.url].filter(Boolean).join('  ')}` : ''),
  ].join('\n\n') + '\n';
}

// Runs a data step and maps rate limiting and provider failures to friendly responses.
// Outside services occasionally hiccup. Every upstream call gets a time limit and one retry
// (after a short pause) on network errors, timeouts, 5xx and 429 responses. by (a Date.now() time, optional) is a
// deadline for both tries together: each try gets what is left of it at most, and the retry comes only with a second
// left after the pause, so a server that doesn't answer gets one try, not two. The error says whether the last try
// timed out (timedOut).
const sleep = ms => new Promise(r => setTimeout(r, ms));
// How long whois, dig and routing may wait on the outside services they ask, every try and redirect included (by,
// above): well inside the 9 seconds the terminal waits (getJson in public/app.js), so it shows the Worker's message,
// not its own. The handbook ("When something fails") lists the worst case of every other route.
const DEADLINE = 6500;
const isTimeout = e => !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
async function fetchRetry(url, init = {}, label = 'upstream', timeout = 8000, by = Infinity) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const again = () => attempt === 0 && by - Date.now() >= 1400;      // the pause, and a second for the retry
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(0, Math.min(timeout, by - Date.now()))) });
      if (again() && (r.status >= 500 || r.status === 429)) { last = new Error(`${label} HTTP ${r.status}`); await sleep(400); continue; }
      return r;
    } catch (e) {
      last = e;
      if (again()) { await sleep(400); continue; }
      break;
    }
  }
  throw Object.assign(new Error(`${label}: ${(last && last.message) || last}`), { timedOut: isTimeout(last) });
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
    console.error('[ipterm] upstream failure:', plain(String((e && e.message) || e)).replace(/token=[^&\s]+/g, 'token=***'));
    // A registry server that didn't answer (rdapFetch) is named, and the fault put where it lies.
    return fail(e instanceof RegistrySilent ? e.text : 'A data source didn\'t respond. Try again in a moment.', 502);
  }
}

/* ---------- data ---------- */

const cacheReq = (io, key) => new Request(`${io.url.origin}/__cache/${key}`);
function cachePut(io, key, data, ttl) {
  io.ctx.waitUntil(caches.default.put(cacheReq(io, key), new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
  })));
}

async function cached(io, key, ttl, produce) {
  const hit = await caches.default.match(cacheReq(io, key));
  if (hit) return hit.json();
  await limit(io);                       // only cache misses cost an upstream call
  const data = await produce();
  if (data && typeof data._ttl === 'number') { ttl = data._ttl; delete data._ttl; }   // a result can ask to be kept shorter
  cachePut(io, key, data, ttl);
  return data;
}

// What the cache holds under key, or null: no limit, no upstream call. What a bot gets (isBot).
async function fromCache(io, key) {
  try { const hit = await caches.default.match(cacheReq(io, key)); return hit ? await hit.json() : null; } catch { return null; }
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

// io.paid: the lookup is part of a report card that has already spent its one token (see gradeFor).
// io.extra: the one count the VPN check (privacyData) and the registry date (blockData) share when a lookup
// needs either; the date takes it only when the lookup itself didn't count (io.charged).
async function limit(io) {
  if (!io.env.LOOKUP_LIMITER || !io.me || io.paid) return;
  let ok = true;
  try { ok = (await io.env.LOOKUP_LIMITER.limit({ key: limitKey(io.me) })).success; } catch { ok = true; } // fail open
  if (!ok) throw new RateLimited();
  io.charged = true;                     // this request has counted once (blockData rides on it)
}

/* Tor exits: leaktest says "Tor" when the visitor's address is a Tor exit. The Tor Project publishes the
   current exits as plain text (one address a line, a couple of thousand). Each data center keeps a copy in
   its cache for an hour, so the list costs at most one subrequest an hour per data center, and only when
   someone there runs leaktest. The visitor's address is looked up in that copy, here: it's never sent to
   the Tor Project. (Cloudflare also gives Tor traffic the country code T1, which the page reads too.) */
const TOR_EXITS_URL = 'https://check.torproject.org/torbulkexitlist';
const TOR_EXITS_TTL = 3600;
let torExits = null, torExitsUntil = 0;                  // per-instance copy, so a warm instance skips the cache read
async function torExitList(io) {
  const now = Date.now();
  if (now < torExitsUntil) return torExits;
  const req = new Request(`${io.url.origin}/__cache/tor-exits`);
  let body = null;
  try { const hit = await caches.default.match(req); if (hit) body = await hit.text(); } catch { /* cache trouble: download it */ }
  if (body == null) {
    try {
      const r = await fetch(TOR_EXITS_URL, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) { if (r.body) r.body.cancel(); throw new Error('HTTP ' + r.status); }
      body = await readBody(r, 500_000);
      io.ctx.waitUntil(caches.default.put(req, new Response(body, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${TOR_EXITS_TTL}` },
      })));
    } catch (e) {
      // Don't hold up every check while it's unavailable: leaktest still runs, without the Tor line.
      console.error(`[ipterm] Tor exit list unavailable (${plain(String((e && e.message) || e))}); trying again in 10 minutes`);
      torExits = null; torExitsUntil = now + 600_000;
      return null;
    }
  }
  const set = new Set();
  for (const ln of body.split('\n')) { const q = parseIp(ln.trim()); if (q) set.add(canonIp(q)); }
  torExits = set.size ? set : null; torExitsUntil = now + 600_000;
  return torExits;
}

// Privacy check (leaktest): your own details from Cloudflare plus IPinfo's classification of your
// address (VPN/proxy/Tor, hosting, mobile) and whether it's a Tor exit. Only runs when a visitor asks.
async function checkData(io) {
  const self = await selfInfo(io, { strict: true });
  const p = parseIp(io.me);
  let network = null;
  if (p && !nonPublicReason(p)) {
    const ip = canonIp(p);
    // A slow download of the exit list doesn't hold the check up: it finishes in the background and fills
    // the cache for the next one.
    const exits = torExitList(io).catch(() => null);
    io.ctx.waitUntil(exits);
    try {
      // proxycheck.io is asked every time here (not only when IPinfo is unsure): it can name the VPN. Unless the address
      // is on a VPN provider's own server list, which names it already: the visitor reaches sites from it, so whatever
      // its role for others, they are on that provider's server (vpnServer). Or on Apple's iCloud Private Relay list
      // (relay): then the visitor is on the relay. Both are free and local, so like the Tor line below they outlive an
      // IPinfo failure (not the rate limit).
      const listing = vpnServerData(io, ip), relaying = relayData(io, ip);
      const [d, listed, relay, privacy] = await Promise.all([ipData(io, ip, p).catch(e => { if (e instanceof RateLimited) throw e; return null; }),
        listing, relaying, Promise.all([listing, relaying]).then(([l, r]) => (l || r ? null : privacyData(io, ip)))]);
      const n = d || {};
      if (d || listed || relay) network = { source: n.source || null, asn: n.asn || null, org: n.org || null, asType: n.asType || null, flags: n.flags || null,
        privacy: privacy || null, ...(listed ? { vpnServer: listed } : {}), ...(relay ? { relay } : {}) };
    } catch (e) { if (e instanceof RateLimited) throw e; }   // classification is a bonus; the check still runs
    const list = await Promise.race([exits, sleep(1500).then(() => null)]);
    if (list && list.has(ip)) network = { ...(network || {}), tor: true };
  }
  const dns = dnsleakConf(io.env);                       // where the page sends its DNS leak test lookups, if anywhere
  return { ...self, network, ...(dns ? { dnsleak: dns.zone } : {}) };
}

// The caller's own details. The edge has all of them but the hostname, so the rate limit guards only the reverse DNS:
// past it the answer goes out without a hostname (null, as with no PTR record), never as "Too many lookups". People
// behind one busy address (an office, a campus, carrier NAT) share its 30 a minute, and the homepage, whoami, /json
// and /text should still show them their address. strict (leaktest's check, which goes on to IPinfo and
// proxycheck.io): past the limit, RateLimited, as for every other lookup. quick: the homepage's short reverse DNS (ptr).
async function selfInfo(io, { quick = false, strict = false } = {}) {
  let limited = false;
  try { await limit(io); } catch (e) { if (strict || !(e instanceof RateLimited)) throw e; limited = true; }
  const hostname = limited ? null : await ptr(io.me, quick);
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

// IPinfo's answers end up on pages and in the terminal, so each field is a string (or null), whatever arrives.
const txt = (v, n = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const asnOf = v => (typeof v === 'string' && /^AS\d{1,10}$/i.test(v) ? v.toUpperCase() : null);
const ccOf = v => (typeof v === 'string' && /^[A-Z]{2}$/i.test(v) ? v.toUpperCase() : null);

// IPinfo Core (paid): city-level location plus connection flags. Shape documented at
// https://ipinfo.io/developers/core-api: { ip, hostname, geo: {...}, as: {...}, is_* flags }. For an address IPinfo
// calls a bogon it is { ip, bogon: true } and nothing more, and so is this (IPINFO_BOGON).
async function ipinfoCore(ip, env) {
  // One attempt with a time limit: if Core has any trouble, the caller falls back to Lite.
  const r = await fetch(`https://api.ipinfo.io/lookup/${ip}`,   // ip is already validated and canonical
    { headers: { authorization: `Bearer ${env.IPINFO_TOKEN}`, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (r.status === 401 || r.status === 403 || r.status === 429) { if (r.body) r.body.cancel(); return { refused: r.status }; }
  if (!r.ok) { if (r.body) r.body.cancel(); throw new Error('ipinfo core ' + r.status); }
  const d = await r.json();
  if (d && d.bogon === true) return { source: 'ipinfo-core', bogon: true };
  const g = d && typeof d.geo === 'object' && d.geo ? d.geo : {}, a = d && typeof d.as === 'object' && d.as ? d.as : {};
  const lat = num(g.latitude), lon = num(g.longitude);
  const flag = k => (d[k] === true ? true : undefined);
  return {
    source: 'ipinfo-core',
    hostname: txt(d.hostname, 255),
    asn: asnOf(a.asn), org: txt(a.name), asDomain: txt(a.domain, 255),
    asType: ['isp', 'hosting', 'business', 'education', 'government'].includes(a.type) ? a.type : null,
    city: txt(g.city), region: txt(g.region), countryCode: ccOf(g.country_code), country: txt(g.country),
    continent: txt(g.continent), postal: txt(g.postal_code, 20), timezone: txt(g.timezone, 64),
    lat: lat != null && Math.abs(lat) <= 90 ? lat : null, lon: lon != null && Math.abs(lon) <= 180 ? lon : null,
    flags: { mobile: flag('is_mobile'), hosting: flag('is_hosting'), anonymous: flag('is_anonymous'), anycast: flag('is_anycast'), satellite: flag('is_satellite') },
  };
}

/* Budget for paid IPinfo Core lookups. One Durable Object (named "ipinfo-core") keeps the count for
   every Cloudflare location, per day (UTC) and per hour, so a scraper can use at most one hour's
   share, and never more than one day's share of the monthly quota. Once a limit is reached, lookups
   use IPinfo Lite (country and network) until the next hour or day. Only fresh lookups count:
   lookups of other addresses and leaktest's check of your own address, by people. Cached results,
   whoami, DNS and whois never do, and neither does a bot (isBot). */
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
    const put = { day, count: used + 1, hour, hcount: usedHour + 1 };
    // For /status: each finished day's totals (kept 35 days), the UTC hours whose limit filled today,
    // and when the day's did. Written only at those moments: about 26 times a day at the very most.
    if (savedDay && savedDay !== day) {
      const hist = await s.get('history');
      put.history = [await dayTotals(s, savedDay, count), ...(Array.isArray(hist) ? hist : [])].slice(0, 35);
    }
    if (hourly > 0 && usedHour + 1 === hourly) {
      const caps = await s.get('caps');
      put.caps = { day, hours: [...(caps && caps.day === day ? caps.hours : []), iso.slice(11, 13)] };
    }
    if (used + 1 === daily) put.full = iso;
    await s.put(put);
    return { ok: true, used: used + 1, usedHour: usedHour + 1, daily, hourly, day, hour };
  }
  // Counts only, for /status: today, this hour, and the past days (newest first).
  async status(now = Date.now()) {
    const iso = new Date(now).toISOString(), day = iso.slice(0, 10);
    const s = this.ctx.storage, [d, c, h, hc, hist] = [await s.get('day'), await s.get('count'), await s.get('hour'), await s.get('hcount'), await s.get('history')];
    // A finished day stays in the current keys until the next lookup moves it into the history.
    const past = [...(d && d !== day ? [await dayTotals(s, d, c)] : []), ...(Array.isArray(hist) ? hist : [])];
    return { ...await dayTotals(s, day, d === day ? c : 0), usedHour: h === iso.slice(0, 13) ? Number(hc) || 0 : 0, past: past.slice(0, 35) };
  }
}

// One day's totals: lookups made, the UTC hours whose limit filled ("14"), and when the day's limit did.
async function dayTotals(s, day, count) {
  const [caps, full] = [await s.get('caps'), await s.get('full')];
  return { day, used: Number(count) || 0, hoursRunOut: caps && caps.day === day && Array.isArray(caps.hours) ? caps.hours : [],
    ranOutAt: typeof full === 'string' && full.startsWith(day) ? full : null };
}

// Whole numbers only ("4500"); anything else (empty, negative, decimals, "abc", "1e400") uses the default.
const intVar = (v, def) => { const t = String(v ?? '').trim(); return /^\d{1,9}$/.test(t) ? Number(t) : def; };

// The configured limits, shared by the budget checks and /status. Hourly pacing defaults to twice an
// even share of the day; "0" turns it (or the per-visitor cap) off.
const limitsOf = (daily, hourly, perVisitor) => ({ daily, hourly: intVar(hourly, Math.ceil((daily / 24) * 2)), perVisitor });
const coreLimits = env => limitsOf(intVar(env.IPINFO_DAILY_BUDGET, 4500), env.IPINFO_HOURLY_BUDGET, intVar(env.IPINFO_VISITOR_HOURLY, 30));
const pcLimits = env => limitsOf(intVar(env.PROXYCHECK_DAILY_BUDGET, 900), env.PROXYCHECK_HOURLY_BUDGET, intVar(env.PROXYCHECK_VISITOR_HOURLY, 10));

let budgetBlockedUntil = 0;                              // per-instance memo: skip the check until the hour/day rolls over
async function coreAllowed(env, who = null, now = Date.now()) {
  const { daily, hourly, perVisitor } = coreLimits(env);
  if (daily === 0) return false;                         // "0" turns Core off
  if (!env.BUDGET) return true;                          // no budget configured: no cap
  if (now < budgetBlockedUntil) return false;
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
        console.error('[ipterm] IPinfo Core unavailable, using IPinfo Lite for a minute:', plain(String((e && e.message) || e)));
      }
    } else if (allowed === 'visitor') fallback = 'visitor';
  }
  if (env.IPINFO_TOKEN) {
    const r = await fetchRetry(`https://api.ipinfo.io/lite/${ip}?token=${env.IPINFO_TOKEN}`, {}, 'ipinfo lite');
    if (!r.ok) throw new Error('ipinfo lite ' + r.status);
    const d = (await r.json()) || {};
    const cap = fallback === 'visitor' ? { _visitorCap: true } : {};
    if (d.bogon === true) return { ...cap, source: 'ipinfo-lite', bogon: true };
    return {
      ...cap,
      source: 'ipinfo-lite',
      asn: asnOf(d.asn),
      org: txt(d.as_name),
      asDomain: txt(d.as_domain, 255),
      countryCode: ccOf(d.country_code),
      country: txt(d.country),
      continent: txt(d.continent),
    };
  }
  const r = await fetchRetry(`https://ipinfo.io/${ip}/json`, { headers: { accept: 'application/json' } }, 'ipinfo');
  if (!r.ok) throw new Error('ipinfo ' + r.status);
  const d = (await r.json()) || {};
  if (d.bogon === true) return { source: 'ipinfo', bogon: true };
  const [lat, lon] = (typeof d.loc === 'string' ? d.loc : '').split(',').map(Number);
  const m = /^(AS\d{1,10})\s+(.*)$/.exec(typeof d.org === 'string' ? d.org : '');
  return {
    source: 'ipinfo',
    hostname: txt(d.hostname, 255),
    asn: m ? m[1] : null,
    org: m ? txt(m[2]) : txt(d.org),
    city: txt(d.city),
    region: txt(d.region),
    postal: txt(d.postal, 20),
    countryCode: ccOf(d.country),
    country: countryName(ccOf(d.country)),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    timezone: txt(d.timezone, 64),
    // The free API marks anycast too (as on 8.8.8.8), and nothing else of Core's flags: enough for the connection
    // line and for the map not to draw a radius. vpnText reads only Core's flags, so the VPN verdict is unchanged.
    ...(d.anycast === true ? { flags: { anycast: true } } : {}),
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
  const { daily, hourly, perVisitor } = pcLimits(env);
  if (daily === 0 || now < pcBlockedUntil) return false;
  if (!env.BUDGET) return true;
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
  if (io.bot) return null;                 // a bot only reads what someone else's check paid for (isBot)
  if (now < pcRefusedUntil) return null;
  // The visitor's rate limit applies here too: an IPinfo answer may have come from the cache, and
  // without this, repeating a lookup would reach the budget counter on every request.
  try { await (io.extra ||= limit(io)); } catch { return null; }   // one count, shared with blockData's
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

/* ---------- known VPN servers and iCloud Private Relay: the providers' own lists ----------
   src/vpn-lists.js reads each VPN provider's published server list, and src/relay-list.js Apple's list of iCloud
   Private Relay's egress ranges; this part keeps them. One Durable Object (VpnServers, named "lists") downloads them on
   the cron trigger (wrangler.toml [triggers], every 6 hours): one request per list, no retries, a time limit and a
   size cap on each. It keeps every address seen on a VPN provider's list in the last 3 days (mergeRecord), so a
   download that fails or comes back broken changes nothing, and packs them into one blob of sorted addresses
   (packIndex: about 70 KB in October 2026). Apple's list (about 12 MB of CSV, 285,000 ranges) is asked for with the
   last copy's ETag, so an unchanged list costs a 304; a new one is read a chunk at a time and merged into about 7,000
   ranges (packRelay: about 100 KB), and replaces the last good copy. Both are well under a Durable Object's 2 MB per value. Each data center
   caches each blob for 30 minutes and each Worker keeps it in memory for 10, so a lookup is a binary search in memory:
   no outside request and no budget, the same for bots and people. A Durable Object rather than KV or D1: the
   deployment creates it (no namespace or database to set up, on ipterm.net or a copy), the writes are a few blobs four
   times a day, and the reads come from the cache. */
const VPN_WAIT = 1500;                   // a lookup waits this long at most for a list, then goes on without it
// Each list a Worker keeps: its Cache API key (with the blob's format, so a new format never meets an old cached
// copy), the object's method that hands it over, and how to read it.
const LISTS = {
  vpn: { key: 'vpn-servers/2', method: 'blob', unpack: unpackIndex, what: 'VPN server lists' },
  relay: { key: 'icloud-relay/1', method: 'relayBlob', unpack: unpackRelay, what: 'iCloud Private Relay list' },
};
const listState = { vpn: { idx: null, until: 0, load: null, loadAt: 0 }, relay: { idx: null, until: 0, load: null, loadAt: 0 } };
const listAgent = env => `ipterm (${env.SOURCE_URL || 'https://github.com/GuardWiseSec/ipterm'}) refreshing its lists of known VPN servers and iCloud Private Relay`;

export class VpnServers extends DurableObject {
  // The packed VPN index (blob) or Private Relay ranges (relayBlob), or null before the first good download. Asked
  // while one is missing, the object starts a refresh of that list (an alarm) at most once an hour after its last try,
  // so a new deployment doesn't wait for the cron, and a missing relay list never sends the VPN lists' requests again
  // (or the reverse). One stored in an older format counts as none, so a deployment that changes the format refreshes
  // too.
  blob(now = Date.now()) { return this.#stored('blob', isIndex, 'vpn', now); }
  relayBlob(now = Date.now()) { return this.#stored('relay', isRelay, 'relay', now); }
  async #stored(key, valid, list, now) {
    const s = this.ctx.storage, v = await s.get(key), b = valid(v) ? v : null;
    if (!b && now - ((await s.get(list === 'vpn' ? 'tried' : 'relayTried')) || 0) > 3600_000) {
      await s.put('want:' + list, true);
      if (!(await s.getAlarm())) await s.setAlarm(now + 1000);
    }
    return b;
  }
  // The lists a lookup found missing (want:), or both when it was set some other way.
  async alarm() {
    const s = this.ctx.storage, vpn = !!(await s.get('want:vpn')), relay = !!(await s.get('want:relay'));
    await s.delete(['want:vpn', 'want:relay']);
    await this.refresh(Date.now(), vpn || relay ? { vpn, relay } : undefined);
  }
  // One refresh of each list at a time: a cron run and an alarm that meet share it. It resolves to the VPN lists'
  // status, or null when only Apple's was refreshed (relayStatus() has that one).
  refresh(now = Date.now(), only = { vpn: true, relay: true }) {
    const s = this.ctx.storage;
    const vpn = only.vpn ? (this.vpnRun ||= refreshVpnLists(s, this.env, now).finally(() => { this.vpnRun = null; })) : null;
    const relay = only.relay ? (this.relayRun ||= refreshRelay(s, this.env, now).finally(() => { this.relayRun = null; })) : null;
    return Promise.all([vpn, relay]).then(([meta]) => meta);
  }
  // For /status: each provider's addresses kept, its last good download (when, how many on it) and last try; and the
  // same for Apple's list.
  async status() { return (await this.ctx.storage.get('meta')) || {}; }
  async relayStatus() { return (await this.ctx.storage.get('relayMeta')) || {}; }
}

// Downloads every provider's list (all at once) and keeps what passes: it parses, has at least the provider's minimum,
// and leaves the provider with at most VPN_MAX_KEPT addresses (so one provider's list can't make the shared write too
// big for storage and stop everyone's update). Each address stays until it has been off its provider's list for
// VPN_MAX_AGE (mergeRecord), so a download that fails or comes back short removes nothing seen lately, and a provider
// that stops answering drops out after that long. The last try's trouble, if any, shows on /status.
async function refreshVpnLists(s, env, now) {
  await s.put('tried', now);
  const got = await Promise.all(VPN_PROVIDERS.map(async p => {
    try {
      const r = await fetch(p.url, { headers: { accept: 'application/json', 'user-agent': listAgent(env) }, signal: AbortSignal.timeout(VPN_FETCH_TIMEOUT) });
      if (!r.ok) { if (r.body) r.body.cancel(); throw new Error('HTTP ' + r.status); }
      return { rec: toRecord(p.parse(await readBody(r, p.max))) };
    } catch (e) {
      // A parse error quotes the provider's text, which could carry terminal escapes into the logs.
      return { error: plain(String((e && e.message) || e)).slice(0, 160) };
    }
  }));
  const meta = (await s.get('meta')) || {}, put = {}, lists = [], iso = new Date(now).toISOString();
  for (const [i, p] of VPN_PROVIDERS.entries()) {
    const { rec, error } = got[i], m = { ...meta[p.id], tried: iso }, old = await s.get('list:' + p.id);
    const n = rec ? rec.four.length + rec.role6.length : 0;
    let why = error || (n < p.min ? `only ${n} addresses (at least ${p.min} expected)` : null);
    let kept = mergeRecord(old, why ? null : rec, now);
    const total = kept.four.length + kept.role6.length;
    if (!why && total > VPN_MAX_KEPT) { why = `${total} addresses with this list (at most ${VPN_MAX_KEPT} kept)`; kept = mergeRecord(old, null, now); }
    if (why) m.error = why;
    else Object.assign(m, { at: iso, listed: n, error: null });
    Object.assign(m, { n4: kept.four.length, n6: kept.role6.length });
    meta[p.id] = m;
    put['list:' + p.id] = kept;
    if (m.n4 + m.n6) lists.push({ id: p.id, name: p.name, at: Date.parse(m.at) || now, rec: kept });
  }
  put.meta = meta;
  if (lists.length) put.blob = packIndex(lists, now);
  await s.put(put);
  if (!lists.length) await s.delete('blob');             // nothing seen in VPN_MAX_AGE: lookups find none
  console.log('[ipterm] VPN server lists: ' + VPN_PROVIDERS.map(p => `${p.id} ${meta[p.id].n4 + meta[p.id].n6}` +
    (meta[p.id].error ? ` (kept; this try: ${meta[p.id].error})` : '')).join(', '));
  return meta;
}

// Downloads Apple's iCloud Private Relay list (src/relay-list.js), asking with the stored copy's ETag, so an unchanged
// list is a 304 with no body: the stored ranges are then dated now. A new list is read a chunk at a time
// (parseRelayStream: the 12 MB never sits in memory whole) and replaces the stored one when it has at least RELAY.min
// ranges; otherwise the last good copy stays, and lookups stop using it once it is VPN_MAX_AGE old (no good download
// or 304 in 3 days). The meta changes only once the ranges are stored, so it never names a list that isn't. Parsing
// takes well under a second of CPU, and only when the list changed.
async function refreshRelay(s, env, now) {
  await s.put('relayTried', now);
  const iso = new Date(now).toISOString(), prev = (await s.get('relayMeta')) || {}, old = await s.get('relay');
  const etag = isRelay(old) && prev.etag ? prev.etag : null;
  let m;
  try {
    const r = await fetch(RELAY.url, { headers: { 'user-agent': listAgent(env), ...(etag ? { 'if-none-match': etag } : {}) }, signal: AbortSignal.timeout(RELAY.timeout) });
    if (r.status === 304 && etag) {
      if (r.body) r.body.cancel();
      const next = { ...prev, tried: iso, at: iso, error: null, unchanged: true };
      await s.put({ relay: restampRelay(old, now), relayMeta: next });
      m = next;
    } else {
      if (!r.ok || !r.body) { if (r.body) r.body.cancel(); throw new Error('HTTP ' + r.status); }
      if (Number(r.headers.get('content-length')) > RELAY.max) { r.body.cancel(); throw new Error('response too large'); }
      const rec = await parseRelayStream(r.body, RELAY.max);
      if (rec.count < RELAY.min) throw new Error(`only ${rec.count} ranges (at least ${RELAY.min} expected)`);
      const next = { ...prev, tried: iso, at: iso, error: null, unchanged: false, etag: r.headers.get('etag') || null, count: rec.count, n4: rec.four.length, n6: rec.six.length };
      await s.put({ relay: packRelay(rec, now), relayMeta: next });
      m = next;
    }
  } catch (e) {
    m = { ...prev, tried: iso, error: plain(String((e && e.message) || e)).slice(0, 160) };
    await s.put('relayMeta', m);
  }
  console.log(`[ipterm] iCloud Private Relay list: ${m.count || 0} ranges` + (m.error ? ` (kept; this try: ${m.error})` : m.unchanged ? ' (unchanged)' : ''));
  return m;
}

// A list for this Worker (LISTS): from memory (10 minutes), this data center's cache (30 minutes) or the Durable
// Object. Never rejects. Past its 10 minutes a list still answers at once while the next copy loads in the background
// (each address in the VPN index expires on its own, and the relay list once it is 3 days old), so only a Worker that
// has none waits, for VPN_WAIT at most, then goes on without. When nothing loaded, it asks again a minute later, not on
// every lookup (until applies with or without a list), and the same once a load has taken longer than VPN_WAIT: the
// lookups after it go on without for a minute instead of each waiting again (a load that settles meanwhile still
// installs its list). Requests share one load in flight, and one older than 30 seconds counts as gone: its requester
// may have left before it settled (as gradeFor's cards), and a promise that never settles mustn't hold up every later
// lookup.
function listIndex(io, which) {
  const st = listState[which], now = Date.now();
  if (now < st.until) return Promise.resolve(st.idx);
  if (!io.env.VPN_SERVERS) return Promise.resolve(null);
  if (!st.load || now - st.loadAt > 30_000) {
    const load = loadListIndex(io, which).finally(() => { if (st.load === load) st.load = null; });
    st.load = load; st.loadAt = now;
    io.ctx.waitUntil(load);
  }
  return st.idx ? Promise.resolve(st.idx) : Promise.race([st.load, sleep(VPN_WAIT).then(() => {
    if (!st.idx) st.until = Math.max(st.until, Date.now() + 60_000);
    return st.idx;
  })]);
}
async function loadListIndex(io, which) {
  const L = LISTS[which], st = listState[which], req = cacheReq(io, L.key), ns = io.env.VPN_SERVERS;
  let buf = null, fresh = false;
  try { const hit = await caches.default.match(req); if (hit) buf = await hit.arrayBuffer(); } catch { /* cache trouble: ask the object */ }
  if (!buf) {
    try { buf = await ns.get(ns.idFromName('lists'))[L.method](); fresh = !!buf; } catch (e) {
      console.error(`[ipterm] ${L.what} unavailable:`, plain(String((e && e.message) || e)));
    }
  }
  try { if (buf) st.idx = L.unpack(buf); } catch (e) { buf = null; console.error(`[ipterm] ${L.what} unreadable:`, plain(String((e && e.message) || e))); }
  if (buf && fresh) io.ctx.waitUntil(caches.default.put(req, new Response(buf, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=1800' },
  })).catch(() => {}));
  st.until = Date.now() + (buf ? 600_000 : 60_000);      // nothing yet (a new deployment): ask again in a minute
  return st.idx;
}

// The address's entry on a VPN provider's own server list, or null: { provider, role, lastSeen }. role "exit": the
// provider's users reach sites from this address; "entry": they connect to it, and reach sites from another address.
// lastSeen: when it was last on that list (within the last 3 days). Free and local, so a bot gets it too (isBot is
// about the paid budgets).
async function vpnServerData(io, ip) {
  try {
    // Only providers still in VPN_PROVIDERS: one taken out answers nothing from the next deployment on, not from the
    // next refresh.
    const hit = findServer(await listIndex(io, 'vpn'), ip, Date.now(), new Set(VPN_PROVIDERS.map(p => p.id)));
    return hit ? { provider: hit.provider, role: hit.role, lastSeen: hit.seen } : null;
  } catch { return null; }
}

// Whether the address is one iCloud Private Relay sends traffic out from (on Apple's own list), or null:
// { service, operator, listUpdated }, listUpdated being when that list was last downloaded or confirmed unchanged.
// Free and local, like vpnServerData.
async function relayData(io, ip) {
  try {
    const hit = findRelay(await listIndex(io, 'relay'), ip, Date.now());
    return hit ? { service: 'iCloud Private Relay', operator: 'Apple', listUpdated: hit.at } : null;
  } catch { return null; }
}

// Both free listings, for a lookup that asks for no paid check (?lite=1): leaktest's lookup of the visitor's other IP
// version uses it to tell whether that address goes through the relay too.
async function withListings(io, ip, pending) {
  const [d, listed, relay] = await Promise.all([pending, vpnServerData(io, ip), relayData(io, ip)]);
  return !d || d.bogon || (!listed && !relay) ? d : { ...d, ...(listed ? { vpnServer: listed } : {}), ...(relay ? { relay } : {}) };
}

/* ---------- RIPEstat: networks and routing ----------
   Free, no key. Answers are read with a size cap, since a big network's answer can run to megabytes and
   parsing that would use up the Worker's CPU time. by: a deadline shared with other calls (fetchRetry). */
const RIPESTAT = 'https://stat.ripe.net/data/';
async function ripestat(call, query, { max = 1_000_000, timeout = 8000, retry = true, by = Infinity } = {}) {
  const url = `${RIPESTAT}${call}/data.json?${query}&sourceapp=ipterm`;
  const r = retry ? await fetchRetry(url, {}, 'ripestat ' + call, timeout, by)
    : await fetch(url, { signal: AbortSignal.timeout(Math.max(0, Math.min(timeout, by - Date.now()))) });
  if (!r.ok) { if (r.body) r.body.cancel(); throw new Error(`ripestat ${call} HTTP ${r.status}`); }
  const j = await readJson(r, max);
  return j && typeof j.data === 'object' && j.data ? j.data : {};
}
const holderName = h => { const m = /^(\S+) - (.+)$/.exec(h || ''); return m ? m[2] : h || null; };   // "CLOUDFLARENET - Cloudflare, Inc."

// A network's main upstreams: the neighbours RIPEstat sees just before it in AS paths ("left" of it), the
// five seen by the most RIS peers, with their names. The neighbour list of a large transit network runs to
// thousands of entries and hundreds of kilobytes, and its "left" neighbours are peers, not upstreams, so a
// list over UPSTREAM_MAX bytes is skipped: tooMany. Six RIPEstat calls at most, the names in parallel.
const UPSTREAM_MAX = 300_000;
async function upstreams(n) {
  let nb;
  try { nb = await ripestat('asn-neighbours', `resource=AS${n}`, { max: UPSTREAM_MAX }); } catch (e) {
    if (/too large/.test(String(e && e.message))) return { tooMany: true, list: [] };
    throw e;
  }
  const left = (Array.isArray(nb.neighbours) ? nb.neighbours : [])
    .filter(x => x && x.type === 'left' && Number.isInteger(x.asn) && x.asn > 0 && x.asn <= 4294967295 && x.asn !== n)
    .sort((a, b) => (Number(b.power) || 0) - (Number(a.power) || 0) || (Number(b.v4_peers) || 0) - (Number(a.v4_peers) || 0)).slice(0, 5);
  const names = await Promise.all(left.map(x => ripestat('as-overview', `resource=AS${x.asn}`, { max: 20_000, timeout: 4000, retry: false })
    .then(o => txt(holderName(typeof o.holder === 'string' ? o.holder : ''), 80), () => null)));
  const counts = nb.neighbour_counts || {};
  return { total: Number.isInteger(counts.left) ? counts.left : left.length, list: left.map((x, i) => ({ asn: 'AS' + x.asn, name: names[i] || null })) };
}

async function asnData(n) {
  // The upstreams are a bonus: if RIPEstat has trouble with them, the page goes out without, kept 10 minutes.
  const [ov, pf, up] = await Promise.all([
    ripestat('as-overview', `resource=AS${n}`),
    ripestat('announced-prefixes', `resource=AS${n}`, { max: 4_000_000 }),
    upstreams(n).catch(() => null),
  ]);
  const holder = typeof ov.holder === 'string' ? ov.holder : '';
  const hm = /^(\S+) - (.+)$/.exec(holder);
  const reg = /Assigned by (\w+)/i.exec((ov.block && ov.block.desc) || '');
  const all = (pf.prefixes || []).map(x => x && x.prefix).filter(x => typeof x === 'string' && /^[0-9a-f.:]+\/\d{1,3}$/i.test(x));
  const v4 = all.filter(x => !x.includes(':')), v6 = all.filter(x => x.includes(':'));
  return {
    asn: 'AS' + n,
    number: n,
    found: Boolean(holder) || all.length > 0,
    holder: holder || null,
    handle: hm ? hm[1] : null,
    name: hm ? hm[2] : holder || null,
    registry: reg ? reg[1].toUpperCase() : null,
    announced: Boolean(ov.announced),
    v4: { count: v4.length, addresses: v4Addresses(v4), prefixes: largestFirst(v4).slice(0, 50) },
    v6: { count: v6.length, prefixes: largestFirst(v6).slice(0, 50) },
    upstreams: up,
    source: 'ripestat',
    ...(up ? {} : { _ttl: 600 }),
  };
}

/* Routing for a public prefix or address: the route that carries it, which network originates that route,
   whether RPKI allows that origin, how many RIS peers see it, and a few AS paths. RIPEstat only (never IPinfo
   or proxycheck.io), five calls at most, cached six hours (ten minutes if a part didn't answer), all of them within
   DEADLINE together, so a RIPEstat that doesn't answer costs 6.5 seconds at most, not 17:
     prefix-overview  the route (the prefix itself, or the less specific that covers it) and its origins;
                      6 seconds, one retry while the deadline allows. Then, in parallel, one try each, cut short
                      by the deadline:
     routing-status   RIS visibility and first seen; 4 seconds (it is slow for big aggregates)
     rpki-validation  each origin (up to two) against the published ROAs; 5 seconds
     bgp-state        AS paths, 5 seconds, from three RIS collectors only (rrcs=): RRC00 Amsterdam (multihop, peers
                      worldwide), RRC01 London and RRC11 New York, about 100 routes. (looking-glass ignores
                      rrcs= and answers with every collector, so it isn't used.) */
const ROUTE_RRCS = [['00', 'Amsterdam'], ['01', 'London'], ['11', 'New York']];
const RPKI_STATES = { valid: 'valid', invalid_asn: 'invalid-asn', invalid_length: 'invalid-length', invalid: 'invalid', unknown: 'not-found', not_found: 'not-found' };

// What to look up: { query, ip, p } for a public address or prefix (canonical), or { error }.
function routeTarget(raw) {
  const s = String(raw || '').trim().replace(/-(\d{1,3})$/, '/$1');
  if (!s) return { error: 'Give a prefix or an address, like 1.1.1.0/24 or 8.8.8.8.' };
  const p = !s.includes('/') && parseIp(s);
  if (p) {
    const why = nonPublicReason(p);
    return why ? { error: `${canonIp(p)} is not a public address, so it isn't routed on the internet: it is ${CIDR.rangeIn(why)}.` } : { query: canonIp(p), ip: true, p };
  }
  const d = CIDR.calc(s);
  if (d.error) return { error: d.error };
  // A public block can start with a non-public entry (192.88.99.2/31, with the 6a44 relay address): it says so.
  const why = nonPublicReason(parseIp(d.network));
  if (d.range !== 'public' || why) {
    return { error: `${d.cidr} is not public address space, so it isn't routed on the internet: it ${d.range !== 'public' ? CIDR.rangeIs(d.rangeNote) : 'starts with the ' + why}.` };
  }
  if (d.prefix < (d.v === 4 ? 8 : 16)) return { error: `${d.cidr} is larger than any route: give a /${d.v === 4 ? 8 : 16} or smaller.` };
  return { query: d.cidr, ip: false, p: parseIp(d.network), len: d.prefix };
}
// A bot (isBot) gets routing only from the cache, where someone else's lookup put it, and otherwise null: RIPEstat is
// free but asks for fair use, and a crawler following ASN pages' prefix links opened about 155 /cidr pages a minute,
// several calls each. The exception is the public prefixes in SITEMAP_PATHS (curatedRoutes): three pages whose titles
// are their routing, five calls each at most every six hours per data center, and a list no request can add to.
let curatedR = null;
const curatedRoutes = () => curatedR || (curatedR = new Set(SITEMAP_PATHS.filter(p => p.startsWith('/cidr/')).map(p => p.slice(6))));
const routeData = (io, t) => (io.bot && !curatedRoutes().has(t.query) ? fromCache(io, 'route/' + t.query)
  : cached(io, 'route/' + t.query, 21600, () => routeLookup(t)));
// What a bot is told in place of routing nobody has looked up lately (routeData).
const ROUTE_BOT = "Routing data skipped: RIPEstat isn't asked for automated visitors (crawlers, link previews, bots).";

// A prefix from upstream data, in canonical form, or null.
function canonPrefix(s) {
  if (typeof s !== 'string' || !/^[0-9a-f.:]{2,39}\/\d{1,3}$/i.test(s)) return null;
  const d = CIDR.calc(s);
  return d.error ? null : d.cidr;
}
// Whether prefix a lies within b (or is b).
const prefixWithin = (a, b) => { const [na, la] = a.split('/'), lb = Number(b.split('/')[1]), p = parseIp(na); return !!p && Number(la) >= lb && inPrefix(p, b) >= 0; };

async function routeLookup(t) {
  const by = Date.now() + DEADLINE;
  const po = await ripestat('prefix-overview', 'resource=' + t.query, { max: 200_000, timeout: 6000, by });
  const origins = (Array.isArray(po.asns) ? po.asns : []).filter(a => a && Number.isInteger(a.asn) && a.asn > 0 && a.asn <= 4294967295).slice(0, 4)
    .map(a => { const holder = txt(a.holder, 160); return { asn: 'AS' + a.asn, holder, name: holderName(holder), rpki: null, roas: [] }; });
  const asked = t.ip ? `${t.query}/${t.p.v === 4 ? 32 : 128}` : t.query;
  let prefix = po.announced && origins.length ? canonPrefix(po.resource) : null;
  if (prefix && !prefixWithin(asked, prefix)) prefix = null;   // must cover what was asked
  const related = (Array.isArray(po.related_prefixes) ? po.related_prefixes : []).slice(0, 200).map(canonPrefix).filter(Boolean);
  const inside = t.ip ? [] : [...new Set(related.filter(x => x !== t.query && prefixWithin(x, t.query)))];
  const reg = /\b(ARIN|RIPE NCC|APNIC|LACNIC|AFRINIC)\b/.exec((po.block && po.block.desc) || '');
  const d = {
    query: t.query, kind: t.ip ? 'ip' : 'prefix',
    status: prefix ? (prefix === t.query ? 'announced' : 'covered') : inside.length ? 'split' : 'unrouted',
    prefix, origins: prefix ? origins : [], registry: reg ? reg[1] : null,
    visibility: null, firstSeen: null, upstreams: [], paths: [], routes: 0,
    inside: inside.slice(0, 8), insideMore: inside.length > 8 || (Number(po.actual_num_related) || 0) > related.length,
    collectors: ROUTE_RRCS.map(([k, place]) => `RRC${k} ${place}`), source: 'ripestat',
  };
  if (!prefix) return withRouteNotes(d);
  let partial = false;
  const soft = pending => pending.catch(() => { partial = true; return null; });
  // One try each, in parallel, so a slow part costs at most five seconds (or what is left of the deadline) and the
  // rest still shows.
  const once = { retry: false, timeout: 5000, by };
  const [rs, bs, ...rpki] = await Promise.all([
    soft(ripestat('routing-status', 'resource=' + prefix, { ...once, max: 100_000, timeout: 4000 })),
    soft(ripestat('bgp-state', `resource=${prefix}&rrcs=${ROUTE_RRCS.map(([k]) => k).join(',')}`, { ...once, max: 400_000 })),
    ...d.origins.slice(0, 2).map(o => soft(ripestat('rpki-validation', `resource=${o.asn}&prefix=${prefix}`, { ...once, max: 50_000 }))),
  ]);
  rpki.forEach((r, i) => {
    if (!r) return;
    const o = d.origins[i];
    o.rpki = RPKI_STATES[String(r.status || '').toLowerCase()] || null;
    o.roas = (Array.isArray(r.validating_roas) ? r.validating_roas : []).slice(0, 3)
      .map(x => ({ asn: /^\d{1,10}$/.test(String(x && x.origin)) ? 'AS' + Number(x.origin) : null, prefix: canonPrefix(x && x.prefix), maxLength: Number.isInteger(x && x.max_length) ? x.max_length : null }))
      .filter(x => x.asn && x.prefix);
  });
  const vis = rs && rs.visibility && rs.visibility[t.p.v === 4 ? 'v4' : 'v6'];
  if (vis && Number.isInteger(vis.ris_peers_seeing) && Number.isInteger(vis.total_ris_peers) && vis.total_ris_peers > 0) {
    d.visibility = { seeing: vis.ris_peers_seeing, total: vis.total_ris_peers };
  }
  const fs = rs && rs.first_seen;
  if (fs && fs.prefix === prefix && /^\d{4}-\d{2}-\d{2}/.test(String(fs.time))) d.firstSeen = String(fs.time).slice(0, 10);
  // AS paths: prepending collapsed, the origin last. The upstream is the AS just before the origin.
  const routes = (bs && Array.isArray(bs.bgp_state) ? bs.bgp_state : []).slice(0, 400).flatMap(r => {
    if (!r || r.target_prefix !== prefix || !Array.isArray(r.path)) return [];
    const path = r.path.filter(a => Number.isInteger(a) && a > 0 && a <= 4294967295).filter((a, i, all) => a !== all[i - 1]);
    const rrc = /^(\d\d)-/.exec(String(r.source_id || ''));
    return path.length && path.length <= 32 ? [{ path, rrc: rrc ? rrc[1] : null }] : [];
  });
  d.routes = routes.length;
  const ups = new Map();
  for (const r of routes) if (r.path.length > 1) { const u = r.path[r.path.length - 2]; ups.set(u, (ups.get(u) || 0) + 1); }
  d.upstreams = [...ups].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map(([a, n]) => ({ asn: 'AS' + a, routes: n }));
  // Two or three sample paths: the shortest through each of the most common upstreams, then the shortest others.
  const byLen = [...routes].sort((a, b) => a.path.length - b.path.length), picked = [], seen = new Set();
  const take = r => { const k = r.path.join(' '); if (picked.length < 3 && !seen.has(k)) { seen.add(k); picked.push({ path: r.path, collector: r.rrc ? 'RRC' + r.rrc : null }); } };
  for (const u of d.upstreams) { const r = byLen.find(x => x.path.length > 1 && 'AS' + x.path[x.path.length - 2] === u.asn); if (r) take(r); }
  byLen.forEach(take);
  d.paths = picked;
  if (partial || !bs) d._ttl = 600;
  return withRouteNotes(d);
}

// The words for RPKI and the whole result, in the JSON too (rpkiNote, summary), so the terminal says the same.
function withRouteNotes(d) {
  for (const o of d.origins) o.rpkiNote = o.rpki ? rpkiText(o) : null;
  d.summary = routeSummary(d);
  return d;
}
function rpkiText(o) {
  const roa = o.roas.find(r => r.asn === o.asn);
  return { valid: `valid: a ROA allows ${o.asn} to announce it` + (roa && roa.maxLength ? `, up to /${roa.maxLength}` : ''),
    'invalid-asn': 'invalid: the ROAs for this prefix name another network as its origin',
    'invalid-length': 'invalid: the route is more specific than its ROA allows',
    invalid: 'invalid: the published ROAs do not allow this route',
    'not-found': 'not found: no ROA covers this prefix' }[o.rpki] || 'not checked';
}

// brief: without the RPKI and visibility sentences (a page's description)
function routeSummary(r, brief = false) {
  if (!r || r.error) return '';
  const o = r.origins[0], who = o ? o.asn + (o.name ? ` (${o.name})` : '') : 'an unknown network';
  const more = r.origins.length > 1 ? ` and ${r.origins.length - 1} other network${r.origins.length > 2 ? 's' : ''}` : '';
  const tail = brief ? '' : (o && o.rpki ? ` RPKI: ${rpkiText(o)}.` : '') + (r.visibility ? ` ${r.visibility.seeing} of ${r.visibility.total} RIS peers see it.` : '');
  if (r.status === 'announced') return `${r.query} is announced in BGP by ${who}${more}.${tail}`;
  if (r.status === 'covered') return (r.kind === 'ip' ? `${r.query} is routed in ${r.prefix}` : `${r.query} is not announced on its own: it is routed as part of ${r.prefix}`) + `, announced by ${who}${more}.${tail}`;
  if (r.status === 'split') return `${r.query} is not announced as a whole, but as more specific prefixes such as ${r.inside.slice(0, 3).join(', ')}.`;
  return `${r.query} is not announced in BGP: no RIS peer sees a route that covers it.`;
}

// [key, value] rows for the page and ?format=text. asText: one AS path per line.
function routeRows(r) {
  const path = p => p.path.map(a => 'AS' + a).join(' ') + (p.collector ? `  (${p.collector})` : '');
  return [
    ['route', r.prefix ? r.prefix + (r.status === 'covered' ? (r.kind === 'ip' ? ' (the route this address is in)' : ' (covers this prefix)') : ' (announced as is)')
      : r.status === 'split' ? 'not announced as a whole' : 'not announced'],
    ['origin', r.origins.map(o => o.asn + (o.name ? ' ' + o.name : ''))],
    ['RPKI', r.origins.filter(o => o.rpki).map(o => (r.origins.length > 1 ? o.asn + ': ' : '') + rpkiText(o))],
    ['visibility', r.visibility ? `seen by ${r.visibility.seeing} of ${r.visibility.total} RIS peers` : null],
    ['first seen', r.firstSeen], ['registry', r.registry],
    ['upstreams', r.upstreams.length ? r.upstreams.map(u => u.asn).join(' ') + `  (just before the origin in ${r.routes} sampled routes)` : null],
    ['AS paths', r.paths.map(path)],
    ['more specific', r.inside.length ? r.inside.join(' ') + (r.insideMore ? ' and more' : '') : null],
    ['collectors', r.prefix ? r.collectors.join(', ') : null],
  ];
}

function routeText(d, o) {
  return kvText([['query', d.query], ['summary', d.summary], ...routeRows(d)], ['Routing data: RIPEstat (https://stat.ripe.net), from the RIS route collectors.'], o);
}

// The n largest prefixes, largest first, then in address order. Only the sizes needed to reach n are parsed
// and sorted, with each key worked out once. (A comparator that called localeCompare(..., { numeric: true })
// built a collator on every comparison: a quarter of a second of CPU for a network with 5,000 prefixes,
// AS13335, far past the Workers limit.)
function largestFirst(list, n = 50) {
  const bySize = new Map();
  for (const s of list) { const len = Number(s.slice(s.indexOf('/') + 1)); if (!bySize.has(len)) bySize.set(len, []); bySize.get(len).push(s); }
  const out = [];
  for (const len of [...bySize.keys()].sort((a, b) => a - b)) {
    if (out.length >= n) break;
    const keyed = bySize.get(len).map(s => { const p = parseIp(s.slice(0, s.indexOf('/'))); return { s, k: p ? (p.v === 4 ? p.o : p.g) : [] }; });
    keyed.sort((x, y) => { for (let i = 0; i < x.k.length; i++) if (x.k[i] !== y.k[i]) return x.k[i] - y.k[i]; return 0; });
    for (const x of keyed) out.push(x.s);
  }
  return out.slice(0, n);
}

// Unique IPv4 addresses covered by a set of prefixes (overlaps counted once). A light parse, not parseIp():
// a big network has thousands of prefixes, and every millisecond here counts against the CPU limit.
function v4Addresses(prefixes) {
  const iv = [];
  for (const s of prefixes) {
    const [a, l] = s.split('/'), o = a.split('.'), len = Number(l);
    if (o.length !== 4 || !(len >= 0 && len <= 32)) continue;
    let start = 0;
    for (const x of o) { const v = x.length && x.length <= 3 ? Number(x) : NaN; if (!(v >= 0 && v <= 255)) { start = NaN; break; } start = start * 256 + v; }
    if (Number.isNaN(start)) continue;
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
// A label starting with "_" (_dmarc.gmail.com, selector1._domainkey.outlook.com) names a DNS record, not a host.
// dig takes it, but it has no website, mail or registration of its own, so it gets no report card.
const recordName = name => /(^|\.)_/.test(name);

function reverseName(p) {
  return p.v === 4 ? [...p.o].reverse().join('.') + '.in-addr.arpa'
    : p.g.map(x => x.toString(16).padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa';
}

// by: a deadline shared by the queries of one answer (dnsData), so a resolver that doesn't answer costs 6.5 seconds.
async function doh(name, type, by = Infinity) {
  const r = await fetchRetry(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { accept: 'application/dns-json' } }, 'dns', 8000, by);
  if (!r.ok) throw new Error('dns HTTP ' + r.status);
  return r.json();
}

const short = (s, n = 500) => String(s).slice(0, n);
const host = s => short(String(s).replace(/\.$/, ''), 255);
// An MX record pointing at "." is a null MX (RFC 7505): the domain accepts no mail. ('' is the same
// record as parsed before the "." was kept, still possible in a cached answer.) Matches app.js.
const nullMx = r => r.value === '.' || r.value === '';
const mxText = r => `${r.priority} ` + (nullMx(r) ? '. (accepts no mail: null MX)' : r.value);
// A TXT record's text. One record may be split into several quoted strings, joined here.
function txtData(data, n = 1000) {
  data = String(data);
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return short(parts ? parts.map(x => x.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : data, n);
}
function parseRecord(type, data) {
  data = String(data);
  switch (type) {
    case 'MX': { const m = /^(\d+)\s+(\S+)$/.exec(data); return m ? { priority: Number(m[1]), value: m[2] === '.' ? '.' : host(m[2]) } : { value: short(data) }; }
    case 'NS': case 'CNAME': case 'PTR': return { value: host(data) };
    case 'TXT': return { value: txtData(data) };
    case 'SOA': {
      const f = data.split(/\s+/);
      return f.length >= 7 ? { value: host(f[0]), admin: host(f[1]), serial: Number(f[2]) || f[2], refresh: Number(f[3]), retry: Number(f[4]), expire: Number(f[5]), minimum: Number(f[6]) } : { value: short(data) };
    }
    case 'SRV': { const f = data.split(/\s+/); return f.length === 4 ? { priority: Number(f[0]), weight: Number(f[1]), port: Number(f[2]), value: host(f[3]) } : { value: short(data) }; }
    default: return { value: short(data) };
  }
}

async function dnsData(io, name, types, forIp) {
  const by = Date.now() + DEADLINE;
  const res = await Promise.all(types.map(t => doh(name, t, by)));
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
  // A resolver failure (SERVFAIL while a zone turns DNSSEC on, say) is kept a minute, not the usual five, like mail's.
  if (d.status !== 'NOERROR' && d.status !== 'NXDOMAIN') d._ttl = 60;
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

/* ---------- mail check ----------
   mail <domain>: MX and the provider behind it, SPF (its DNS lookups counted against RFC 7208's limit
   of 10), DMARC, DKIM at a few common selectors, MTA-STS (the TXT record plus the policy file the domain
   serves at https://mta-sts.<domain>), TLS-RPT and BIMI, graded A to F. Everything comes from
   Cloudflare's resolver except the MTA-STS policy. Each part has its own budget of subrequests
   (MAIL_BUDGET for the records, the selectors plus one retry for DKIM). Cache reads and writes count
   toward the Workers limit of 50 too, so the worst case, every retry firing for a named selector, is
   22 + 7 + 2 fetches and 6 cache calls: 37. A typical fresh check takes 15 to 30. */

const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 's1'];
const MAIL_BUDGET = 22;            // 6 record queries, up to 3 DMARC parents, 1 policy fetch, 10 SPF includes, 2 retries
const SPF_MAX_FETCH = 10;          // past 10 includes the record is over the limit anyway
const MAIL_GRADES = [
  ['A', 'no FAIL and no WARN'],
  ['B', 'no FAIL, one or two WARN'],
  ['C', 'one FAIL, or three or more WARN'],
  ['D', 'two FAIL'],
  ['F', 'three or more FAIL, no working SPF and no DMARC, or SPF that lets any server pass (+all)'],
];

// Who runs the mail servers, from the MX host names (the first match wins).
const MAIL_PROVIDERS = [
  [/(^|\.)gmail-smtp-in\.l\.google\.com$/, 'Gmail'], [/(^|\.)(aspmx\.l\.google|smtp\.google|googlemail)\.com$/, 'Google Workspace'],
  [/(^|\.)google\.com$/, 'Google'], [/\.mail\.protection\.outlook\.com$/, 'Microsoft 365'], [/(^|\.)(outlook|hotmail)\.com$/, 'Microsoft (Outlook.com)'],
  [/(^|\.)(pphosted|ppe-hosted)\.com$/, 'Proofpoint'], [/(^|\.)mimecast(-offshore)?\.com$|(^|\.)mimecast\.co\.za$/, 'Mimecast'],
  [/(^|\.)iphmx\.com$/, 'Cisco Secure Email'], [/(^|\.)barracudanetworks\.com$/, 'Barracuda'], [/(^|\.)messagelabs\.com$/, 'Broadcom Email Security.cloud'],
  [/(^|\.)mx\.cloudflare\.net$/, 'Cloudflare Email Routing'], [/(^|\.)yahoodns\.net$/, 'Yahoo'], [/(^|\.)mail\.icloud\.com$/, 'iCloud Mail'],
  [/(^|\.)protonmail\.ch$/, 'Proton Mail'], [/(^|\.)messagingengine\.com$/, 'Fastmail'], [/(^|\.)zoho(mail)?\.(com|eu|in|jp|com\.au)$/, 'Zoho Mail'],
  [/(^|\.)secureserver\.net$/, 'GoDaddy'], [/(^|\.)emailsrvr\.com$/, 'Rackspace Email'], [/(^|\.)(amazonaws|awsapps)\.com$/, 'Amazon (SES or WorkMail)'],
  [/(^|\.)mailgun\.org$/, 'Mailgun'], [/(^|\.)sendgrid\.net$/, 'SendGrid'], [/(^|\.)yandex\.(net|ru)$/, 'Yandex'], [/(^|\.)mail\.ru$/, 'Mail.ru'],
  [/(^|\.)qq\.com$/, 'Tencent'], [/(^|\.)ovh\.net$/, 'OVHcloud'], [/(^|\.)(ionos|1and1)\.[a-z.]+$/, 'IONOS'], [/(^|\.)migadu\.com$/, 'Migadu'],
  [/(^|\.)improvmx\.com$/, 'ImprovMX'], [/(^|\.)forwardemail\.net$/, 'Forward Email'], [/(^|\.)hornetsecurity\.com$/, 'Hornetsecurity'],
  [/(^|\.)trendmicro\.(com|eu)$/, 'Trend Micro'], [/(^|\.)tutanota\.de$/, 'Tuta'],
];
const mxProvider = h => { const m = MAIL_PROVIDERS.find(([re]) => re.test(h)); return m ? m[1] : null; };
// The include a provider documents for its customers' SPF, for the fix line when a domain has none.
const PROVIDER_SPF = { Gmail: '_spf.google.com', 'Google Workspace': '_spf.google.com', Google: '_spf.google.com', 'Microsoft 365': 'spf.protection.outlook.com',
  Fastmail: 'spf.messagingengine.com', 'Proton Mail': '_spf.protonmail.ch', 'iCloud Mail': 'icloud.com', 'Cloudflare Email Routing': '_spf.mx.cloudflare.net' };

// One DNS query within a check's budget: a time limit, and one retry while the budget allows, also
// after SERVFAIL (the resolver couldn't reach the domain's name servers in time, which is often brief).
// A retry takes its share of the budget before the pause, so queries failing together can't overspend it.
async function mailDoh(b, name, type) {
  if (name.length > 253) return { Status: 3 };          // too long to be a name (a long domain plus _dmarc.), so nothing is there
  let last = null, answer = null;
  for (let attempt = 0; attempt < 2 && b.left > 0; attempt++) {
    b.left--; b.used++;
    if (attempt) await sleep(300);
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
        { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        answer = await r.json();
        if (!answer || answer.Status !== 2) return answer;
        continue;
      }
      if (r.body) r.body.cancel();
      last = new Error('HTTP ' + r.status);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
  }
  if (answer) return answer;                             // still SERVFAIL: the caller says what couldn't be read
  throw new Error(last ? 'dns: ' + (last.message || last) : 'mail check: subrequest budget used up');
}
// An answer that says nothing about the record: anything but NOERROR, or NXDOMAIN (which means "none").
const dnsFailed = r => r && r.Status != null && r.Status !== 0 && r.Status !== 3;
// The TXT records of an answer that pass a test (big domains keep dozens of verification records beside SPF).
const txtOf = (r, test, n = 2000) => (r && Array.isArray(r.Answer) ? r.Answer : []).slice(0, 300)
  .filter(a => a && a.type === 16).map(a => txtData(a.data, n)).filter(test).slice(0, 10);
const isSpf = v => /^v=spf1(\s|$)/i.test(v);
const isDmarc = v => /^v\s*=\s*DMARC1\s*(;|$)/i.test(v);
const isDkim = v => /^v\s*=\s*DKIM1\s*(;|$)/i.test(v) || (!/^\s*v\s*=/i.test(v) && /(^|;)\s*p\s*=/i.test(v));

// "v=DMARC1; p=reject; rua=mailto:..." as { v, p, rua } (names lowercased; the first of a repeated tag wins).
function tagList(rec) {
  const t = Object.create(null);
  for (const part of String(rec).split(';').slice(0, 40)) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/i.exec(part);
    if (m && !(m[1].toLowerCase() in t)) t[m[1].toLowerCase()] = m[2];
  }
  return t;
}
const httpsUrl = v => { try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' && !u.username && !u.password ? short(u.href, 200) : null; } catch { return null; } };
// Report addresses from rua= or ruf=: plain email addresses (from mailto:, without a !size suffix) and
// https URLs. Anything else is dropped.
function reportUris(v) {
  const out = [];
  for (const raw of String(v || '').split(',').slice(0, 10)) {
    const u = raw.trim().replace(/!\d+[kmgt]?$/i, ''), m = /^mailto:(.+)$/i.exec(u);
    const x = m ? (validEmail(m[1]) ? m[1] : null) : httpsUrl(u);
    if (x && out.length < 5) out.push(x);
  }
  return out;
}
// A DKIM selector as typed after --dkim: DNS labels, at most 100 characters. A pasted
// "selector1._domainkey.example.com" is cut back to the selector.
function dkimSelector(v) {
  const s = String(v).trim().toLowerCase().replace(/\._domainkey(\..*)?$/, '');
  const label = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
  return s.length <= 100 && new RegExp(`^${label}(?:\\.${label})*$`).test(s) ? s : null;
}

/* SPF (RFC 7208). Receivers give up with an error (permerror) once evaluating a record takes more than
   10 DNS lookups: include, a, mx, ptr, exists and redirect each cost one, and so does everything inside
   an include. Includes and redirects are followed to count them, at most SPF_MAX_FETCH of them. */
const SPF_LOOKUP = new Set(['include', 'a', 'mx', 'ptr', 'exists']);
const SPF_MECH = new Set([...SPF_LOOKUP, 'all', 'ip4', 'ip6']);
const spfTerm = t => (t.length > 60 ? t.slice(0, 60) + '…' : t);

// One record's terms: the lookups it costs by itself, what it includes or redirects to, its "all",
// and anything RFC 7208 calls an error. Terms after "all" are never evaluated, so they cost nothing.
function spfParse(rec) {
  const p = { lookups: 0, all: null, includes: [], redirect: null, redirectMacro: false, errors: [], ptr: false, macros: false, mechs: 0 };
  for (const t of String(rec).trim().split(/\s+/).slice(1, 80)) {
    const mod = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(t);
    if (mod) {                                           // modifiers: redirect= and exp= (unknown ones are allowed)
      if (mod[1].toLowerCase() !== 'redirect') continue;
      if (p.redirect !== null) p.errors.push({ text: 'has more than one redirect=', fix: 'keep a single redirect=' });
      else {                                             // a macro in it is counted but not followed, like include:'s
        p.redirect = String(mod[2]).toLowerCase().replace(/\.$/, '');
        if (p.redirect.includes('%')) p.macros = p.redirectMacro = true;
      }
      continue;
    }
    const m = /^([+\-~?]?)([a-z][a-z0-9]*)(.*)$/i.exec(t);
    const mech = m ? m[2].toLowerCase() : null, q = m ? m[1] || '+' : null, rest = m ? m[3] : '';
    if (!mech || !SPF_MECH.has(mech)) {
      p.errors.push({ text: `has an unknown term "${spfTerm(t)}", which receivers treat as an error (permerror)`, fix: `correct or remove "${spfTerm(t)}"` });
      continue;
    }
    p.mechs++;
    if (mech === 'all') {
      if (rest) p.errors.push({ text: `has an invalid "${spfTerm(t)}"`, fix: 'end the record with a plain ~all or -all' });
      else if (!p.all) p.all = q + 'all';
      continue;
    }
    if (p.all) continue;
    if (SPF_LOOKUP.has(mech)) p.lookups++;
    if (mech === 'ptr') p.ptr = true;
    else if (mech === 'include' || mech === 'exists') {
      const target = rest.startsWith(':') ? rest.slice(1) : '';
      if (!target) p.errors.push({ text: `has "${spfTerm(t)}" without a domain`, fix: `add the domain (${mech}:example.com) or remove it` });
      else if (target.includes('%')) p.macros = true;
      else if (mech === 'include') {
        const dom = normalizeDomain(target);
        if (dom) p.includes.push({ q, domain: dom });
        else p.errors.push({ text: `includes "${spfTerm(target)}", which is not a domain name`, fix: `correct or remove "${spfTerm(t)}"` });
      }
    } else if (mech === 'ip4' || mech === 'ip6') {
      const v = /^:([^/]+)(?:\/(\d{1,3}))?$/.exec(rest), ip = v && parseIp(v[1]);
      if (!ip || ip.v !== (mech === 'ip4' ? 4 : 6) || (v[2] && Number(v[2]) > (ip.v === 4 ? 32 : 128))) {
        p.errors.push({ text: `has an invalid range "${spfTerm(t)}"`, fix: `correct it (${mech}:${mech === 'ip4' ? '192.0.2.0/24' : '2001:db8::/32'}) or remove it` });
      }
    }
  }
  if (p.redirect && !p.all) p.lookups++;                 // redirect= only applies (and costs) without an "all"
  return p;
}

async function spfAnalyze(b, rec) {
  const st = { lookups: 0, fetches: 0, walks: 0, capped: false, includes: [], errors: [], unresolved: [], passAll: [], ptr: false, macros: false };
  const memo = new Map();
  const getSpf = dom => {                                // an included domain's record, fetched once per check
    if (!memo.has(dom)) memo.set(dom, (async () => {
      if (st.fetches >= SPF_MAX_FETCH) { st.capped = true; return { skipped: true }; }
      st.fetches++;
      let r;
      try { r = await mailDoh(b, dom, 'TXT'); } catch { return { unresolved: true }; }
      if (r.Status && r.Status !== 3) return { unresolved: true };
      const recs = txtOf(r, isSpf);
      return recs.length === 1 ? { rec: recs[0] } : { count: recs.length };
    })());
    return memo.get(dom);
  };
  const follow = async (dom, label, depth) => {          // returns the "all" of the record it reaches
    // Records are fetched once but may be walked many times (an include loop, or ten includes that each include
    // the same ten): 40 walks and 10 levels are far past any record that works, and keep the CPU time small.
    if (depth > 9 || ++st.walks > 40) { st.capped = true; return null; }
    const r = await getSpf(dom);
    if (r.skipped) return null;
    if (r.unresolved) { if (st.unresolved.length < 3 && !st.unresolved.includes(label)) st.unresolved.push(label); return null; }
    if (!r.rec) {
      if (st.errors.length < 5) st.errors.push(r.count
        ? { text: `${label} points at ${r.count} SPF records, which receivers treat as an error (permerror)`, fix: `ask whoever runs ${dom} to merge them, or remove ${label}` }
        : { text: `${label} has no SPF record, which receivers treat as an error (permerror)`, fix: `remove ${label}, or check its spelling` });
      return null;
    }
    return walk(r.rec, depth + 1, label);
  };
  async function walk(rec, depth, via) {
    const p = spfParse(rec);
    st.lookups += p.lookups;
    st.ptr = st.ptr || p.ptr; st.macros = st.macros || p.macros;
    for (const e of p.errors) {
      if (st.errors.length < 5) st.errors.push(via ? { text: `the record behind ${via} ${e.text}`, fix: `remove ${via}, or ask whoever runs it to fix it` } : e);
    }
    await Promise.all(p.includes.map(async ({ q, domain }) => {
      if (st.includes.length < 40 && !st.includes.includes(domain)) st.includes.push(domain);
      const all = await follow(domain, 'include:' + domain, depth);
      if (all === '+all' && q === '+' && st.passAll.length < 3 && !st.passAll.includes(domain)) st.passAll.push(domain);
    }));
    const redirected = p.redirect && !p.all && !p.redirectMacro ? await follow(p.redirect, 'redirect=' + p.redirect, depth) : null;
    return p.all || redirected;
  }
  const top = spfParse(rec), all = await walk(rec, 0, null);
  return {
    records: 1, record: short(rec, 1000), all: all || null, redirect: top.redirect && !top.all ? top.redirect : null,
    redirectMacro: top.redirectMacro && !top.all,        // its "all" is behind a macro, so it can't be known
    lookups: st.lookups, overLimit: st.lookups > 10 || st.capped, counted: !st.capped,
    includes: st.includes, errors: st.errors, unresolved: st.unresolved, passAll: st.passAll, ptr: st.ptr, macros: st.macros,
    onlyFail: top.mechs === 1 && top.all === '-all',     // "v=spf1 -all": no server may send
  };
}

function dmarcParse(rec) {
  const t = tagList(rec), pol = v => { const x = String(v ?? '').trim().toLowerCase(); return ['none', 'quarantine', 'reject'].includes(x) ? x : null; };
  const pct = t.pct == null ? 100 : /^\s*\d{1,3}\s*$/.test(t.pct) && Number(t.pct) <= 100 ? Number(t.pct) : null;
  return {
    record: short(rec, 600), policy: pol(t.p), subdomainPolicy: pol(t.sp), nonexistentPolicy: pol(t.np), pct,
    testing: String(t.t || '').trim().toLowerCase() === 'y', rua: reportUris(t.rua), ruf: reportUris(t.ruf),
    adkim: String(t.adkim || '').trim().toLowerCase() === 's' ? 'strict' : 'relaxed',
    aspf: String(t.aspf || '').trim().toLowerCase() === 's' ? 'strict' : 'relaxed',
  };
}
// A subdomain without its own record gets the parent's sp= (or p=, without one).
const dmarcEffective = dm => (dm.inherited ? dm.subdomainPolicy || dm.policy : dm.policy);

// The MTA-STS policy file. RFC 8461: HTTPS with a valid certificate, and redirects must not be
// followed, so the only URL ever fetched is https://mta-sts.<domain>/.well-known/mta-sts.txt. The time
// limit and the 64 KB cap are ipterm's own.
async function stsPolicy(b, name) {
  const url = `https://mta-sts.${name}/.well-known/mta-sts.txt`;
  if (b.left <= 0) return { url, error: "wasn't fetched: this check's lookup budget ran out" };
  b.left--; b.used++;
  let r;
  try { r = await fetch(url, { redirect: 'manual', headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(5000) }); }
  catch (e) { return { url, error: e && e.name === 'TimeoutError' ? "didn't answer within 5 seconds" : "couldn't be fetched (no such host, no HTTPS, or a certificate problem)" }; }
  if (r.status !== 200) {
    if (r.body) r.body.cancel();
    return { url, error: r.status >= 300 && r.status < 400 ? `redirects (HTTP ${r.status}), and RFC 8461 says senders must not follow redirects` : `answered HTTP ${r.status}` };
  }
  let body;
  try { body = await readBody(r, 65536); } catch (e) { return { url, error: e && e.message === 'response too large' ? 'is larger than 64 KB' : "couldn't be read" }; }
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { url, ...parseSts(body), contentType: ct && ct !== 'text/plain' ? short(ct, 60) : null };
}

function parseSts(body) {
  const p = { version: null, mode: null, mx: [], maxAge: null, errors: [] };
  for (const line of String(body).split(/\r?\n/).slice(0, 200)) {
    const m = /^([A-Za-z0-9_]{1,32}):\s*(.*?)\s*$/.exec(line.trim());
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'version' && p.version === null) p.version = short(v, 20);
    else if (k === 'mode' && p.mode === null) p.mode = short(v.toLowerCase(), 20);
    else if (k === 'max_age' && p.maxAge === null) p.maxAge = /^\d{1,10}$/.test(v) ? Number(v) : -1;
    else if (k === 'mx' && p.mx.length < 20) {
      const h = v.toLowerCase().replace(/\.$/, '');
      if (h.length <= 253 && /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(h)) p.mx.push(h);
      else if (p.errors.length < 3) p.errors.push(`"mx: ${short(v, 60)}" is not a host name`);
    }
  }
  if (p.version !== 'STSv1') p.errors.push('the version line is missing or not STSv1');
  if (!['enforce', 'testing', 'none'].includes(p.mode)) p.errors.push('the mode line is missing or not enforce, testing or none');
  if (p.maxAge === null || p.maxAge < 0 || p.maxAge > 31557600) p.errors.push('max_age is missing or out of range');
  if (p.mode !== 'none' && !p.mx.length) p.errors.push('there are no mx lines');
  if (p.maxAge !== null && p.maxAge < 0) p.maxAge = null;
  return p;
}
// RFC 8461 section 4.1: "*.example.com" covers exactly one more label (mx1.example.com, not a.b.example.com).
const stsMatch = (h, pat) => (pat.startsWith('*.') ? h.endsWith(pat.slice(1)) && /^[^.]+$/.test(h.slice(0, -(pat.length - 1))) : h === pat);
const ageText = s => (s >= 86400 ? `${Math.round(s / 86400)} day${Math.round(s / 86400) === 1 ? '' : 's'}` : s >= 3600 ? `${Math.round(s / 3600)} hours` : `${s} seconds`);

// DKIM keys can't be listed: only selectors someone names can be checked. A selector the resolver
// couldn't read (SERVFAIL after the retry, or no answer) is unanswered, not "no key", and the probe is
// then kept for a minute instead of five.
async function dkimProbe(name, selectors) {
  const b = { left: selectors.length + 1, used: 0 };
  const res = await Promise.all(selectors.map(async s => {
    let r;
    try { r = await mailDoh(b, `${s}._domainkey.${name}`, 'TXT'); } catch { return { selector: s, unanswered: true }; }
    const rec = txtOf(r, isDkim, 3000)[0];
    return dnsFailed(r) ? { selector: s, unanswered: true } : rec ? { selector: s, ...dkimKey(rec) } : { selector: s };
  }));
  const unanswered = res.filter(x => x.unanswered).map(x => x.selector);
  return { ...(unanswered.length ? { _ttl: 60 } : {}), selectors, keys: res.filter(x => x.keyType), unanswered, subrequests: b.used };
}

function dkimKey(rec) {
  const t = tagList(rec), k = String(t.k || 'rsa').trim().toLowerCase(), p = String(t.p ?? '').replace(/\s+/g, '');
  const keyType = k === 'rsa' || k === 'ed25519' ? k : short(k, 20);
  const testing = String(t.t || '').split(':').some(f => f.trim().toLowerCase() === 'y');
  if (!p) return { keyType, revoked: true, bits: null, testing, record: short(rec, 300) };
  return { keyType, revoked: false, bits: keyType === 'rsa' ? rsaBits(p) : keyType === 'ed25519' ? 256 : null, testing, record: short(rec, 300) };
}

// The size of an RSA key in bits: the length of its modulus, read from the DER encoding
// (SubjectPublicKeyInfo, or a bare RSAPublicKey). null if it can't be read.
function rsaBits(b64) {
  let a;
  try { a = Uint8Array.from(atob(b64.slice(0, 4000)), c => c.charCodeAt(0)); } catch { return null; }
  let i = 0;
  const next = () => {                                   // one DER header: tag and length
    if (i + 2 > a.length) throw new Error('short');
    const tag = a[i++]; let len = a[i++];
    if (len & 0x80) {
      const n = len & 0x7f; if (n < 1 || n > 3) throw new Error('length');
      len = 0; for (let j = 0; j < n; j++) len = len * 256 + a[i++];
    }
    if (i + len > a.length) throw new Error('short');
    return { tag, len };
  };
  try {
    let h = next(); if (h.tag !== 0x30) return null;                      // SEQUENCE
    h = next();
    if (h.tag === 0x30) {                                // SubjectPublicKeyInfo: skip the algorithm, open the BIT STRING
      i += h.len; h = next(); if (h.tag !== 0x03) return null;
      i++;                                               // the BIT STRING's unused-bits byte
      h = next(); if (h.tag !== 0x30) return null;
      h = next();
    }
    if (h.tag !== 0x02) return null;                     // INTEGER: the modulus
    let s = i, len = h.len;
    while (len > 0 && a[s] === 0) { s++; len--; }
    return len ? (len - 1) * 8 + (32 - Math.clz32(a[s])) : null;
  } catch { return null; }
}

// Everything except DKIM: two rounds of queries (the records, then SPF includes, the MTA-STS policy and,
// when the domain has no DMARC record of its own, its parents').
async function mailRecords(name) {
  const b = { left: MAIL_BUDGET, used: 0 }, q = (n, t) => mailDoh(b, n, t);
  const [mxR, txtR, dmarcR, stsR, rptR, bimiR] = await Promise.all([q(name, 'MX'), q(name, 'TXT'),
    q('_dmarc.' + name, 'TXT'), q('_mta-sts.' + name, 'TXT'), q('_smtp._tls.' + name, 'TXT'), q('default._bimi.' + name, 'TXT')]);
  const st = mxR.Status ?? 0;
  if (st !== 0) return { ...(st !== 3 ? { _ttl: 60 } : {}), domain: name, status: RCODES[st] || 'ERROR', source: 'cloudflare-dns', subrequests: b.used };
  // Lowercased: some zones publish ASPMX.L.GOOGLE.COM, and MAIL_PROVIDERS and the MTA-STS mx lines are lowercase.
  const mx = (mxR.Answer || []).filter(a => a && a.type === 15).slice(0, 20).map(a => parseRecord('MX', String(a.data).toLowerCase()))
    .sort((x, y) => (x.priority ?? 0) - (y.priority ?? 0));
  const real = mx.filter(r => !nullMx(r));
  const spfRecs = txtOf(txtR, isSpf), dmarcRecs = txtOf(dmarcR, isDmarc, 1000);
  const stsRecs = txtOf(stsR, v => /^v\s*=\s*STSv1\s*(;|$)/i.test(v), 500);
  const rptRecs = txtOf(rptR, v => /^v\s*=\s*TLSRPTv1\s*(;|$)/i.test(v), 500);
  const bimiRecs = txtOf(bimiR, v => /^v\s*=\s*BIMI1\s*(;|$)/i.test(v), 500);
  const nullOnly = mx.length > 0 && !real.length;
  // Without a record of its own, a subdomain falls under its organizational domain's. Without a list of
  // public suffixes, ask the (up to three) shortest parents and take the shortest one with a record that
  // isn't a public suffix's own (psd=y), as DMARCbis's tree walk does.
  const labels = name.split('.');
  const parents = dmarcRecs.length || dnsFailed(dmarcR) ? [] : labels.slice(1, -1).map((_, i) => labels.slice(i + 1).join('.')).slice(-3);
  const [spf, policy, up] = await Promise.all([
    spfRecs.length === 1 ? spfAnalyze(b, spfRecs[0]) : null,
    stsRecs.length && !nullOnly ? stsPolicy(b, name) : null,
    Promise.all(parents.map(p => q('_dmarc.' + p, 'TXT').then(r => ({ from: p, recs: txtOf(r, isDmarc, 1000), failed: dnsFailed(r) ? RCODES[r.Status] || 'an error' : null }),
      () => ({ from: p, recs: [], failed: 'no answer' })))),
  ]);
  const own = dmarcRecs.length ? { from: name, recs: dmarcRecs } : up.filter(x => x.recs.length && !/(^|;)\s*psd\s*=\s*y/i.test(x.recs[0])).pop();
  const sts = stsRecs.length ? tagList(stsRecs[0]) : null, rpt = rptRecs.length ? tagList(rptRecs[0]) : null, bimi = bimiRecs.length ? tagList(bimiRecs[0]) : null;
  const stsId = sts && String(sts.id || '').trim();
  // Records the resolver couldn't read (SERVFAIL even after a retry) are reported as unread, not as
  // missing, and the answer is kept for a minute instead of five. A subdomain without a record of its
  // own whose parent couldn't be read is unread too, at that parent (parents are only asked once the
  // subdomain's own answer was read).
  const unread = Object.fromEntries([['SPF', txtR], ['DMARC', own ? null : dmarcR], ['MTA-STS', stsR], ['TLS-RPT', rptR], ['BIMI', bimiR]]
    .filter(([, r]) => dnsFailed(r)).map(([k, r]) => [k, RCODES[r.Status] || 'an error']));
  const upFail = own ? null : up.find(x => x.failed);
  if (upFail) unread.DMARC = upFail.failed;
  return {
    ...(Object.keys(unread).length ? { _ttl: 60 } : {}),
    domain: name, status: 'NOERROR', nullMx: nullOnly, unread, ...(upFail ? { dmarcUnreadAt: upFail.from } : {}),
    mx: { records: mx.map(r => ({ priority: r.priority ?? null, host: r.value })), providers: [...new Set(real.map(r => mxProvider(r.value)).filter(Boolean))],
      mixedNull: real.length > 0 && real.length < mx.length },
    spf: spf || { records: spfRecs.length, record: spfRecs.length ? short(spfRecs[0], 1000) : null, others: spfRecs.slice(1, 4).map(v => short(v, 1000)) },
    dmarc: own ? { ...dmarcParse(own.recs[0]), records: own.recs.length, from: own.from, inherited: own.from !== name } : null,
    mtaSts: sts ? { record: short(stsRecs[0], 300), records: stsRecs.length, id: /^[A-Za-z0-9]{1,32}$/.test(stsId) ? stsId : null, policy } : null,
    tlsRpt: rpt ? { record: short(rptRecs[0], 300), records: rptRecs.length, rua: reportUris(rpt.rua) } : null,
    bimi: bimi ? { record: short(bimiRecs[0], 300), logo: httpsUrl(bimi.l), vmc: httpsUrl(bimi.a), declined: bimi.l != null && !bimi.l.trim() } : null,
    source: 'cloudflare-dns', subrequests: b.used,
  };
}

// One line per finding: { check, status: ok | warn | fail | info, text, fix }, with a fix on every WARN
// and FAIL. The grade counts them (MAIL_GRADES). Every value from DNS stays a plain string here; pages
// escape it with esc() and text answers with plain().
function mailChecks(d, k, sel) {
  const out = [], name = d.domain, noMail = d.nullMx;
  const add = (check, status, text, fix) => out.push({ check, status, text, ...(fix && (status === 'warn' || status === 'fail') ? { fix } : {}) });
  const hosts = d.mx.records.filter(r => !nullMx({ value: r.host })).map(r => r.host), providers = d.mx.providers;
  const two = a => a.slice(0, 2).join(', ') + (a.length > 2 ? ` and ${a.length - 2} more` : '');
  const unread = d.unread || {};
  const notRead = (check, status, where, zone = name) => add(check, status, `couldn't be read: Cloudflare's resolver ${unread[check] === 'no answer' ? 'got no answer' : 'answered ' + unread[check]} for ${where} (its name servers didn't answer in time), so it wasn't checked`,
    `check that every name server for ${zone} answers; receivers that get no answer treat ${check} as a temporary error`);

  if (d.mx.mixedNull) add('MX', 'fail', 'a null MX (0 .) sits beside other MX records, which RFC 7505 forbids', "remove the null MX if the domain takes mail, or the other MX records if it doesn't");
  else if (noMail) add('MX', 'ok', `null MX: ${name} accepts no mail (RFC 7505)`);
  else if (!hosts.length) add('MX', 'warn', `no MX records, so senders try ${name}'s own address (its A or AAAA record) instead`, 'add MX records for your mail provider, or a null MX (0 .) if the domain takes no mail');
  else add('MX', 'ok', (providers.length ? providers.join(' + ') + ': ' : '') + two(hosts));

  const spf = d.spf, inc = providers.map(p => PROVIDER_SPF[p]).find(Boolean);
  if (unread.SPF) notRead('SPF', 'warn', name);
  else if (!spf.records) {
    add('SPF', 'fail', `no SPF record, so nothing says which servers may send mail as ${name}`, noMail
      ? `publish a TXT record at ${name}: "v=spf1 -all" (no server may send as it)`
      : `publish one TXT record at ${name}, such as "v=spf1 include:${inc || "<your provider's SPF domain>"} ~all", or "v=spf1 -all" if it sends no mail`);
  } else if (spf.records > 1) add('SPF', 'fail', `${spf.records} SPF records: receivers treat that as an error (permerror) and ignore them all`, 'merge them into one v=spf1 record');
  else {
    const before = out.length, via = spf.redirect ? ` via redirect=${spf.redirect}` : '';
    const count = spf.counted ? String(spf.lookups) : 'more than 10';
    const lk = spf.overLimit ? '' : `; ${spf.lookups} of 10 DNS lookups`;   // over the limit has its own line
    if (spf.all === '+all') add('SPF', 'fail', `ends in +all${via}, so any server on the internet passes SPF as ${name}`, 'change +all to ~all, or to -all once every sender is listed');
    for (const x of spf.passAll) add('SPF', 'fail', `include:${x} ends in +all, so any server on the internet passes SPF as ${name}`, `remove include:${x}`);
    for (const e of spf.errors) add('SPF', 'fail', e.text, e.fix);
    if (spf.overLimit) add('SPF', 'fail', `needs ${count} DNS lookups, over the limit of 10, so receivers treat it as an error (permerror) and SPF fails for all your mail`,
      'remove includes you no longer use, or replace some with the ip4: and ip6: ranges they list');
    if (noMail) {
      if (spf.onlyFail) add('SPF', 'ok', `v=spf1 -all: no server may send as ${name}`);
      else if (out.length === before) add('SPF', 'warn', "lists senders, but a domain with a null MX can't send mail (receivers reject mail they couldn't bounce)", 'replace it with "v=spf1 -all"');
    } else {
      if (spf.all === '?all') add('SPF', 'warn', `ends in ?all${via} (neutral), so mail from unlisted servers isn't marked as failing${lk}`, 'end it with ~all, or -all once every sender is listed');
      else if (!spf.all && !spf.redirectMacro) add('SPF', 'warn', `doesn't end in ~all or -all, so mail from unlisted servers gets a neutral result${lk}`, 'add ~all at the end, or -all once every sender is listed');
      if (spf.ptr) add('SPF', 'warn', 'uses the ptr mechanism, which RFC 7208 says not to use: it is slow, and some receivers skip it', 'replace ptr with the ip4: and ip6: ranges (or a and mx) it stands for');
      for (const x of spf.unresolved) add('SPF', 'warn', `${x} didn't answer, so it couldn't be checked (receivers may delay your mail when that happens)`, `check that ${x.replace(/^[a-z]+[:=]/, '')} resolves and has one SPF record`);
      if (!out.slice(before).length) add('SPF', 'ok', (spf.all ? `ends in ${spf.all}${via}` : `hands off to redirect=${spf.redirect}, which uses a macro, so the record it reaches depends on the sender and wasn't checked`) +
        `${lk}${spf.lookups >= 9 ? ' (close to the limit)' : ''}`);
      if (spf.macros) add('SPF', 'info', 'uses macros (%{...}), which depend on the sender: those lookups are counted but not followed');
    }
  }

  const dm = d.dmarc;
  if (unread.DMARC) notRead('DMARC', 'warn', '_dmarc.' + (d.dmarcUnreadAt || name), d.dmarcUnreadAt || name);
  else if (!dm) {
    add('DMARC', 'fail', 'no DMARC record, so receivers have no policy for mail that fails SPF and DKIM', noMail
      ? `add a TXT record at _dmarc.${name}: "v=DMARC1; p=reject"`
      : `add a TXT record at _dmarc.${name}: "v=DMARC1; p=none; rua=mailto:dmarc-reports@${name}" to collect reports, then move to p=quarantine and p=reject`);
  } else if (dm.records > 1) add('DMARC', 'fail', `${dm.records} DMARC records at _dmarc.${dm.from}: receivers ignore DMARC when there is more than one`, 'keep a single v=DMARC1 record');
  else if (!dm.policy) add('DMARC', 'fail', 'the policy (p=) is missing or not none, quarantine or reject', 'set p=none, p=quarantine or p=reject');
  else {
    const eff = dmarcEffective(dm), tag = dm.inherited && dm.subdomainPolicy ? 'sp' : 'p';
    const from = dm.inherited ? `inherited from ${dm.from}, ` : '', rep = dm.rua.length ? `; reports go to ${two(dm.rua)}` : '';
    const strict = noMail ? 'use p=reject: the domain sends no mail, so nothing real can fail' : null;
    if (eff === 'reject') add('DMARC', 'ok', `${from}${tag}=reject: mail that fails is refused${rep}`);
    else if (eff === 'quarantine') add('DMARC', noMail ? 'warn' : 'ok', `${from}${tag}=quarantine: mail that fails goes to spam${rep}`, strict);
    else add('DMARC', 'warn', `${from}${tag}=none: monitoring only, so mail that fails is still delivered${rep}`, strict || 'once the reports show your own mail passes, move to p=quarantine, then p=reject');
    if (eff !== 'none' && dm.pct != null && dm.pct < 100) add('DMARC', 'warn', `pct=${dm.pct}: the policy covers only ${dm.pct}% of the mail that fails`, 'remove pct (it defaults to 100)');
    if (eff !== 'none' && dm.testing) add('DMARC', 'warn', 't=y (testing): receivers apply a policy one step weaker', 'remove t=y once your own mail passes');
    if (!dm.inherited && dm.policy !== 'none' && dm.subdomainPolicy === 'none') add('DMARC', 'warn', `sp=none: subdomains of ${name} aren't protected`, 'remove sp (subdomains then follow p), or set it to quarantine or reject');
    if (!dm.rua.length) add('DMARC', noMail ? 'info' : 'warn', `no report address (rua), so nobody hears about mail sent as ${name}`, `add rua=mailto:dmarc-reports@${dm.from} (or a DMARC report service's address)`);
  }

  if (noMail) {
    add('other', 'info', "DKIM, MTA-STS, TLS-RPT and BIMI don't apply: a domain with a null MX sends and receives no mail");
    return out;
  }

  const keys = k ? k.keys : [], usable = keys.filter(x => !x.revoked);
  const what = x => (x.keyType === 'ed25519' ? 'Ed25519' : x.keyType === 'rsa' ? (x.bits ? `${x.bits}-bit RSA` : 'RSA') : x.keyType) + (x.testing ? ', testing' : '');
  if (usable.length) {
    add('DKIM', 'ok', `key${usable.length > 1 ? 's' : ''} at ${usable.map(x => `${x.selector} (${what(x)})`).join(', ')}`);
    for (const x of usable.filter(x => x.keyType === 'rsa' && x.bits && x.bits < 2048)) {
      add('DKIM', 'warn', `the key at ${x.selector} is ${x.bits}-bit RSA, too short to count on`, 'publish a 2048-bit key under a new selector, sign with it, then remove the old one');
    }
  } else if (keys.length) add('DKIM', 'info', `only a revoked key (empty p=) at ${keys.map(x => x.selector).join(', ')}`);
  // Selectors the resolver couldn't read are left out of "no key at": they say nothing either way.
  const unans = (k && k.unanswered) || [], common = DKIM_SELECTORS.filter(s => s !== sel && !unans.includes(s));
  if (sel && unans.includes(sel)) {
    if (!keys.length && common.length) add('DKIM', 'info', `no key at the common selectors (${common.join(', ')})`);
  } else if (sel && !keys.some(x => x.selector === sel)) {
    add('DKIM', 'info', `no key at ${sel}._domainkey.${name}` + (keys.length || !common.length ? '' : `, nor at the common selectors (${common.join(', ')})`) +
      ". The selector is the s= value in a message's DKIM-Signature header");
  } else if (!sel && !keys.length && common.length) {
    add('DKIM', 'info', `no key at the common selectors (${common.join(', ')}). Selectors can't be listed, so this doesn't mean DKIM is off: ` +
      "name yours with --dkim <selector> (?dkim= in a URL), the s= value in a message's DKIM-Signature header");
  }
  if (unans.length) {
    add('DKIM', 'info', `couldn't read ${unans.length > 1 ? `the selectors ${unans.join(', ')}` : `${unans[0]}._domainkey.${name}`} (Cloudflare's resolver didn't answer), so ` +
      (unans.length > 1 ? "they weren't checked" : "it wasn't checked"));
  }

  const m = d.mtaSts, p = m && m.policy;
  if (unread['MTA-STS']) notRead('MTA-STS', 'info', '_mta-sts.' + name);
  else if (!m) add('MTA-STS', 'info', 'not set up (optional: it makes sending servers insist on an encrypted connection to your mail servers)');
  else if (m.records > 1) add('MTA-STS', 'fail', `${m.records} _mta-sts records: senders ignore MTA-STS when there is more than one`, 'keep one v=STSv1 record');
  else if (!m.id) add('MTA-STS', 'fail', `the _mta-sts record has no valid id`, 'add id= with up to 32 letters and digits, and change it whenever the policy changes');
  else if (!p || p.error) add('MTA-STS', 'fail', `the _mta-sts record is there, but the policy at ${p ? p.url : 'mta-sts.' + name} ${p ? p.error : 'was not read'}`,
    'serve the policy file over HTTPS with a valid certificate at that address, or remove the _mta-sts record');
  else if (p.errors.length) add('MTA-STS', 'fail', `the policy file is invalid: ${p.errors.join('; ')}`, 'fix the file: it needs version: STSv1, mode, one mx line per mail server and max_age (RFC 8461)');
  else {
    const miss = hosts.filter(h => !p.mx.some(pat => stsMatch(h, pat)));
    const missText = miss.length ? `${miss[0]}${miss.length > 1 ? ` and ${miss.length - 1} more MX host${miss.length > 2 ? 's' : ''}` : ''} ${miss.length > 1 ? "aren't" : "isn't"} in the policy's mx lines` : '';
    const addMx = miss.length ? `add "mx: ${miss[0]}" to the policy (a wildcard such as *.${miss[0].split('.').slice(1).join('.')} works too), then change the id in _mta-sts.${name}` : null;
    if (p.mode === 'enforce') {
      if (miss.length) add('MTA-STS', 'fail', `mode enforce, but ${missText}, so senders that honor MTA-STS won't deliver there`, addMx);
      else add('MTA-STS', 'ok', `mode enforce, max_age ${ageText(p.maxAge)}, and every MX host is covered`);
      if (p.maxAge < 86400) add('MTA-STS', 'warn', `max_age is ${ageText(p.maxAge)}, so senders forget the policy quickly`, 'raise max_age to at least 604800 (a week); RFC 8461 suggests weeks');
    } else if (p.mode === 'testing') add('MTA-STS', miss.length ? 'warn' : 'info', `mode testing: problems are reported, not enforced${miss.length ? `, and ${missText}` : ''}`, addMx);
    else add('MTA-STS', 'info', 'mode none: the policy is switched off');
    if (p.contentType) add('MTA-STS', 'warn', `the policy is served as ${p.contentType}, not text/plain as RFC 8461 requires`, 'serve mta-sts.txt with Content-Type: text/plain');
  }

  const r = d.tlsRpt;
  if (unread['TLS-RPT']) notRead('TLS-RPT', 'info', '_smtp._tls.' + name);
  else if (r && r.records > 1) add('TLS-RPT', 'warn', `${r.records} records at _smtp._tls.${name}, so reporters may ignore them`, 'keep one v=TLSRPTv1 record');
  else if (r && !r.rua.length) add('TLS-RPT', 'warn', 'the record has no valid rua address', `add rua=mailto:tls-reports@${name}`);
  else if (r) add('TLS-RPT', 'ok', `reports go to ${two(r.rua)}`);
  else if (m) add('TLS-RPT', 'warn', "MTA-STS is set up, but there is no TLS-RPT record, so you won't hear when senders can't deliver securely", `add a TXT record at _smtp._tls.${name}: "v=TLSRPTv1; rua=mailto:tls-reports@${name}"`);
  else add('TLS-RPT', 'info', 'not set up (optional: daily reports from senders about TLS problems reaching you)');

  const bi = d.bimi, enforcing = !!(dm && dm.records === 1 && ['quarantine', 'reject'].includes(dmarcEffective(dm)) && (dm.pct ?? 100) === 100);
  if (unread.BIMI) notRead('BIMI', 'info', 'default._bimi.' + name);
  else if (!bi) add('BIMI', 'info', 'no logo (optional: some inboxes show a brand logo next to your mail)');
  else if (bi.declined) add('BIMI', 'info', 'the record declines a logo (empty l=)');
  else if (!bi.logo) add('BIMI', 'warn', 'the record has no valid https logo address (l=)', 'point l= at an https:// SVG logo (the SVG Tiny PS profile)');
  else if (!enforcing) add('BIMI', 'warn', 'a logo is published, but inboxes only show it when DMARC is at p=quarantine or p=reject', 'move DMARC to p=quarantine or p=reject, covering all mail');
  else add('BIMI', 'ok', `logo at ${bi.logo}` + (bi.vmc ? ', with a mark certificate (a=)' : ' (no certificate in a=, which Gmail requires)'));
  return out;
}

function mailGrade(checks, d) {
  const n = s => checks.filter(c => c.status === s).length, fail = n('fail'), warn = n('warn');
  const spf = d.spf, dm = d.dmarc;
  const spfWorks = spf.records === 1 && !spf.errors.length && !spf.overLimit;
  const dmarcWorks = !!(dm && dm.records === 1 && dm.policy);
  const anyone = spf.records === 1 && (spf.all === '+all' || spf.passAll.length > 0);
  const unread = d.unread || {}, open = !spfWorks && !dmarcWorks && !unread.SPF && !unread.DMARC;   // nothing stops spoofing
  if (fail >= 3 || open || anyone) return 'F';
  return fail === 2 ? 'D' : fail === 1 || warn >= 3 ? 'C' : warn ? 'B' : 'A';
}

function mailResult(base, probe, sel) {
  if (base.status !== 'NOERROR') return { domain: base.domain, status: base.status, grade: null, selector: sel, source: base.source, subrequests: base.subrequests };
  const checks = mailChecks(base, probe, sel), n = s => checks.filter(c => c.status === s).length;
  return {
    domain: base.domain, status: base.status, grade: mailGrade(checks, base), counts: { ok: n('ok'), warn: n('warn'), fail: n('fail'), info: n('info') },
    checks, selector: sel, nullMx: base.nullMx, mx: base.mx, spf: base.spf, dmarc: base.dmarc,
    dkim: probe ? { selectors: probe.selectors, keys: probe.keys, unanswered: probe.unanswered || [] } : null,
    mtaSts: base.mtaSts, tlsRpt: base.tlsRpt, bimi: base.bimi, unread: base.unread || {},
    source: base.source, subrequests: base.subrequests + (probe ? probe.subrequests : 0),
  };
}

/* ---------- domain report card (grade) ----------
   grade <domain>: one A-F grade from what ipterm already reads, as OK / WARN / FAIL / INFO lines with a
   fix: under each problem, like the mail check:
   - DNS (Cloudflare's resolver): DNSSEC, an AAAA record (IPv6), CAA (which CAs may issue certificates), an
     HTTPS record;
   - the mail check's grade and its main findings (the same cache entries as mail <domain>);
   - the registration (RDAP, the same cache entry as whois <domain>): expiry and the transfer lock;
   - the website: one HEAD request to https://<domain>/ for its security headers (a GET, its body dropped, if
     the server refuses HEAD), and one to http://<domain>/ for the redirect to HTTPS. Short time limits,
     redirects followed only within the domain (and only over https) to hosts whose addresses are public, a
     capped number of headers read, and nothing else. A 403, a bot challenge (even one sent with a 2xx), a
     timeout or an error is "couldn't check" (INFO), never a FAIL. Certificates can't be checked: a Worker
     never sees them. The Worker's own host (grade ipterm.net) is asked in-process instead (webCheck).
   It never touches IPinfo or proxycheck.io, and a fresh card is one of the visitor's lookups. The whole card is
   cached for five minutes (one minute when a part couldn't be checked and a recheck might fill it). Budgets:
   GRADE_DNS_BUDGET queries (and GRADE_CAA_PARENTS + 2 for CAA at parent names), at most WEB_MAX_FETCH +
   WEB_HTTP_FETCH requests to the site and WEB_DNS_BUDGET queries for the hosts its redirects go to, plus the mail
   check's and whois's own (see the handbook for the totals). */

const GRADE_GRADES = [
  ['A', 'no FAIL and no WARN'],
  ['B', 'no FAIL, one to three WARN'],
  ['C', 'one FAIL, or four or more WARN'],
  ['D', 'two FAIL'],
  ['F', 'three or more FAIL, an expired registration, or broken DNSSEC (validating resolvers refuse the domain)'],
];
const GRADE_DNS_BUDGET = 6;        // A, AAAA, CAA and HTTPS, plus two for retries
const GRADE_CAA_PARENTS = 6;       // parent names asked for CAA, side by side, plus two queries for retries; a deeper climb is "unread"
// Registries whose RDAP has no transfer-lock status at all (.nl and .br show only "active", even for domains whose
// registrar locks everything it can), so there the lock can't be graded.
const NO_TRANSFER_LOCK_TLDS = new Set(['nl', 'br']);
const WEB_TIMEOUT = 5000;          // the whole https:// chain, redirects and their hosts' lookups included
const WEB_HTTP_TIMEOUT = 4000;     // the plain http:// check
const WEB_MAX_FETCH = 3;           // requests along the https:// chain (two redirects, or a GET after a refused HEAD)
const WEB_HTTP_FETCH = 2;          // requests along the http:// chain (one redirect within the domain)
const WEB_DNS_BUDGET = 6;          // A and AAAA for the other hosts the redirects go to (three at most), retries included
const WEB_MAX_HEADERS = 100;       // response headers looked at; the rest are ignored
const WEB_SECURITY = ['strict-transport-security', 'content-security-policy', 'content-security-policy-report-only', 'x-content-type-options',
  'x-frame-options', 'referrer-policy'];
// cf-mitigated and x-amzn-waf-action mark a bot challenge (Cloudflare's, AWS WAF's), which can come with a 2xx.
const WEB_KEEP = new Set([...WEB_SECURITY, 'location', 'cf-mitigated', 'x-amzn-waf-action']);
// Extended DNS Errors (RFC 8914) that mean the answer was refused because the domain's DNSSEC doesn't check out.
const EDE_DNSSEC = { 5: 'DNSSEC Indeterminate', 6: 'DNSSEC Bogus', 7: 'Signature Expired', 8: 'Signature Not Yet Valid', 9: 'DNSKEY Missing',
  10: 'RRSIGs Missing', 11: 'No Zone Key Bit Set', 12: 'NSEC Missing' };
const edeCode = r => { for (const c of (r && Array.isArray(r.Comment) ? r.Comment : []).slice(0, 5)) { const m = /^EDE\((\d{1,3})\)/.exec(String(c)); if (m) return Number(m[1]); } return null; };

// "0 issue \"letsencrypt.org; cansignhttpexchanges=yes\"" as { tag, ca }: ca is the CA's domain, '' for none (";").
function caaRecord(data) {
  const m = /^(\d{1,3})\s+([A-Za-z0-9]{1,15})\s+"?((?:[^"\\]|\\.)*)"?\s*$/.exec(String(data).slice(0, 600));
  if (!m) return null;
  const v = m[3].replace(/\\(.)/g, '$1').split(';')[0].trim().toLowerCase();
  return { tag: m[2].toLowerCase(), ca: /^[a-z0-9.-]{0,100}$/.test(v) ? v : '?', value: short(m[3], 200) };
}
// "1 . alpn=h3,h2 ipv4hint=..." as { priority, target, alpn, ech }. Data in the generic form (\# ...) keeps only raw.
function httpsRecord(data) {
  const m = /^(\d{1,5})\s+(\S+)(?:\s+([\s\S]*))?$/.exec(String(data).slice(0, 2000));
  if (!m) return { raw: short(data, 200) };
  const p = {};
  for (const kv of (m[3] || '').trim().split(/\s+/).slice(0, 20)) { const [k, v] = kv.split('='); if (/^[a-z0-9-]{1,20}$/.test(k)) p[k] = v == null ? '' : v.replace(/^"|"$/g, ''); }
  return { priority: Number(m[1]), target: m[2] === '.' ? '.' : host(m[2]),
    alpn: String(p.alpn || '').split(',').filter(x => /^[a-z0-9.-]{1,20}$/i.test(x)).slice(0, 8), ech: Object.hasOwn(p, 'ech') };
}

// The DNS half: A, AAAA, CAA and HTTPS for the name, and CAA at its parents when it has none (RFC 8659 climbs
// the tree; the bare TLD is never asked). An answer that couldn't be read is "unread", never "missing".
async function gradeDns(name) {
  const b = { left: GRADE_DNS_BUDGET, used: 0 };
  const ask = (n, t) => mailDoh(b, n, t).catch(() => null);           // null: no answer at all
  const [a, aaaa, caa, https] = await Promise.all([ask(name, 'A'), ask(name, 'AAAA'), ask(name, 'CAA'), ask(name, 'HTTPS')]);
  const ok = r => r && (r.Status ?? 0) === 0, st = r => (r ? r.Status ?? 0 : null);
  if (!ok(a) && !ok(aaaa)) {
    if (st(a) === 3 || st(aaaa) === 3) return { status: 'NXDOMAIN', subrequests: b.used };
    const code = edeCode(a) ?? edeCode(aaaa);
    if (st(a) === 2 && Object.hasOwn(EDE_DNSSEC, code)) return { status: 'SERVFAIL', broken: `EDE ${code}: ${EDE_DNSSEC[code]}`, subrequests: b.used, _ttl: 60 };
    if (!a && !aaaa) throw new Error('dns: no answer');
    return { status: RCODES[st(a) ?? st(aaaa)] || 'ERROR', subrequests: b.used, _ttl: 60 };
  }
  const recs = (r, type) => (ok(r) && Array.isArray(r.Answer) ? r.Answer : []).filter(x => x && x.type === type).slice(0, 20);
  const unread = Object.fromEntries([['A', a], ['AAAA', aaaa], ['CAA', caa], ['HTTPS', https]].filter(([, r]) => !r || dnsFailed(r)).map(([k]) => [k, true]));
  let caaFrom = name, caaRecs = recs(caa, 257);
  const labels = name.split('.');
  if (!caaRecs.length && ok(caa) && labels.length > 2) {           // none here: the closest parent with records applies
    // Every parent at once, on a budget of its own so the first round's retries can't starve it. The climb stops at
    // the first parent that has records or couldn't be read; one cut short by GRADE_CAA_PARENTS is unread too.
    const all = labels.slice(1, -1).map((_, i) => labels.slice(i + 1).join('.')), parents = all.slice(0, GRADE_CAA_PARENTS);
    const cb = { left: parents.length + 2, used: 0 };
    const up = await Promise.all(parents.map(p => mailDoh(cb, p, 'CAA').catch(() => null)));
    b.used += cb.used;
    const i = up.findIndex(r => !r || dnsFailed(r) || recs(r, 257).length);
    if (i >= 0 && recs(up[i], 257).length) { caaFrom = parents[i]; caaRecs = recs(up[i], 257); }
    else if (i >= 0) unread.CAA = true;
    else if (all.length > parents.length) unread.CAA = 'too deep';       // the names above weren't asked
  }
  const caaList = caaRecs.map(x => caaRecord(x.data)).filter(Boolean);
  const cas = tag => [...new Set(caaList.filter(x => x.tag === tag).map(x => x.ca))];
  return {
    ...(Object.values(unread).includes(true) ? { _ttl: 60 } : {}),   // a read that failed; 'too deep' won't change on a recheck
    status: 'NOERROR', dnssec: !!((ok(a) && a.AD) || (ok(aaaa) && aaaa.AD)), unread,
    cname: [...new Set([...recs(a, 5), ...recs(aaaa, 5)].map(x => host(x.data)))].slice(0, 5),
    v4: recs(a, 1).map(x => String(x.data)).filter(x => parseIp(x)).slice(0, 10),
    v6: recs(aaaa, 28).map(x => String(x.data)).filter(x => parseIp(x)).slice(0, 10),
    all: [...recs(a, 1), ...recs(aaaa, 28)].map(x => String(x.data)),   // every address, for webCheck's guard
    caa: caaList.length ? { from: caaFrom, issue: cas('issue'), issuewild: cas('issuewild'), records: caaList.slice(0, 12).map(x => `${x.tag} "${x.value}"`) } : null,
    https: recs(https, 65).slice(0, 3).map(x => httpsRecord(x.data)),
    subrequests: b.used,
  };
}

// One request to the site, redirects not followed, only the headers we use kept (each one capped), the body
// never read. A HEAD has no body; a GET after a refused HEAD has its body cancelled at once. self: the request this
// card came in on, when the site is the Worker's own host (webCheck): its "/" is answered in-process.
async function webFetch(url, method, signal, ua, self = null) {
  const init = { method, redirect: 'manual', signal, headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } };
  const u = self ? new URL(url) : null;
  const r = u && u.hostname === self.url.hostname && u.pathname === '/' && !u.search
    ? secure(await route(new Request(url, init), self.env, self.ctx), self.env) : await fetch(url, init);
  const h = {};
  let n = 0;
  for (const [k, v] of r.headers) { if (++n > WEB_MAX_HEADERS) break; if (WEB_KEEP.has(k) && !h[k]) h[k] = short(v, 4000); }
  if (r.body) r.body.cancel().catch(() => {});
  return { status: r.status, h };
}
// The domain a redirect may stay within: the name without a leading www., and anything under it.
const siteBase = name => name.replace(/^www\./, '');
const onSite = (h, base) => h === base || h.endsWith('.' + base);
// Where a redirect points, checked before anything follows it: a validated host name (never an IP address), the
// default port, no user name or password.
function redirectTarget(from, loc) {
  let u;
  try { u = new URL(String(loc).slice(0, 2000), from); } catch { return null; }
  const h = normalizeDomain(u.hostname);
  if (!h || u.port || u.username || u.password || !/^https?:$/.test(u.protocol)) return null;
  return { scheme: u.protocol.slice(0, -1), host: h, url: `${u.protocol}//${h}${short(u.pathname + u.search, 300)}` };
}
const challenged = r => !!(r.h['cf-mitigated'] || r.h['x-amzn-waf-action']);
function blockedWhy(r) {
  if (challenged(r)) return 'showed a bot challenge';
  if (r.status === 401) return 'asks for a login (HTTP 401)';
  if (r.status === 403) return 'turned the check away (HTTP 403, usually bot protection)';
  if (r.status === 429) return 'said too many requests (HTTP 429)';
  return `answered HTTP ${r.status}`;
}
const fetchFailed = e => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'connect');
// A wait the chain's time limit also covers, though fetch() isn't part of it: a redirect host's lookups, shared by
// both chains and so not tied to either's signal. It gives up with the signal's TimeoutError, which reads as a timeout.
const inTime = (p, signal) => Promise.race([p, new Promise((_, no) => (signal.aborted ? no(signal.reason)
  : signal.addEventListener('abort', () => no(signal.reason), { once: true })))]);

// https://<name>/: follows up to two redirects within the domain, then reads the page's headers. A challenge
// page is the WAF's, not the site's, so its headers say nothing about the site.
async function httpsCheck(name, ua, n, noFollow, self) {
  const base = siteBase(name), signal = AbortSignal.timeout(WEB_TIMEOUT), start = `https://${name}/`;
  let url = start, k = 0;
  const hops = [];
  try {
    while (k < WEB_MAX_FETCH) {
      let r = await webFetch(url, 'HEAD', signal, ua, self), refusal = null; k++;
      if ((r.status === 405 || r.status === 501) && k < WEB_MAX_FETCH) { refusal = r; r = await webFetch(url, 'GET', signal, ua, self); k++; }
      hops.push({ url, status: r.status });
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        const t = r.h.location ? redirectTarget(url, r.h.location) : null;
        if (!t) return { hops, error: r.h.location ? "redirects to an address ipterm doesn't follow" : `answered HTTP ${r.status} without saying where to go` };
        if (t.scheme === 'http') return { hops, downgrade: t.url };
        if (!onSite(t.host, base)) return { hops, offsite: t.host, final: url };
        const no = await inTime(noFollow(t.host), signal);
        if (no) return { hops, final: url, error: no };
        url = t.url;
        continue;
      }
      if (r.status >= 200 && r.status < 300 && !challenged(r)) {
        // A bot manager can answer the GET with its own page, a 200 with no marker (Akamai's does), which then
        // lacks a header the site's own refusal of HEAD carried. Those headers aren't graded: they aren't the page's.
        const gone = refusal && WEB_SECURITY.find(x => refusal.h[x] && !r.h[x]);
        if (gone) return { hops, final: url, error: `showed what looks like a bot challenge (its page has no ${gone} header, though the site sent one when it refused HEAD)` };
        return { hops, checked: true, final: url, status: r.status, headers: r.h };
      }
      return { hops, final: url, error: blockedWhy(r) };
    }
    return { hops, error: `redirects more than ${WEB_MAX_FETCH - 1} times` };
  } catch (e) {
    return { hops, error: fetchFailed(e) };
  } finally { n.used += k; }
}
// http://<name>/: does it send visitors to HTTPS? One more redirect is followed if it stays on plain http within the domain.
async function httpCheck(name, ua, n, noFollow, self) {
  const base = siteBase(name), signal = AbortSignal.timeout(WEB_HTTP_TIMEOUT);
  let url = `http://${name}/`, k = 0;
  try {
    while (k < WEB_HTTP_FETCH) {
      const r = await webFetch(url, 'HEAD', signal, ua, self); k++;
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        const t = r.h.location ? redirectTarget(url, r.h.location) : null;
        if (!t) return { error: "redirects to an address ipterm doesn't follow" };
        if (t.scheme === 'https') return { upgrades: true, to: t.url };
        if (!onSite(t.host, base)) return { plainRedirect: t.url };
        const no = await inTime(noFollow(t.host), signal);
        if (no) return { error: no };
        url = t.url;
        continue;
      }
      if (r.status >= 200 && r.status < 300 && !challenged(r)) return { plain: true, final: url, status: r.status };
      return { error: blockedWhy(r) };
    }
    return { error: 'redirects more than once on plain HTTP' };
  } catch (e) {
    return { error: fetchFailed(e) };
  } finally { n.used += k; }
}

// The website half. It only runs for a name that has addresses and whose addresses are all public (for IPv6, the
// port check's rule; an address that doesn't parse, such as ::ffff:127.0.0.1, isn't), and a redirect is followed
// only to a host whose addresses pass the same test, on the same terms when its A or AAAA can't be read
// (WEB_DNS_BUDGET queries, shared by both checks, within each chain's time limit). fetch() resolves names again
// and may get another answer (DNS rebinding), which a Worker can't prevent: the real control is the platform's,
// since Workers can't reach private networks. This is defence in depth. The two checks run side by side.
// The Worker's own host is the exception: a Worker's fetch() to the hostname it runs on never reaches it (Cloudflare
// answers HTTP 522), so there "/" is answered in-process: the same request through the same route() and secure() that
// every visitor gets, with no network hop and no visitor's address in it. Only "/" on that host, whose answers are the
// homepage and the 301 to https, so it can never reach a card again. (Not under wrangler dev: its host is an address.)
async function webCheck(name, dns, io) {
  const origin = io.url.origin, self = !localHost(io.url) && name === io.url.hostname ? io : null;
  // With one record unread, the site is still checked on the other's addresses (an unread AAAA is on the IPv6 line).
  if (!dns.all.length && (dns.unread.A || dns.unread.AAAA)) return { reason: 'unread', type: dns.unread.A ? 'A' : 'AAAA' };
  if (!dns.all.length) return { reason: 'noaddr' };
  const bad = x => { const p = parseIp(x); return !p || nonPublicReason(p) || v6Reserved(p); };
  const priv = dns.all.find(bad);
  if (priv) return { reason: 'private', address: priv };
  const b = { left: WEB_DNS_BUDGET, used: 0 }, seen = new Map();
  const ask = (h, t) => mailDoh(b, h, t).catch(() => null);
  // Why a redirect to h isn't followed ('' when it is). As for the name, one unread record is fine beside addresses.
  const noFollow = h => {
    if (h === name) return '';
    if (!seen.has(h)) seen.set(h, Promise.all([ask(h, 'A'), ask(h, 'AAAA')]).then(rs => {
      const ips = rs.flatMap(r => (r && (r.Status ?? 0) === 0 && Array.isArray(r.Answer) ? r.Answer : []).slice(0, 20)
        .filter(x => x && (x.type === 1 || x.type === 28)).map(x => String(x.data)));
      if (ips.some(bad)) return "redirects to an address ipterm doesn't follow";
      return ips.length ? '' : rs.some(r => !r || dnsFailed(r)) ? `redirects to ${h}, whose address couldn't be read` : `redirects to ${h}, which has no address`;
    }));
    return seen.get(h);
  };
  const ua = `Mozilla/5.0 (compatible; ipterm-grade/1.0; +${origin}/grade)`, n = { used: 0 };
  const [https, http] = await Promise.all([httpsCheck(name, ua, n, noFollow, self), httpCheck(name, ua, n, noFollow, self)]);
  return { https, http, subrequests: n.used + b.used };
}

// Whole 30-day months, so 180 days (HSTS's six-month bar) reads as six and 179 as five; years are rounded.
const daysText = d => { const y = Math.round(d / 365.25); return d >= 365 ? `${y} year${y === 1 ? '' : 's'}` : d >= 60 ? `${Math.floor(d / 30)} months` : `${d} day${d === 1 ? '' : 's'}`; };
// HSTS, CSP, X-Content-Type-Options, frame protection and Referrer-Policy, from the page's own response.
function headerChecks(add, h, page) {
  const at = ` (at ${page})`;
  const hsts = h['strict-transport-security'], age = hsts && /(?:^|;)\s*max-age\s*=\s*"?(\d{1,12})"?\s*(?:;|$)/i.exec(hsts.split(',')[0]);
  const hstsFix = 'send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response';
  if (!hsts) add('web', 'HSTS', 'warn', `no Strict-Transport-Security header${at}, so a browser may still try plain HTTP first, where an attacker can intercept it`, hstsFix);
  else if (!age) add('web', 'HSTS', 'warn', 'the Strict-Transport-Security header has no valid max-age, so browsers ignore it', hstsFix);
  else {
    const s = Number(age[1]), extra = [/includesubdomains/i.test(hsts) && 'includeSubDomains', /(^|;)\s*preload\s*(;|$)/i.test(hsts) && 'preload'].filter(Boolean);
    if (s === 0) add('web', 'HSTS', 'warn', 'max-age=0, which tells browsers to forget HSTS', hstsFix);
    else if (s < 15552000) add('web', 'HSTS', 'warn', `max-age=${s} (${s >= 86400 ? daysText(Math.floor(s / 86400)) : s + ' seconds'}) is short: browsers forget it before long`, 'raise max-age to 31536000 (a year); six months is the least most audits accept');
    else add('web', 'HSTS', 'ok', `max-age=${s} (${daysText(Math.floor(s / 86400))})${extra.length ? '; ' + extra.join('; ') : ''}`);
  }

  const csp = h['content-security-policy'], dirs = Object.create(null);
  for (const part of String(csp || '').split(/[;,]/).slice(0, 60)) {      // names and keywords compare lowercased; hashes keep their case
    const [d, ...v] = part.trim().split(/\s+/), k = (d || '').toLowerCase();
    if (k && /^[a-z-]{1,40}$/.test(k) && !(k in dirs)) dirs[k] = v.slice(0, 80).map(x => (/^'(nonce|sha\d+)-/i.test(x) ? x : x.toLowerCase()));
  }
  const scripts = dirs['script-src'] || dirs['default-src'], which = dirs['script-src'] ? 'script-src' : 'default-src';
  const cspFix = "send a Content-Security-Policy that limits scripts: default-src 'self' and the hosts you use, or script-src with nonces";
  if (!csp) {
    if (h['content-security-policy-report-only']) add('web', 'CSP', 'warn', 'only Content-Security-Policy-Report-Only: it reports problems but blocks nothing', 'once the reports are clean, send the same policy as Content-Security-Policy');
    else add('web', 'CSP', 'warn', 'no Content-Security-Policy, so nothing limits which scripts the page runs if an attacker injects one', cspFix);
  } else if (!scripts) add('web', 'CSP', 'warn', "a Content-Security-Policy is set, but without script-src or default-src it doesn't limit scripts", cspFix);
  else {
    // A nonce, a hash or 'strict-dynamic' turns 'unsafe-inline' off; only 'strict-dynamic' also turns off hosts and schemes.
    const strong = scripts.some(s => /^'(nonce-|sha(256|384|512)-|strict-dynamic')/i.test(s));
    const anySite = s => s === '*' || s === 'https:' || s === 'http:' || s === 'data:';
    if (scripts.includes("'unsafe-inline'") && !strong) add('web', 'CSP', 'warn', `${which} allows 'unsafe-inline', so an injected inline script still runs: little protection against XSS`, "replace 'unsafe-inline' with nonces or hashes (and 'strict-dynamic')");
    else if (!scripts.includes("'strict-dynamic'") && scripts.some(anySite)) add('web', 'CSP', 'warn', `${which} allows scripts from any site (${scripts.find(anySite)})`, "list the hosts your scripts come from instead, or use nonces with 'strict-dynamic'");
    else add('web', 'CSP', 'ok', `limits scripts (${which} ${scripts.slice(0, 3).join(' ')}${scripts.length > 3 ? ' …' : ''})`);
  }

  // A header sent twice arrives joined with ", "; browsers read only its first value (Fetch's "determine nosniff").
  const xcto = String(h['x-content-type-options'] || '').trim().toLowerCase();
  if (xcto.split(',')[0].trim() === 'nosniff') add('web', 'nosniff', 'ok', 'X-Content-Type-Options: nosniff');
  else add('web', 'nosniff', 'warn', xcto ? `X-Content-Type-Options is "${short(xcto, 40)}", not nosniff` : 'no X-Content-Type-Options header, so browsers may guess a file\'s type and run it as a script', 'send X-Content-Type-Options: nosniff');

  // Browsers read X-Frame-Options as a set (HTML's steps): "SAMEORIGIN, SAMEORIGIN" is SAMEORIGIN, and several values
  // that include a known one refuse all framing. frame-ancestors overrides it; '*', a '*' host or a bare https: or
  // http: (which takes https too) lets every site in.
  const fa = dirs['frame-ancestors'], xfos = [...new Set(String(h['x-frame-options'] || '').split(',').map(x => x.trim().toLowerCase()))];
  const xfo = xfos.length > 1 && xfos.some(x => x === 'deny' || x === 'sameorigin' || x === 'allowall') ? 'deny' : xfos.join(', ');
  const anyFrame = fa && fa.find(s => s === 'https:' || s === 'http:' || /^(?:https?:\/\/)?\*(?::[^/]*)?(?:\/.*)?$/.test(s));
  const frameFix = "send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: SAMEORIGIN)";
  if (anyFrame) add('web', 'frames', 'warn', `frame-ancestors ${short(anyFrame, 40)} lets any site show the page in a frame (clickjacking)`, frameFix);
  else if (fa) add('web', 'frames', 'ok', `CSP frame-ancestors ${fa.slice(0, 3).join(' ') || "'none'"}`);
  else if (xfo === 'deny' || xfo === 'sameorigin') add('web', 'frames', 'ok', `X-Frame-Options: ${xfo.toUpperCase()}`);
  else if (xfo) add('web', 'frames', 'warn', `X-Frame-Options is "${short(xfo, 40)}", which current browsers don't honor`, frameFix);
  else add('web', 'frames', 'warn', 'neither X-Frame-Options nor CSP frame-ancestors is set, so other sites can show the page in a frame (clickjacking)', frameFix);

  // The last policy a browser knows wins (RFC: a list falls back from new values to older ones).
  const KNOWN_RP = ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
  const rp = String(h['referrer-policy'] || '').toLowerCase().split(',').map(x => x.trim()).filter(x => KNOWN_RP.includes(x)).pop();
  if (!rp) add('web', 'referrer', 'info', "no Referrer-Policy header: browsers then use strict-origin-when-cross-origin, which gives other sites only the domain, not the page's address");
  else if (rp === 'unsafe-url' || rp === 'no-referrer-when-downgrade') add('web', 'referrer', 'warn', `Referrer-Policy: ${rp} sends other sites the full address of the page, path and query included`, 'use strict-origin-when-cross-origin (the browsers\' default) or something stricter');
  else add('web', 'referrer', 'ok', `Referrer-Policy: ${rp}`);
}

// Every line of the card: { section, check, status, text, fix, details }. A part that couldn't be checked is one
// INFO line marked skipped, so the tally can say what the grade leaves out. Values from DNS, registries and the
// site stay plain strings here; pages escape them with esc() and text answers with plain().
function gradeChecks(g) {
  const out = [], name = g.domain, dns = g.dns;
  const add = (section, check, status, text, fix, extra = {}) => out.push({ section, check, status, text, ...(fix && (status === 'warn' || status === 'fail') ? { fix } : {}), ...extra });
  // what: the part the grade leaves out, as the tally names it ("not checked: security headers"). lasting: a recheck
  // won't fill the gap (the TLD has no RDAP, the site turns ipterm away), so the card keeps its usual cache time.
  const skip = (section, check, text, what = check, lasting = false) => add(section, check, 'info', text, null, { skipped: what, ...(lasting ? { lasting } : {}) });
  const walled = e => /HTTP 40[13]|bot challenge/.test(e || '');   // a login, a 403 or a challenge: the same every time
  const unreadText = what => `couldn't be read (Cloudflare's resolver got no usable answer for ${what}), so it wasn't checked`;
  const reg = g.registration && g.registration.found ? g.registration : null;

  if (dns.broken) add('dns', 'DNSSEC', 'fail', `broken: validating resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9) refuse every answer for ${name} (${dns.broken}), so most people can't reach it at all`,
    "fix the zone's signatures at your DNS host, or remove the DS record at your registrar until they are fixed");
  else if (dns.dnssec) add('dns', 'DNSSEC', 'ok', `signed: answers for ${name} are validated`);
  else if (dns.cname.length && reg && reg.dnssec) add('dns', 'DNSSEC', 'info', `${reg.domain} is signed, but ${name} is an alias of ${dns.cname[dns.cname.length - 1]}, whose answers aren't`);
  else add('dns', 'DNSSEC', 'warn', `not signed, so resolvers can't tell forged answers for ${name} from real ones`, 'turn on DNSSEC at your DNS host, then add the DS record it gives you at your registrar');

  if (!dns.broken) {
    const u = dns.unread;
    if (dns.v6.length) add('dns', 'IPv6', 'ok', `reachable over IPv6: ${dns.v6.length} AAAA record${dns.v6.length > 1 ? 's' : ''} (${dns.v6[0]}${dns.v6.length > 1 ? ' …' : ''})`);
    else if (u.AAAA) skip('dns', 'IPv6', unreadText('AAAA'));
    else if (u.A) skip('dns', 'IPv6', "no AAAA record, but the A record couldn't be read (Cloudflare's resolver got no usable answer), so it wasn't checked");
    else if (dns.v4.length) add('dns', 'IPv6', 'warn', `no AAAA record, so visitors on IPv6-only networks can't reach ${name}`, `add an AAAA record for ${name}: most hosts and CDNs give you an IPv6 address`);
    else add('dns', 'IPv6', 'info', `no A or AAAA record: ${name} has no web address`);

    const c = dns.caa, at = c && c.from !== name ? ` (the CAA records at ${c.from})` : '';
    // issuewild only governs wildcard certificates (RFC 8659 4.3): without an issue tag, any CA may issue for the name itself.
    const named = xs => [...new Set(xs.filter(Boolean))], few = xs => (xs.length > 4 ? `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more` : andList(xs));
    const issuers = c ? named(c.issue) : [], wild = c ? named(c.issuewild) : [];
    const wildText = c && c.issuewild.length && !(wild.length === issuers.length && wild.every(x => issuers.includes(x)))
      ? (wild.length ? `; for wildcard certificates, only ${few(wild)}` : '; no wildcard certificates') : '';
    const caaFix = `add a CAA record naming the CA that issues your certificates, such as ${name}. CAA 0 issue "letsencrypt.org"`;
    if (u.CAA) skip('dns', 'CAA', u.CAA === 'too deep' ? `none at ${name} or its ${GRADE_CAA_PARENTS} closest parent names, and the names above those weren't asked, so it wasn't checked` : unreadText('CAA'), 'CAA', u.CAA === 'too deep');
    else if (!c) add('dns', 'CAA', 'warn', `no CAA record, so any certificate authority may issue certificates for ${name}`, caaFix);
    else if (!c.issue.length) add('dns', 'CAA', 'warn', c.issuewild.length ? `CAA records${at} cover only wildcard certificates (issuewild, no issue tag), so any certificate authority may still issue for ${name}`
      : `CAA records${at} name no CA (no issue tag), so any certificate authority may still issue`, caaFix);
    else if (!issuers.length) add('dns', 'CAA', 'ok', `no certificate authority may issue certificates for ${name} (issue ";")${at}${wildText}`);
    else add('dns', 'CAA', 'ok', `only ${few(issuers)} may issue certificates${at}${wildText}`);

    const hr = dns.https[0];
    if (u.HTTPS) skip('dns', 'HTTPS record', unreadText('HTTPS'));
    else if (!hr) add('dns', 'HTTPS record', 'info', 'none (optional: it tells browsers about HTTP/3 and other connection options before they connect)');
    else if (hr.raw) add('dns', 'HTTPS record', 'ok', 'published');
    else if (hr.priority === 0) add('dns', 'HTTPS record', 'ok', `points to ${hr.target} (alias form)`);
    else add('dns', 'HTTPS record', 'ok', (hr.alpn.length ? `alpn ${hr.alpn.join(',')}${hr.alpn.includes('h3') ? ': browsers can use HTTP/3 from the start' : ''}` : 'published') + (hr.ech ? ', with Encrypted Client Hello' : ''));
  }

  const m = g.mail;
  if (dns.broken) skip('mail', 'mail', "not checked: the domain's records can't be read", 'email');
  else if (!m || m.error) skip('mail', 'mail', `the email security check couldn't run${m && m.error ? ` (${m.error})` : ''}, so it isn't counted`, 'email');
  else if (!m.grade) skip('mail', 'mail', `the email security check couldn't run: the resolver answered ${m.status}`, 'email');
  else {
    const probs = [...m.checks.filter(c => c.status === 'fail'), ...m.checks.filter(c => c.status === 'warn')];
    const details = probs.slice(0, 3).map(c => `${c.check} ${MAIL_STATUS[c.status]}: ${c.text}`);
    if (probs.length > 3) details.push(`and ${probs.length - 3} more`);
    add('mail', 'mail', m.grade === 'A' ? 'ok' : m.grade === 'B' ? 'warn' : 'fail',
      `grade ${m.grade} for email security (${mailTally(m.counts)})${m.nullMx ? '; the domain accepts no mail (null MX)' : ''}`,
      probs[0] && (probs[0].fix ? `${probs[0].fix}; mail ${name} lists every fix` : `mail ${name} lists every fix`), details.length ? { details } : {});
  }

  const r = g.registration;
  if (!r || r.error) skip('registration', 'registration', `the registry record couldn't be read${r && r.error ? ` (${r.error})` : ''}, so expiry and the transfer lock weren't checked`);
  else if (!r.found) skip('registration', 'registration', r.reason === 'no-rdap' ? `the .${r.tld} registry doesn't publish RDAP, so expiry and the transfer lock weren't checked`
    : `no registry record was found for ${r.domain || name}, so expiry and the transfer lock weren't checked`, 'registration', r.reason !== 'unknown');   // unknown: asked rdap.org while IANA's file was down
  else {
    const left = r.expires ? dayDiff(r.expires) : null, date = r.expires ? String(r.expires).slice(0, 10) : null, st = r.status || [];
    const at = r.registrar && r.registrar.name ? r.registrar.name : 'your registrar';
    const lapsed = st.find(x => /redemption period|pending delete/.test(x));
    if (lapsed) add('registration', 'expiry', 'fail', `${r.domain} is in "${lapsed}": it has lapsed and is about to be released`, `restore it at ${at} now, before someone else can register it`);
    else if (left == null) add('registration', 'expiry', 'info', `the registry gives no expiry date for ${r.domain}`);
    // Expired is decided from the timestamp: left is rounded, so the first twelve hours after expiry would be "in 0 days".
    else if (Date.parse(r.expires) < Date.now()) add('registration', 'expiry', 'fail', `${r.domain} expired on ${date}, ${left < 0 ? `${daysText(-left)} ago` : 'less than a day ago'}`, `renew it at ${at} now: an expired domain stops working and can be registered by someone else`);
    else if (left <= 30) add('registration', 'expiry', 'warn', `${r.domain} expires on ${date}, in ${left ? daysText(left) : 'less than a day'}`, `renew it now, and turn on auto-renew at ${at}`);
    else add('registration', 'expiry', 'ok', `${r.domain} expires on ${date}, in ${daysText(left)}`);
    // RFC 9083's "locked" (a registry lock, such as sidn.nl's) also stops transfers.
    const lock = st.filter(x => /transfer prohibited|^locked$/.test(x));
    if (!st.length) add('registration', 'transfer lock', 'info', `the registry publishes no status codes for ${r.domain}, so the transfer lock wasn't checked`);
    else if (lock.length) add('registration', 'transfer lock', 'ok', `${r.domain} is locked against transfers (${lock.join(', ')})`);
    else if (NO_TRANSFER_LOCK_TLDS.has(r.tld)) add('registration', 'transfer lock', 'info', `the .${r.tld} registry has no transfer-lock status, so the transfer lock wasn't checked`);
    else add('registration', 'transfer lock', 'warn', `${r.domain} isn't locked against transfers, so whoever gets into the registrar account can move it away more easily`, `turn on the transfer lock (registrar lock) at ${at}`);
  }

  const w = g.web, why = e => (e === 'timeout' ? "didn't answer in time" : e === 'connect' ? "couldn't be reached (nothing listening, or a certificate or network problem)" : e);
  if (dns.broken) skip('web', 'website', "not checked: the domain's address can't be read");
  else if (w && w.reason === 'unread') skip('web', 'website', `${name}'s ${w.type} record couldn't be read (Cloudflare's resolver got no usable answer), so the website wasn't checked`);
  else if (!w || w.reason === 'noaddr') add('web', 'website', 'info', `${name} has no A or AAAA record, so there is no website to check`);
  else if (w.reason === 'private') skip('web', 'website', `${name} points at a non-public address (${w.address}), so the website wasn't checked`, 'website', true);
  else {
    const s = w.https, p = w.http, home = `https://${name}/`;
    if (s.downgrade) add('web', 'HTTPS', 'fail', `${home} redirects to plain HTTP (${s.downgrade}), so visitors lose the encryption they came with`, 'redirect to an https:// address instead');
    else if (s.checked) add('web', 'HTTPS', 'ok', s.final === home ? `${home} answers (HTTP ${s.status})` : `${home} redirects to ${s.final}, which answers (HTTP ${s.status})`);
    else if (s.offsite) add('web', 'HTTPS', 'ok', `${home} redirects to ${s.offsite}, another domain`);
    else skip('web', 'HTTPS', `${s.final && s.final !== home ? s.final : home} ${why(s.error)}, so the security headers weren't checked`, 'security headers', walled(s.error));

    if (p.upgrades) add('web', 'HTTP', 'ok', `http://${name}/ redirects to HTTPS`);
    else if (p.plain) add('web', 'HTTP', 'warn', `http://${name}/ serves the site over plain HTTP instead of sending visitors to HTTPS`, `redirect every http:// request to https:// (a 301 to https://${name}/)`);
    else if (p.plainRedirect) add('web', 'HTTP', 'warn', `http://${name}/ redirects to ${p.plainRedirect}, still plain HTTP`, `redirect every http:// request to https:// (a 301 to https://${name}/)`);
    else skip('web', 'HTTP', `http://${name}/ ${p.error === 'connect' ? "couldn't be reached (fine if the site only serves HTTPS)" : why(p.error)}, so the redirect to HTTPS wasn't checked`, 'HTTP redirect',
      (p.error === 'connect' && !!s.checked) || walled(p.error));

    if (s.checked) headerChecks(add, s.headers, s.final);
    else if (s.offsite) add('web', 'headers', 'info', `not checked: ${home} sends visitors to ${s.offsite}, another domain`);
  }
  return out;
}

function gradeOf(checks, dns) {
  const n = s => checks.filter(c => c.status === s).length, fail = n('fail'), warn = n('warn');
  if (fail >= 3 || dns.broken || checks.some(c => c.check === 'expiry' && c.status === 'fail')) return 'F';
  return fail === 2 ? 'D' : fail === 1 || warn >= 4 ? 'C' : warn ? 'B' : 'A';
}
// What the grade leaves out, for the tally line ("not checked: website").
const gradeTally = d => mailTally(d.counts) + (d.notChecked && d.notChecked.length ? `; not checked: ${[...new Set(d.notChecked)].join(', ')}` : '');
// A gap a recheck might fill (a timeout, a 429, an unread record) keeps the card and its badge briefly.
const regrade = checks => (checks || []).some(c => c.skipped && !c.lasting);

async function gradeData(io, name) {
  const dns = await gradeDns(name);
  if (dns.status !== 'NOERROR' && !dns.broken) return { ...(dns._ttl ? { _ttl: dns._ttl } : {}), domain: name, status: dns.status, grade: null, subrequests: dns.subrequests };
  // A rate limit in a part fails the whole card (429); any other failure only leaves that part unchecked. A registry
  // server that didn't answer (rdapFetch) is named.
  const part = p => p.then(v => v, e => {
    if (e instanceof RateLimited) throw e;
    return { error: e instanceof RegistrySilent ? `${e.host} didn't answer` : "a data source didn't respond" };
  });
  const [mail, registration, web] = await Promise.all([
    dns.broken ? null : part(mailCheck(io, name, null)),
    part(cached(io, 'whois/' + name, 21600, () => domainLookup(name, io.url.origin))),
    dns.broken ? null : webCheck(name, dns, io),
  ]);
  const g = { domain: name, dns, mail, registration, web };
  const checks = gradeChecks(g), n = s => checks.filter(c => c.status === s).length;
  const notChecked = checks.filter(c => c.skipped).map(c => c.skipped);
  const h = web && web.https && web.https.checked ? web.https.headers : null;
  return {
    ...(regrade(checks) || dns._ttl ? { _ttl: 60 } : {}),
    domain: name, status: dns.status, grade: gradeOf(checks, dns), counts: { ok: n('ok'), warn: n('warn'), fail: n('fail'), info: n('info') },
    checks, notChecked,
    dns: { dnssec: dns.dnssec || false, broken: dns.broken || null, cname: dns.cname || [], addresses: [...(dns.v4 || []), ...(dns.v6 || [])],
      caa: dns.caa || null, https: dns.https || [] },
    mail: mail && mail.grade ? { grade: mail.grade, counts: mail.counts } : null,
    registration: registration && registration.found ? { domain: registration.domain, registrar: registration.registrar ? registration.registrar.name : null,
      expires: registration.expires, status: registration.status, dnssec: registration.dnssec } : null,
    web: web && web.https ? { https: { start: `https://${name}/`, final: web.https.final || null, status: web.https.status || null, hops: web.https.hops,
      headers: h ? Object.fromEntries(Object.entries(h).filter(([k]) => WEB_SECURITY.includes(k)).map(([k, v]) => [k, short(v, 1000)])) : null },
      http: web.http } : web ? { skipped: web.reason } : null,
    checked: new Date().toISOString(), source: 'cloudflare-dns, rdap, the site itself',
    subrequests: (dns.subrequests || 0) + (mail && mail.subrequests || 0) + (web && web.subrequests || 0),
  };
}

// Badge links for a graded domain: the shields.io endpoint (shields.io and GitHub's image proxy fetch it, so a
// README reader's IP never reaches ipterm) and ipterm's own SVG (fetched from ipterm by each reader's browser,
// except where a proxy like GitHub's sits in between).
function badgeLinks(name, origin) {
  const page = `${origin}/grade/${name}`, json = `${origin}/badge/${name}.json`, svg = `${origin}/badge/${name}.svg`;
  const shields = 'https://img.shields.io/endpoint?url=' + encodeURIComponent(json);
  return { endpoint: json, svg, shields, markdown: `[![domain security grade](${shields})](${page})`, markdownSvg: `[![domain security grade](${svg})](${page})` };
}
const withBadge = (d, origin) => (d.grade ? { ...d, badge: badgeLinks(d.domain, origin) } : d);

/* ---------- badges ----------
   /badge/<domain>.json is a shields.io endpoint ({ schemaVersion, label, message, color }): README authors put
   https://img.shields.io/endpoint?url=<that URL> in a Markdown image, so shields.io (and GitHub's image proxy)
   fetch it, never the reader's browser. /badge/<domain>.svg is the same badge drawn by ipterm, which reaches
   ipterm directly unless a proxy sits in between. Both are cached for an hour (ten minutes when part of the card
   couldn't be checked and a recheck might fill it), and a cached copy says how long it has left. shields.io
   gives up after 3.5 seconds, so a card that isn't ready within BADGE_WAIT answers "checking" (or the last known
   grade) and finishes in the background. A card that can't be had (rate limited, a data source down) falls back
   to the last grade, kept for a week. */
const BADGE_LABEL = 'domain security';
const BADGE_WAIT = 2800;
const BADGE_COLORS = { A: ['brightgreen', '#4c1'], B: ['green', '#97ca00'], C: ['yellow', '#dfb317'], D: ['orange', '#fe7d37'], F: ['red', '#e05d44'] };
function badgeOf(d) {
  if (d.grade) return { message: d.grade, color: d.grade, ttl: regrade(d.checks) ? 600 : 3600 };
  return d.status === 'NXDOMAIN' ? { message: 'no such domain', error: true, ttl: 3600 } : { message: 'unknown', error: true, ttl: 300 };
}
async function badgeRoute(io, raw) {
  const m = /^([^/]{1,260})\.(json|svg)$/i.exec(raw || ''), kind = m ? m[2].toLowerCase() : 'json', name = m && normalizeDomain(m[1]);
  if (!name || recordName(name)) return badgeReply(kind, { message: 'not a domain', error: true }, 400, 'public, max-age=300');
  const cache = caches.default, key = new Request(`${io.url.origin}/__cache/badge/${name}`), lastKey = new Request(`${io.url.origin}/__cache/badge-last/${name}`);
  const hit = await cache.match(key);
  // A copy goes out with the time it has left, so shields.io and browsers drop it when this cache does, not a full ttl later.
  if (hit) { const b = await hit.json(); return badgeReply(kind, b, 200, `public, max-age=${b.exp ? Math.max(60, Math.ceil((b.exp - Date.now()) / 1000)) : 300}`); }
  const save = b => Promise.all([
    cache.put(key, new Response(JSON.stringify({ ...b, exp: Date.now() + b.ttl * 1000 }), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${b.ttl}` } })),
    // Kept a week, so an existing badge keeps its last grade while shields.io's lookups are used up (see the handbook).
    !b.error ? cache.put(lastKey, new Response(JSON.stringify({ ...b, ttl: 300 }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=604800' } })) : null,
  ]).catch(() => {});
  const work = gradeFor(io, name).then(badgeOf);
  const got = await Promise.race([work.then(b => ({ b }), e => ({ e })), sleep(BADGE_WAIT).then(() => null)]);
  if (got && got.b) { io.ctx.waitUntil(save(got.b)); return badgeReply(kind, got.b, 200, `public, max-age=${got.b.ttl}`); }
  if (!got) io.ctx.waitUntil(work.then(save, () => {}));                // not ready yet: finish in the background
  const last = await cache.match(lastKey).then(r => (r ? r.json() : null), () => null);
  if (last) return badgeReply(kind, last, 200, 'public, max-age=300');
  if (!got) return badgeReply(kind, { message: 'checking…', ttl: 60 }, 200, 'public, max-age=60');
  return badgeReply(kind, { message: got.e instanceof RateLimited ? 'busy, try later' : 'unavailable', error: true }, 200, 'public, max-age=60');
}
function badgeReply(kind, b, status, cache) {
  const [named, hex] = BADGE_COLORS[b.color] || ['lightgrey', '#9f9f9f'];
  if (kind === 'svg') {
    return new Response(badgeSvg(BADGE_LABEL, b.message, hex), { status, headers: {
      'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': cache, 'cross-origin-resource-policy': 'cross-origin' } });
  }
  // Only the fields shields.io's endpoint schema knows: it rejects anything else.
  const ttl = Number((/max-age=(\d+)/.exec(cache) || [])[1]) || 300;
  return json({ schemaVersion: 1, label: BADGE_LABEL, message: b.message, color: named, ...(b.error ? { isError: true } : {}), cacheSeconds: Math.max(300, ttl) }, status, { 'cache-control': cache });
}
// A flat badge like shields.io's. Text widths are estimated for 11px Verdana and pinned with textLength, so the
// text fits whatever font the reader has. Only fixed strings and a grade letter go in; everything is escaped anyway.
function badgeSvg(label, message, color) {
  const width = s => Math.round([...s].reduce((w, c) => w + (/[fijlrt.,:;' |]/.test(c) ? 3.7 : /[mw]/.test(c) ? 9.6 : /[A-Z]/.test(c) ? 7.6 : /\d/.test(c) ? 7 : c === '…' ? 11 : 6.4), 0));
  const lt = width(label), mt = width(message), lw = lt + 12, mw = mt + 12, w = lw + mw;
  const text = (x, len, s) => `<text x="${x}" y="15" fill="#010101" fill-opacity=".3" textLength="${len}" lengthAdjust="spacingAndGlyphs">${esc(s)}</text>` +
    `<text x="${x}" y="14" textLength="${len}" lengthAdjust="spacingAndGlyphs">${esc(s)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">` +
    `<title>${esc(label)}: ${esc(message)}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    text(lw / 2, lt, label) + text(lw + mw / 2, mt, message) + `</g></svg>\n`;
}

/* ---------- RDAP (whois) ---------- */
// RDAP is the registries' structured replacement for whois. IANA's bootstrap files say which
// regional registry (ARIN, RIPE NCC, APNIC, LACNIC, AFRINIC) holds each address block and ASN.

// An address or ASN file that couldn't be read isn't asked for again for a minute (per isolate): while IANA is down,
// each lookup goes straight to rdap.org instead of spending 3 seconds on IANA first. Not dns.json: through
// rdap.org a domain's answer names no registry and can't say its TLD has no RDAP, and whois keeps it for 6 hours.
// by: the registry exchange's deadline (rdapFetch), of which IANA gets BOOT_WAIT at most, so rdap.org still has time.
const BOOT = {}, BOOT_FAILED = {};
const BOOT_WAIT = 3000;
async function bootstrap(kind, origin, by = Date.now() + DEADLINE) {   // kind: ipv4 | ipv6 | asn | dns
  if (BOOT[kind]) return BOOT[kind];
  const key = new Request(`${origin}/__cache/rdap-bootstrap/${kind}`);
  const hit = await caches.default.match(key);
  let data;
  if (hit) data = await hit.json();
  else {
    if (Date.now() < (BOOT_FAILED[kind] || 0)) throw new Error('bootstrap failed a moment ago');
    try {
      const r = await fetchRetry(`https://data.iana.org/rdap/${kind}.json`, {}, 'iana bootstrap', BOOT_WAIT, Math.min(by, Date.now() + BOOT_WAIT));
      if (!r.ok) throw new Error('bootstrap ' + r.status);
      data = await r.json();
    } catch (e) { if (kind !== 'dns') BOOT_FAILED[kind] = Date.now() + 60_000; throw e; }
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

// The RDAP base of the registry that holds target, null when none does, or rdap.org (which redirects to it) when
// IANA's file can't be read.
async function rdapBase(target, origin, by) {
  let list;
  try { list = await bootstrap(target.asn ? 'asn' : target.p.v === 4 ? 'ipv4' : 'ipv6', origin, by); }
  catch (e) {
    console.error('[ipterm] IANA bootstrap unavailable, using rdap.org:', plain(String((e && e.message) || e)));
    return 'https://rdap.org/';
  }
  if (target.asn) {
    for (const s of list) {
      for (const r of s.ranges) { const [lo, hi] = r.split('-').map(Number); if (target.asn >= lo && target.asn <= (hi || lo)) return s.base; }
    }
    return null;
  }
  let best = null, bestLen = -1;
  for (const s of list) {
    for (const r of s.ranges) { const l = inPrefix(target.p, r); if (l > bestLen) { bestLen = l; best = s.base; } }
  }
  return best;
}

// The registries an RDAP record can come from, by a word in their name or their servers' (registryOf()): the five
// RIRs, and the national registries (NIRs) that keep part of APNIC's and LACNIC's space in databases of their own.
// The NIRs come first: APNIC answers for IDNIC's records from idnic.rdap.apnic.net.
const REGISTRY = { idnic: 'IDNIC', jpnic: 'JPNIC', krnic: 'KRNIC', twnic: 'TWNIC', 'registro.br': 'NIC.br',
  arin: 'ARIN', ripe: 'RIPE NCC', apnic: 'APNIC', lacnic: 'LACNIC', afrinic: 'AFRINIC' };
const RDAP_INIT = { headers: { accept: 'application/rdap+json, application/json' } };

// One RDAP request within its exchange's deadline (by, a Date.now() time: DEADLINE from the start of the lookup, IANA's
// file included). Redirects are followed here, three at most and to http or https only, as fetch would, so a server
// that doesn't answer is known by name: ARIN sends a transferred block on to its registry, LACNIC sends Brazil's
// addresses to NIC.br, and rdap.org sends everything on. A server still silent at the deadline gets no second try
// (fetchRetry): RegistrySilent names it, and one that had RDAP_FAIR or more to answer is then taken as silent for
// RDAP_PAUSE (per isolate, keyed by its origin), so the requests after it fail at once instead of each waiting the
// deadline out. tld: a domain's, whose registry the message names. Returns { r, url }: the answer and the server it
// came from.
const RDAP_FAIR = 3000, RDAP_PAUSE = 60_000;
const rdapQuiet = {};                    // per isolate: RDAP server (origin) -> until when it is taken as silent
const rdapSilent = u => Date.now() < (rdapQuiet[originOf(u)] || 0);
async function rdapFetch(url, by, tld = null) {
  for (let hop = 0; hop < 4; hop++) {
    if (rdapSilent(url)) throw new RegistrySilent(url, tld);
    const t0 = Date.now();
    let r;
    try { r = await fetchRetry(url, { ...RDAP_INIT, redirect: 'manual' }, 'rdap', DEADLINE, by); } catch (e) {
      if (!e.timedOut) throw Object.assign(e, { origin: originOf(url) });
      if (Date.now() - t0 >= RDAP_FAIR) rdapQuiet[originOf(url)] = Date.now() + RDAP_PAUSE;
      throw new RegistrySilent(url, tld);
    }
    const to = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!to) return { r, url };
    if (r.body) r.body.cancel();
    let next = null;
    try { next = new URL(to, url); } catch {}
    const odd = !next || !/^https?:$/.test(next.protocol) ? 'a redirect that is not http(s)' : hop === 3 ? 'too many redirects' : null;
    if (odd) throw Object.assign(new Error('rdap: ' + odd), { origin: originOf(url) });   // the server that sent it
    url = next.href;
  }
}

// A registry server that didn't answer within the deadline (rdapFetch). Its message is for the logs and for blockAsk,
// which pauses the registry date after an "rdap: " failure. text is what whois says, in JSON, as text and on the
// page alike: which server, whose (a domain's registry by its TLD, an address's or AS number's by REGISTRY), and that
// the fault is theirs, not the visitor's.
class RegistrySilent extends Error {
  constructor(url, tld) {
    const host = (() => { try { return new URL(url).hostname; } catch { return String(url); } })();
    super('rdap: no answer from ' + host);
    this.origin = originOf(url);
    this.host = host;
    const rir = Object.keys(REGISTRY).find(k => host.includes(k));
    const who = host === 'rdap.org' ? "rdap.org, which ipterm asks while IANA's list of registries can't be read,"
      : tld ? `The .${tld} registry's whois server (${host})` : `${rir ? REGISTRY[rir] + "'s" : "The registry's"} whois server (${host})`;
    this.text = `${who} didn't answer. That's on their side; try again later.`;
  }
}

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
  return JSON.parse(await readBody(r, max));
}
async function readBody(r, max) {                     // the text of a response, refused past max bytes
  const declared = Number(r.headers.get('content-length'));
  if (declared > max) { if (r.body) r.body.cancel(); throw new Error('response too large'); }
  if (!r.body) return r.text();
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (;;) {                                             // stop reading as soon as the cap is passed
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel(); throw new Error('response too large'); }
    parts.push(value);
  }
  const buf = new Uint8Array(n); let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return new TextDecoder().decode(buf);
}

// The registry that holds an RDAP record: a name from REGISTRY (or one a registry gives itself), never a hostname.
// APNIC's and RIPE NCC's answers say it in a "Source" notice (IDNIC, JPNIC, KRNIC or TWNIC for the NIR records APNIC
// mirrors; CNNIC's, VNNIC's and IRINN's are in APNIC's own database, and NIC Mexico's in LACNIC's). Otherwise it is
// the server that answered (NIC.br's own, for Brazil), its whois server, or the one IANA's list sent the request to;
// null when none of them is known (rdap.org).
function registryOf(o, host, base) {
  const src = (Array.isArray(o.notices) ? o.notices : []).find(n => n && n.title === 'Source');
  const said = src && Array.isArray(src.description) ? String(src.description[src.description.length - 1] || '').trim() : '';
  const known = s => { const k = Object.keys(REGISTRY).find(k => String(s || '').toLowerCase().includes(k)); return k ? REGISTRY[k] : null; };
  return known(said) || (/^[A-Z][A-Z0-9-]{1,15}$/.test(said) ? said : null) || known(host) || known(o.port43) || known(base);
}

async function rdapLookup(target, origin, base) {   // base: rdapBase's answer, when the caller already has it
  const query = target.asn ? 'AS' + target.asn : target.ip;
  const kind = target.asn ? 'asn' : 'ip';
  const tail = target.asn ? 'autnum/' + target.asn : 'ip/' + target.ip;
  const by = Date.now() + DEADLINE;
  if (base === undefined) base = await rdapBase(target, origin, by);
  if (!base) return { query, kind, found: false };
  const url = base + tail;
  const { r, url: at } = await rdapFetch(url, by);     // at: the server that answered (after any redirect)
  if (r.status === 404) return { query, kind, found: false };
  if (!r.ok) throw Object.assign(new Error('rdap ' + r.status), { origin: originOf(at) });
  const o = await readJson(r);

  const ents = flatEntities(o.entities);
  const str = vstr, has = hasRole;
  const registrants = ents.filter(e => has(e, 'registrant'));
  const org = registrants.find(e => vget(e, 'kind') === 'org') || registrants[0] || ents.find(e => has(e, 'administrative'));
  const abuse = ents.find(e => has(e, 'abuse'));
  const ev = a => eventDate(o, a);
  const remark = (o.remarks || []).find(x => !x.title || /^description$/i.test(x.title));
  const host = (() => { try { return new URL(at).hostname; } catch { return ''; } })();

  return {
    query, kind, found: true, source: 'rdap',
    registry: registryOf(o, host, base),
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

/* ---------- a lookup's block: its registry date ----------
   Location databases (IPinfo, IP2Location, MaxMind...) place a block from its registration, its holder's geofeed
   and their own measurements. For months after a block goes to someone new (a new customer, or a lease through a
   broker), they often still place it where its last user was, or each somewhere different, so two sites can name
   two cities for one address. So an address lookup carries the date the registry record of its network (the most
   specific one, as whois <ip> shows it, from the same cache entry, kept a day) was created, and the text, the page
   and the terminal add a line when that was within BLOCK_RECENT_DAYS. Once the rest of an answer is ready it waits
   for the date at most BLOCK_GRACE (withBlock): past that it goes without it, and the registry's answer still fills
   the cache for the next one. Lookups of an address whose registry request is still in flight share it, and a
   registry that is unavailable is left alone for a minute (ten after a 429), so an outage adds no wait, no count and no
   load on it. Bots (isBot) only read the cache, so they never cause an RDAP query; anyone else's
   counts toward their rate limit, riding on the lookup's own count when it made one (limit() sets io.charged) or
   sharing the VPN check's (io.extra). The caller's own address is never sent (ipRoute): asked for by number it is
   answered from the edge, like /json, its page goes without the date, and the terminal asks with ?block=0 for the
   caller's other addresses (the other IP version, WebRTC's), its links and address bar too. */
const BLOCK_RECENT_DAYS = 180;
const BLOCK_GRACE = 300;                 // ms the date may add once the rest of the answer is ready
const blockFlight = new Map();           // per isolate: address -> its registry request in flight, { at, fresh }
const blockPause = {};                   // per isolate: RDAP server (origin) -> until when that registry is left alone
const originOf = u => { try { return new URL(u).origin; } catch { return String(u); } };
// The registry request in flight for an address, if any: one older than waitUntil's 30 seconds was cut off with
// the request that started it and will never settle.
const blockInFlight = ip => { const f = blockFlight.get(ip); return f && Date.now() - f.at < 30_000 ? f : null; };
async function blockData(io, ip, p, pending) {
  if (nonPublicReason(p)) return null;
  const key = 'whois/' + ip;               // whoisRoute's key for an address
  try {
    const hit = await caches.default.match(cacheReq(io, key));
    if (hit) return blockOf(await hit.json());
    if (io.bot) return null;               // bots (isBot) only read the cache
    // The lookup failed or was refused: no registry query either. Nor for an address IPinfo calls a bogon (IPINFO_BOGON).
    if ((await pending).bogon) return null;
    let f = blockInFlight(ip);
    if (!f) {
      const base = await rdapBase({ ip, p }, io.url.origin);
      // no registry, or it just failed (here, or went silent for whois: rdapFetch): no count, no request
      if (!base || Date.now() < (blockPause[originOf(base)] || 0) || rdapSilent(base)) return null;
      if (!io.charged) await (io.extra ||= limit(io));                 // one count, shared with privacyData's
      f = blockInFlight(ip) || blockAsk(io, ip, p, base, key);         // another lookup may have asked meanwhile
    }
    return blockOf(await f.fresh);         // a failure, this lookup's or the one it shares, just means no block
  } catch { return null; }
}

// Asks the registry for blockData: the answer fills whois's cache entry. A registry that is unavailable (a 429, a 5xx,
// a timeout or no connection) is paused, keyed by the server that failed: the one ARIN redirected to, when it did. One
// bad record (another 4xx, JSON that doesn't parse) pauses nothing.
function blockAsk(io, ip, p, base, key) {
  const f = { at: Date.now() };
  f.fresh = rdapLookup({ ip, p }, io.url.origin, base).then(d => { cachePut(io, key, d, 86400); return d; }, e => {
    const why = String((e && e.message) || e), down = /^rdap (?:(429)|5\d\d)$|^rdap: /.exec(why);
    const minutes = !down ? 0 : down[1] ? 10 : 1, at = (e && e.origin) || originOf(base);
    if (minutes) blockPause[at] = Date.now() + minutes * 60_000;
    console.error(`[ipterm] registry date skipped (${plain(why)})` + (minutes ? `; ${at} left alone for ${minutes} minute${minutes > 1 ? 's' : ''}` : ''));
    throw e;
  });
  blockFlight.set(ip, f);
  const done = () => { if (blockFlight.get(ip) === f) blockFlight.delete(ip); };
  io.ctx.waitUntil(f.fresh.then(done, done));
  return f;
}

// { network, registry, registered (the date part of the registry's own timestamp), days (calendar days from then
// to today, UTC), recent }, or null when the registry has no record or no date for it.
function blockOf(w) {
  const day = w && w.found ? /^(\d{4}-\d{2}-\d{2})/.exec(w.registered || '') : null;
  const t = day ? Date.parse(day[1]) : NaN;
  if (!Number.isFinite(t)) return null;
  const days = Math.max(0, Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - t) / 86400000));
  return {
    network: (w.cidrs || []).join(', ') || (w.range ? `${w.range.start} - ${w.range.end}` : null),
    registry: w.registry || null, registered: day[1], days, recent: days <= BLOCK_RECENT_DAYS,
  };
}

// The line for a recent block (null otherwise), in the text and on the page. app.js (blockLine) words it the same.
function blockText(b) {
  if (!b || !b.recent) return null;
  const ago = b.days === 0 ? 'today' : b.days === 1 ? '1 day ago' : `${b.days} days ago`;
  // "with" only names a registry REGISTRY knows: a whois record cached before registryOf() may hold a hostname
  const reg = Object.values(REGISTRY).includes(b.registry) ? ` with ${b.registry}` : '';
  return `${b.network || 'this block'} registered${reg} on ${b.registered} (${ago}): IP location databases often take months ` +
    'to catch up with new or reassigned blocks, so sites may disagree about where this address is';
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

async function domainBase(name, origin, by) {           // longest matching TLD in IANA's dns.json
  let best = null, bestLen = 0;
  for (const s of await bootstrap('dns', origin, by)) {
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
  // IANA's list, the registry (each name tried) and the registrar's record share one deadline (rdapFetch).
  const by = Date.now() + DEADLINE;
  let base, viaFallback = false;
  try { base = await domainBase(name, origin, by); }
  catch (e) {
    console.error('[ipterm] IANA bootstrap unavailable, using rdap.org:', plain(String((e && e.message) || e)));
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
    const { r } = await rdapFetch(url, by, tld);
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

  // Follow the registrar's RDAP record when the registry links to it (best effort, short timeout: 4 seconds, or what
  // is left of the deadline, and not at all with under half a second left).
  let rr = null;
  const rel = (Array.isArray(o.links) ? o.links : []).find(l => l && l.rel === 'related' && typeof l.href === 'string' &&
    (l.type ? /json/i.test(l.type) : /\/domain\//i.test(l.href)));
  const relUrl = rel && safeRdapLink(rel.href), wait = Math.min(4000, by - Date.now());
  if (relUrl && relUrl !== url && wait >= 500) {
    try {
      // redirect: 'manual' so the checks above can't be sidestepped by a redirect elsewhere
      const r2 = await fetch(relUrl, { ...RDAP_INIT, redirect: 'manual', signal: AbortSignal.timeout(wait) });
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

// Search results show about 155 characters of a description. A page offers its summary and shorter versions of it,
// key fact first, and gets the first that fits (one still too long is cut at a word). The page itself keeps the
// whole summary. shorter() gives the versions that drop parts from the end: all of them, then one fewer, and so on.
const DESC_MAX = 155;
function descFit(...tries) {
  const t = tries.filter(Boolean), s = t.find(x => x.length <= DESC_MAX) || t[t.length - 1] || '';
  return s.length <= DESC_MAX ? s : s.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, '').replace(/[\s,;:]+$/, '') + '…';
}
const shorter = (parts, sep = ' ', end = '') => parts.filter(Boolean).map((_, i, a) => a.slice(0, a.length - i).join(sep) + end);

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
// noindex: a working page that search engines should skip but whose links they may follow (ports without an
// explainer of their own, non-public addresses that aren't in SITEMAP_PATHS, a network's first address unless it is
// there (netStart), ASN, whois and /cidr pages that name a network holder who may be a private person, and shared
// leak test results).
// image: the share image's path (a shared leak test result uses its grade's).
async function shell(io, { status = 200, title, desc, path = '/', body = '', initial = null, cache = null, noindex = false, image = '/og.png' }) {
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
    `<meta property="og:image" content="${esc(io.url.origin + image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    path === '/' ? homeJsonLd(io.url.origin) : status < 400 ? breadcrumbJsonLd(io.url.origin, path) : '',
    (status >= 400 && status !== 429) || noindex || selfHosted(io.env) ? `<meta name="robots" content="noindex, follow">` : '',
  ].filter(Boolean).join('\n');
  if (path !== '/') h = h.replace(/\s*<p class="intro">[\s\S]*?<\/p>/, '');   // the plain-English line is for the homepage
  const h1 = path !== '/' && title ? title.replace(/\s*\|\s*ipterm$/, '') : null;
  if (h1) h = h.replace(/<h1 class="sr-only">[^<]*<\/h1>/, () => `<h1 class="sr-only">${esc(h1)}</h1>`);
  // The homepage terminal shows the reader's own address (a crawler's, when a crawler renders it): never a snippet.
  if (path === '/') h = h.replace('<div id="out"', () => '<div id="out" data-nosnippet');
  h = h.replace('<!--SEO-->', () => head).replace('<!--STATIC-->', () => body).replace('<!--BUILD-->', () => footBuild(io.env))
    .replaceAll('%ORIGIN%', () => io.url.origin);
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
// personal, so no shared cache may keep it. Past the rate limit it still carries the address, only
// without the hostname (selfInfo). If it fails anyway, the plain shell goes out and the terminal
// asks for itself. So does a prefetch or prerender: it may come
// through a proxy (Chrome's private prefetch proxy, from search results) or be shown minutes later,
// and either way the address it would carry might not be the visitor's.
async function homePage(io) {
  const cache = 'private, no-store';
  const purpose = io.request.headers.get('sec-purpose') || io.request.headers.get('purpose') || '';
  if (io.request.method === 'HEAD' || /prefetch|prerender/i.test(purpose)) return shell(io, { status: 200, cache });
  let d = null;
  try { d = await selfInfo(io, { quick: true }); } catch {}
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
  if (!tool || rest.length) crumbs.push([tool === 'leaktest' ? 'shared result' : tool ? (tool === 'port' ? 'port ' : '') + rest.join(tool === 'cidr' ? '/' : ' ') : first, path]);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: origin + encodePath(p) })),
  };
  return `<script type="application/ld+json">${safeJson(ld)}</script>`;
}

// Plain-language summary of IPinfo Core's flags (and the free API's anycast).
function connectionText(d) {
  const f = d.flags || {}, out = [];
  if (f.hosting || d.asType === 'hosting') out.push('hosting or data center');
  if (f.mobile) out.push('mobile network');
  if (f.satellite) out.push('satellite');
  if (f.anycast) out.push('anycast (served from many locations)');
  if (!out.length && d.asType === 'isp') out.push('home or business internet provider');
  return out.length ? out.join(' · ') : null;
}

// VPN / proxy verdict. Core, proxycheck.io and the VPN providers' own server lists check for it, and a clean result
// is not proof: VPN providers keep adding fresh addresses that no list knows yet. Kept in step with app.js
// (pcKnown, pcFlag, vpnKind, listedText, vpnText there).
// "yes" needs Core's flag, a specific proxycheck.io finding (VPN, proxy, Tor or a named service), the address on a
// provider's own list (vpnServer), or on Apple's iCloud Private Relay list (relay). Apple's list comes first, then a
// listed address, exit or entry, named by its provider even where Core or proxycheck.io also say yes: the provider's
// own word is the most specific (an entry is said as such: its users connect to it, and reach sites from another
// address). Private Relay is a relay, not a VPN, and is named as one.
// proxycheck.io's own "anonymous" is a catch-all ("any kind of anonymising service (proxy, VPN,
// TOR, etc.)" in its API reference) that is also set on addresses that are none of those, such as
// Google Public DNS (8.8.8.8). Alone, it is reported as what it is (PC_CATCHALL), never as
// "anonymizing", and "compromised" (seen performing attacks, which doesn't by itself mean the
// address relays anyone's traffic) gets a hedged line.
const pcKnown = pc => !!(pc && pc.anonymous && (pc.vpn || pc.proxy || pc.tor || pc.operator));
const PC_CATCHALL = 'not a known VPN, proxy or Tor service (proxycheck.io sets its catch-all "anonymous" flag, which it also gives public DNS and CDN addresses)';
const pcFlag = pc => (pc.compromised ? 'flagged by proxycheck.io as compromised (seen performing attacks), but not as a known VPN, proxy or Tor service' : PC_CATCHALL);
const vpnKind = pc => (pcKnown(pc) ? (pc.tor ? 'Tor' : pc.vpn ? 'VPN' : pc.proxy ? 'proxy' : 'VPN, proxy or Tor') : 'VPN, proxy or Tor');
const RELAY_TEXT = "yes: Apple's iCloud Private Relay (on Apple's own list of its relay addresses: sites see a Private Relay address, not the user's)";
// The provider first, as the owner chose ("a known Mullvad VPN server"); a name that already says VPN (IVPN, AirVPN)
// just gets "server".
const vpnLabel = p => (/vpn/i.test(p) ? `${p} server` : `${p} VPN server`);
const listedText = ls => (ls.role === 'exit' ? `yes: a known ${vpnLabel(ls.provider)} (on ${ls.provider}'s own server list, as an address its users reach sites from)`
  : `yes: a known ${vpnLabel(ls.provider)} (on ${ls.provider}'s own server list, as an address its users connect to; sites may see them at a different address)`);
function vpnText(d) {
  const core = d.source === 'ipinfo-core' && d.flags ? d.flags : null, pc = d.privacy || null, ls = d.vpnServer || null;
  if (d.relay) return RELAY_TEXT;
  if (ls) return listedText(ls);
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
  if (d.bogon && d.range) {                              // not public (nonPublicReason): never looked up
    const range = d.range, priv = /RFC 1918|unique local/.test(range), url = `http://${d.version === 6 ? '[' + ip + ']' : ip}`;
    const where = CIDR.rangeIn(range), lead = `${ip} is a non-public ${v} address${where.startsWith('the ') ? ': ' : ' '}${where}.`;
    // Documentation, benchmarking, multicast and reserved space isn't anyone's local network.
    const reach = /RFC 1918|unique local|link-local|loopback|carrier-grade/.test(range)
      ? 'It is used inside local networks and cannot be reached or located from the internet.' : 'It cannot be reached or located from the internet.';
    const router = priv ? `If it is your router's address, open ${url} in a browser on the same network to reach its settings.` : null;
    const summary = [lead, reach, router].filter(Boolean).join(' ');
    const desc = descFit(summary, router && `${lead} ${router}`, router && `${lead} If it is your router, open ${url} for its settings.`,
      `${lead} It cannot be reached or located from the internet.`, lead);
    // Only the router and well-known addresses in SITEMAP_PATHS are indexed: the rest of the private space
    // is millions of near-identical pages. The title and the tag are the terminal's (lookup() and render() in
    // public/app.js): the word for the special-purpose table's kind ("private IPv4 address": kindWord() in
    // public/cidr.js), and the kind itself (private, docs, benchmark ...).
    const kind = CIDR.special(parseIp(ip))[0];
    return shell(io, { status, path, title: `${ip} · ${CIDR.kindWord(kind)} ${v} address | ipterm`, desc, noindex: !curatedIps().has(ip),
      initial: { kind: 'ip', query: ip, data: d }, body: staticBlock(ip, [v, kind], [['range', range]], summary,
        `<p class="ln sys">Guides: <a href="/guides/find-router-ip">How to find your router's IP address</a> · <a href="/guides/private-ip-ranges">Private IP address ranges explained</a></p>`) });
  }
  if (d.bogon) {
    // IPinfo's bogon (IPINFO_BOGON), an address the special-purpose table calls public: what the table says of it, if
    // anything, and then IPinfo's word, in IPinfo's name. ipTitle() and render() in public/app.js do the same.
    const [, words, listed] = CIDR.special(parseIp(ip));
    const lead = `${ip} is an ${v} address${listed ? ' ' + CIDR.rangeIn(words) : ''}.`, summary = `${lead} ${IPINFO_BOGON}.`;
    return shell(io, { status, path, title: `${ip} IP lookup: IPinfo lists it as a bogon | ipterm`, desc: descFit(summary, `${lead} IPinfo lists it as a bogon.`),
      noindex: true, initial: { kind: 'ip', query: ip, data: d },
      body: staticBlock(ip, [v, 'bogon'], [['hostname', d.hostname], ['range', listed ? words : null]], summary) });
  }
  const place = [d.city, d.region, d.country || d.countryCode].filter(Boolean).join(', ');
  const owner = d.org ? d.org + (d.asn ? ` (${d.asn})` : '') : d.asn || '';
  // An anycast address is answered from many places, and IPinfo's location is one of them, so it is called anycast
  // instead. IPinfo Lite, which bots get, has no anycast flag and gives only a country, which for a resolver says
  // little (1.1.1.1: Australia), so the resolver pages in SITEMAP_PATHS, the IP pages search results show most, name
  // no place for a Lite answer. Other Lite answers keep their country.
  const anycast = Boolean(d.flags && d.flags.anycast);
  const placed = !anycast && !(d.source === 'ipinfo-lite' && curatedIps().has(ip)) ? place : '';
  const lead = `${ip} is a public ${v} address` + (owner ? ` operated by ${owner}` : '') +
    (anycast ? ', anycast (served from many locations)' : placed ? `, located in ${placed}` : '') + '.';
  const host = d.hostname ? `Hostname: ${d.hostname}.` : null, approx = placed ? 'IP location is approximate.' : null;
  const summary = [lead, host, approx].filter(Boolean).join(' ');
  const desc = descFit(summary, approx && `${lead} ${approx}`, lead);
  // "<ip> IP lookup: <org> (<ASN>), <hostname>", without the parts the lookup doesn't have. ipTitle() in public/app.js
  // words it the same way.
  const named = [owner, d.hostname].filter(Boolean).join(', ');
  const title = `${ip} IP lookup${named ? ': ' + named : ''} | ipterm`;
  const rows = [
    ['hostname', d.hostname], ['network', owner], ['domain', d.asDomain], ['location', place],
    ['coordinates', d.lat != null && d.lon != null ? `${d.lat}, ${d.lon}` : null], ['time zone', d.timezone],
    ['block', blockText(d.block)], ['connection', connectionText(d)], ['vpn / proxy', vpnText(d)],
  ];
  // A network's first address isn't indexed unless curated (netStart), and leads with its registered block, when the
  // lookup has it: the block's /cidr page is the one that answers a search for it.
  const p = parseIp(ip), start = netStart(p) && !curatedIps().has(ip);
  const net = start && d.block ? String(d.block.network || '').split(', ').find(c => c.includes('/') && inPrefix(p, c) >= 0) : null;
  const links = (net ? `<p class="ln sys">Registered block: <a href="/cidr/${esc(net)}">${esc(net)}</a> (subnet and routing)</p>` : '') +
    (/^AS\d{1,10}$/i.test(d.asn || '') ? `<p class="ln sys">More from this network: <a href="/${esc(d.asn)}">${esc(d.asn)}${d.org ? ' ' + esc(d.org) : ''}</a></p>` : '') +
    `<p class="ln sys">Registry record: <a href="/whois/${esc(ip)}">whois ${esc(ip)}</a> (owner and abuse contact)</p>` +
    `<p class="ln sys">Guide: <a href="/guides/what-your-ip-reveals">What your IP address reveals (and what it doesn't)</a></p>`;
  return shell(io, { status, path, title, desc, noindex: start, initial: { kind: 'ip', query: ip, data: d },
    cache: d.blockLate ? 'no-store' : null,                // sent before its registry date arrived (withBlock)
    body: staticBlock(ip, [v, 'public'], rows, summary, links) });
}

// route: the routing of a public prefix (routeLookup()), { error } if it didn't load, or null for private ranges.
function cidrPage(io, d, status, route = null) {
  if (d.error) {
    return shell(io, { status, path: '/cidr/' + String(d.input || '').slice(0, 60), title: 'Subnet calculator | ipterm',
      initial: { kind: 'cidr', query: String(d.input || ''), error: d.error }, body: staticBlock('Subnet calculator', ['cidr'], [], d.error) });
  }
  const path = '/cidr/' + d.cidr;                        // canonical: the network address, not the host that was typed
  const where = `It ${CIDR.rangeIs(d.rangeNote)}.`;      // "It is in the ...", "It starts with the ..." (rangeIs)
  let summary, title, rows, brief;                       // brief: shorter summaries for the description, longest first
  if (d.v === 4) {
    const hosts = `${d.usableText} usable host${d.usable === 1 ? '' : 's'}`, span = d.prefix <= 30 ? ` from ${d.first} to ${d.last}` : '';
    const has = `${d.cidr} has netmask ${d.netmask}`, count = `${d.totalText} address${d.total === 1 ? '' : 'es'} and ${hosts}`;
    summary = `${has} (wildcard ${d.wildcard}), ${count}${span}` + (d.prefix <= 30 ? `, with broadcast address ${d.broadcast}` : '') + `. ${where}`;
    brief = [`${has}, ${count}${span}. ${where}`, `${has}, ${count}. ${where}`, `${has}, ${count}.`, `${has} and ${hosts}.`];
    // cidrTitle() in public/app.js words it the same way
    title = `${d.cidr} subnet: ${d.netmask}, ${d.usable === 1 ? 'a single address' : d.usableText + ' usable hosts'} | ipterm`;
    rows = [['network', d.cidr], ['netmask', d.netmask], ['wildcard', d.wildcard], ['broadcast', d.prefix <= 30 ? d.broadcast : null],
      ['usable hosts', `${d.first} – ${d.last}`], ['host count', `${d.usableText} usable · ${d.totalText} addresses`],
      ['splits into', d.halves && d.halves.join(' · ')], ['part of', d.supernet], ['range', d.rangeNote], ['legacy class', d.legacyClass]];
  } else {
    const subs = d.subnets64 ? `${d.subnets64} /64 subnet${d.subnets64 === '1' ? '' : 's'}` : null, block = `${d.cidr} is an IPv6 block of ${d.totalPow}`;
    summary = `${block} (${d.totalText}) addresses, from ${d.network} to ${d.last}` + (subs ? `, containing ${subs}` : '') + `. ${where}`;
    brief = [`${block} addresses, from ${d.network} to ${d.last}. ${where}`, subs && `${block} addresses (${subs}). ${where}`, `${block} addresses. ${where}`,
      `${block} addresses.`];                          // the block's size, beside a routing lead that leaves no room for where
    title = `${d.cidr} IPv6 subnet | ipterm`;
    rows = [['network', d.cidr], ['first address', d.network], ['last address', d.last], ['addresses', `${d.totalPow} = ${d.totalText}`],
      ['/64 subnets', d.subnets64], ['expanded', d.expanded], ['splits into', d.halves && d.halves.join(' · ')], ['part of', d.supernet], ['range', d.rangeNote]];
  }
  let links = `<p class="ln sys">Guide: <a href="/guides/subnet-cheat-sheet">Subnet mask cheat sheet</a>` +
    (d.range === 'public' ? ` · Registry: <a href="/whois/${esc(d.network)}">whois ${esc(d.network)}</a>` : '') + `</p>`;
  const r = route && !route.error ? route : null;
  if (r) {
    // How it is routed leads the page: that is what "1.1.1.0/24" and "AS13335 prefix RPKI" searches look for.
    const o = r.origins[0];
    const rpki = o && o.rpki ? (o.rpki === 'valid' ? ', RPKI valid' : o.rpki === 'not-found' ? ', no ROA' : ', RPKI invalid') : '';
    if (o && r.status === 'announced') title = `${d.cidr}: announced by ${o.asn}${o.name ? ' ' + o.name : ''}${rpki} | ipterm`;
    else if (o) title = `${d.cidr}: routed in ${r.prefix} by ${o.asn}${o.name ? ' ' + o.name : ''} | ipterm`;
    const lead = routeSummary(r, true) + (o && o.rpki ? ` RPKI: ${o.rpki === 'valid' ? 'valid' : o.rpki === 'not-found' ? 'no ROA' : 'invalid'}.` : '');
    brief = [...brief.filter(Boolean).map(s => `${lead} ${s}`), lead, routeSummary(r, true)];
    summary = r.summary + ' ' + summary;
    rows.push(...routeRows(r).map(([k, v]) => [k, Array.isArray(v) ? v.join(' · ') : v]));
    const asLink = a => `<a href="/${esc(a)}">${esc(a)}</a>`;   // ASN pages ask RIPEstat only
    const nets = [...new Set([...r.origins.map(x => x.asn), ...r.upstreams.map(u => u.asn)])];
    links = (nets.length ? `<p class="ln sys">Networks: ${nets.map(asLink).join(' · ')}</p>` : '') +
      (r.prefix && r.prefix !== d.cidr ? `<p class="ln sys">Route: <a href="/cidr/${esc(r.prefix)}">${esc(r.prefix)}</a></p>` : '') +
      `<p class="ln sys">Routing data from <a href="https://stat.ripe.net/" rel="noopener">RIPEstat</a> (RIS collectors ${esc(r.collectors.map(c => c.split(' ')[0]).join(', '))}). From a command line: <code>curl ${esc(io.url.host)}/route/${esc(d.cidr)}</code></p>` + links;
  } else if (route && route.error) links = `<p class="ln sys${route.bot ? ' route-bot' : ''}">${esc(route.error)}</p>` + links;   // .route-bot: cidrRoute
  // The routing section names the origin networks' holders: noindex, follow when one may be a private person, as
  // on the origin's own ASN page (prefix-overview gives the holder as as-overview does).
  const personal = Boolean(r) && r.origins.some(o => personHeld(o.holder));
  return shell(io, { status, path, title, desc: descFit(summary, ...brief), noindex: personal, initial: { kind: 'cidr', query: d.cidr, data: d, ...(route ? { route } : {}) },
    body: staticBlock(`Subnet ${d.cidr}`, ['cidr', 'IPv' + d.v, d.range, ...(r ? [r.status] : [])], rows, summary, links) });
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
  let summary, desc;
  if (parseIp(name)) summary = desc = R.PTR ? `The reverse DNS (PTR) name for ${name} is ${list(vals('PTR'))}.` : `${name} has no reverse DNS (PTR) record.`;
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
    desc = descFit(summary, ...shorter(parts, '; ', '.'));
  }
  const rows = [];
  if (d.cname && d.cname.length) rows.push(['alias of', d.cname.join(' → ')]);
  for (const t of d.types) if (R[t]) rows.push([t, vals(t).join(' · ')]);
  if (d.hosting && d.hosting.org) rows.push(['hosted by', `${d.hosting.org}${d.hosting.asn ? ' (' + d.hosting.asn + ')' : ''}`]);
  rows.push(['DNSSEC', d.dnssec ? 'validated' : 'not validated']);
  const takesMail = !parseIp(name) && ((R.MX || []).length > 0 || (R.TXT || []).some(r => isSpf(r.value)));
  const links = (d.hosting ? `<p class="ln sys">First address: <a href="/${esc(d.hosting.ip)}">${esc(d.hosting.ip)}</a> · <a href="/whois/${esc(d.hosting.ip)}">whois</a></p>` : '') +
    (!parseIp(name) ? `<p class="ln sys">Registration: <a href="/whois/${esc(name)}">whois ${esc(name)}</a> (registrar, dates, status)</p>` : '') +
    (takesMail ? `<p class="ln sys">Email security: <a href="/mail/${esc(name)}">mail check for ${esc(name)}</a> (SPF, DMARC, DKIM, MTA-STS, graded A to F)</p>` : '') +
    (!parseIp(name) && !recordName(name) ? `<p class="ln sys">Report card: <a href="/grade/${esc(name)}">grade ${esc(name)}</a> (DNSSEC, email, expiry and security headers, graded A to F)</p>` : '');
  const typesTitle = single ? `${single} record` : 'DNS records';
  return shell(io, { status, path, title: `${name} ${typesTitle}` + (R.A ? ` · ${R.A[0].value}` : '') + ' | ipterm', desc,
    initial: { kind: 'dns', query: name, qtype: single, data: d },
    body: staticBlock(`DNS: ${name}${single ? ' ' + single : ''}`, ['dns', d.dnssec ? 'dnssec' : 'unsigned'], rows, summary, links) });
}

function whoisPage(io, d, status) {
  if (d.kind === 'domain' && d.found) return domainWhoisPage(io, d, status);
  const q = d.query, path = '/whois/' + q;
  const date = s => (s ? String(s).slice(0, 10) : null);
  if (d.error || d.bogon || !d.found) {
    const msg = d.error || (d.bogon ? `${q} is a non-public address, so no internet registry holds a record for it: it is ${CIDR.rangeIn(d.range)}.`
      : d.message || `No registry record was found for ${q}.`);
    const keep = d.bogon || (d.kind === 'domain' && !d.error);     // let the terminal explain it in its own words
    return shell(io, { status, path, title: `whois ${q} | ipterm`, initial: { kind: 'whois', query: q, ...(keep ? { data: d } : { error: msg }) },
      body: staticBlock(`whois ${q}`, ['whois'], [], msg, d.bogon ? `<p class="ln sys">Guide: <a href="/guides/private-ip-ranges">Private IP address ranges explained</a></p>` : '') });
  }
  const block = (d.cidrs || []).join(', ') || (d.range ? `${d.range.start} – ${d.range.end}` : null);
  const who = `${q} is registered` + (d.org ? ` to ${d.org}` : '') + (d.registry ? ` through ${d.registry}` : '');
  const lead = who + (block && d.kind === 'ip' ? `, as part of ${block}` : '') + '.', abuse = d.abuse && d.abuse.email ? `Abuse reports go to ${d.abuse.email}.` : null;
  const summary = [lead, abuse].filter(Boolean).join(' ');
  const desc = descFit(summary, lead, who + '.');
  const rows = [
    ['owner', d.org], ['network name', d.name], ['handle', d.handle && !/ - /.test(d.handle) ? d.handle : null], ['registry', d.registry],
    ['address block', block], ['range', d.range ? `${d.range.start} – ${d.range.end}` : null], ['type', d.type], ['country', d.country],
    ['registered', date(d.registered)], ['last changed', date(d.updated)],
    ['abuse email', d.abuse && d.abuse.email], ['abuse phone', d.abuse && d.abuse.phone], ['description', d.description],
  ];
  // A registry block's first address links the block's /cidr page (RIPEstat only) rather than a lookup of it (mostly a
  // noindex page: netStart): crawlers reach whois from /cidr pages, a block at a time. Curated addresses keep theirs,
  // and so does a record of one address (a /32 or /128 reassignment): that is a host, not a block.
  const start = d.kind === 'ip' && !curatedIps().has(q) ? (d.cidrs || []).find(c => {
    const [a, n] = c.split('/');
    return Number(n) < (a.includes(':') ? 128 : 32) && sameIp(a, q);
  }) : null;
  const back = d.kind === 'asn' ? `<a href="/${esc(q)}">${esc(q)} network details</a>`
    : start ? `<a href="/cidr/${esc(start)}">${esc(start)} subnet and routing</a>` : `<a href="/${esc(q)}">${esc(q)} location and network</a>`;
  // noindex, follow when the holder may be a private person, as on ASN pages. RDAP gives the holder in org (the
  // registrant, or else the administrative contact) and the AS or network name in name; "<name> <org>" is the
  // holder as RIPEstat gives it, so this page and the network's ASN page come to the same answer.
  const personal = personName(d.org) || personName(d.name) || (Boolean(d.org) && personHeld(`${d.name || d.handle || ''} ${d.org}`));
  return shell(io, { status, path, title: `whois ${q}` + (d.org ? ` · ${d.org}` : '') + ' | ipterm', desc, noindex: personal,
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
  const parts = [
    `${q} was registered` + (d.registered ? ` on ${date(d.registered)}` : '') + (reg ? ` through ${reg}` : '') +
      (d.expires ? ` and ${left != null && left < 0 ? 'expired' : 'expires'} on ${date(d.expires)}` : '') + '.',
    ns.length ? `Its name servers are ${ns.slice(0, 2).join(' and ')}${ns.length > 2 ? ` (and ${ns.length - 2} more)` : ''}.` : null,
    d.registrant ? `Registrant: ${d.registrant.replace(/\.$/, '')}.` : 'Owner details are not published.',
    d.abuse && d.abuse.email ? `Abuse reports go to ${d.abuse.email}.` : null,
  ];
  const summary = parts.filter(Boolean).join(' '), desc = descFit(...shorter(parts));
  const rows = [
    ['domain', d.unicodeName ? `${q} (${d.unicodeName})` : q], ['registrar', reg ? reg + (d.registrar.ianaId ? ` (IANA ID ${d.registrar.ianaId})` : '') : null],
    ['registered', date(d.registered)], ['expires', d.expires ? date(d.expires) + (left != null ? (left < 0 ? ` (expired ${-left} days ago)` : ` (in ${left} days)`) : '') : null],
    ['last changed', date(d.updated)], ['status', (d.status || []).join(' · ')], ['name servers', ns.join(' · ')],
    ['DNSSEC', d.dnssec == null ? null : d.dnssec ? 'signed' : 'not signed'],
    ['registrant', d.registrant ? d.registrant + (d.registrantCountry ? ` (${d.registrantCountry})` : '') : 'not published (redacted for privacy)'],
    ['abuse email', d.abuse && d.abuse.email], ['abuse phone', d.abuse && d.abuse.phone], ['registry', d.registry],
  ];
  return shell(io, { status, path, title: `whois ${q}` + (reg ? ` · ${reg}` : '') + (d.expires ? ` · expires ${date(d.expires)}` : '') + ' | ipterm', desc,
    initial: { kind: 'whois', query: q, data: d },
    body: staticBlock(`whois ${q}`, ['whois', 'domain', d.registry || 'rdap'], rows, summary,
      `<p class="ln sys">See also: <a href="/dns/${esc(q)}">DNS records for ${esc(q)}</a> · <a href="/mail/${esc(q)}">mail check for ${esc(q)}</a>` +
      ` · <a href="/grade/${esc(q)}">report card for ${esc(q)}</a></p>`) });
}

function mailPage(io, d, status) {
  const name = d.domain, path = '/mail/' + name;
  const initial = { kind: 'mail', query: name, dkim: d.selector || null };
  if (d.error || d.status !== 'NOERROR') {
    const msg = d.error || mailProblem(d);
    return shell(io, { status, path, title: `${name} mail check | ipterm`, initial: { ...initial, ...(d.status ? { data: d } : { error: msg }) },
      body: staticBlock(`Mail check: ${name}`, ['mail'], [], msg) });
  }
  const rows = mailRows(d, false).map(([k, v]) => [k, Array.isArray(v) ? v.join(' · ') : v]);
  const dm = d.dmarc, spf = d.spf, sts = d.mtaSts && d.mtaSts.policy, unread = d.unread || {};
  const hosts = d.mx.records.filter(r => !nullMx({ value: r.host })).map(r => r.host);
  // The summary is what search engines show for "<domain> dmarc" and "<domain> spf record". A record
  // that couldn't be read is said so, as on its check line, never called missing.
  const clauses = [`${name} gets ${/^[AF]$/.test(d.grade) ? 'an' : 'a'} ${d.grade} for email security (${mailTally(d.counts)})`,
    d.nullMx ? 'it accepts no mail (null MX)' : d.mx.providers.length ? `mail is handled by ${d.mx.providers.join(' and ')}` : hosts.length ? `mail goes to ${hosts[0]}` : 'it has no MX records',
    unread.DMARC ? "its DMARC record couldn't be read"
      : dm && dm.policy ? `its DMARC policy${dm.inherited ? ` (from ${dm.from})` : ''} is p=${dmarcEffective(dm)}` + (dm.rua.length ? ` with reports to ${dm.rua[0]}` : '') : 'it has no working DMARC policy',
    unread.SPF ? "its SPF record couldn't be read"
      : spf.records === 1 ? (spf.overLimit ? `its SPF record needs ${spf.counted ? spf.lookups : 'more than 10'} DNS lookups, over the limit of 10`
        : spf.redirectMacro ? `SPF uses ${spf.lookups} of 10 DNS lookups and hands off to a redirect= with a macro`
        : `SPF ends in ${spf.all || 'no all'} with ${spf.lookups} of 10 DNS lookups`) : spf.records ? `it has ${spf.records} SPF records` : 'it has no SPF record',
    ...(sts && !sts.error && !sts.errors.length && sts.mode === 'enforce' ? ['MTA-STS is enforced'] : []),
  ];
  const summary = clauses.join('; ') + '.', desc = descFit(...shorter(clauses, '; ', '.'));
  const links = `<p class="ln sys">Records: <a href="/dns/${esc(name)}/MX">dig ${esc(name)} MX</a> · <a href="/dns/${esc(name)}/TXT">dig ${esc(name)} TXT</a>` +
    ` · <a href="/dns/_dmarc.${esc(name)}/TXT">dig _dmarc.${esc(name)} TXT</a> · <a href="/whois/${esc(name)}">whois ${esc(name)}</a></p>` +
    `<p class="ln sys">${recordName(name) ? '' : `Report card: <a href="/grade/${esc(name)}">grade ${esc(name)}</a> (DNSSEC, expiry and security headers too) · `}How the grade works: <a href="/mail">email security check</a></p>`;
  return shell(io, { status, path, title: `${name} SPF, DMARC and DKIM check: grade ${d.grade} | ipterm`, desc,
    initial: { ...initial, data: d }, body: staticBlock(`Mail check: ${name}`, ['mail', `grade ${d.grade}`], rows, summary, links) });
}

function gradePage(io, d, status) {
  const name = d.domain, path = '/grade/' + name, initial = { kind: 'grade', query: name };
  if (d.error || !d.grade) {
    const msg = d.error || gradeProblem(d);
    return shell(io, { status, path, title: `${name} report card | ipterm`, initial: { ...initial, ...(d.status ? { data: d } : { error: msg }) },
      body: staticBlock(`Report card: ${name}`, ['grade'], [], msg) });
  }
  const rows = gradeRows(d, false).map(([k, v]) => [k, Array.isArray(v) ? v.join(' · ') : v]);
  const problems = [...d.checks.filter(c => c.status === 'fail'), ...d.checks.filter(c => c.status === 'warn')];
  // The summary is what search engines show for "<domain> security headers" and the like.
  const lead = `${name} gets ${/^[AF]$/.test(d.grade) ? 'an' : 'a'} ${d.grade} on ipterm's domain report card (${gradeTally(d)})`;
  const summary = lead +
    (problems.length ? `. To fix: ${problems.slice(0, 3).map(c => `${c.check}, ${c.text}`).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}.`
      : '. DNSSEC, IPv6, CAA, email security, the registration and the security headers all check out.');
  // The description names what to fix without the reasons: the page gives those.
  const desc = descFit(summary, problems.length && `${lead}. To fix: ${andList([...new Set(problems.map(c => c.check))])}.`, lead + '.');
  const b = badgeLinks(name, io.url.origin);
  const links = `<p class="ln sys">See also: <a href="/dns/${esc(name)}">dig ${esc(name)}</a> · <a href="/mail/${esc(name)}">mail check for ${esc(name)}</a>` +
    ` · <a href="/whois/${esc(name)}">whois ${esc(name)}</a></p><p class="ln sys">How the grade works: <a href="/grade">domain report card</a></p>` +
    // The terminal prints these with copy buttons, so the page's copy goes once it runs (app.js removes .badge-ref).
    `<div class="badge-ref"><p class="ln sys">Badge for a README (shields.io fetches it, so your readers' browsers never contact ipterm):</p>` +
    `<pre class="doc-pre"><code>${esc(b.markdown)}</code></pre>` +
    `<p class="ln sys">Or the same badge served by ipterm itself (each reader's browser fetches it from ipterm):</p><pre class="doc-pre"><code>${esc(b.markdownSvg)}</code></pre></div>`;
  return shell(io, { status, path, title: `${name} security report card: grade ${d.grade} | ipterm`, desc,
    initial: { ...initial, data: d }, body: staticBlock(`Report card: ${name}`, ['grade', `grade ${d.grade}`], rows, summary, links) });
}

// How many of an ASN page's largest prefixes are links to their /cidr pages, [IPv4, IPv6]: ten in all, up to four of
// them IPv6. The sitemap lists 10,000 ASN pages, and a crawler following 30 prefix links on each opened about 155
// public /cidr pages a minute. renderAsn() in public/app.js links the same ones and makes the rest rel="nofollow".
const ASN_LINKS = 10, ASN_LINKS_V6 = 4;
const asnLinked = n6 => { const k6 = Math.min(ASN_LINKS_V6, n6); return [ASN_LINKS - k6, k6]; };

function asnPage(io, d, status) {
  const path = '/' + d.asn;
  if (d.error || !d.found) {
    const msg = d.error || `${d.asn} has no registered holder or announced prefixes in RIPEstat.`;
    return shell(io, { status, path, title: `${d.asn} | ipterm`, initial: { kind: 'asn', query: d.asn, error: msg },
      body: staticBlock(d.asn, ['asn'], [], msg) });
  }
  // A holder name that may be a private person's (GDPR caution): the page works and its links are followed, but
  // search engines are asked not to index it. The same rules keep these networks out of the ASN sitemap.
  const personal = personHeld(d.holder);
  // An indexed page doesn't name an upstream that may be a private person either: it lists it by AS number only,
  // in the HTML and in the data the terminal draws from (search engines run the page's script). The upstream's
  // own page names it, and is noindex; the JSON and text answers keep every name.
  const hide = u => !personal && (personName(u.name) || personHeld(u.name));
  if (d.upstreams && d.upstreams.list && d.upstreams.list.some(hide)) {
    d = { ...d, upstreams: { ...d.upstreams, list: d.upstreams.list.map(u => (hide(u) ? { ...u, name: null } : u)) } };
  }
  const name = d.name || d.holder || d.asn;
  const ups = d.upstreams && d.upstreams.list ? d.upstreams.list : [];
  const upName = u => u.asn + (u.name ? ` (${u.name})` : '');
  const prefixes = (n, v) => `${n.toLocaleString('en-US')} ${v} prefix${n === 1 ? '' : 'es'}`;
  const lead = `${d.asn}${name !== d.asn ? ` (${name})` : ''} is an autonomous system`, reg = d.registry ? ` registered with ${d.registry}` : '';
  const size = `It announces ${prefixes(d.v4.count, 'IPv4')} covering ${d.v4.addresses.toLocaleString('en-US')} addresses and ${prefixes(d.v6.count, 'IPv6')}.`;
  const upsText = ups.length && `Its main upstream network${ups.length > 1 ? 's are' : ' is'} ${andList(ups.slice(0, 3).map(upName))}.`;
  const summary = [`${lead}${reg}.`, size, upsText].filter(Boolean).join(' ');
  // The description names the upstreams by number only, as the shorter way to fit them in.
  const desc = descFit(summary, upsText && `${lead}${reg}. ${size} Main upstreams: ${andList(ups.slice(0, 3).map(u => u.asn))}.`,
    `${lead}${reg}. ${size}`, `${lead}. ${size}`, `${lead}${reg}.`);
  const rows = [
    ['holder', d.holder], ['registry', d.registry], ['announced', d.announced ? 'yes' : 'no'],
    ['IPv4 prefixes', d.v4.count.toLocaleString('en-US')], ['IPv4 addresses', d.v4.addresses.toLocaleString('en-US')],
    ['IPv6 prefixes', d.v6.count.toLocaleString('en-US')], ['upstreams', upstreamText(d.upstreams)],
  ];
  // Prefixes link to the subnet calculator, whose routing section asks RIPEstat only, never IPinfo, and
  // upstreams to their ASN pages (RIPEstat too): crawlers following them land on pages that answer the search (a
  // block, not one address in it) and cost no IPinfo Lite lookups or rate-limit counts. Keep it that way: no IP
  // lookup links here. The budgets themselves are isBot()'s (ipData, privacyData, blockData). Only the largest ten
  // or so are links (asnLinked); the rest are listed as text, still the page's content.
  const [k4, k6] = asnLinked(d.v6.prefixes.length);
  const item = k => (px, i) => `<li>${i < k ? `<a href="/cidr/${esc(px)}">${esc(px)}</a>` : esc(px)}</li>`;
  const list = [...d.v4.prefixes.slice(0, 20).map(item(k4)), ...d.v6.prefixes.slice(0, 10).map(item(k6))].join('');
  const upList = ups.map(u => `<li><a href="/${esc(u.asn)}">${esc(u.asn)}${u.name ? ' ' + esc(u.name) : ''}</a></li>`).join('');
  const links = (upList ? `<p class="ln sys">Main upstream networks (seen just before ${esc(d.asn)} in AS paths):</p><ul class="static-list">${upList}</ul>` : '') +
    (list ? `<p class="ln sys">Largest announced prefixes:</p><ul class="static-list">${list}</ul>` : '') +
    `<p class="ln sys">Registry record: <a href="/whois/${esc(d.asn)}">whois ${esc(d.asn)}</a></p>` +
    `<p class="ln sys">Guide: <a href="/guides/what-is-an-asn">What is an ASN?</a></p>`;
  // "AS13335 Cloudflare, Inc.: ASN, IP ranges and upstreams", as asn() in public/app.js titles it
  const title = `${d.asn}${name !== d.asn ? ' ' + name : ''}: ASN, IP ranges and upstreams | ipterm`;
  return shell(io, { status, path, title, desc, noindex: personal,
    initial: { kind: 'asn', query: d.asn, data: d }, body: staticBlock(`${d.asn} · ${name}`, ['asn'], rows, summary, links) });
}

const andList = a => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

// rows: [key, value]. A value is made a string and escaped, whatever its shape (upstream JSON can hold anything), unless
// it is Markup.
function staticBlock(heading, tags, rows, summary, extra = '') {
  const tagHtml = tags.map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
  const dl = rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v instanceof Markup ? v.html : esc(v)}</dd>`).join('');
  return `<article class="static" id="static"><div class="head"><span class="hip">${esc(heading)}</span> ${tagHtml}</div>` +
    (dl ? `<dl class="kv">${dl}</dl>` : '') + `<p class="ln">${esc(summary)}</p>${extra}</article>`;
}
// Markup this file wrote and escaped itself (the links in a port page's IANA row), which staticBlock prints as it is.
// Nothing outside the module can make one, so no value from upstream, { html } or not, is ever taken for markup.
class Markup { constructor(html) { this.html = String(html); } }

/* ---------- robots and sitemap ---------- */

const SITEMAP_PATHS = [
  // pages, tools and guides
  '/', '/whois', '/dns', '/mail', '/cidr', '/leaktest', '/api', '/guides', '/guides/find-router-ip', '/guides/private-ip-ranges', '/guides/what-your-ip-reveals',
  '/guides/ipv4-vs-ipv6', '/guides/what-is-an-asn', '/privacy',
  // the port checker's pages have a file of their own: /sitemap-ports.xml (portPaths)
  // router and other private addresses people search for. These are the only non-public addresses whose pages
  // are indexed (curatedIps()), and typos of them redirect here (routerTypo()).
  '/192.168.1.1', '/192.168.0.1', '/10.0.0.1', '/192.168.1.254', '/192.168.100.1', '/192.168.2.1', '/192.168.0.254',
  '/192.168.10.1', '/192.168.8.1', '/10.0.0.138', '/10.1.1.1', '/10.0.1.1', '/172.16.0.1', '/127.0.0.1', '/169.254.1.1',
  // public DNS resolvers
  '/8.8.8.8', '/8.8.4.4', '/1.1.1.1', '/1.0.0.1', '/9.9.9.9', '/149.112.112.112', '/208.67.222.222', '/208.67.220.220',
  '/94.140.14.14', '/2001:4860:4860::8888', '/2001:4860:4860::8844', '/2606:4700:4700::1111', '/2620:fe::fe',
  // networks (ASNs) have their own sitemap files: /sitemap-asn-<n>.xml, from src/asn-sitemap.js
  // subnet calculator, and routing for the resolvers' prefixes
  '/guides/subnet-cheat-sheet', '/cidr/192.168.1.0/24', '/cidr/192.168.0.0/24', '/cidr/192.168.0.0/16', '/cidr/10.0.0.0/8', '/cidr/10.0.0.0/24',
  '/cidr/172.16.0.0/12', '/cidr/100.64.0.0/10', '/cidr/10.0.0.0/22', '/cidr/192.168.1.0/25', '/cidr/192.168.1.0/30', '/cidr/2001:db8::/32', '/cidr/2001:db8::/48',
  '/cidr/1.1.1.0/24', '/cidr/8.8.8.0/24', '/cidr/9.9.9.0/24',
  // DNS pages
  '/dns/google.com', '/dns/cloudflare.com', '/dns/github.com', '/dns/wikipedia.org', '/dns/example.com', '/dns/gmail.com/MX',
  // mail checks (SPF, DMARC, DKIM)
  '/mail/gmail.com', '/mail/outlook.com', '/mail/github.com',
  // domain report cards
  '/grade', '/grade/github.com', '/grade/cloudflare.com', '/grade/wikipedia.org', '/grade/example.com',
  // registry (whois) pages
  '/whois/google.com', '/whois/github.com', '/whois/cloudflare.com', '/whois/wikipedia.org', '/whois/example.com',
  '/whois/8.8.8.8', '/whois/1.1.1.1', '/whois/9.9.9.9', '/whois/208.67.222.222', '/whois/AS15169', '/whois/AS13335', '/whois/AS16509', '/whois/AS8075',
];

// The port checker and each port's page in public/ports.js, for /sitemap-ports.xml. The pages never run a check and
// draw only on ports.js, so crawling them asks no one anything.
const portPaths = () => ['/port', ...PORTS.list().map(n => '/port/' + n)];

function robots(url) {
  return text(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /go\nDisallow: /badge/\n\nSitemap: ${url.origin}/sitemap.xml\n`, 'public, max-age=86400');
}

// The ASN sitemap in tiers by size, so Search Console shows how each tier is indexed: the 1,000 largest
// networks, then the rest of the top 10,000, then files of 40,000 should the list grow (a sitemap file may
// hold 50,000 URLs and 50 MB; 40,000 ASN URLs are about 1.8 MB).
const ASN_TIERS = [1000, 10000], ASN_FILE_MAX = 40000;
let asnFiles = null;
function asnSitemapFiles() {
  if (asnFiles) return asnFiles;
  asnFiles = [];
  for (let start = 0, t = 0; start < ASN_SITEMAP.length; t++) {
    const end = Math.min(ASN_SITEMAP.length, t < ASN_TIERS.length ? ASN_TIERS[t] : start + ASN_FILE_MAX);
    asnFiles.push(ASN_SITEMAP.slice(start, end));
    start = end;
  }
  return asnFiles;
}

const XML = { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' };
// /sitemap.xml: the index of the sitemap files. A copy run by someone else (SELF_HOSTED) lists nothing.
function sitemapIndex(url, env) {
  if (selfHosted(env)) return sitemap(url, env, []);
  const files = [['/sitemap-pages.xml', null], ['/sitemap-ports.xml', PORTS.updated],
    ...asnSitemapFiles().map((_, i) => [`/sitemap-asn-${i + 1}.xml`, ASN_SITEMAP_DATE])];
  const items = files.map(([p, mod]) => `  <sitemap><loc>${esc(url.origin + p)}</loc>${mod ? `<lastmod>${esc(mod)}</lastmod>` : ''}</sitemap>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`, { headers: XML });
}

// A file of 9,000 URLs takes about 7 ms of CPU to build, so each isolate keeps what it built (a few files at most).
// lastmod: the day these pages' content last changed (PORTS.updated for the port pages), given on each URL. The other
// files have none: their pages change with live data, and a date that is always new is one search engines ignore.
const sitemapMemo = new Map();
function sitemap(url, env, paths, lastmod = null) {
  const key = url.origin + url.pathname + (selfHosted(env) ? ' copy' : '');
  if (!sitemapMemo.has(key)) {
    const origin = esc(url.origin), mod = lastmod ? `<lastmod>${esc(lastmod)}</lastmod>` : '';
    const items = (selfHosted(env) ? [] : paths).map(p => `  <url><loc>${origin}${esc(encodePath(p))}</loc>${mod}</url>`).join('\n');
    if (sitemapMemo.size > 20) sitemapMemo.clear();
    sitemapMemo.set(key, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`);
  }
  return new Response(sitemapMemo.get(key), { headers: XML });
}

/* ---------- owner status ----------
   /status shows ipterm's own upstream spend: today's and this hour's IPinfo Core and proxycheck.io
   lookups against their limits, from the LookupBudget counters. Counts only, nothing about visitors.
   It needs the STATUS_KEY secret (16+ characters) in an x-status-key header or ?key=. Without it the
   path is a 404 like any unknown one, so scrapers get no gauge of when the budgets run out. It is
   never linked and not in the sitemap. */
async function statusKeyOk(request, url, env) {
  const want = String(env.STATUS_KEY || '');
  if (want.length < 16) return false;                    // unset, or too short to be a real secret
  const got = request.headers.get('x-status-key') || url.searchParams.get('key') || '';
  const hash = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));   // same length, so it can be compared
  const [a, b] = await Promise.all([hash(got), hash(want)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function statusRoute(io) {
  const env = io.env, d = new Date();
  const at = (h, plusDays = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays, h)).toISOString();
  const budget = async (name, lim, off) => {
    const b = { on: !off, off: off || undefined, usedToday: null, dailyLimit: lim.daily, usedThisHour: null,
      hourlyLimit: lim.hourly, perVisitorHourly: lim.perVisitor, hoursRunOutToday: [], dayRanOutAt: null, pastDays: [] };
    if (!env.BUDGET) return { ...b, error: 'no BUDGET binding, so nothing is counted' };
    try {
      const s = await env.BUDGET.get(env.BUDGET.idFromName(name)).status();
      return { ...b, usedToday: s.used, usedThisHour: s.usedHour, hoursRunOutToday: s.hoursRunOut, dayRanOutAt: s.ranOutAt, pastDays: s.past };
    } catch (e) {
      return { ...b, error: 'counter unreachable: ' + String((e && e.message) || e) };
    }
  };
  const plan = String(env.IPINFO_PLAN || '').toLowerCase(), core = coreLimits(env), pc = pcLimits(env);
  const coreOff = !env.IPINFO_TOKEN ? 'no IPINFO_TOKEN secret' : plan !== 'core' ? `IPINFO_PLAN is "${plan}", not "core"`
    : core.daily === 0 ? 'IPINFO_DAILY_BUDGET is 0' : null;
  const pcOff = !env.PROXYCHECK_KEY ? 'no PROXYCHECK_KEY secret' : pc.daily === 0 ? 'PROXYCHECK_DAILY_BUDGET is 0' : null;
  // The VPN providers' server lists (VpnServers): each one's addresses kept, last good download and last try.
  const vpnLists = async () => {
    const ns = env.VPN_SERVERS;
    if (!ns) return { error: 'no VPN_SERVERS binding, so no lists are kept' };
    try {
      const m = await ns.get(ns.idFromName('lists')).status();
      return { providers: VPN_PROVIDERS.map(p => {
        const x = m[p.id] || {};
        return { id: p.id, name: p.name, addresses: (x.n4 || 0) + (x.n6 || 0), ipv4: x.n4 || 0, ipv6: x.n6 || 0, latestList: x.listed || 0,
          updated: x.at || null, tried: x.tried || null, error: x.error || null, stale: !!(x.at && d.getTime() - Date.parse(x.at) > VPN_MAX_AGE) };
      }) };
    } catch (e) {
      return { error: 'lists unreachable: ' + String((e && e.message) || e) };
    }
  };
  // Apple's iCloud Private Relay list: ranges kept (merged), its last good download or 304, last try.
  const relayList = async () => {
    const ns = env.VPN_SERVERS;
    if (!ns) return { error: 'no VPN_SERVERS binding, so no list is kept' };
    try {
      const x = await ns.get(ns.idFromName('lists')).relayStatus();
      return { ranges: x.count || 0, ipv4: x.n4 || 0, ipv6: x.n6 || 0, updated: x.at || null, unchanged: !!x.unchanged, tried: x.tried || null,
        error: x.error || null, stale: !!(x.at && d.getTime() - Date.parse(x.at) > VPN_MAX_AGE) };
    } catch (e) {
      return { error: 'list unreachable: ' + String((e && e.message) || e) };
    }
  };
  const [ipinfoCore, proxycheck, vpnServers, privateRelay] = await Promise.all([budget('ipinfo-core', core, coreOff), budget('proxycheck', pc, pcOff), vpnLists(), relayList()]);
  return reply(io, {
    time: d.toISOString(), ipinfoCore, proxycheck, vpnServers, privateRelay, resets: { hour: at(d.getUTCHours() + 1), day: at(0, 1) },
    note: "Counts of ipterm's own upstream lookups (limit 0 = none; hours are UTC). Nothing about visitors.",
  }, 200, { 'x-robots-tag': 'noindex, nofollow' }, statusText);
}

function statusText(d, o) {
  const hhmm = iso => iso.slice(11, 16);
  const of = (used, limit) => `${used ?? '?'} ` + (limit ? `of ${limit}` : '(no limit)');
  const runOut = (hours, at) => [hours.length ? 'hours run out ' + hours.map(h => h + ':00').join(' ') : '',
    at ? 'day ran out ' + hhmm(at) : ''].filter(Boolean).join(', ');
  const part = (name, b) => [
    [name, b.on ? 'on' : `off (${b.off})`],
    ['  today', `${of(b.usedToday, b.dailyLimit)}, resets 00:00 UTC`],
    ['  this hour', `${of(b.usedThisHour, b.hourlyLimit)}, resets ${hhmm(d.resets.hour)} UTC`],
    ['  per visitor', b.perVisitorHourly ? `${b.perVisitorHourly} an hour` : 'no cap'],
    ['  ran out today', runOut(b.hoursRunOutToday, b.dayRanOutAt) || 'no'],
    ['  past days', b.pastDays.map(p => [p.day, String(p.used).padStart(6), runOut(p.hoursRunOut, p.ranOutAt)].join('  ').trimEnd())],
    ['  error', b.error],
  ];
  const v = d.vpnServers || {}, when = iso => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : 'never');
  const lists = [['vpn server lists', v.error || 'refreshed every 6 hours'],
    ...(v.providers || []).map(p => ['  ' + p.id, `${p.addresses} addresses (${p.latestList} on the latest list), updated ${when(p.updated)}` +
      (p.stale ? ' (too old: none used)' : '') + (p.error ? `; last try ${when(p.tried)} failed: ${p.error}` : '')])];
  const r = d.privateRelay || {};
  const relay = [['icloud relay', r.error && r.ranges == null ? r.error : `${r.ranges} ranges (${r.ipv4} IPv4 and ${r.ipv6} IPv6 merged), updated ${when(r.updated)}` +
    (r.stale ? ' (too old: not used)' : '') + (r.error ? `; last try ${when(r.tried)} failed: ${r.error}` : '')]];
  return kvText([['time', d.time.slice(0, 16).replace('T', ' ') + ' UTC'], ...part('ipinfo core', d.ipinfoCore), ...part('proxycheck.io', d.proxycheck), ...lists, ...relay],
    ["Counts of ipterm's own upstream lookups (hours are UTC). Nothing about visitors."], o);
}

/* ---------- the deployed build, and copies run by others ----------
   `npm run deploy` (tools/deploy.mjs) deploys with the git short SHA as the version's tag, and the
   CF_VERSION_METADATA binding (wrangler.toml) reads it back, so the footer, `about` and /help can name
   the code that is running. SOURCE_URL (wrangler.toml) turns the SHA into a link to that commit.
   SELF_HOSTED = "true" marks a copy run by someone else: every page is noindex, the sitemap is empty,
   no sponsored line is shown (app.js reads data-copy from the footer) and the footer says it's a copy. */
const selfHosted = env => String((env && env.SELF_HOSTED) || '').toLowerCase() === 'true';
function buildOf(env) {
  const tag = env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.tag;
  const sha = typeof tag === 'string' && /^[0-9a-f]{7,40}(-dirty)?$/.test(tag) ? tag : null;
  const src = env && /^https:\/\/[^\s"'<>]+$/.test(String(env.SOURCE_URL || '')) ? String(env.SOURCE_URL).replace(/\/+$/, '') : null;
  return { sha, url: src && sha ? `${src}/commit/${sha.replace(/-dirty$/, '')}` : src };
}
// Footer spans for the shell's <!--BUILD-->. app.js reads data-build, data-source and data-copy for `about`.
function footBuild(env) {
  const b = buildOf(env), out = [];
  if (b.sha || b.url) {
    const label = esc(b.sha || 'source code');
    out.push(`<span class="foot-build" data-build="${esc(b.sha || '')}" data-source="${esc(b.url || '')}">${b.sha ? 'the code we deploy: ' : ''}` +
      (b.url ? `<a href="${esc(b.url)}" rel="noopener">${label}</a>` : label) + '</span>');
  }
  if (selfHosted(env)) out.push('<span class="foot-copy" data-copy>a copy of ipterm run by someone else, not ipterm.net</span>');
  return out.join('');
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
  "form-action 'self'",                                                  // the search form on /api goes to /go
  "frame-ancestors 'none'",
].join('; ');

// The DNS leak test's lookups are fetches to https://<token>.<zone>, which fail at once (the zone's server
// answers NXDOMAIN), so the zone is the one other host the page may contact, and only once it's set up.
function cspFor(env) {
  const dns = dnsleakConf(env);
  return dns ? CSP.replace("connect-src 'self'", `connect-src 'self' https://*.${dns.zone}`) : CSP;
}

function secure(res, env) {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('content-security-policy', cspFor(env));
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  h.set('cross-origin-opener-policy', 'same-origin');
  // Badges (/badge/<domain>.svg) say cross-origin themselves, so other sites can show them.
  h.set('cross-origin-resource-policy', publicApi(env) || h.get('cross-origin-resource-policy') === 'cross-origin' ? 'cross-origin' : 'same-origin');
  h.set('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), browsing-topics=()');
  if (selfHosted(env) && !h.has('x-robots-tag')) h.set('x-robots-tag', 'noindex');   // a copy shouldn't compete with ipterm.net in search
  if (publicApi(env)) {
    // Never add access-control-allow-headers (least of all "*"): the port check's X-Ipterm guard relies
    // on cross-site pages being unable to send a custom header (sameOrigin()).
    h.set('access-control-allow-origin', '*');
    h.set('access-control-allow-methods', 'GET, OPTIONS');
  } else {
    h.delete('access-control-allow-origin');
    h.delete('access-control-allow-methods');
  }
  return out;
}

// Why an address isn't public, in the words of the special-purpose table in public/cidr.js (the subnet calculator and
// the terminal use the same one), or null for a public address.
function nonPublicReason(p) {
  const [kind, note] = CIDR.special(p);
  return kind === 'public' ? null : note;
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

// JSON.stringify escapes only U+0000-001F, and curl prints JSON straight to a terminal, so the rest of what plain()
// catches (DEL, the C1 controls some terminals act on, bidi marks) is written as \u escapes too: the same data
// for any parser. They can only occur inside strings, where an escape is always valid.
const termSafe = s => s.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function json(data, status = 200, extra = {}) {
  return new Response(termSafe(JSON.stringify(data, null, 2)) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept, User-Agent', ...extra },
  });
}

function text(s, cache = 'no-store', status = 200, extra = {}) {
  return new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache, ...extra } });
}

// Same-site redirects. Some answers differ for browsers and curl (/help), hence the Vary. Permanent ones (301)
// may be kept for a day.
function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location, 'cache-control': `public, max-age=${status === 301 ? 86400 : 3600}`, vary: 'Accept, User-Agent' } });
}
