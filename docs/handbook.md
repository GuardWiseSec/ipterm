# ipterm handbook

How ipterm works, and how to run your own copy: deploying, settings and keys, every route and check, the security
measures and the limits. For what ipterm is and how to use it, see the [README](../README.md).

ipterm is a terminal-style IP lookup site that runs on a single Cloudflare Worker. Where things are:

- The page: `public/index.html`, `public/app.css`, `public/app.js` (no build step)
- Map data: `public/land.js` (simplified land outlines and country sizes from
  [Natural Earth](https://www.naturalearthdata.com/), public domain, via world-atlas)
- Fonts: `public/fonts/` (self-hosted, SIL Open Font License, licenses included)
- The API, routing and security headers: `src/worker.js`
- The `curl ipterm.net/me` card: `src/me.js`, with its world map in `src/landmask.js` (generated, see "The map")
- The ASN sitemap's list of networks: `src/asn-sitemap.js` (generated, see "Shareable pages and search")
- Whether a network's holder may be a private person (the sitemap leaves it out, and its ASN, whois and `/cidr`
  pages are noindex): `src/holder-heuristic.js`
- Settings: `wrangler.toml`
- Scripts: `tools/` (deploy, land mask, guides, ASN sitemap, link-preview and SEO checks)
- The DNS leak test's own DNS server: `dnsleak-server/` (runs on a small VPS outside Cloudflare; see
  [dnsleak-server/README.md](../dnsleak-server/README.md))

Open source under the MIT license (`LICENSE`); the fonts and map data keep their own licenses (see "License").

## Deploy

You need Node 18+ and a free Cloudflare account.

```sh
npm install
npx wrangler login
npm run deploy
```

Wrangler prints your URL, something like `https://ipterm.<you>.workers.dev`.
To use your own domain, add it under the Worker's **Settings → Domains & Routes**
in the Cloudflare dashboard.

**Which code is running.** `npm run deploy` runs `tools/deploy.mjs`, which calls `wrangler deploy --tag <git short SHA>`
(plain Node, no shell substitution, so it works the same in PowerShell, cmd and sh). The Worker reads the tag back
through the `CF_VERSION_METADATA` binding (`[version_metadata]` in `wrangler.toml`) and shows it as "the code we deploy:
3b77978" in the page footer, at the end of `about` and in `/help`. Set `SOURCE_URL` in `wrangler.toml` to the
repository's address and the SHA links to that commit (`<SOURCE_URL>/commit/<sha>`), so anyone can read the exact
code behind the site.

- It refuses to deploy while `src/`, `public/`, `wrangler.toml` or `package.json` differ from the commit (untracked
  files there count too), since the SHA would then be wrong. `npm run deploy -- --dirty` deploys anyway, tagged
  `<sha>-dirty`.
- It warns when the commit isn't on any remote branch yet: the footer's link only works once it's pushed.
- Anything after `--` goes to `wrangler deploy` (`npm run deploy -- --dry-run`). The version message is the commit's
  subject line unless you pass `--message`.
- A plain `npx wrangler deploy` still works; the version just has no tag, so no SHA is shown.

### Recommended: add a free IPinfo token

1. Sign up at https://ipinfo.io (the free Lite plan needs no credit card).
2. Copy your token and run:

```sh
npx wrangler secret put IPINFO_TOKEN
```

With a token, lookups of other IPs use IPinfo Lite: unlimited requests, country and ASN.
Without one, the Worker falls back to IPinfo's public endpoint, which has city-level data
but is limited to about 1,000 requests a day and that limit is shared, so expect errors under load.

**Attribution.** IPinfo's free data (Lite and the public endpoint, CC BY-SA 4.0) has one condition: credit
IPinfo with a link wherever the data is shown. Every page the Worker renders (home, `/<ip>`, `/AS<n>`,
`/dns/...`, `/whois/...`, the tool pages and 404s) shares the footer in `public/index.html`, which ends with
`IP address data powered by IPinfo`, linked to https://ipinfo.io: IPinfo's own suggested wording. The footer
stays on screen under the terminal, so it covers terminal results too. Text answers, `/help`, `/api`, the
OpenAPI file and `llms.txt` carry the same line, and one-value answers carry it in an `x-attribution` header
(see "The command line (curl-first)" below). Keep the credit on Core too: lookups fall back to Lite
whenever the Core budget runs out, and one-value answers and the DNS "hosted by" row always use Lite.

### City-level lookups: IPinfo Core (paid)

IPinfo Core adds city, region, coordinates, time zone and a connection type (mobile network,
hosting or data center, anycast) to lookups of other IPs, and the map zooms to the city. Each
public lookup also gets a **vpn / proxy** row: "yes" when Core flags the address as VPN/proxy/Tor;
otherwise "not on known lists", with a note that hosting networks are where VPN servers usually
live, or that a clean result is not a guarantee (new VPN servers are often unlisted). Lookups
answered without Core (and without proxycheck.io, below) say "not checked". To switch:

1. Upgrade your IPinfo account to Core. The token stays the same, so there is no need to run
   `wrangler secret put` again.
2. In `wrangler.toml`, set `IPINFO_PLAN = "core"` and deploy.

**Daily budget.** So one scraper can't use up the month, Core is used for at most
`IPINFO_DAILY_BUDGET` fresh lookups a day (default 4,500, about 140,000 a month, inside Core's
150,000). After that, lookups use IPinfo Lite (country and network) until midnight UTC, and a line
is logged: `IPinfo Core daily budget used`.

**Hourly pacing.** Within the day, Core is also limited to `IPINFO_HOURLY_BUDGET` fresh lookups an
hour (default 375, about twice an even share of the daily budget). A burst, for example a scraper
rotating through VPN or proxy addresses, then only uses up the current hour: lookups fall back to
Lite and city-level results return at the start of the next hour (logged as `IPinfo Core hourly
budget used`). Set it to `"0"` to turn pacing off.

**Per-visitor share.** Each visitor (IP, or IPv6 /56, since many homes get a whole /56) gets at most `IPINFO_VISITOR_HOURLY` fresh
Core lookups an hour (default 30); past that they get Lite, while everyone else keeps Core. The
counter keeps only a salted hash of the address, in memory, with a salt that changes hourly.

All budget settings accept whole numbers only; anything else uses the default.
`IPINFO_DAILY_BUDGET = "0"` turns Core off. If Core errors or times out, lookups use Lite and Core
is paused for a minute; if Core refuses the token or quota, it's paused for ten. The count is kept by a small Durable Object
(`LookupBudget`, binding `BUDGET` in `wrangler.toml`), which is included in the free Workers plan;
`wrangler deploy` sets it up automatically the first time. If you move to a bigger IPinfo plan,
raise the number to about your monthly allowance divided by 31.

Only fresh lookups count: lookups of other addresses, and `leaktest`'s check of the visitor's own address. Cached results (six hours), `whoami` (your visitors'
own location comes from Cloudflare), DNS, mail checks, whois, the subnet calculator and the command line's one-value
endpoints (`/asn`, `/8.8.8.8/org` and the rest, which use IPinfo Lite) never use the quota. If
the monthly quota runs out anyway, or the token is refused, or the counter can't be reached,
lookups fall back to IPinfo Lite rather than failing.

### VPN / proxy second opinion: proxycheck.io (optional, free)

IPinfo's flag misses some VPN servers, especially newer ones. With a free
[proxycheck.io](https://proxycheck.io/) key (1,000 queries a day), lookups and `leaktest` also ask
proxycheck.io, which often names the service too ("yes: a known VPN address (Proton VPN)"):

```
npx wrangler secret put PROXYCHECK_KEY
```

- **When it's asked:** every `leaktest` (your own address), and lookups of other addresses that
  IPinfo hasn't already flagged. Not for whoami, DNS, whois, the "hosted by" lines or the one-value
  endpoints (`/8.8.8.8/org`).
- **Budget:** `PROXYCHECK_DAILY_BUDGET` (default 900) queries a day, paced to
  `PROXYCHECK_HOURLY_BUDGET` an hour (default twice an even share, 75) and
  `PROXYCHECK_VISITOR_HOURLY` per visitor (default 10), counted by the same `LookupBudget` Durable
  Object as Core under its own name. `"0"` turns proxycheck.io off.
- **Caching:** clean answers for an hour, flagged ones for 15 minutes (proxycheck.io's guidance).
- **Failures:** a refused key or used-up allowance pauses proxycheck.io for 10 minutes, a timeout
  or server error for one; results then come from IPinfo alone. An odd answer about one address
  just skips that address, so no single lookup can pause the check for everyone. Private and
  reserved addresses are never sent. Nothing breaks.
- **Rate limit:** a proxycheck.io query also uses one of the visitor's 30-per-minute requests, so
  repeating a lookup whose IPinfo answer is cached can't hammer the budget counter.
- **Privacy and terms:** queries are sent with `tag=0` so they aren't kept in the account's log.
  The page and the JSON API show only a few fields (VPN / proxy / Tor / hosting, the service's
  name, a risk score), as proxycheck.io's terms require, never the full response.

The verdict on the **vpn / proxy** line combines both sources (`vpnText()` in `src/worker.js` and
`public/app.js`, kept in step):

| What the sources say | The line says |
| --- | --- |
| Core flags it, or proxycheck.io finds a VPN, proxy or Tor exit, or names the service | `yes: a known VPN address (Proton VPN)` (or proxy, Tor, or "VPN, proxy or Tor" when it isn't specific) |
| proxycheck.io's `anonymous` flag alone, with no VPN, proxy, Tor or service name | `flagged as anonymizing by proxycheck.io, but not as a known VPN, proxy or Tor service` |
| proxycheck.io's `compromised` flag alone (seen performing attacks) | `flagged by proxycheck.io as compromised (seen performing attacks), but not as a known VPN, proxy or Tor service` |
| Neither flags it | `not on known VPN or proxy lists`, plus the hosting-network note or the "not a guarantee" note |

proxycheck.io's API reference defines `anonymous` as "any kind of anonymising service (proxy, VPN,
TOR, etc.)", and it's also set on addresses that are none of those: Google Public DNS (8.8.8.8) has
it, with only `hosting` besides. So on its own it isn't reported as a VPN, here or in `leaktest`.

### Budget status for the owner: /status (optional)

`/status` shows how much of the IPinfo Core and proxycheck.io budgets ipterm has used today and this hour,
read from the same `LookupBudget` counters, plus each past day's total (kept for 35 days). It counts
ipterm's own upstream lookups and nothing else: no visitor data, no addresses. To turn it on, make a random
key of at least 16 characters and store it as a secret:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npx wrangler secret put STATUS_KEY
```

Then send the key in a header. A key in the query string can end up in browser history, so the header is
the better habit:

```sh
curl -H "x-status-key: <your key>" https://ipterm.net/status
curl -H "x-status-key: <your key>" "https://ipterm.net/status?format=text"
```

`?key=<your key>` works too, for a quick look in a browser. Without the right key (and while no key of 16+
characters is set), `/status` is an ordinary 404, the same answer as any unknown address, so scrapers can't
watch the budgets run down. It isn't linked anywhere or listed in the sitemap, and the keyed answer is sent
`no-store` with `X-Robots-Tag: noindex, nofollow`. Each look costs one Worker request and two Durable
Object requests; it never touches IPinfo or proxycheck.io.

| Field (per service) | Meaning |
| --- | --- |
| `on`, `off` | Whether the service is in use, and if not, why (no secret, plan not Core, budget `"0"`) |
| `usedToday`, `dailyLimit` | Fresh lookups since 00:00 UTC, and the daily budget |
| `usedThisHour`, `hourlyLimit` | The same for the current UTC hour (limit `0` = no hourly pacing) |
| `perVisitorHourly` | Each visitor's hourly share (`0` = no cap) |
| `hoursRunOutToday` | UTC hours (`"14"`) whose hourly budget filled. After that, lookups used IPinfo Lite (or skipped proxycheck.io) until the hour ended |
| `dayRanOutAt` | When the daily budget filled, if it did. After that, the fallback lasted until midnight UTC |
| `pastDays` | The same per finished day, newest first: `used`, `hoursRunOut`, `ranOutAt`. A day with no lookups has no entry |

Not counted: lookups that fell back because one visitor used up their own hourly share, or because Core
errored or refused the token (those are logged; watch with `npx wrangler tail`).

## How the data works

| What | Source | Cost |
| --- | --- | --- |
| Visitor's own IP, city, ASN, timezone, edge location | Cloudflare `request.cf` | Free, unlimited |
| Visitor's other IP version (IPv6 for an IPv4 visit, or the reverse) | [ipify](https://www.ipify.org/) `api.ipify.org` / `api6.ipify.org`, called from the browser | Free, open source, no logging |
| Other IPs: owner and country | IPinfo Lite | Free, unlimited |
| Other IPs: city, coordinates, time zone, connection type (optional) | IPinfo Core, with `IPINFO_PLAN = "core"` | Paid, monthly quota; falls back to Lite |
| VPN / proxy / Tor second opinion, VPN service name (optional) | proxycheck.io, with the `PROXYCHECK_KEY` secret | Free, 1,000 a day; falls back to IPinfo alone |
| Reverse DNS (hostname) | Cloudflare DNS-over-HTTPS | Free |
| Mail checks: MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT, BIMI | Cloudflare DNS-over-HTTPS, plus the domain's own MTA-STS policy file | Free |
| Networks (ASNs): holder, prefixes, main upstreams | RIPEstat (`as-overview`, `announced-prefixes`, `asn-neighbours`) | Free, no key |
| Routing of a prefix: route, origin, RPKI, visibility, AS paths | RIPEstat (`prefix-overview`, `routing-status`, `rpki-validation`, `bgp-state`) | Free, no key |
| The ASN sitemap's ranking (offline, `tools/build_asn_sitemap.mjs`) | RIPE NCC RIS table dump and AS names list (or CAIDA's prefix-to-AS file) | Free, run by hand |
| Which DNS resolvers a visitor uses (leaktest) | ipterm's own DNS server for `dl.ipterm.net` (`dnsleak-server/`), plus IPinfo Lite for the resolvers' networks | The VPS, about $4 to $6 a month |
| Whether the visitor's address is a Tor exit (leaktest) | The Tor Project's exit list, cached an hour per data center | Free; at most one subrequest an hour per data center |
| Cloudflare WARP, TLS and HTTP versions, key exchange (leaktest) | Cloudflare's `/cdn-cgi/trace`, read by the browser | Free; the edge answers it, not the Worker |

Lookups of other IPs are cached at the edge for six hours.

## Self-hosting

ipterm is MIT-licensed, so you can run your own copy. Follow "Deploy" above, then:

1. In `wrangler.toml`, set `SELF_HOSTED = "true"`. Every page then carries `noindex` (an `X-Robots-Tag` header on
   everything the Worker answers, and a robots meta tag in the pages), `/sitemap.xml` and the other sitemap files are empty, `public/sponsors.json`
   is ignored so no sponsored line appears, and the footer, `about` and `/help` say the site is a copy of ipterm,
   not ipterm.net. Copies shouldn't compete with ipterm.net in search or carry its affiliate links.
2. Set `SOURCE_URL` to your fork (or leave it empty), so the footer links the code you actually run.
3. Change the two `namespace_id`s under `[[ratelimits]]` if your account already uses 1001 or 1002.
   `DNSLEAK_ZONE` and `DNSLEAK_API` point at ipterm.net's own leak-test server: the test stays off without the
   `DNSLEAK_KEY` secret, but change them to your own (`dnsleak-server/README.md`) or delete both lines.
4. Edit what names ipterm.net: the contact address in `public/privacy.html` (and anything in the policy your copy
   does differently) and the URLs in `public/openapi.json`, `public/llms.txt` and `public/opensearch.xml` (otherwise
   browsers that add your copy as a search engine search ipterm.net). Canonical and share links, the search form on
   `/api` and the terminal's copy of it use your own address automatically.
5. Optional: `npx wrangler secret put IPINFO_TOKEN` (and `PROXYCHECK_KEY`, `STATUS_KEY`), as described above. Your
   copy uses your own IPinfo and proxycheck.io allowances, and keeps IPinfo's attribution in the footer.

Everything else (the budgets, the rate limits, the CSP) works the same. `workers_dev = false` means the copy only
answers on a custom domain; set it to `true` to try it on `*.workers.dev` first.

### The map

Each result with a location gets a dot-matrix map drawn on a canvas, with no map service involved.
It marks the reported point and draws a ring for the uncertainty:

- City-level results (your own IP, or other IPs without a token) get a 50 km "approximate area" ring.
  IP location usually points at the ISP's hub, so treat the ring as a hint, not a boundary.
- Country-level results (IPinfo Lite) get a ring sized to the country, centered on its main landmass.

Change the 50 km default with `CITY_KM` near the top of the map section in `public/app.js`.

**The command-line map** (`curl ipterm.net/me`) is drawn with Braille characters from `src/landmask.js`: a 1-degree
land grid (360 × 180 bits, base64) made from the same `public/land.js` outlines. There's no build step, so the
generated file is checked in. After changing `public/land.js`, regenerate it and commit both:

```sh
npm run landmask        # or: node tools/build_landmask.mjs
```

The generator unwraps outlines that cross the 180° meridian before filling them (even-odd, like the page): Eurasia's
outline jumps from 180° to -180° and back, and filled as it is that flips land and sea between 65°N and 69°N.

Private, loopback, CGNAT and documentation ranges are detected in the browser and never hit the API.

## Routes

Every IP and network has its own address. Browsers get a full page; curl and scripts get JSON.

```sh
curl https://your-domain              # your IP as plain text
curl https://your-domain/me           # your IP, network and place as a card with a world map
curl https://your-domain/json         # your details as JSON
curl https://your-domain/8.8.8.8      # any IP as JSON
curl https://your-domain/AS13335      # any network (ASN) as JSON, with its main upstreams
curl https://your-domain/route/1.1.1.0/24  # how a prefix (or an address) is routed: origin, RPKI, AS paths
curl https://your-domain/mail/gmail.com  # a domain's email security (SPF, DMARC, DKIM), graded
curl -4 https://your-domain/port/22   # is TCP port 22 open on your own IP? (see "Port checker")
curl https://your-domain/help         # the command-line reference as plain text
curl -L 'https://your-domain/go?q=AS13335'  # address-bar search: a redirect to that page (see "Address-bar search")
```

Add `?format=json` to force JSON from a browser.

### The command line (curl-first)

`curl ipterm.net/help` prints the whole reference as plain text. `/api` is the same reference as a web page
for browsers (a landing page like `/whois`, with the terminal running `api`), and command-line clients that ask
for `/api` get the plain text too. Browsers that open `/help` are sent to `/api`.

**One value for your own address**, plain text with a trailing newline, straight from Cloudflare's
`request.cf`, so they make no outside call and don't count toward the rate limit:

| Path | Value |
| --- | --- |
| `/asn` | your network's AS number (`AS13335`) |
| `/org` | your network's name |
| `/cc` | your country code, ISO 3166-1 (Cloudflare uses `T1` for Tor). Not `/country`: that path is kept free for country pages |
| `/city` | your city |
| `/tz` | your time zone (`Europe/Berlin`) |
| `/colo` | the Cloudflare data center that answered |
| `/hostname` | your reverse DNS name: the only one that asks anybody (Cloudflare's resolver), so it is rate limited |

**One value for any public address:** `/<ip>/<field>` with `asn`, `org`, `cc`, `country` (the name),
`continent` or `hostname`, e.g. `curl ipterm.net/8.8.8.8/country`. These always use IPinfo Lite
(`ipData(..., { lite: true })`, without `withPrivacy()`), so they never spend the IPinfo Core budget or
proxycheck.io's allowance, however hard a script hits them. `city` and `tz` for other addresses answer
with a short explanation, since Lite has country and network only. Private addresses get HTTP 400.

A missing value is an empty line with HTTP 404, so `curl -fs ipterm.net/city` exits non-zero and
`$(curl -s ...)` is empty.

**Your own address as a card, a line or a check.** Also from `request.cf` only: no outside call, no reverse DNS, no
rate limit, and every value passes through `plain()` first.

| Path | What it gives |
| --- | --- |
| `/me` | A card: IP, network, city/region/country, time zone with the local time, and the Cloudflare data center, under a Braille world map with your approximate location lit (`src/me.js`). ANSI colors for command-line clients (`CLI_UA`); `?color=0` turns them off and `?color=1` on for anything else. `?w=<columns>` sets the width, frame included (32 to 120, default 64; `curl "ipterm.net/me?w=$COLUMNS"` fits the terminal). `?redact` replaces the IP with x's for screenshots. Browsers are redirected to `/`, whose terminal shows the same. Sent `private, no-store` |
| `/line` | `203.0.113.4 AS64500 Example ISP · US · EWR`: IP, AS number, network name, country code and data center, for shell prompts and tmux status bars. Parts that aren't known are left out |
| `/expect/<ASN or cc>` | HTTP 200 and the value when the request comes from that network (`AS13335`, or `13335`) or country (`CH`; `T1` is Tor), 412 with a line saying what it came from when it doesn't. Up to 10, comma-separated, any one matching: `/expect/AS13335,AS209242`. A malformed value is 400. Meant for kill switches: `curl -fs ipterm.net/expect/AS13335 \|\| pkill -f my-private-job` |

The map's location is Cloudflare's guess for the address, usually the provider's hub; the card says so under the map.
 Because a second line would break `$(curl ...)`, the IPinfo credit for these rides in
an `x-attribution` response header instead (it is in `/help`, `/api`, the OpenAPI file and `llms.txt` too).

**Aligned text instead of JSON:** add `?format=text` to `/`, `/json`, `/<ip>`, `/AS<number>`, `/dns/...`,
`/mail/...`, `/whois/...`, `/cidr/...`, `/route/...` (and their `/api/...` forms) for key/value lines like the terminal draws.
Browsers get the text too. Results that include IPinfo data end with `IP address data powered by IPinfo
(https://ipinfo.io)`, as IPinfo's free-data terms ask. JSON stays the default for command-line clients,
and `curl ipterm.net` still prints the bare address. Shells such as zsh treat `?` as a wildcard, so the
reference quotes those URLs: `curl 'ipterm.net/8.8.8.8?format=text'`.

Text answers carry no sponsored line (that line only exists in the browser terminal), and every value
from upstream (TXT records, registry names) has control characters and bidi overrides replaced with `?`,
so a hostile record can't send escape sequences to the reader's terminal (`plain()` in `src/worker.js`).

**Machine-readable descriptions:** `public/openapi.json` (OpenAPI 3.1), `public/llms.txt` and
`public/opensearch.xml` (see "Address-bar search") are static files, listed in `run_worker_first`'s exclusions
so they don't count as Worker requests. Their links are written for `https://ipterm.net`; change them if you
deploy elsewhere. Edit them whenever a route changes.
`public/_headers` sends both with `Access-Control-Allow-Origin: *`, so browser-based OpenAPI tools and
agents on other sites can load them. That covers only these two public documents: the API's own
cross-site access still follows `PUBLIC_API` (off by default).

The homepage itself carries the visitor's address: the Worker writes their IP, network and location into the
HTML (`homePage()` in `src/worker.js`), so the number is there on first paint and without JavaScript, and the
terminal draws it without a second request. Because it's personal, it's sent `private, no-store`, and it's
kept out of search snippets (`data-nosnippet`), since a crawler would see its own address. Prefetches and
prerenders (Chrome's prefetch proxy, from search results) get the plain page instead, because the address
they'd carry may not be the visitor's; the terminal then asks the API as before.

### Terminal commands

`help` lists every command, and each one is a link that runs it (or an example of it). `man <command>`,
`help <command>` and `<command> --help` show a manual with clickable examples, the matching curl line and
related commands. A mistyped command gets a "did you mean" (`whos example.com` → `whois example.com`), and
commands people type out of habit answer sensibly: `ifconfig`, `ipconfig` and `ip a` show whoami, `ping`
times HTTPS round trips to the nearest Cloudflare data center (browsers can't send ICMP), and `traceroute`
explains why it can't run in a browser. Every result ends with a `next:` line of up to four follow-ups
picked from its own data (whoami suggests `leaktest` and your network; a domain suggests `whois`; a failed
lookup suggests `retry`). Commands typed while another runs wait their turn, as in a real terminal (type-ahead).

**Share, copy and copy md.** Every result's header line ends in `[share] [copy] [md]`, tied to that result, so an
older result's buttons still act on it; `share`, `copy`, `copy md` and `copy link` at the prompt act on the newest
one (`shareBar()` and `current` in `public/app.js`).

- `share` opens the system share sheet on phones and tablets (`navigator.share`, when the pointer is coarse) and
  copies the link everywhere else, or when the sheet fails.
- `copy` copies the result's main value: the IP address, the domain, the range or the AS number (a port result's
  number, leaktest's verdict). Every lookup replaces it, a failed one too, so it never copies an earlier result.
- `copy md` copies a fenced Markdown block for a GitHub issue, Discord or Stack Overflow: `$ <command>`, the header's
  tags, the table and the notes under it, then the permalink on the line after the fence, where it stays clickable.
  The fence is longer than any run of backticks in the result, so a TXT record can't end it early.
- Nothing copied carries the sponsored line, the `next:` line, the map or buttons.
- Results about the visitor's own connection (whoami, leaktest, a port check) never share their address. The link
  is the page itself (`/`, `/leaktest`, `/port/<n>`), which shows each visitor their own result, so the share sheet
  says "check yours". Their Markdown replaces the visitor's addresses with `[hidden]` and leaves out the rows that
  are the address in another form or point at it (`SELF_DROP`: hostname, the other IP version, postal code,
  coordinates, decimal, hex, binary, reverse-DNS zone). `copy` still copies your own IP after whoami: it goes to
  your own clipboard, not to anyone else.

**History and keys.** The commands a visitor runs (typed or clicked, never their results) are kept in their browser's
local storage under `ipterm-history`, the newest 200, so Up, Down and `history` work after a reload. A page's own
first command (the homepage's whoami, a shared link's lookup) and Back/Forward replays aren't saved, since nobody
typed them. `history` lists them numbered, each a link that runs it again; `history clear` deletes them and
`history off` deletes them and stops saving (`ipterm-history-off`) until `history on`. Up and Down keep working
for the tab either way. Nothing is sent anywhere, and the privacy policy says so. Two open tabs add to one list
(each write reads the list again first).

| Key | What it does |
| --- | --- |
| Tab | Completes the word being typed: a command, a record type after `dig <name>`, a theme or `history`/`copy`/`crt` argument, a port, or an address, domain, range or AS number from the history. Several matches: the first Tab fills in what they share, then each Tab steps to the next, with the list in a hint beside the prompt. On an empty prompt Tab isn't captured, so keyboard users can tab out of the terminal; Shift+Tab never is |
| Ctrl+R | Searches the history as you type, newest first (the prompt reads `(reverse-i-search)`). Ctrl+R again: an older match. Enter runs it, an arrow key, Tab, Home or End keeps it for editing, Esc (or Ctrl+G) gives the line back |
| `!!`, `!<n>`, `!-<n>` | As in bash: the previous command, number n in `history`, the nth from the end; also inside a line (`sudo !!`). The expanded command is shown, run and saved; an unknown one says `event not found` |
| Up, Down, Ctrl+L | Step through the history; clear the screen |

`keys` (or `man keys`) lists them in the terminal.

### Address-bar search (/go)

`/go?q=<anything>` answers with a 302 to the page for what was typed, so ipterm can be a browser search engine and a
search box on other sites (`goRoute()` in `src/worker.js`):

| Typed | Goes to |
| --- | --- |
| `8.8.8.8`, `[2606:4700:4700::1111]`, `http://192.168.1.1/admin` | `/8.8.8.8` (IPv6 in its short form) |
| `AS13335`, `as 13335`, `asn 13335` | `/AS13335` |
| `example.com`, a URL, an international name | `/dns/example.com` (punycode) |
| `10.1.2.3/22`, `10.0.0.0-22`, `192.168.1.10 255.255.255.0` | `/cidr/10.1.0.0/22` (the network address) |
| `someone@gmail.com`, `mailto:…`, `mail gmail.com --dkim google` | `/mail/gmail.com` (with `?dkim=`) |
| `port 22`, `port:22`, `22/tcp` | `/port/22` (the page explains the port; nothing is checked) |
| a terminal command: `dig gmail.com MX`, `whois AS13335`, `lookup 1.1.1.1` | its page |
| a tool's name: `whois`, `dig`, `leaktest`, `port`, `help`; or nothing | `/whois`, `/dns`, `/leaktest`, `/port`, `/api`; `/` |

Anything else is a 400: JSON for command-line clients, and for browsers a `noindex` page in the terminal's style
with examples (a bare number is offered as both `asn AS<n>` and `port <n>`). `/go` is in `robots.txt`'s Disallow,
and a redirect is cached for an hour like the other redirects.

**The Location is never the input.** It is put together only from values that were parsed and written out again
(`canonIp()`, `AS` and a number, `normalizeDomain()`, `CIDR.calc()`, `PORTS.parse()`, the `DNS_TYPES` list,
`dkimSelector()`), and `goLocation()` checks the result before it goes out: a path on this site, made of
`A-Za-z0-9._~:/?=%-` only, not starting with `//` or `/\` (which browsers read as another host), with no dot
segments. Input with control, zero-width or bidi characters, other URL schemes (`javascript:`, `data:`, `ftp:`) or
more than 300 characters is refused before parsing. `tools/check_go.sh` runs 78 inputs against `npx wrangler dev`
(or the live site: `sh tools/check_go.sh https://ipterm.net`), including `//evil.com`, `/\evil.com`, `%2F%2Fevil.com`,
`javascript:alert(1)`, CRLF and NUL injection, bidi overrides, `__proto__` as a record type, out-of-range ports and
AS numbers and an over-long name. Every answer must be the exact expected path or a 400. A URL to another site
(`https://evil.com`) goes to that host's DNS page here, which is a page on this site like any other lookup.

**Browsers.** `public/opensearch.xml` (static, in `run_worker_first`'s exclusions) describes the search, and every
page links it (`<link rel="search">` in `public/index.html`), so Firefox offers "Add ipterm" in the address bar's
search menu and Chrome lists ipterm under its site search shortcuts. It's written for `https://ipterm.net`.

**Wikis and intranets.** The `/api` page shows a plain GET form to paste anywhere (no script, `action` pointing at
`<origin>/go`), and the terminal's `api` output has the same HTML with a copy button (`goForm()` in
`src/worker.js` and `public/app.js`, kept in step). On `/api` itself the form works without JavaScript too, which is
why the CSP's `form-action` is `'self'` rather than `'none'`: the form may only submit to this site.

### Subnet calculator

`cidr 10.0.0.0/22`, `cidr 192.168.1.10 255.255.255.0`, `cidr 2001:db8::/48`, or just type a range. It shows the
network and broadcast addresses, netmask, wildcard, usable host range and count, a bit diagram, and how the
block splits or combines. Pages live at `/cidr/<ip>/<prefix>` (canonicalized to the network address) and the
cheat sheet is at `/guides/subnet-cheat-sheet`. The math is in `public/cidr.js`, shared by the page and the
Worker, and makes no outside calls: the JSON and `?format=text` answers are the calculation alone. The page for a
public range adds how it is routed (see "Routing" below), and so does `cidr` in the terminal for a public range.

### Routing (route)

`route 1.1.1.0/24` or `route 8.8.8.8` in the terminal, `curl …/route/1.1.1.0/24` for JSON (`?format=text` for aligned
lines), and a section on the `/cidr/<prefix>` page of every public range. Browsers that open `/route/...` are sent to
that page (an address goes to the page of the route it is in). It shows, from [RIPEstat](https://stat.ripe.net/):

- **the route**: the prefix itself when it is announced, or the less specific route it is part of (`8.8.0.0/16` is
  routed as part of `8.0.0.0/12`), or, for a range that isn't announced as a whole, up to 8 of the more specific
  routes inside it;
- **the origin**: the network (AS) that announces the route, with its holder's name, and up to four when several do;
- **RPKI**: whether a ROA allows that origin to announce the route (valid; invalid because of the origin or the
  length; or not found, when no ROA covers it), for up to two origins;
- **visibility**: how many RIS peers see the route, and when it was first seen;
- **upstreams and AS paths**: the networks just before the origin in the routes the collectors see, and two or
  three sample paths, the shortest through each of the most common of those networks.

The data comes from five RIPEstat calls at most, cached for six hours (ten minutes when a part didn't answer):

| Call | For | Limits |
| --- | --- | --- |
| `prefix-overview` | the route and its origins | 6 seconds, one retry, 200 KB |
| `routing-status` | visibility, first seen | one try, 4 seconds (it is slow for big aggregates), 100 KB |
| `rpki-validation` | each origin (up to two) | one try, 5 seconds, 50 KB |
| `bgp-state` | AS paths | one try, 5 seconds, 400 KB, three collectors only: `rrcs=00,01,11` |

The AS paths come from three RIS collectors: RRC00 (Amsterdam, multihop, with peers worldwide), RRC01 (London) and
RRC11 (New York), about 100 routes for a typical prefix (about 12 KB). The full table from every collector would
run to hundreds of kilobytes for a busy prefix, and parsing that would use up the Worker's CPU time. RIPEstat's
`looking-glass` call ignores `rrcs=` and always answers from every collector, so it isn't used; `bgp-state` takes it.
Only public ranges between /8 and /32 (IPv6 /16 to /128) are looked up; anything else is refused without a call.
A lookup never uses IPinfo or proxycheck.io, so it can't spend their budgets; it counts as one of the visitor's 30
lookups a minute when it isn't cached, and the `/cidr` page shows the calculation with a note instead when a visitor
is over that limit or RIPEstat doesn't answer.

**ASN pages** list the network's main upstreams: the five networks RIPEstat's `asn-neighbours` sees just before it
in AS paths ("left" neighbours), by how many RIS peers see each, with their names (`as-overview`, in parallel).
Those are usually its transit providers. A large transit network's neighbour list runs to thousands of entries and
hundreds of kilobytes, and its "left" neighbours are customers and peers rather than upstreams, so a list over
300 KB isn't read (`UPSTREAM_MAX`), and the page says so. If RIPEstat doesn't answer for the upstreams, the page goes
out without them and is cached for ten minutes instead of six hours.

### DNS tools

`lookup example.com` (or just type a domain, or paste a URL) shows A, AAAA, MX, NS, TXT and CAA records, any
CNAME alias, who hosts the first address, and whether DNSSEC validates. `dig example.com MX` shows one record
type with TTLs (A, AAAA, CNAME, MX, NS, TXT, CAA, SOA, SRV, PTR, DS, DNSKEY, HTTPS); `dig 8.8.8.8` does a
reverse lookup. A null MX (`0 .`, RFC 7505: the domain accepts no mail, as on example.com) shows as
`0 . (accepts no mail: null MX)`, and its JSON `value` is `"."`. Pages live at `/dns/<domain>` and
`/dns/<domain>/<TYPE>`; curl gets JSON. Answers come from
Cloudflare's public resolver (1.1.1.1) and are cached for five minutes. International domain names are
converted to their punycode form automatically.

A DNS result for a domain with MX records or an SPF record links to its mail check (a `mail check` row and the
`next:` line in the terminal, a link on the `/dns/...` page), and so does a domain's whois `next:` line.

### Email security check (mail)

`mail gmail.com` in the terminal, `/mail/<domain>` as a page, `curl …/mail/gmail.com` for JSON (`?format=text` for
aligned lines). It reads a domain's mail records through Cloudflare's resolver and grades them A to F:

- **MX**: the mail servers, and the provider behind them when the host names say (Google Workspace, Microsoft 365,
  Proofpoint, Fastmail …, `MAIL_PROVIDERS` in `src/worker.js`). A null MX (`0 .`, RFC 7505) means the domain accepts
  no mail; see below.
- **SPF**: exactly one `v=spf1` record. `include:` and `redirect=` are followed to count DNS lookups against RFC 7208's
  limit of 10 (include, a, mx, ptr, exists and redirect each cost one, and so does everything inside an include).
  One with a macro (`%{d}` and the like) depends on the sender, so it is counted but not followed.
  Flags `+all` (anywhere it lets any server pass, including inside an include), `?all`, no `all`, `ptr`, syntax
  errors, includes without an SPF record, and two or more records.
- **DMARC**: the policy, `pct`, `sp`, `t=y` and the report addresses (`rua`). A subdomain without its own record
  gets its organizational domain's (`sp=`, or `p=`): without a public-suffix list, ipterm asks up to three parent
  names and takes the shortest one with a record, as DMARCbis's tree walk does.
- **DKIM**: selectors can't be listed, so only `google`, `selector1`, `selector2`, `default`, `k1` and `s1` are
  tried, plus one you name: `mail example.com --dkim <selector>` (or `?dkim=<selector>`), the `s=` value in a
  message's DKIM-Signature header. A named selector is checked as well as the common ones, never instead, so naming
  a good key can't hide a weak one. Not finding a key is INFO, not a failure. RSA key sizes are read from the key
  itself (its modulus).
- **MTA-STS**: the `_mta-sts` TXT record, then the policy file at `https://mta-sts.<domain>/.well-known/mta-sts.txt`,
  matched against the MX hosts. That fetch is the only request that doesn't go to Cloudflare's resolver: HTTPS only,
  to that exact host, redirects not followed (RFC 8461 forbids them), a 5-second limit and a 64 KB cap.
- **TLS-RPT** (`_smtp._tls`) and **BIMI** (`default._bimi`): present or not, and where reports and the logo point.

Every finding is a line marked OK, WARN, FAIL or INFO, with a `fix:` line under each WARN and FAIL, like
`leaktest`'s. The grade counts them (`MAIL_GRADES` in `src/worker.js`; the same rubric is in `man mail` and on the
`/mail` page):

| Grade | When |
| --- | --- |
| A | no FAIL and no WARN |
| B | no FAIL, one or two WARN |
| C | one FAIL, or three or more WARN |
| D | two FAIL |
| F | three or more FAIL, or no working SPF and no DMARC (nothing stops anyone sending as the domain), or SPF that lets any server pass (`+all`) |

INFO lines never count. What each check reports:

| | FAIL | WARN | INFO |
| --- | --- | --- | --- |
| MX | a null MX beside other MX records | no MX records | |
| SPF | no record; two or more; over 10 lookups; `+all` (also inside an include); syntax errors; an include or redirect with no SPF record | `?all` or no `all`; `ptr`; an include that didn't answer | macros (`%{…}`), counted but not followed |
| DMARC | no record; two or more; no valid `p=` | `p=none`; `pct` below 100; `t=y`; `sp=none`; no `rua` | |
| DKIM | | an RSA key under 2048 bits | no key at the selectors tried; a revoked key; a selector that couldn't be read |
| MTA-STS | two records or no `id`; the policy can't be fetched or is invalid; `mode: enforce` leaving out an MX host | `mode: testing` leaving out an MX host; `max_age` under a day; not served as `text/plain` | not set up; `mode: testing` or `none` |
| TLS-RPT | | no record while MTA-STS is set up; no valid `rua`; two records | not set up |
| BIMI | | a logo while DMARC isn't at quarantine or reject; no valid `l=` | no record; a declined logo (empty `l=`) |

A domain with a null MX accepts no mail and, since nobody could bounce it, can't really send any either. Its
SPF should be `v=spf1 -all` and its DMARC `p=reject` (anything weaker is a WARN, a missing record a FAIL, and a
missing `rua` only INFO). DKIM, MTA-STS, TLS-RPT and BIMI don't apply and aren't checked. `example.com` is one.

**Cost.** A fresh check makes about 12 to 22 fetches (6 record queries, the SPF includes, up to 3 DMARC parents,
the policy fetch, 6 DKIM selectors) plus 4 to 6 cache reads and writes, which count toward the Workers limit of 50
subrequests too. Each part has a budget, retries included: 22 fetches for the records, 7 for the common selectors
and 2 for a named one, so even the worst case stays at 37.
The records, the common selectors and a named selector are cached separately for five minutes, like DNS, so a new
selector costs one query and can't be used to make ipterm fetch a domain's MTA-STS policy again and again. A fresh
check counts as two or three of the visitor's 30 lookups a minute. When the resolver can't read a record
(SERVFAIL, even after one retry), the line says so instead of calling it missing, and that answer is kept for a
minute. The same goes for a parent's DMARC record when a subdomain has none of its own, and for each DKIM
selector. No IPinfo or proxycheck.io budget is ever used.

### Registry records (whois)

`whois 8.8.8.8` or `whois AS13335` in the terminal, `/whois/<ip, ASN or domain>` as a page, `curl …/whois/8.8.8.8` for JSON.
It shows the registered owner, address block, registration dates and abuse contact, straight from the
regional internet registry (ARIN, RIPE NCC, APNIC, LACNIC or AFRINIC) over RDAP. IANA's bootstrap files
pick the right registry; they're cached for a day, and each record for a day. Some registries (RIPE NCC
in particular) hide abuse emails in RDAP; ipterm then shows the contact's handle instead.

`whois example.com` (or a pasted URL) looks up a domain's registration: registrar, registration and expiry
dates, status codes, name servers, DNSSEC and the registrar's abuse contact. ipterm asks the registry for
the domain's extension (Verisign for .com/.net, PIR for .org, and so on), then follows its link to the
registrar's own record for the abuse contact and any published owner details. Owner names are usually
redacted for privacy since GDPR, so "not published" is normal. Subdomains are looked up as their
registered domain (`whois blog.github.com` shows github.com). Domain records are cached for six hours.
Every generic extension (.com, .org, .app, .xyz …) publishes RDAP, because ICANN requires it; some
country extensions don't (.de and .io, for example), and ipterm says so instead of guessing.

### Privacy check (leaktest)

`leaktest` (or `dnsleak`) in the terminal, or the page `/leaktest` (which runs it on load; `/dnsleak`
redirects there), is a VPN and DNS leak test: it checks whether the browser gives away more than its IP
address, and grades the leaks A to F. Each line is marked OK, LEAK or INFO:

- **Sites see:** the visitor's IP, with its network and rough location: their provider's without a VPN,
  the VPN's with one. Always INFO, and never graded: every connection without a VPN shows these, and the
  grade is about leaks, not about whether someone uses a VPN.
- **VPN detection:** IPinfo Core's classification of the visitor's IP (VPN/proxy/Tor, hosting
  flag, or a network whose type is hosting), plus proxycheck.io's when `PROXYCHECK_KEY` is set
  (which can name the VPN service). Two services are named outright: **Cloudflare WARP**, when
  Cloudflare's edge says the request came through it (`warp=on` or `warp=plus` in `/cdn-cgi/trace`, which
  the page reads itself), and **Tor**, when the address is on the Tor Project's exit list (see "Tor exits"
  below) or Cloudflare gives it the country code `T1`. Both count as a VPN. Without any of these, this line
  says it wasn't checked. An unflagged address on a home or mobile provider's network (IPinfo type "isp",
  a mobile network, or proxycheck.io's "Residential" / "Wireless") is reported plainly as "no VPN", since
  commercial VPN servers run in data centers. Any other unflagged address stays hedged. An
  unlisted IP isn't treated as proof of no VPN: mismatches below still carry "(a leak if you use
  a VPN)", just marked INFO instead of LEAK. proxycheck.io's `anonymous` or `compromised` flag
  alone (see the table above) doesn't count as a VPN: on a hosting network the address counts as
  one anyway, as any hosting address does; elsewhere the tag says "vpn unclear" and the check
  treats it like an address it couldn't classify (mismatches marked LEAK, with the "if you use a
  VPN" caveat), and the sponsored line shows, since no VPN was detected.
- **DNS:** which resolvers look up names for the visitor. The page looks up six random, single-use names
  under the test zone (`<token>.dl.ipterm.net`, 20 hex characters from `crypto.getRandomValues`) with a
  `no-cors` fetch and a 3-second abort. Each fails within milliseconds, since the zone's server answers
  NXDOMAIN, but by then the visitor's resolvers have asked that server. Then `/api/dnsleak` asks which
  resolvers those were, and names each one's network with IPinfo Lite. On a VPN, resolvers outside the
  VPN's network (another AS number and name) are a LEAK, called "your ISP" when they belong to the network
  the other IP version leaked to; resolvers inside it are OK. Through Tor the exit relay picks the
  resolver, so there only the visitor's own provider's is a LEAK. Without a VPN they're named, as INFO:
  `Cloudflare (1.1.1.1)`, `your ISP: Verizon Business`, a private address, or "your own address" for a
  resolver the visitor runs themselves. Until the DNS test server is set up, or when it doesn't answer, or
  no lookup reached it, the check says "Not tested: DNS leaks" instead. See "DNS leak test server" below.
- **WebRTC:** asks Cloudflare's public STUN server (`stun.cloudflare.com:3478`) which public
  addresses the browser reveals, and flags any that differ from the IP websites see. A local network
  address WebRTC shows (current browsers hide it) is INFO: it says nothing about where the visitor is.
- **IPv6 / IPv4:** compares the network of the visitor's other IP version (via ipify) with the one
  they connected over. On a VPN, a different network means that traffic bypasses the VPN.
- **Time zone:** the device's time zone versus the IP's location (compared by UTC offset). A device that
  reports UTC (Tor Browser, Firefox's `privacy.resistFingerprinting`) is OK: it gives nothing away.
- **Language (INFO only):** the country in the browser's preferred language (`en-US` → United States)
  next to the IP's country. Sites can compare the two, but expats and travelers differ for good reasons,
  so it's never a LEAK and never graded.
- **Connection (INFO only):** badges for TLS 1.3, HTTP/3 and post-quantum key exchange (`tls=`, `http=`
  and `kex=` in `/cdn-cgi/trace`; a `kex` with ML-KEM or Kyber in it is post-quantum). They describe how
  the browser reaches ipterm, so they're never a plus on the grade. The line is left out when the trace
  isn't there (under `wrangler dev`).

Findings count as LEAK only when the visitor appears to be on a VPN; otherwise the same facts are
shown as INFO. (WebRTC, IPv6 and the time zone also show LEAK when the check can't tell whether a VPN is
on, with the "if you use a VPN" caveat. DNS doesn't: without a VPN's network there is nothing to compare
the resolvers with.) Nothing is stored. The visitor's own IP is sent to IPinfo only when they run the
check (it uses the Core daily budget), and the privacy policy says so. When no VPN is detected, the
verdict is always followed by the sponsored line (any sponsor with `"check"` in its `on` list in
`sponsors.json`, currently Proton VPN). A run that detects a VPN never shows it, and neither does any later
run in the same tab: someone who turns their VPN off to compare already has one. (That's kept in memory with
the last result, so a reload forgets it.) A DNS LEAK only happens on a VPN, so it never brings the line.

#### The grade

One grade, "Leaks: A" to "F", for what leaks past a VPN. The rubric lives in `public/leakgrade.js`
(shared by the page and the Worker), and the same words are in `man leaktest` and on the `/leaktest` page:

| Grade | When |
| --- | --- |
| A | no leaks |
| B | only the time zone leaks: it gives away the region, not the address |
| C | DNS leaks (sites are looked up outside the VPN), but neither WebRTC nor IPv6 does |
| D | WebRTC or IPv6 shows an address outside the VPN (one of the two), and DNS doesn't leak |
| F | WebRTC or IPv6 leaks and DNS does too, or WebRTC and IPv6 both leak |

- Only four checks count: DNS, WebRTC, IPv6 (the other IP version) and the time zone, and each only when
  a VPN is detected (a known VPN, proxy or Tor address, a hosting network, or Cloudflare WARP).
- **Not using a VPN never lowers the grade.** With no VPN detected nothing can leak past one, so the grade
  is A; what sites see (the provider and rough location) is its own line, never graded.
- When the check can't tell whether a VPN is on, there's no grade if a line would be a leak with one
  ("Leaks: –, not graded"), and A if none would.
- Checks that couldn't run don't count (the tally says which). INFO lines never count: connection
  security, browser language, a local address.

#### Before and after

The last result stays in the tab's memory (a variable, never `localStorage`; a reload forgets it). Run
`leaktest` again, after turning a VPN on or off or after a fix, and it prints each line before → after,
with unchanged lines folded into one row (a leak that's still there is always shown). Between a run with a
VPN and one without, the run without it shows what a leak would give away, so "a leak if you use a VPN"
becomes a verdict: "confirmed leak: it's the address you have without the VPN" (WebRTC), "it's your
network without the VPN" (IPv6), "the same resolvers as without the VPN" (DNS), or "not a leak with the VPN
on". With the VPN in the same state both times it says "fixed", "still leaks" or "new leak".

#### Shared results (/leaktest/r/<code>)

`share` after `leaktest` copies a link like `/leaktest/r/1bjp`. The page makes the code (`encode()` in
`public/leakgrade.js`): version `1`, the grade letter, then two characters of Crockford base32 holding 10
bits, whether a VPN was detected and, for each graded check, passed, leaked or not tested. That's all:
no IP address, provider, location or resolver, so every browser with the same result gets the same link
(113 codes are valid in all), and a link can't be traced back to anyone. The Worker only decodes it, and
rejects a code whose letter doesn't match its checks (a 404 page).

- The page says "this browser got a B on ipterm's leak test", lists the lines, and offers **run yours**
  (a link to `/leaktest`). It never runs the test by itself: opening someone's link mustn't test the
  visitor's browser, so the terminal shows `leaktest --result <code>` instead, and Back and Forward do the
  same.
- Link previews use one of five static images, `public/og-leak-a.png` to `-f.png` (1200×630). They're made
  by `node tools/build_og_leak.mjs` with headless Chrome or Edge (set `CHROME` if it isn't found); commit
  the PNGs after changing it.
- Result pages are `noindex` (meta tag and `X-Robots-Tag`), cached for a day like static pages, and not
  in the sitemap. Command-line clients get the decoded result as JSON (`?format=text` for lines).
- A run that can't be graded has no code: `share` then copies `/leaktest` and says why.

#### Tor exits

To say "Tor", the Worker checks the visitor's address against the Tor Project's exit list
(`https://check.torproject.org/torbulkexitlist`, about 1,200 IPv4 addresses, 17 KB). Each Cloudflare data
center keeps a copy in its cache for an hour, and each Worker instance remembers it for ten minutes, so
the list costs at most one subrequest an hour per data center, and only when someone there runs leaktest.
The visitor's address is looked up in that copy, never sent to the Tor Project. A slow download doesn't
hold the check up (it waits 1.5 seconds, then finishes in the background and fills the cache); if the
list can't be had, leaktest runs without it and tries again ten minutes later. iCloud Private Relay isn't
named: its list of egress ranges is too big to fetch for this.

### DNS leak test server (dnsleak-server/)

Telling which resolver asked for a name takes a DNS server that answers for that name itself, which
Cloudflare's DNS can't do for us. So `dl.ipterm.net` is delegated to a small VPS outside Cloudflare
running `dnsleak-server/` (Node.js, no dependencies). Its README has the owner's setup steps (the VPS,
the three Cloudflare records, `setup.sh`, the secret and the checks), its settings and its tests.

- **How it fits together:** the browser's lookups go through the visitor's resolver to the VPS on port 53,
  which notes the resolver's address against the token and answers NXDOMAIN. The page then asks
  `/api/dnsleak?t=<tokens>`; the Worker asks `https://dlapi.ipterm.net/v1/resolvers` (Caddy with a Let's
  Encrypt certificate in front of the VPS's API, since Workers can't fetch a bare IP address), sending the
  `DNSLEAK_KEY` secret in an `x-dnsleak-key` header, with a 3-second limit, and gets the addresses once.
- **Why NXDOMAIN, not an address:** in Chrome a fetch to an NXDOMAIN name fails within milliseconds,
  while one to an address such as TEST-NET 192.0.2.1 hangs until the page gives up (and home routers with
  rebinding protection drop such answers). The test is in dnsleak-server/README.md.
- **Settings:** `DNSLEAK_ZONE` and `DNSLEAK_API` in `wrangler.toml`, and the `DNSLEAK_KEY` secret (32 characters
  or more). Without all three the test is off: `/api/check` offers no zone, the CSP doesn't allow one,
  `/api/dnsleak` is a 404, the `/leaktest` page keeps its old title and description, and leaktest says
  DNS leaks weren't tested. Under `wrangler dev`, `DNSLEAK_API` may be plain `http://` on 127.0.0.1.
- **`/api/dnsleak?t=<token>,...`:** only for the ipterm page (same-origin; the terminal sends
  `X-Ipterm: dnsleak`) and command-line clients, like the port check; 1 to 10 tokens. It counts as one of
  the visitor's 30 lookups a minute, plus one per resolver network not already cached (one IPinfo Lite
  lookup per /24, or IPv6 /48, at most 8). Never Core, never proxycheck.io. Private and other non-public
  resolver addresses are shown as such and never sent anywhere. JSON, or aligned text with
  `?format=text`. From a shell:
  `T=$(openssl rand -hex 10); dig +short $T.dl.ipterm.net; curl "ipterm.net/api/dnsleak?t=$T&format=text"`.
- **Named services:** resolvers on Cloudflare's, Google's, Quad9's and Cisco OpenDNS's networks are named
  as the service (`DNS_SERVICES` in `src/worker.js`); others by their network's name.
- **Privacy:** the VPS sees resolvers' addresses (the visitor's own only if they run their own recursive
  resolver), keeps them in memory for under two minutes, hands them over once, logs no queries or
  addresses and never reads EDNS Client Subnet. The privacy policy says so.
- **Costs:** the VPS, about $4 to $6 a month. Each `leaktest` makes one more Worker request.

### Port checker (port)

`port 25565` in the terminal, or `curl -4 ipterm.net/port/25565` from a command line, answers "is this port
open on my IP?". The Worker opens one TCP connection (`connect()` from `cloudflare:sockets`) to
`cf-connecting-ip`, the address Cloudflare saw the request come from, on that one port. It sends nothing,
closes the connection at once and stores nothing. `port <n> --info` explains a port without checking it,
and `port` on its own lists the common ports.

| Result | Meaning |
| --- | --- |
| open | the connection was accepted |
| closed | it was turned away at once rather than timing out: nothing is listening, or a firewall on the device or router rejected it |
| no answer | nothing within 5 seconds: a router or firewall dropped it, which is what most home routers do with a port they don't forward |
| not tested | port 25 (Cloudflare blocks it), Cloudflare's own addresses (WARP, the 1.1.1.1 app, iCloud Private Relay), non-public addresses (for IPv6, anything outside global unicast 2000::/3, plus 6to4 and Teredo) |

Results that aren't open list what has to be true for a port to be open (a program listening, the
device firewall, the router's forward), the port's own advice, and how to spot carrier-grade NAT: the
router's WAN address isn't the one websites see, or is in 100.64.0.0/10. On networks that usually use
carrier-grade NAT (Starlink, T-Mobile, Verizon Wireless, AT&T Mobility: `CGNAT_ASNS` in `src/worker.js`)
the provider is named. Only TCP can be tested; for UDP services (WireGuard, Valheim, Minecraft Bedrock)
the result says so. No sponsored line follows any port result.

**Guards** (`portRoute()` in `src/worker.js`):

- Only the visitor's own address. There is no parameter for any other, and Cloudflare overwrites a
  `CF-Connecting-IP` header sent by the client (checked on Cloudflare's network). The terminal says so
  when an address is typed (`port 8.8.8.8 22`), takes one port per check (no ranges or lists), and has
  no `nmap` alias.
- `/api/port?n=` and `/port/<n>` check only for same-origin requests and command-line user agents
  (`CLI_UA`). Same-origin means `Sec-Fetch-Site: same-origin` when the browser sends it (it always wins),
  and otherwise a matching `Origin` or the terminal's own `X-Ipterm: port` header: browsers without
  `Sec-Fetch-*` (Safari before 16.4, Firefox before 90) send no `Origin` on a same-origin GET. A cross-site
  page can't add that header without a CORS preflight, which ipterm never allows (OPTIONS is 405, and with
  `PUBLIC_API` on no `Access-Control-Allow-Headers` is sent; keep it that way). Everything else gets
  HTTP 403, so other sites can't make their visitors' browsers start checks.
- Only public addresses are connected to. Beyond the non-public ranges every lookup refuses, an IPv6
  address must be global unicast (`2000::/3`) and not 6to4 (`2002::/16`) or in the IETF block
  `2001::/23` (Teredo), so no form that embeds an IPv4 address (`::/96`, `64:ff9b::/96`) is ever tried.
  None of these can reach ipterm from the internet anyway; it is defence in depth.
- The `/port/<n>` pages explain the port and offer a button in the terminal. Nothing is tested on page
  load, on Back/Forward, for prefetches, crawlers or link previews. Search crawlers and link previews get
  the page (`CRAWLER_UA`, `PREVIEW_UA`), never a check or a 403.
- `PORT_LIMITER` (`[[ratelimits]]`, namespace `1002`): 10 checks a minute per address (IPv6 per /64),
  apart from the 30-lookup limit. Checks that are refused up front (port 25, Cloudflare, non-public
  addresses) make no connection and don't count.

**Pages:** `/port` lists the common ports. `/port/<n>` explains each of the 42 ports in `public/ports.js`
(SSH, RDP, Plex, Minecraft, game, NAS and remote-access ports): what it's for, why it may be closed and
any risk in opening it. Other port numbers get a short page marked `noindex`. Port 25's page (title,
description and terminal) says ipterm can't check it, since Cloudflare blocks it, and offers no check
button (`UNTESTABLE` in `public/ports.js`). `public/ports.js` is shared by the page and the Worker, like
`cidr.js`; add a port by adding a line to its `LIST`.

**IPv4, IPv6 and dual stack.** What testing on Cloudflare (`wrangler dev --remote`) showed:

- `connect()` reaches IPv6 addresses, but only written in brackets (`[2001:db8::1]`); a bare IPv6
  literal is refused with the same error as a blocked address. `probePort()` adds the brackets.
- Port 25 throws at `connect()` ("Connections to port 25 are prohibited"), and Cloudflare's own addresses
  are refused at once ("proxy request failed, cannot connect to the specified address"). Both are
  recognized beforehand (port number; network AS13335 / AS209242, or Cloudflare's published ranges plus
  the 1.1.1.1 resolver's and WARP's exits, `CLOUDFLARE_RANGES`), so
  visitors get an explanation rather than a false "closed".
- A port that a router drops never opens, so it shows as "no answer" after 5 seconds. A refusal (reset)
  ends the connection attempt at once (seen under `wrangler dev`); the test connection's router drops
  everything, so a reset couldn't be observed on Cloudflare's network itself.
- workerd rejects a refusal, an unreachable network and a blocked destination with the same error
  ("proxy request failed, cannot connect to the specified address"), so the error can't tell them apart.
  Anything turned away at once counts as "closed", including a router or firewall that answers with an
  ICMP "unreachable" reply, and the result says only that it was turned away, not that it got through.
- **Dual-stack visitors:** a visitor who reaches ipterm over IPv6 has their IPv6 address tested. Home
  routers forward ports on IPv4 only, and their IPv6 firewall usually drops incoming connections, so a
  working IPv4 port forward would show as "no answer" over IPv6. (On the test connection, even a port
  that was listening on the machine's IPv6 address showed no answer.) The result says which address
  was tested and why, shows the visitor's IPv4 address (from ipify, as `whoami` does) marked "not
  tested", and gives `curl -4 ipterm.net/port/<n>`, which tests IPv4.
- **Why the page can't test IPv4 for an IPv6 visitor:** a browser can't choose IPv4 for a request, and the
  IPv4 address ipify reports comes from the page, so trusting it would let anyone aim the check at any
  address. The real fix is an IPv4-only hostname for the check, such as `v4.ipterm.net`. Cloudflare gives
  every proxied hostname AAAA records while the zone's IPv6 Compatibility setting is on, and that setting
  covers a whole zone. So it needs a second domain (zone) with IPv6 Compatibility off, routed to this
  Worker, plus a `connect-src` entry in the CSP and CORS for that one route. It is not set up here.

## Shareable pages and search

- `/<ip>` and `/AS<number>` are real pages with their own title, h1, description, canonical link,
  social-share tags and breadcrumbs (BreadcrumbList structured data), plus a plain summary of the
  result in the HTML itself. That summary is what search engines index and what visitors without
  JavaScript see. On load the terminal redraws the heading line and table, and the summary sentence
  and links stay, so crawlers that run JavaScript still see them.
- Link previews: chat apps and social sites (Facebook, WhatsApp, Slack, Discord, Telegram, X,
  LinkedIn, iMessage, Reddit, Mastodon, Bluesky, Embedly, Iframely) get the HTML page even when they
  don't ask for `text/html`, so shared links preview with a title and image. So do search engine
  crawlers (Googlebot, Bingbot, DuckDuckBot, Yandex, Baidu, Amazonbot, Petal, Seznam, Qwant), which
  often send `Accept: */*` or none, so they index the pages rather than JSON (or, for `/port/<n>`, a
  403). Both are matched by name (`PREVIEW_UA` and `CRAWLER_UA` in `src/worker.js`); `?format=json`
  and `?format=text` still win, and curl, scripts and other clients still get JSON.
- Private addresses like `/192.168.1.1` get a page explaining the range and how to reach a router,
  a popular search topic, without any upstream lookup. Only the router and well-known addresses in `SITEMAP_PATHS`
  (`/192.168.1.1`, `/10.0.0.1`, `/127.0.0.1` ...) are indexed; the page of any other non-public address (private,
  CGNAT, loopback, link-local, documentation, IPv6 unique local ...) carries `<meta name="robots" content="noindex,
  follow">`, since the private space is millions of near-identical pages (`curatedIps()` in `src/worker.js`).
- Router-address typos get a 301 to the exact address in that list: `/192.168.l.l`, `/192.168.1.l`, `/192,168,1,1`,
  `/192.168.0.l`, `/10.0.0.l`, `/l92.168.1.1`, `/192.168.o.1`, `/192.168.001.001`, `/192;168;1;1`, `/192.168.1.1.`
  (l, i, I, `|` and `!` read as 1, o and O as 0, commas, semicolons, underscores and spaces as dots). The Location is
  always the list's own string, never built from the request, so it can't redirect anywhere else, and a query string
  is dropped (`routerTypo()`). A typo of an address that isn't in the list (`/192.168.5.l`) gets the 404 page with
  "did you mean lookup 192.168.5.1", not a redirect. `tools/check_seo.sh` tests valid, typo and hostile paths.
- `/whois`, `/dns`, `/mail` and `/cidr` on their own are landing pages for each tool (what it does, usage and
  example links), and typing `whois`, `dig`, `mail` or `cidr` with nothing after it shows the same thing.
  `/api` is the API docs page (the terminal runs `api`; the plain-text reference stays in the HTML for
  visitors without JavaScript), and it is in the sitemap.
- Addresses that don't exist get a 404 page in the terminal's style with a "did you mean" link when
  the address looks like an IP, ASN or domain. A domain typed straight after the slash
  (`/github.com`) redirects to its DNS page. Invalid lookups (`/whois/not-a-domain!`) show the error
  in the terminal instead of raw JSON. None of these pages are indexed by search engines.
- Inside the terminal, every lookup updates the address bar, Back/Forward replay results, ASNs and
  prefixes are clickable, and each result's `[share] [copy] [md]` buttons (and the `share` command) share its
  link (see "Share, copy and copy md"; after `leaktest`, the link is to the grade: see "Shared results"). Prefixes on ASN pages
  open the subnet calculator (`/cidr/<prefix>`), whose routing section asks RIPEstat only, and upstreams open their
  own ASN pages (RIPEstat too), so crawlers following them never spend the IPinfo budget. Keep it that way: an ASN
  page must not link to an IP lookup (`/<ip>`).
- `/robots.txt` and the sitemaps are generated. `/sitemap.xml` is a sitemap index (submit that one in Google Search
  Console and Bing Webmaster Tools) listing:

  | File | What | URLs (October 2026) |
  | --- | --- | --- |
  | `/sitemap-pages.xml` | `SITEMAP_PATHS` in `src/worker.js`: the home page, tools, guides, popular ports, router and resolver addresses, subnet and routing examples, DNS, mail and whois pages | 90 |
  | `/sitemap-asn-1.xml` | the 1,000 largest networks by announced IPv4 space | 1,000 |
  | `/sitemap-asn-2.xml` | the rest of the 10,000 largest | 9,000 |

  More ASN files, up to 40,000 URLs each (a sitemap file may hold 50,000), follow automatically if the list grows
  (`ASN_TIERS`, `asnSitemapFiles()`). The tiers let Search Console show how each is indexed. The index gives each ASN
  file a `<lastmod>`: the day the list was generated. Every file is checked against the sitemaps.org schemas.
- **The ASN list** is `src/asn-sitemap.js`, generated by `tools/build_asn_sitemap.mjs` (`npm run asn-sitemap`) and
  committed, since there is no build step. It ranks every origin AS in RIPE NCC's RIS table
  (`riswhoisdump.IPv4.gz`, the data behind RIPEstat; `--caida` uses CAIDA's RouteViews prefix-to-AS file instead) by
  the IPv4 addresses it announces, each counted once, from prefixes between /8 and /24 that at least 10 RIS peers see,
  without non-public space or private and reserved AS numbers. Holder names come from RIPE NCC's AS names list
  (`asn.txt`). Rerun it every few months and commit the result. In October 2026 the 10,000th network announced
  8,448 addresses.
- **Private individuals are left out of that list, and their pages are noindex** (GDPR caution): many networks are
  registered to a person, and the holder name is then the person's name. The rules are in `src/holder-heuristic.js`,
  which the tool and the Worker share; in short, a network is left out when it has no holder name or isn't in the
  names list; when the name shows a natural person (sole proprietor, sole trader, individual or private entrepreneur,
  Einzelunternehmen, e.K., a patronymic such as -ovich, or a PE / FOP / IP prefix before a person's name); when it is
  a partnership of named people (spolka jawna, s.c., GbR, v.o.f.) with no other legal form; when "trading as" follows
  a person's name; when a common given name is followed by another word and the name has no registered legal form
  (Inc, LLC, Ltd, GmbH, SA, BV, Oy, spolka akcyjna ...) or public body or institution (university, school,
  foundation, ministry, district ...); or, with no sign of an organization at all (a legal form, an institution, a
  word such as network or telecom, a country or region, also in its own language: "Orange Polska"), when the name is
  two to six plain words, the shape of a person's name. It errs on the side of leaving a network out: some
  businesses that look like a person's name go too. In October 2026, 118 of the 10,118 largest networks were left
  out: 99 for those signs, 19 with no name or not in the names list. A review of that list added legal forms written
  out or missing (spolka akcyjna, spolka z ograniczona odpowiedzialnoscia, sociedad anonima, S.c.p.A., Q.S.C.,
  B.S.C., FZE, PJS ...) and place names (Polska, Türkiye written Turkiye, NSW, Hong Kong, American ...), which
  brought back 17 organizations, among them AS5617 (Orange Polska), AS8781 (Ooredoo) and AS2594 (CSI Piemonte);
  every network left out for a person sign (patronymic, trading as, sole trader, partnership, given name) stayed out,
  and across all 122,000 names in `asn.txt` the only answers that changed were 207 "might be a person's name" that
  are organizations. The list of what was left out is only printed (`--show-excluded`), never saved to a file, so the
  repository doesn't collect those names.
- Those networks' pages still work, but they aren't in the sitemap, and search engines that find them through links
  (another network's upstreams, a shared link) are asked not to index them: `asnPage()` runs the same rules on
  RIPEstat's holder name, split from its handle the way the tool splits `asn.txt` lines (`<HANDLE> - <Name>` from
  ARIN, LACNIC and AFRINIC, `<HANDLE> <Name>` from RIPE and APNIC, or the name alone), and a name that may be a
  person's gets `<meta name="robots" content="noindex, follow">`. This covers every network, not only the 10,000
  largest, and the JSON and text answers are unchanged. RIPEstat and `asn.txt` give the same names, so the sitemap
  and the noindex agree: in October 2026 all 99 networks left out for those signs, the 17 brought back by the review,
  and a sample of 80 kept ones got the same answer from both (a holder that renames itself can differ until the list
  is regenerated). `tools/check_seo.sh` checks AS35100 and AS50053 (noindex, not in the sitemap) against AS13335,
  AS15169, AS3356 and AS5617.
  The check costs a few microseconds per page, plus about 3 ms the first time in an isolate.
- **Other pages that name such a holder are noindex too, or leave the name out.** A noindex ASN page links to its
  whois record and its prefixes, and those pages name the holder as well:
  - `/whois/AS<n>` and `/whois/<ip>` (`whoisPage()`): RDAP gives the holder in `org` (the registrant, or else the
    administrative contact) and the AS or network name in `name`. The page is noindex when either may be a person's,
    or when `<name> <org>` does, which is the holder as RIPEstat gives it (`JDOE-AS Jane Doe`), so the record
    and the network's ASN page come to the same answer. An address record goes by its own holder: an address block
    of a person's network that is registered to a company stays indexed.
  - `/cidr/<public prefix>` (`cidrPage()`): noindex when the routing section names an origin that may be a person
    (`origins[].holder`, from RIPEstat's `prefix-overview`, the same string `as-overview` gives). Without a routing
    section (RIPEstat didn't answer) the page names no network and stays indexable. A `/cidr` page links on to the
    whois record of its network address, which decides for itself.
  - Upstreams on an indexed ASN page: one that may be a person is listed by its AS number only, linked to its own
    (noindex) page, in the summary, the static list and the data embedded for the terminal (search engines run the
    page's script). On a page that is noindex anyway, upstreams keep their names. The name check runs both on the
    name as shown and on it split from its handle, so it hides at least what the upstream's own page would noindex.

  The JSON and text answers (`/AS<n>?format=json`, `/api/asn`, `/whois/...`, `/route/...`) keep every name: they are
  the API, and crawlers get the HTML pages. These pages ask RIPEstat and RDAP only, never IPinfo. `tools/check_seo.sh`
  checks the whois pages and the largest prefix's `/cidr` page of AS35100 and AS50053 (noindex) and of AS13335,
  AS15169 and AS3356 (indexable), an address block of AS50053 registered to its holder, and AS203761, an organization
  whose upstream AS28748 is held by a person: its page must link AS28748 without naming it. That name is read from the
  JSON while the check runs, so it isn't written in the repository.

Network data comes from [RIPEstat](https://stat.ripe.net/) (free, no key). Results are cached for six hours.

## Guides and search

- **Guides** live at `/guides` and `/guides/<name>`. They're generated from `tools/build_guides.py`: edit the
  text there, run `python3 tools/build_guides.py`, then deploy. Each page gets its own title, description,
  canonical link, share tags, breadcrumbs and Article structured data.
- **Homepage section:** plain HTML below the terminal (in `public/index.html`) explains ipterm and links to
  popular lookups and the guides, so search engines see real text and links. Clicking a lookup there runs it
  in the terminal.
- **Share image:** `public/og.png` (1200×630) is used when any page is shared, except a shared leak test result, which uses its grade's `public/og-leak-<a-f>.png` (made by `tools/build_og_leak.mjs`).
- **Placeholders:** static pages use `%ORIGIN%`, which the Worker replaces with your site's address.
- **Sitemap:** `/sitemap.xml` is an index of `/sitemap-pages.xml` (`SITEMAP_PATHS` in `src/worker.js`: guides,
  router addresses, public DNS resolvers, the most searched port pages and more) and the ASN files
  (`/sitemap-asn-<n>.xml`, from `src/asn-sitemap.js`). See "Shareable pages and search".

## Sponsored line (ads)

ipterm shows one labeled `sponsored` line under some results. It is plain text and a link: no ad
scripts, no tracking, no cookies, so no consent banner is needed and the security policy stays strict.

Edit `public/sponsors.json` and run `npx wrangler deploy` to change it:

```json
{
  "enabled": true,
  "every": 3,
  "sponsors": [
    {
      "text": "Hide your real IP with ExampleVPN: 3 months free",
      "url": "https://example.com/?ref=ipterm",
      "on": ["check"],
      "weight": 2
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | `false` hides the line everywhere |
| `every` | Show after the 1st result that has a matching sponsor, then every Nth such result (default 3). Results with no matching sponsor don't count. `check` ignores this and always shows |
| `text` | Up to 160 characters, shown as plain text |
| `url` | Optional `https://` link, opened in a new tab with `rel="sponsored"`. Anything else is ignored |
| `on` | Which results it can appear after: `whoami` (visitor's own IP), `check` (the leaktest verdict when no VPN is detected), `ip`, `asn`. Leave out for all |
| `weight` | Relative chance when several sponsors match (default 1) |
| `label` | Optional tag text instead of `sponsored`, e.g. `affiliate` |

Nothing the visitor copies or shares (`copy`, `copy md`, `share`) carries the sponsored line.
Targeting by result type works without tracking: a VPN offer fits `check`, a hosting offer fits `asn`.
`whoami` has no VPN signal, so a VPN offer on `whoami` is also shown to visitors who are already on a VPN;
`check` only appears when leaktest finds no VPN, and not after an earlier run in the same tab found one.
Affiliate programs (VPNs, hosting, dev tools) and direct sponsors both work: put the referral link in `url`.
In the US, the FTC requires affiliate and sponsored links to be disclosed; the `sponsored` tag does that.

## Privacy policy

`public/privacy.html` is served at `/privacy` and linked in the footer and the `privacy` command.
The contact address is `contact@ipterm.net` (near the bottom). If you add analytics or a script-based
ad network later, update the policy first, and add that service's domains to the CSP in `src/worker.js`.
The policy is a plain-language template, not legal advice.

## Accessibility

| Feature | How visitors use it |
| --- | --- |
| High-contrast theme | `theme contrast`. Applied automatically when the system asks for more contrast and the visitor hasn't picked a theme |
| Light theme | The **light / dark** switch in the header of every page, or `theme paper`. Switching back returns to whichever dark theme was in use |
| CRT effects off | `crt off` (glow, scanlines, vignette) in any theme; `crt on` to restore |
| Accessibility help | `access` command, or the "accessibility" link in the footer |
| Back to defaults | `reset` forgets the saved theme and CRT setting, restoring automatic high-contrast detection |
| Reduced motion | Follows the system setting: map zoom, pulse and label animation are skipped |
| Keyboard | Tab completes at the prompt, but on an empty prompt it moves focus on, and Shift+Tab always does, so the terminal never traps the keyboard. The share buttons are real buttons with names (`Copy the address 8.8.8.8`) and say "copied" in place; screen readers hear what was copied, Tab's matches and Ctrl+R's finds |
| Screen readers | One spoken summary per result plus every error, instead of each line as it types out |
| Non-color cues | Errors and notes carry `ERR` / `NOTE` tags; status colors avoid red-vs-green |
| Windows High Contrast | Forced-color mode is respected; effects are dropped |

Every text color in every theme meets WCAG AA contrast (4.5:1) against both backgrounds; the
high-contrast theme is 10:1 or better. Saved settings are applied by `public/prefs.js` before the
page paints, so there is no flash of the default theme. Settings live in the visitor's browser only.

## Icons

`favicon.svg` is the source. `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and
`site.webmanifest` cover browsers, iOS home screens and Android installs.

## Request limits

The Worker only runs for pages and the API (`run_worker_first` in `wrangler.toml`). CSS, JavaScript,
fonts, images and map data are served directly by Cloudflare, which is free and unlimited, and get their
headers from `public/_headers`. A first visit costs 1 Worker request (the homepage carries the visitor's
address, so the terminal doesn't call the API) and each further lookup or page 1, so the free plan's 100,000
requests a day covers up to about 100,000 visits. Every curl call (`/help`, `/asn`, `/8.8.8.8/org`, a
`?format=text` lookup) is one request too; `/openapi.json`, `/llms.txt` and `/opensearch.xml` are not. A search
through `/go` is one request for the redirect plus the page it lands on (the redirect itself makes no outside call). A `leaktest` costs two (`/api/check`
and, once the DNS leak test is set up, `/api/dnsleak`), plus one for the other IP version's lookup when there is one; its `/cdn-cgi/trace` read and a shared result page's images are free. A shared result page (`/leaktest/r/<code>`) is one request. `ping` costs nothing: it times requests to `/cdn-cgi/trace`,
which Cloudflare's edge answers before the Worker runs. The Workers Paid plan ($5/month) includes 10 million
requests. `/me`, `/line` and `/expect/...` are one request each, with no other cost: no subrequest, no Durable
Object call, no rate-limiter call.

**If you add a new static file** (an image, a script, like `cidr.js` was), add a `"!/<file>"` line to `run_worker_first`
so it doesn't count against the limit. Watch usage under **Workers & Pages → ipterm → Metrics**.

**What crawling the network pages costs.** The sitemap lists 10,000 ASN pages, each linking up to 30 prefixes to
`/cidr` and up to 5 upstreams to other ASN pages. None of them ever reaches IPinfo or proxycheck.io. Measured under
`wrangler dev` (subrequests by wrapping `fetch` and the Cache API; CPU time by running the Worker's own code in Node
with RIPEstat's answers replayed, on a laptop, so treat it as an estimate):

| Request | Subrequests (uncached / cached) | CPU time (uncached / cached) |
| --- | --- | --- |
| `/cidr/<public prefix>` page | 6 (4 RIPEstat, 2 cache) / 1 | about 1 ms (IPv6 about 2.4 ms) / 0.3 ms |
| `/cidr/<private range>` page | 0 | under 0.5 ms |
| `/AS<n>` page | 10 (3 RIPEstat, up to 5 names, 2 cache); 5 when the neighbour list is too large / 1 | 2 to 6 ms; 12 ms for AS13335, the largest prefix list (5,776 prefixes) / 0.3 ms; the private-holder check adds about 3 ms the first time in an isolate, then microseconds |
| `/sitemap-asn-2.xml` (9,000 URLs, 486 KB) | 0 | about 7 ms the first time in an isolate, then kept |

Every one counts as one Worker request. An ASN page used to sort its prefixes with `localeCompare(..., { numeric:
true })`, which builds a collator on every comparison: a quarter of a second of CPU for AS13335, far past the Workers
limit. `largestFirst()` now sorts only the sizes it shows, on numeric keys. RIPEstat allows 8 concurrent requests
from one address; one page makes at most 5 at once. Consider registering the `sourceapp=ipterm` identifier the
Worker sends with stat@ripe.net, as RIPEstat asks of regular users, before a large crawl.

## Security

| Protection | Where | How to change it |
| --- | --- | --- |
| Rate limit: 30 uncached lookups per minute per visitor IP (per /64 network for IPv6, so rotating addresses doesn't help), then HTTP 429. Cached pages are never limited, so search crawlers can read them | `[[ratelimits]]` in `wrangler.toml` | Edit `limit` (period must be 10 or 60 seconds) |
| Port checks: only the visitor's own address, one port at a time, only from the ipterm page (same-origin) or a command-line tool, never on page load; 10 a minute per address (`PORT_LIMITER`) | `portRoute()` in `src/worker.js`, `[[ratelimits]]` | See "Port checker" |
| DNS leak test: `/api/dnsleak` only from the ipterm page or a command-line tool, well-formed tokens only, rate limited; the VPS's API needs the `DNSLEAK_KEY` secret (compared in constant time), listens on 127.0.0.1 behind Caddy, hands each token's resolvers over once and forgets them; non-public resolver addresses never go to IPinfo | `dnsleakRoute()` in `src/worker.js`, `dnsleak-server/` | See "DNS leak test server" |
| Shared leak test results: the code is made in the browser and holds only the grade and per-check flags (no IP, provider, location or resolver); the Worker decodes it strictly (a letter that doesn't match its checks is a 404); the page never runs the test, and isn't indexed | `public/leakgrade.js`, `leakShareRoute()` in `src/worker.js` | See "Shared results" |
| Every value from DNS or a data provider is HTML-escaped; the JSON embedded in pages cannot break out of its script tag; page text is inserted with replacer functions so `$` sequences stay literal | `esc()`, `safeJson()` and `shell()` in `src/worker.js` | |
| Plain-text answers (`?format=text`, one-value endpoints, `/line`, `/expect`, the `/me` card) have control characters and bidi overrides replaced, so upstream data can't send escape sequences to a terminal. The `/me` card's only escape sequences are its own colors | `plain()` in `src/worker.js`, `meRoute()` | |
| Upstream data is checked before use: AS numbers must look like `AS123`, abuse emails must be plain addresses (no `mailto:` extras), registry responses are read with a size cap, and the registrar link is only followed to a public https host, without redirects | `provider()`, `validEmail()`, `readJson()`, `safeRdapLink()` in `src/worker.js` | |
| The mail check's one outside fetch, the MTA-STS policy, goes only to `https://mta-sts.<domain>/.well-known/mta-sts.txt` for a validated domain name: no redirects followed, 5-second limit, 64 KB cap. Policy lines, report addresses and logo links are checked before use (host names, plain emails, https URLs only) | `stsPolicy()`, `parseSts()`, `reportUris()`, `httpsUrl()` in `src/worker.js` | |
| Cross-site browser access (CORS) off by default. Only the static `/openapi.json` and `/llms.txt` allow any origin | `PUBLIC_API` in `wrangler.toml`; `public/_headers` for the two documents | Set to `"true"` to offer a public browser API |
| Private, loopback, CGNAT, multicast and documentation addresses rejected before any upstream call | `nonPublicReason()` in `src/worker.js` | |
| Redirects for router-address typos take their Location from `SITEMAP_PATHS`, never from the request, so they can't be pointed anywhere else; the query string is dropped | `routerTypo()` in `src/worker.js`, tested by `tools/check_seo.sh` | |
| RIPEstat answers are read with a size cap (a big network's answer can run to megabytes, which would use up the CPU limit), the AS paths come from three collectors only, and every value is checked before use (AS numbers, prefixes, dates) | `ripestat()`, `routeLookup()`, `upstreams()` in `src/worker.js` | |
| Strict Content-Security-Policy (no inline scripts or styles; the only outside hosts are ipify, for the visitor's other IP version, and, once the DNS leak test is set up, `https://*.dl.ipterm.net` (the configured zone) for its lookups; forms may only submit to this site), nosniff, no framing, HSTS, no referrer, locked-down browser permissions | `secure()` and `cspFor()` in `src/worker.js` | Loosen the CSP if you add ads or analytics |
| Address-bar search (`/go`) redirects only to a path on this site, built from parsed values, never from the input; hostile input is a 400 | `goTarget()` and `goLocation()` in `src/worker.js`; `tools/check_go.sh` | See "Address-bar search" |
| Only GET and HEAD accepted | `route()` in `src/worker.js` | |
| IPinfo token kept server-side as a secret | `wrangler secret put` | |
| proxycheck.io key kept server-side as a secret, masked in logs; its answers validated field by field (VPN name limited to plain letters, digits and punctuation) | `wrangler secret put`, `parseProxycheck` | |
| `/status` (budget counts) answers only with the `STATUS_KEY` secret, compared in constant time; without it, an ordinary 404 | `statusKeyOk()` in `src/worker.js` | `wrangler secret put STATUS_KEY`; delete the secret to turn it off |

Notes:

- The rate limiter is counted per Cloudflare location, so it is a strong brake on abuse rather than an exact count.
  For a second layer, add a rate-limiting rule for `/api/*` in the Cloudflare dashboard under **Security → WAF**.
- Each `namespace_id` in `wrangler.toml` (`1001` for `LOOKUP_LIMITER`, `1002` for `PORT_LIMITER`) must be unique
  within your Cloudflare account and different from each other. Rate limiters that share a `namespace_id` share
  counters, so change either one if your account already uses it.
- The CSP blocks every third-party host. Ad networks and analytics need their domains added to
  `script-src`, `connect-src`, `img-src` and possibly `frame-src`.
- The Worker stores and logs nothing about visitors. If you turn on Workers Logs or add analytics or ads,
  publish a privacy policy: IP addresses count as personal data under GDPR.

## When something fails

Every call to an outside service (IPinfo, RIPEstat, the registries, DNS) has a time limit and is retried
once after a short pause, so brief hiccups don't reach visitors. If IANA's registry directory is down,
whois falls back to rdap.org. When a lookup still fails, the visitor sees "A data source didn't respond"
and the Worker logs which service failed. Watch live with:

```sh
npx wrangler tail
```

Logs name the service and error only: never the visitor's IP or your API token.

## Local development

```sh
npx wrangler dev
```

`sh tools/check_previews.sh` (link previews and crawlers get pages, scripts get JSON) and `sh tools/check_go.sh`
(address-bar search, hostile inputs included) run against it.

Note that `request.cf` location data is limited when running locally, and `ping` says it can't run there:
it needs Cloudflare's edge, which answers `/cdn-cgi/trace` on the deployed site. The port check sees
your address as `127.0.0.1` locally, so it answers "not tested". `wrangler dev` passes a
`CF-Connecting-IP` header through (Cloudflare's network replaces it), so sending your own public address
in it exercises the whole check locally.

Two scripts check a running copy (`wrangler dev` by default, or pass the site's address): `tools/check_previews.sh`
(link previews and crawlers get HTML, curl gets JSON) and `tools/check_seo.sh` (typo redirects with valid, typo and
hostile paths, noindex on non-public addresses and on the ASN, whois and `/cidr` pages that name a network holder who
may be a private person, such an upstream listed by number only, the sitemap index and its URL counts; `ROUTES=1`
adds the routing section). Neither makes an IPinfo lookup; the ASN pages and the routing section ask RIPEstat, and
the whois pages RDAP. In Git Bash on Windows, run them with `MSYS_NO_PATHCONV=1` so paths like
`/192.168.l.l` aren't rewritten.

## License

The code is MIT-licensed (`LICENSE`). If you'd rather it name you, change "the ipterm authors" there. Other parts
keep their own terms: the fonts in `public/fonts/` are under the SIL Open Font License (license files alongside),
the map outlines in `public/land.js` (and the land mask made from them) are from Natural Earth, public domain, and
IPinfo's data comes with its own attribution condition (see "Recommended: add a free IPinfo token").

## Next steps worth considering

- City-level data for every lookup: upgrade to IPinfo Core, or swap the provider function for another API.
- Bulk lookups.
- IPv6 for the DNS leak test server (`DNSLEAK_NS_IPV6` and an AAAA record for `ns1.dl`), so resolvers that
  prefer IPv6 show their IPv6 addresses too.
- `/<ip>` pages name the address's network too ("operated by ..."), from IPinfo, next to its location, and crawlers
  reach them through links on `/whois/<ip>` and `/dns` pages. `personName(d.org)` in `ipPage()` would decide them the
  same way; it isn't done because checking it costs IPinfo lookups, which `tools/check_seo.sh` never makes.
- Some large businesses still look like people to the rules, because their names have no legal form, place or
  business word: in October 2026 AS17858 ("LG POWERCOMM"), AS8167 and AS7738 (V.tal, written "V tal"), AS1906
  (Northrop Grumman) and AS13692 ("Douglas FastNet", whose first word is a given name). Their pages are noindex, they
  are out of the ASN sitemap, and indexed pages list them as upstreams by number only. The rules can't tell these
  from a person's name without letting people through; a short list of reviewed AS numbers that are organizations,
  in `src/holder-heuristic.js` so the tool and the Worker agree, would bring them back.
- Domain whois pages show a registrant's name when the registrar publishes one, often a person's. The same caution
  could apply in `domainWhoisPage()`, though the rules were written for network holders' names.
