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
curl https://your-domain/mail/gmail.com  # a domain's email security (SPF, DMARC, DKIM), graded
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
`/mail/...`, `/whois/...`, `/cidr/...` (and their `/api/...` forms) for key/value lines like the terminal draws.
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
| DKIM | | an RSA key under 2048 bits | no key at the selectors tried; a revoked key |
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
minute. No IPinfo or proxycheck.io budget is ever used.

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
- `/whois`, `/dns`, `/mail` and `/cidr` on their own are landing pages for each tool (what it does, usage and
  example links), and typing `whois`, `dig`, `mail` or `cidr` with nothing after it shows the same thing.
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
  public DNS resolvers and major networks).

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

## Security

| Protection | Where | How to change it |
| --- | --- | --- |
| Rate limit: 30 uncached lookups per minute per visitor IP (per /64 network for IPv6, so rotating addresses doesn't help), then HTTP 429. Cached pages are never limited, so search crawlers can read them | `[[ratelimits]]` in `wrangler.toml` | Edit `limit` (period must be 10 or 60 seconds) |
| Every value from DNS or a data provider is HTML-escaped; the JSON embedded in pages cannot break out of its script tag; page text is inserted with replacer functions so `$` sequences stay literal | `esc()`, `safeJson()` and `shell()` in `src/worker.js` | |
| Plain-text answers (`?format=text`, one-value endpoints) have control characters and bidi overrides replaced, so upstream data can't send escape sequences to a terminal | `plain()` in `src/worker.js` | |
| Upstream data is checked before use: AS numbers must look like `AS123`, abuse emails must be plain addresses (no `mailto:` extras), registry responses are read with a size cap, and the registrar link is only followed to a public https host, without redirects | `provider()`, `validEmail()`, `readJson()`, `safeRdapLink()` in `src/worker.js` | |
| The mail check's one outside fetch, the MTA-STS policy, goes only to `https://mta-sts.<domain>/.well-known/mta-sts.txt` for a validated domain name: no redirects followed, 5-second limit, 64 KB cap. Policy lines, report addresses and logo links are checked before use (host names, plain emails, https URLs only) | `stsPolicy()`, `parseSts()`, `reportUris()`, `httpsUrl()` in `src/worker.js` | |
| Cross-site browser access (CORS) off by default. Only the static `/openapi.json` and `/llms.txt` allow any origin | `PUBLIC_API` in `wrangler.toml`; `public/_headers` for the two documents | Set to `"true"` to offer a public browser API |
| Private, loopback, CGNAT, multicast and documentation addresses rejected before any upstream call | `nonPublicReason()` in `src/worker.js` | |
| Strict Content-Security-Policy (no inline scripts or styles; the only outside host is ipify, for the visitor's other IP version), nosniff, no framing, HSTS, no referrer, locked-down browser permissions | `secure()` in `src/worker.js` | Loosen the CSP if you add ads or analytics |
| Only GET and HEAD accepted | `route()` in `src/worker.js` | |
| IPinfo token kept server-side as a secret | `wrangler secret put` | |
| proxycheck.io key kept server-side as a secret, masked in logs; its answers validated field by field (VPN name limited to plain letters, digits and punctuation) | `wrangler secret put`, `parseProxycheck` | |

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
it needs Cloudflare's edge, which answers `/cdn-cgi/trace` on the deployed site.

## Next steps worth considering

- City-level data for every lookup: upgrade to IPinfo Core, or swap the provider function for another API.
- VPN / proxy detection, bulk lookups, and a DNS / WebRTC leak test page.
