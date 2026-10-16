# ipterm

A terminal-style IP lookup site that runs on a single Cloudflare Worker.

- The page: `public/index.html`, `public/app.css`, `public/app.js` (no build step)
- Map data: `public/land.js` (simplified land outlines and country sizes from
  [Natural Earth](https://www.naturalearthdata.com/), public domain, via world-atlas)
- Fonts: `public/fonts/` (self-hosted, SIL Open Font License, licenses included)
- The API, routing and security headers: `src/worker.js`
- Settings: `wrangler.toml`

## Deploy

You need Node 18+ and a free Cloudflare account.

```sh
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints your URL, something like `https://ipterm.<you>.workers.dev`.
To use your own domain, add it under the Worker's **Settings → Domains & Routes**
in the Cloudflare dashboard.

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
own location comes from Cloudflare), DNS, whois, the subnet calculator and the command line's one-value
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

Lookups of other IPs are cached at the edge for six hours.

### The map

Each result with a location gets a dot-matrix map drawn on a canvas, with no map service involved.
It marks the reported point and draws a ring for the uncertainty:

- City-level results (your own IP, or other IPs without a token) get a 50 km "approximate area" ring.
  IP location usually points at the ISP's hub, so treat the ring as a hint, not a boundary.
- Country-level results (IPinfo Lite) get a ring sized to the country, centered on its main landmass.

Change the 50 km default with `CITY_KM` near the top of the map section in `public/app.js`.

Private, loopback, CGNAT and documentation ranges are detected in the browser and never hit the API.

## Routes

Every IP and network has its own address. Browsers get a full page; curl and scripts get JSON.

```sh
curl https://your-domain              # your IP as plain text
curl https://your-domain/json         # your details as JSON
curl https://your-domain/8.8.8.8      # any IP as JSON
curl https://your-domain/AS13335      # any network (ASN) as JSON
curl -4 https://your-domain/port/22   # is TCP port 22 open on your own IP? (see "Port checker")
curl https://your-domain/help         # the command-line reference as plain text
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
`$(curl -s ...)` is empty. Because a second line would break `$(curl ...)`, the IPinfo credit for these rides in
an `x-attribution` response header instead (it is in `/help`, `/api`, the OpenAPI file and `llms.txt` too).

**Aligned text instead of JSON:** add `?format=text` to `/`, `/json`, `/<ip>`, `/AS<number>`, `/dns/...`,
`/whois/...`, `/cidr/...` (and their `/api/...` forms) for key/value lines like the terminal draws.
Browsers get the text too. Results that include IPinfo data end with `IP address data powered by IPinfo
(https://ipinfo.io)`, as IPinfo's free-data terms ask. JSON stays the default for command-line clients,
and `curl ipterm.net` still prints the bare address. Shells such as zsh treat `?` as a wildcard, so the
reference quotes those URLs: `curl 'ipterm.net/8.8.8.8?format=text'`.

Text answers carry no sponsored line (that line only exists in the browser terminal), and every value
from upstream (TXT records, registry names) has control characters and bidi overrides replaced with `?`,
so a hostile record can't send escape sequences to the reader's terminal (`plain()` in `src/worker.js`).

**Machine-readable descriptions:** `public/openapi.json` (OpenAPI 3.1) and `public/llms.txt` are static files,
listed in `run_worker_first`'s exclusions so they don't count as Worker requests. Their links are written
for `https://ipterm.net`; change them if you deploy elsewhere. Edit them whenever a route changes.
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

### Subnet calculator

`cidr 10.0.0.0/22`, `cidr 192.168.1.10 255.255.255.0`, `cidr 2001:db8::/48`, or just type a range. It shows the
network and broadcast addresses, netmask, wildcard, usable host range and count, a bit diagram, and how the
block splits or combines. Pages live at `/cidr/<ip>/<prefix>` (canonicalized to the network address) and the
cheat sheet is at `/guides/subnet-cheat-sheet`. The math is in `public/cidr.js`, shared by the page and the
Worker, and makes no outside calls.

### DNS tools

`lookup example.com` (or just type a domain, or paste a URL) shows A, AAAA, MX, NS, TXT and CAA records, any
CNAME alias, who hosts the first address, and whether DNSSEC validates. `dig example.com MX` shows one record
type with TTLs (A, AAAA, CNAME, MX, NS, TXT, CAA, SOA, SRV, PTR, DS, DNSKEY, HTTPS); `dig 8.8.8.8` does a
reverse lookup. A null MX (`0 .`, RFC 7505: the domain accepts no mail, as on example.com) shows as
`0 . (accepts no mail: null MX)`, and its JSON `value` is `"."`. Pages live at `/dns/<domain>` and
`/dns/<domain>/<TYPE>`; curl gets JSON. Answers come from
Cloudflare's public resolver (1.1.1.1) and are cached for five minutes. International domain names are
converted to their punycode form automatically.

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

`leaktest` in the terminal, or the page `/leaktest` (which runs it on load), checks whether the
browser gives away more than its IP address. Each line is marked OK, LEAK or INFO:

- **VPN detection:** IPinfo Core's classification of the visitor's IP (VPN/proxy/Tor, hosting
  flag, or a network whose type is hosting), plus proxycheck.io's when `PROXYCHECK_KEY` is set
  (which can name the VPN service). Without either, this line says it wasn't checked. An
  unflagged address on a home or mobile provider's network (IPinfo type "isp", a mobile network,
  or proxycheck.io's "Residential" / "Wireless") is reported plainly as "no VPN", since commercial
  VPN servers run in data centers. Any other unflagged address stays hedged. An
  unlisted IP isn't treated as proof of no VPN: mismatches below still carry "(a leak if you use
  a VPN)", just marked INFO instead of LEAK. proxycheck.io's `anonymous` or `compromised` flag
  alone (see the table above) doesn't count as a VPN: on a hosting network the address counts as
  one anyway, as any hosting address does; elsewhere the tag says "vpn unclear" and the check
  treats it like an address it couldn't classify (mismatches marked LEAK, with the "if you use a
  VPN" caveat), and the sponsored line shows, since no VPN was detected.
- **WebRTC:** asks Cloudflare's public STUN server (`stun.cloudflare.com:3478`) which public
  addresses the browser reveals, and flags any that differ from the IP websites see.
- **IPv6 / IPv4:** compares the network of the visitor's other IP version (via ipify) with the one
  they connected over. On a VPN, a different network means that traffic bypasses the VPN.
- **Time zone:** the device's time zone versus the IP's location (compared by UTC offset).

Findings count as LEAK only when the visitor appears to be on a VPN; otherwise the same facts are
shown as INFO. DNS leaks are not tested (that needs a custom DNS server). Nothing is stored. The
visitor's own IP is sent to IPinfo only when they run the check (it uses the Core daily budget),
and the privacy policy says so. When no VPN is detected, the verdict is always followed by the
sponsored line (any sponsor with `"check"` in its `on` list in `sponsors.json`, currently Proton VPN).

### Port checker (port)

`port 25565` in the terminal, or `curl -4 ipterm.net/port/25565` from a command line, answers "is this port
open on my IP?". The Worker opens one TCP connection (`connect()` from `cloudflare:sockets`) to
`cf-connecting-ip`, the address Cloudflare saw the request come from, on that one port. It sends nothing,
closes the connection at once and stores nothing. `port <n> --info` explains a port without checking it,
and `port` on its own lists the common ports.

| Result | Meaning |
| --- | --- |
| open | the connection was accepted |
| closed | it was refused (a reset): it reached the address, but nothing there accepted it |
| no answer | nothing within 5 seconds: a router or firewall dropped it, which is what most home routers do with a port they don't forward |
| not tested | port 25 (Cloudflare blocks it), Cloudflare's own addresses (WARP, the 1.1.1.1 app, iCloud Private Relay), non-public addresses |

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
- `/api/port?n=` and `/port/<n>` check only for same-origin requests (`Sec-Fetch-Site: same-origin`, or
  a matching `Origin`) and command-line user agents (`CLI_UA`). Everything else gets HTTP 403, so other
  sites can't make their visitors' browsers start checks.
- The `/port/<n>` pages explain the port and offer a button in the terminal. Nothing is tested on page
  load, on Back/Forward, for prefetches, crawlers or link previews.
- `PORT_LIMITER` (`[[ratelimits]]`, namespace `1002`): 10 checks a minute per address (IPv6 per /64),
  apart from the 30-lookup limit. Checks that are refused up front (port 25, Cloudflare, non-public
  addresses) make no connection and don't count.

**Pages:** `/port` lists the common ports. `/port/<n>` explains each of the 42 ports in `public/ports.js`
(SSH, RDP, Plex, Minecraft, game, NAS and remote-access ports): what it's for, why it may be closed and
any risk in opening it. Other port numbers get a short page marked `noindex`. `public/ports.js` is
shared by the page and the Worker, like `cidr.js`; add a port by adding a line to its `LIST`.

**IPv4, IPv6 and dual stack.** What testing on Cloudflare (`wrangler dev --remote`) showed:

- `connect()` reaches IPv6 addresses, but only written in brackets (`[2001:db8::1]`); a bare IPv6
  literal is refused with the same error as a blocked address. `probePort()` adds the brackets.
- Port 25 throws at `connect()` ("Connections to port 25 are prohibited"), and Cloudflare's own addresses
  are refused at once ("proxy request failed, cannot connect to the specified address"). Both are
  recognized beforehand (port number; network AS13335 / AS209242 or Cloudflare's published ranges), so
  visitors get an explanation rather than a false "closed".
- A port that a router drops never opens, so it shows as "no answer" after 5 seconds. A refusal (reset)
  ends the connection attempt at once (seen under `wrangler dev`); the test connection's router drops
  everything, so a reset couldn't be observed on Cloudflare's network itself.
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
  don't ask for `text/html`, so shared links preview with a title and image. They're matched by
  name (`PREVIEW_UA` in `src/worker.js`); curl, scripts and other clients still get JSON.
- Private addresses like `/192.168.1.1` get a page explaining the range and how to reach a router,
  a popular search topic, without any upstream lookup.
- `/whois`, `/dns` and `/cidr` on their own are landing pages for each tool (what it does, usage and
  example links), and typing `whois`, `dig` or `cidr` with nothing after it shows the same thing.
  `/api` is the API docs page (the terminal runs `api`; the plain-text reference stays in the HTML for
  visitors without JavaScript), and it is in the sitemap.
- Addresses that don't exist get a 404 page in the terminal's style with a "did you mean" link when
  the address looks like an IP, ASN or domain. A domain typed straight after the slash
  (`/github.com`) redirects to its DNS page. Invalid lookups (`/whois/not-a-domain!`) show the error
  in the terminal instead of raw JSON. None of these pages are indexed by search engines.
- Inside the terminal, every lookup updates the address bar, Back/Forward replay results, ASNs and
  prefixes are clickable, and the `share` command copies the current link. Prefixes on ASN pages
  open the subnet calculator (`/cidr/<prefix>`), which makes no outside calls, so crawlers following
  them don't spend the IPinfo budget.
- `/robots.txt` and `/sitemap.xml` are generated. Add popular pages to `SITEMAP_PATHS` in
  `src/worker.js`, then submit the sitemap in Google Search Console.

Network data comes from [RIPEstat](https://stat.ripe.net/) (free, no key). Results are cached for six hours.

## Guides and search

- **Guides** live at `/guides` and `/guides/<name>`. They're generated from `tools/build_guides.py`: edit the
  text there, run `python3 tools/build_guides.py`, then deploy. Each page gets its own title, description,
  canonical link, share tags, breadcrumbs and Article structured data.
- **Homepage section:** plain HTML below the terminal (in `public/index.html`) explains ipterm and links to
  popular lookups and the guides, so search engines see real text and links. Clicking a lookup there runs it
  in the terminal.
- **Share image:** `public/og.png` (1200×630) is used when any page is shared.
- **Placeholders:** static pages use `%ORIGIN%`, which the Worker replaces with your site's address.
- **Sitemap:** generated at `/sitemap.xml` from `SITEMAP_PATHS` in `src/worker.js` (guides, router addresses,
  public DNS resolvers, major networks and the most searched port pages).

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

Targeting by result type works without tracking: a VPN offer fits `check`, a hosting offer fits `asn`.
`whoami` has no VPN signal, so a VPN offer on `whoami` is also shown to visitors who are already on a VPN;
`check` only appears when leaktest finds no VPN.
Affiliate programs (VPNs, hosting, dev tools) and direct sponsors both work: put the referral link in `url`.
In the US, the FTC requires affiliate and sponsored links to be disclosed; the `sponsored` tag does that.

**Placement sub-ID.** The Proton VPN link ends in `&aff_sub=leaktest`. Proton's affiliate links run on TUNE
(formerly HasOffers, the `go.getproton.me/aff_c` address), where `aff_sub` is the first of five sub-ID fields
that stats reports can be grouped by. So clicks and sign-ups from the leaktest line can be told apart from
any others. The value names the placement, never the visitor: it's the same for everyone who sees the line,
as the privacy policy says. To show a sponsor in a second place, give it a second entry with its own `on`
list and its own value (`aff_sub=whoami`), rather than adding to `on`, which would credit both places to
`leaktest`. Never put anything per visitor in it. TUNE itself warns against unique values in `aff_sub`.

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
`?format=text` lookup) is one request too; `/openapi.json` and `/llms.txt` are not. `ping` costs nothing: it times requests to `/cdn-cgi/trace`,
which Cloudflare's edge answers before the Worker runs. The Workers Paid plan ($5/month) includes 10 million
requests.

**If you add a new static file** (an image, a script, like `cidr.js` was), add a `"!/<file>"` line to `run_worker_first`
so it doesn't count against the limit. Watch usage under **Workers & Pages → ipterm → Metrics**.

## Measuring

ipterm runs no analytics, beacons or Workers Analytics Engine, and the privacy policy promises as much
("runs no analytics or tracking"). Adding any of them changes that promise, so it's the owner's decision,
and the policy is updated first. Everything below comes from places that need nothing on the page:
Cloudflare's dashboards, the search engines' webmaster tools, the affiliate dashboard and `/status`.
What visitors do once they arrive (which commands, lookups per visit) is deliberately not measured.

### Primary metric and guardrails

**Primary: Google Search clicks per week, whole site** (Search Console → Performance → Search results).
It counts people, not crawlers or scrapers (which inflate request counts). It has 16 months of history,
so a "before" exists for any change. And it isn't skewed by request accounting: a homepage visit now costs
one Worker request instead of two, which lowers request counts without any change in visitors.

**Guardrails.** If one of these goes bad, fix it before reading anything into the primary metric:

| Guardrail | Where | Healthy | When it isn't |
| --- | --- | --- | --- |
| Worker requests a day | Workers metrics | Busiest day under 70,000 (70% of the Free plan's 100,000) | Look for a scraper, or move to Workers Paid ($5/month, 10 million a month). Past 100,000, requests fail until 00:00 UTC |
| Worker errors | Workers metrics | Close to zero | `npx wrangler tail` shows which service failed |
| CPU time | Workers metrics | Median well under the Free plan's 10 ms a request | Near 10 ms, "Exceeded Resources" errors follow |
| 429 rate (rate-limited answers) | GraphQL query below | Under 1% of requests | A scraper, or the 30-a-minute limit is too tight for real use |
| Core fallback | `/status`, `pastDays` | No hours run out on most days, and the day never runs out | Raise `IPINFO_HOURLY_BUDGET` if the monthly quota allows, or look for a scraper. The same goes for proxycheck.io |
| Durable Object use | Dashboard, Durable Objects (under Storage & databases) | Far below the Free plan's 100,000 requests and 100,000 rows written a day | Past either, the budget counter fails and every lookup falls back to Lite |

### Checklist for a 4-week baseline

Search Console keeps 16 months, so its "before" numbers can be read at any time. Cloudflare's Free plan keeps
about 30 days and Proton's sub-ID split starts with the new link, so write those down before a deploy you
want to judge. Then fill in one row per source once a week, on the same weekday, for four weeks. Use a
spreadsheet, not anything on the site.

**Once:**

- [ ] `npx wrangler secret put STATUS_KEY` (see "Budget status for the owner: /status" above), then check
      `curl -H "x-status-key: <your key>" https://ipterm.net/status` answers, and that `/status` without it is a 404.
- [ ] **Google Search Console:** add a *Domain* property for `ipterm.net` (verified with a DNS TXT record; for a
      Cloudflare domain, Search Console offers to add it for you), then submit `https://ipterm.net/sitemap.xml`
      under Sitemaps.
- [ ] **URL Inspection** in Search Console for `/`, `/8.8.8.8`, `/AS13335`, `/whois`, `/leaktest` and `/api`:
      *Test live URL* → *View tested page*. In the HTML tab, check that the title, the h1, the plain summary
      and the BreadcrumbList are in the rendered HTML. In the screenshot, check that the page looks right.
      Repeat after deploys that touch page markup.
- [ ] **Bing Webmaster Tools:** add `https://ipterm.net` and verify with the XML file option:
      `public/BingSiteAuth.xml` is already served at `/BingSiteAuth.xml`. (Bing can also import the site
      from Search Console.) Submit the sitemap there too.
- [ ] **Proton affiliate dashboard:** find the report that can be grouped by sub-ID (`aff_sub`), and after the
      deploy, check that clicks show up under `leaktest`. Clicks with no sub-ID come from older copies of the link.
- [ ] **For the 429 guardrail:** create a Cloudflare API token with *Analytics: Read* for the zone, and note the
      zone ID (on the zone's Overview page).

**Every week:**

| Source | Where | Write down |
| --- | --- | --- |
| Workers metrics | Workers & Pages → ipterm → Metrics, last 7 days | Requests a day (busiest and average), errors, CPU time (median and the highest percentile shown) |
| Zone analytics | ipterm.net → Analytics & Logs → HTTP Traffic, last 7 days | Requests and unique visitors. Free plans show no status codes or paths here; Pro and up can filter by them |
| 429s | The GraphQL query below, one day per query | Count of `429` against all requests for each day, as a percentage |
| Google Search Console | Performance → Search results, last 7 days (Compare with the previous period) | Clicks, impressions, CTR and position for the whole site, then for each of `/`, `/whois`, `/dns`, `/cidr`, `/leaktest`, `/api` (Page filter, *Exact URL*). For page groups, use *Custom (regex)*: `^https://ipterm\.net/AS\d+$` (networks), `/dns/`, `/whois/`, `/cidr/`, `/guides/`. Also Indexing → Pages: indexed count, and any new reason for pages not being indexed |
| Bing Webmaster Tools | Search Performance, last 7 days | Clicks and impressions; indexed pages |
| Proton affiliate dashboard | Stats grouped by sub-ID, last 7 days | Clicks, sign-ups and earnings for `leaktest` (and for no sub-ID) |
| `/status` | `curl -H "x-status-key: <your key>" "https://ipterm.net/status?format=text"` | From `past days`, each day's Core and proxycheck.io lookups, hours run out, and whether the day ran out |

Unique visitors in zone analytics count addresses, crawlers included, so treat Worker requests ÷ unique
visitors as a rough engagement hint. Compare it only between weeks with the same deployed code.

**429s from the GraphQL Analytics API.** Free plans can't see status codes in the dashboard, but the
`httpRequestsAdaptiveGroups` dataset is open to every plan, one day per query. Run it once per day of the week:

```sh
curl -s https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer <analytics token>" -H "Content-Type: application/json" \
  --data '{"query":"{ viewer { zones(filter: {zoneTag: \"<zone id>\"}) { httpRequestsAdaptiveGroups(limit: 50, filter: {datetime_geq: \"2026-11-02T00:00:00Z\", datetime_lt: \"2026-11-03T00:00:00Z\"}, orderBy: [count_DESC]) { count dimensions { edgeResponseStatus } } } } }"}'
```

It lists requests by status code for that day; add them up for the total, and divide the `429` count by it.
This query wasn't run when this section was written. If the API rejects a field or the date range, ask the
zone's `settings { httpRequestsAdaptiveGroups { enabled maxDuration notOlderThan } }` node what your plan
allows (`notOlderThan` is how many seconds back you can query).

## Security

| Protection | Where | How to change it |
| --- | --- | --- |
| Rate limit: 30 uncached lookups per minute per visitor IP (per /64 network for IPv6, so rotating addresses doesn't help), then HTTP 429. Cached pages are never limited, so search crawlers can read them | `[[ratelimits]]` in `wrangler.toml` | Edit `limit` (period must be 10 or 60 seconds) |
| Port checks: only the visitor's own address, one port at a time, only from the ipterm page (same-origin) or a command-line tool, never on page load; 10 a minute per address (`PORT_LIMITER`) | `portRoute()` in `src/worker.js`, `[[ratelimits]]` | See "Port checker" |
| Every value from DNS or a data provider is HTML-escaped; the JSON embedded in pages cannot break out of its script tag; page text is inserted with replacer functions so `$` sequences stay literal | `esc()`, `safeJson()` and `shell()` in `src/worker.js` | |
| Plain-text answers (`?format=text`, one-value endpoints) have control characters and bidi overrides replaced, so upstream data can't send escape sequences to a terminal | `plain()` in `src/worker.js` | |
| Upstream data is checked before use: AS numbers must look like `AS123`, abuse emails must be plain addresses (no `mailto:` extras), registry responses are read with a size cap, and the registrar link is only followed to a public https host, without redirects | `provider()`, `validEmail()`, `readJson()`, `safeRdapLink()` in `src/worker.js` | |
| Cross-site browser access (CORS) off by default. Only the static `/openapi.json` and `/llms.txt` allow any origin | `PUBLIC_API` in `wrangler.toml`; `public/_headers` for the two documents | Set to `"true"` to offer a public browser API |
| Private, loopback, CGNAT, multicast and documentation addresses rejected before any upstream call | `nonPublicReason()` in `src/worker.js` | |
| Strict Content-Security-Policy (no inline scripts or styles; the only outside host is ipify, for the visitor's other IP version), nosniff, no framing, HSTS, no referrer, locked-down browser permissions | `secure()` in `src/worker.js` | Loosen the CSP if you add ads or analytics |
| Only GET and HEAD accepted | `route()` in `src/worker.js` | |
| IPinfo token kept server-side as a secret | `wrangler secret put` | |
| proxycheck.io key kept server-side as a secret, masked in logs; its answers validated field by field (VPN name limited to plain letters, digits and punctuation) | `wrangler secret put`, `parseProxycheck` | |
| `/status` (budget counts) answers only with the `STATUS_KEY` secret, compared in constant time; without it, an ordinary 404 | `statusKeyOk()` in `src/worker.js` | `wrangler secret put STATUS_KEY`; delete the secret to turn it off |

Notes:

- The rate limiter is counted per Cloudflare location, so it is a strong brake on abuse rather than an exact count.
  For a second layer, add a rate-limiting rule for `/api/*` in the Cloudflare dashboard under **Security → WAF**.
- `namespace_id` in `wrangler.toml` must be unique within your Cloudflare account. Change it if you already use `1001`.
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

Note that `request.cf` location data is limited when running locally, and `ping` says it can't run there:
it needs Cloudflare's edge, which answers `/cdn-cgi/trace` on the deployed site. The port check sees
your address as `127.0.0.1` locally, so it answers "not tested". `wrangler dev` passes a
`CF-Connecting-IP` header through (Cloudflare's network replaces it), so sending your own public address
in it exercises the whole check locally.

## Next steps worth considering

- City-level data for every lookup: upgrade to IPinfo Core, or swap the provider function for another API.
- VPN / proxy detection, bulk lookups, and a DNS / WebRTC leak test page.
