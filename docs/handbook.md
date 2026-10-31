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
- What each common port is for, and IANA's names for it: `public/ports.js` (see "Port checker"); the table of
  special-purpose addresses: `public/cidr.js` (see "Subnet calculator"); the public DNS resolvers, from their
  operators' own documentation: `public/resolvers.js` (see "Public DNS resolvers")
- The list of changes (`/changes`): `public/changes.js`; the GitHub issue forms behind the corrections line:
  `.github/ISSUE_TEMPLATE/` (see "Corrections and changes")
- Scripts: `tools/` (deploy, land mask, guides, ASN sitemap, and the checks: `npm test` runs those that need no
  server, as GitHub does on every push and pull request, `.github/workflows/test.yml`; see "Local development")
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
in the Cloudflare dashboard. Leave **Always Use HTTPS** (under SSL/TLS, Edge Certificates) off and add no
http-to-https Redirect Rule: the Worker sends browsers and crawlers to https itself and keeps plain http for curl
(see "One copy of the site, on https" under "Shareable pages and search").

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

Only fresh lookups count: lookups of other addresses, and `leaktest`'s check of the visitor's own address, by people
(bots never spend it: see "Bots never spend the budgets" below). Cached results (six hours), `whoami` (your visitors'
own location comes from Cloudflare), DNS, mail checks, report cards and their badges, whois, the subnet calculator and the command line's one-value
endpoints (`/asn`, `/8.8.8.8/org` and the rest, which use IPinfo Lite) never use the quota, and neither does a lookup asked
for with `?lite=1`, as `leaktest` asks for the visitor's other IP version (IPinfo Lite, no VPN check). If
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
  IPinfo hasn't already flagged. Not when a VPN provider's own list names the address (see "Known VPN
  servers" below): in `leaktest` at all, in a lookup when the list has it as an exit. Nor when Apple's iCloud Private
  Relay list has it (see "iCloud Private Relay" below), in either. Not for whoami, DNS, whois, the "hosted by" lines, the one-value
  endpoints (`/8.8.8.8/org`) or a `?lite=1` lookup (`leaktest`'s of your other IP version), and never
  for a bot, which gets a cached answer or none (see "Bots never spend the budgets" below).
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

The verdict on the **vpn / proxy** line combines these with the VPN providers' own server lists (`vpnText()` in
`src/worker.js` and `public/app.js`, kept in step), in this order:

| What the sources say | The line says |
| --- | --- |
| Apple's iCloud Private Relay list has it (see "iCloud Private Relay") | `yes: Apple's iCloud Private Relay (on Apple's own list of its relay addresses: sites see a Private Relay address, not the user's)` |
| A VPN provider's own list names the address as one its users reach sites from (none of the lists does today) | `yes: a known Mullvad VPN server (on Mullvad's own server list, as an address its users reach sites from)` |
| A VPN provider's own list names the address as one its users connect to, an entry (even when Core or proxycheck.io also flag it, or weren't asked: the provider's own word is the most specific) | `yes: a known Mullvad VPN server (on Mullvad's own server list, as an address its users connect to; sites may see them at a different address)`; a name that already says VPN gets just "server" (`a known IVPN server`, `a known AirVPN server`) |
| Core flags it, or proxycheck.io finds a VPN, proxy or Tor exit, or names the service | `yes: a known VPN address (Proton VPN)` (or proxy, Tor, or "VPN, proxy or Tor" when it isn't specific) |
| proxycheck.io's `anonymous` flag alone, with no VPN, proxy, Tor or service name | `not a known VPN, proxy or Tor service (proxycheck.io sets its catch-all "anonymous" flag, which it also gives public DNS and CDN addresses)` |
| proxycheck.io's `compromised` flag alone (seen performing attacks) | `flagged by proxycheck.io as compromised (seen performing attacks), but not as a known VPN, proxy or Tor service` |
| Neither flags it | `not on known VPN or proxy lists`, plus the hosting-network note or the "not a guarantee" note |

proxycheck.io's API reference defines `anonymous` as "any kind of anonymising service (proxy, VPN,
TOR, etc.)", and it's also set on addresses that are none of those: Google Public DNS (8.8.8.8) has
it, with only `hosting` besides. So on its own it isn't reported as a VPN, or as "anonymizing", here or in `leaktest`.
The JSON still carries the flag (`"anonymous": true` under `privacy`).

### Known VPN servers: the providers' own lists

Some VPN providers publish the list of servers their apps connect to. ipterm downloads four of these lists and checks
lookups against them, so an address on one is that provider's server, by the provider's own word rather than a
third party's guess. Nobody adds addresses by hand. Checked on 2026-10-21 (provider docs, app code and terms; counts
change from day to day):

| Provider | List | Addresses | What the addresses are | Terms |
| --- | --- | --- | --- | --- |
| Mullvad | `api.mullvad.net/public/relays/wireguard/v2/`, from the documented "Mullvad Public API" | about 1,100: 553 WireGuard servers, IPv4 and IPv6 | Entries. Mullvad's app shows a server's entry (in) and exit (out) addresses apart, its blog says each server has several exit addresses, and an independent mapping of nine servers found none of their exits in the list | Silent: they cover customers. `api.mullvad.net/robots.txt` disallows all crawlers; ipterm reads one documented endpoint four times a day (hourly at most while it has no lists at all) |
| Private Internet Access | `serverlist.piaservers.net/vpninfo/servers/v6`, the list PIA's apps and its `manual-connections` scripts read | about 1,170 IPv4 per download, and more each day: the list names a different part of PIA's servers every few minutes (half of them changed within 45 minutes on 2026-10-21) | Entries. PIA's own app code says the listed address is not necessarily the exit, and asks PIA's API for the real one after connecting. The `meta` addresses (API proxies) are skipped | Silent |
| IVPN | `api.ivpn.net/v5/servers/stats`, offered on IVPN's status page ("Live server list as JSON") | about 180 IPv4: WireGuard and OpenVPN | Entries. No field or document says which address traffic leaves from, and IVPN's knowledge base says it keeps a small pool of addresses (usually 3 to 5) per server | Silent; the feed is offered publicly |
| AirVPN | `airvpn.org/api/status/`, a documented free API (at most 600 requests per 10 minutes) | about 2,000: 250 servers, four entry addresses each, IPv4 and IPv6 | Entries. Each server sends traffic out from a separate exit address, which AirVPN's own app reads apart from the entries | Allowed: a documented free API |

Left out:

- **NordVPN.** Its terms forbid using any "robot, spider, scraper, or other automated means" to reach its websites or
  services without written permission. Its list is the one where the listed address is most likely the one sites see
  (Nord's help center says your IP changes to that of your VPN server), so it is worth asking Nord.
- **Proton VPN.** Its server list carries exit addresses, but its API answers only a request with a Proton app's
  version header, and its terms allow automated access only when it can't be told from the app. ipterm won't fake
  either.
- **Surfshark.** Its public list encrypts the addresses.

**What a match means.** None of the four lists names the addresses traffic leaves from, so every address in them is
an entry: the provider's users connect to it, and the list doesn't say that sites see them there. Mullvad and AirVPN
document separate exit addresses (for AirVPN, none of its 250 servers' exit addresses is one of its entries), PIA's
own code says its listed address is not necessarily the exit, and IVPN doesn't say. So:

- A lookup of a listed address says `yes: a known Mullvad VPN server (on Mullvad's own server list, as an address its
  users connect to; sites may see them at a different address)`: the provider first, as the owner chose, in the text
  and in the JSON (`vpnServer.provider`). That answers "is this address a VPN?" for the
  address itself, and "what are these connections my firewall sees?", but it doesn't make the addresses VPN users
  browse from easier to spot: those are still for IPinfo Core and proxycheck.io to judge. A listed address leads with
  its provider's line even when they say yes too, since the provider's own word is the most specific.
- In `leaktest`, the visitor's own address on a list means they are on that provider's server, whatever the address
  is for others: the VPN line says `your IP is a known Mullvad VPN server (on Mullvad's own server list): sites see
  that, not your provider`, it counts as a VPN, proxycheck.io isn't asked (unless the Worker couldn't read its copy of
  the lists in time: then it is asked as before), and no sponsored line follows. The listing holds when IPinfo is
  down too: like the Tor line, it is free and local. The copied Markdown hides the provider's name, as it hides
  proxycheck.io's.
- The data also has a role for an exit, an address the provider says its users reach sites from. None of the four
  lists has one today. A listed exit would come first on the line (`... on Mullvad's own server list, as an address
  its users reach sites from`) and spare the proxycheck.io query in lookups too.
- No guessing past the list: exact addresses only, never a neighbour or the /24 around one. (Mullvad's exit pools
  often share a /24 with the server's listed address, but not always, and the /24 can hold other servers.) An address
  on no list says nothing either way.

The JSON carries it as `vpnServer`, only when a list names the address, beside the other fields, which are unchanged:
`{ "provider": "Mullvad", "role": "entry", "lastSeen": "2026-10-21T06:17:02.000Z" }` (`role`: `entry` or `exit`;
`lastSeen`: when ipterm last found the address on that provider's list). Lookups (`/<ip>` and its `/text` and `/json` forms,
`/api/lookup`) have it at the top level, and leaktest's `/api/check` under `network`. The text answer's `source` line
adds `+ Mullvad's server list`. The caller's own address asked for by number, `/json` and `/text` don't carry it:
the edge answers them with no lookup at all. Its page in a browser does, and `leaktest` checks it.

**How it's kept.** One Durable Object (`VpnServers`, named `lists`) downloads the four lists when the cron trigger
fires (`[triggers]` in `wrangler.toml`: every 6 hours, at minute 17), and once by itself on a new deployment, when a
lookup finds it empty (an alarm for that list only, at most once an hour after its last try). Its own small budget: one request per list and run, no
retries (the next run is the retry), 20 seconds and a size cap (1 or 2 MB) per list, and a few tens of milliseconds
of CPU to read all four (about 150, 180, 70 and 210 KB). `src/vpn-lists.js` reads each list field by field: only
public IPv4 and global IPv6 addresses count, so a placeholder such as `2001:db8::1` is skipped.

What is kept is every address seen on a provider's list in the last 3 days (`VPN_MAX_AGE`; `mergeRecord()`), each
with when it was last there. So a download that fails, isn't JSON or has fewer addresses than the provider's minimum
changes nothing (the last good list stays, and the try's error shows on `/status`); a list that comes back short
removes nothing seen lately; PIA's list, which names a different part of its servers every few minutes, adds up to
far more of them than any one download; and an address a provider stops listing, or a provider that stops answering,
drops out 3 days later, so an address given up doesn't stay "known" for long. A provider keeps at most 20,000
addresses (`VPN_MAX_KEPT`; PIA's, which add up, would reach about 14,000 if each of the 12 downloads in 3 days named
1,200 new ones): a list that would take it past that counts as broken, like a short one, and the try's error says so.
Every list is stored in one write, so without the cap one provider's oversized list would make that write too big for
storage and stop every provider's update.

All the lists are packed into one blob of sorted addresses with when each was last listed (`packIndex()`): 9 bytes per
IPv4 address and 21 per IPv6, about 70 KB in October 2026, well under a Durable Object's 2 MB per value. Each data center caches it
for 30 minutes and each Worker keeps it in memory for 10, so a lookup is a binary search in memory: no outside
request, no budget, no rate-limit count, and nothing about the lookup or the visitor leaves the Worker. That is why
bots get the listing like anyone else: the bot rule is about the paid budgets, and this spends none. On a cold Worker
a lookup waits at most 1.5 seconds for the blob, then goes on without it; once one has waited that long, the lookups
after it on that Worker don't wait for a minute (a slow answer that arrives meanwhile is still used).

Why a Durable Object rather than KV or D1: the deployment creates it, so neither ipterm.net nor a copy has a namespace
or database to set up; the writes are one blob four times a day; and the reads come from the cache and memory, where
an exact-match search of a sorted array is as fast as it gets.

### iCloud Private Relay: Apple's own list

Apple publishes the addresses its iCloud Private Relay sends traffic out from
(`mask-api.icloud.com/egress-ip-ranges.csv`, made for location databases: one range a line with the place it stands
for). Private Relay is a relay, not a VPN: on Apple devices with iCloud+ it covers Safari, DNS lookups and unencrypted
app traffic, not other browsers, and sites reached through it see one of these addresses instead of the user's.
Apple runs the service and publishes the list; partner networks (Akamai, Cloudflare and Fastly) run the relays that
traffic leaves from, so the address's network is theirs. Unlike the VPN lists, these are the addresses traffic leaves
from, so a match is certain in the way that matters to a site.

- **The list:** about 12 MB, 285,106 ranges on 2026-10-21 (41,747 IPv4, mostly /31 and /32; 243,359 IPv6, mostly
  /64, none narrower). `src/relay-list.js` merges overlapping and adjacent ranges, since only whether an address is in
  one matters here, not the place each line names: 1,011 IPv4 and 5,903 IPv6 ranges, packed into about 100 KB
  (IPv4 as first and last address, IPv6 by its first 64 bits). A lookup is a binary search for the last range starting
  at or before the address. Lines that aren't ranges, private or documentation ranges, IPv4 ranges wider than a /8
  and IPv6 ones wider than a /16 or narrower than a /64 are skipped.
- **The refresh:** the same Durable Object and cron trigger as the VPN lists (every 6 hours), one request, 60 seconds
  and a 32 MB cap, asked with the last copy's ETag: an unchanged list is a `304` with no body, and the stored ranges
  are dated again. A new list is read a chunk at a time into flat number arrays (`parseRelayStream()`), so the 12 MB
  never sits in memory whole and the parse stays a few MB, well inside a Durable Object's 128 MB. A line over 4,096
  characters (Apple's are under 100) ends the download as a failure, since a body with no line breaks (an error page,
  a binary file) would otherwise cost CPU time growing with the square of its size. It replaces the
  stored one when it has at least 10,000 ranges; otherwise (a failure, an error page, a list far too short) the last
  good copy stays, and lookups stop using it once nothing has confirmed it for 3 days. The status changes only once
  the ranges are stored. Parsing a changed list takes well under a second of CPU (about 0.5 s in Node on a laptop),
  and it is linear in the number of lines whatever their columns. A lookup that finds no relay list starts an alarm
  that downloads Apple's list only (at most once an hour after its last try), never the VPN lists again.
- **Lookups:** the JSON carries `relay: { "service": "iCloud Private Relay", "operator": "Apple", "listUpdated":
  "<when the list was last downloaded or confirmed>" }`, only for an address in a range, on the same routes as
  `vpnServer`. `operator` is the company that runs the service; the address itself is a partner network's, which
  `asn` and `org` name. Both listings are on `?lite=1` lookups too, since they are free (before, a `?lite=1` answer had neither). The **vpn / proxy** line says `yes: Apple's iCloud
  Private Relay (on Apple's own list of its relay addresses: sites see a Private Relay address, not the user's)`,
  before any other finding, and proxycheck.io isn't asked about it. The text answer's `source` line adds `+ Apple's
  iCloud Private Relay list`.
- **`leaktest`:** a visitor whose address Apple lists is on Private Relay. Like Cloudflare WARP and Tor it is named
  (`you're on Apple's iCloud Private Relay ...: sites see a Private Relay address, not your provider's. It covers
  Safari, DNS lookups and unencrypted app traffic, not other browsers`; tag `relay on`), even when IPinfo is down, and
  graded the way they are, so no sponsored line follows it. As with a Tor exit, the relay
  picks the DNS resolver, so only the visitor's own provider's resolver is a DNS LEAK; and the other IP version may
  leave through another relay network, which is fine when Apple lists that address too (`also through iCloud Private
  Relay`). This is how the owner chose to count it.
- `/status` shows it as `privateRelay`: `ranges` (as read), `ipv4` and `ipv6` (merged), `updated`, `unchanged` (the
  last good answer was a 304), `tried`, `error` and `stale`.

**What no list covers.** Residential proxy networks and commercial proxy services (the kind sold by the gigabyte,
which route through home and mobile connections) publish no list of their addresses, and their addresses belong to
ordinary home and mobile providers. They stay with proxycheck.io's and IPinfo Core's flags and the hosting-network
hint, and an address on no list proves nothing. Tor exits come from the Tor Project's own list (see "Tor exits").

### Bots never spend the budgets

Crawlers, link previews and other bots never spend IPinfo Core or proxycheck.io. That is a rule in the code, where the
budgets are spent, not a matter of which pages link where: crawlers reach address pages from whois, DNS and `/cidr`
pages, from links they found long ago, and from the terminal's own links when they run its JavaScript (Googlebot
does). Until October 2026 only the registry date had such a rule, and Googlebot's lookups of uncached addresses used
Core and proxycheck.io like anyone's.

`isBot()` in `src/worker.js` decides once per request (`io.bot`), and is conservative about who is a person:

- A user agent that names a crawler or link preview (`CRAWLER_UA`, `PREVIEW_UA`) or matches `BOT_UA` is a bot,
  whatever else the request sends. `BOT_UA` covers AI and SEO crawlers (GPTBot, ClaudeBot, CCBot, Bytespider,
  PerplexityBot, AhrefsBot, SemrushBot, MJ12bot, DotBot, DataForSeoBot and more), headless browsers, and anything that
  calls itself a bot, crawler, spider or scraper. "bot" has to end a word, and a Cubot phone's browser ("CUBOT P30")
  doesn't count. `BOT_UA` is for the budgets only: it doesn't change who gets HTML (`wantsHtml()`). It also covers
  the AI assistants that fetch a page for a person's question (ChatGPT-User, Claude-User, Perplexity-User), on the API
  too: for an address not looked up recently they get country and network with no VPN check, and `llms.txt` says so.
- A request that asks for HTML (`Accept: text/html`, even on a `?format=json` or `/json` copy) counts as a person only
  when it looks like a browser's own: a navigation (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`, which
  browsers send and plain HTTP clients don't) or the terminal's fetch (`Sec-Fetch-Site: same-origin`, or the
  `X-Ipterm` header). So an unnamed crawler asking for pages is a bot, and so is a browser too old to send
  `Sec-Fetch-*` (Safari before 16.4, for one): it gets the bot's answer on uncached addresses.
- Everything else, curl and the other command-line tools (`CLI_UA`) and scripts asking for JSON, is the documented
  API and keeps full data, held in check by the per-visitor shares and the rate limit as before.

What a bot gets, on every route that looks an address up (`/<ip>` and its `/text`, `/json` and `?format=` forms,
`/api/lookup`, and leaktest's `/api/check`, which Googlebot calls when it renders `/leaktest`):

- IPinfo: Core's answer when it is in the cache (someone else's lookup paid for it; six hours, per data center),
  otherwise IPinfo Lite, which is free (`ipData()`).
- proxycheck.io: a cached answer or none, never a new query, a budget count or a rate-limit count (`privacyData()`).
- The registry date: from the cache only, as before (`blockData()`).
- The VPN providers' own lists (`vpnServer`): the same as anyone's, since they are searched in memory and spend nothing.

So a bot sees country and network where a person sees a city, on the same page with the same title, links and
wording, the way a visitor past their hourly share does: less detail, never different content. Everything else the
site does (DNS, whois, `/cidr`, ASN pages, mail checks, report cards, one-value answers) never spends either budget
for anyone.

**Routing follows the same rule.** RIPEstat has no budget, but it is free and asks for fair use, and in October 2026
a crawler (Bingbot, by the look of it) opened about 155 public `/cidr/<prefix>` pages a minute, reached through the
ASN pages' prefix links, each a routing lookup of up to five RIPEstat calls. Throttled, routing would break for
people too. So a bot never starts a routing lookup (`routeData()`):

- A public `/cidr/<prefix>` page shows a bot the subnet calculation, with the routing when someone else's lookup
  cached it (six hours, per data center), and otherwise this line where the routing would be: "Routing data skipped:
  RIPEstat isn't asked for automated visitors (crawlers, link previews, bots). Open the page in a browser to see it."
  The title and description are then the calculation's.
- `/route/<ip>` in a browser is sent to the `/cidr` page of the route the address is in; a bot is sent there only when
  that address's routing is cached (someone's `/route/<ip>` or `route <ip>` in the last six hours: it is cached
  under the address, not its prefix), and otherwise to the address's own `/32` (or `/128`) page. A bot asking
  `/route/...` or `/api/route` for JSON or text gets a 403 saying so when the routing isn't cached (`openapi.json`
  lists it).
- The exception is the public prefixes in `SITEMAP_PATHS` (`1.1.1.0/24`, `8.8.8.0/24` and `9.9.9.0/24`,
  `curatedRoutes()`): their pages are in the sitemap and their titles are their routing ("1.1.1.0/24: announced by
  AS13335 ..."), so crawlers get the real page. That is five RIPEstat calls each at most every six hours per data
  center, and no request can add to the list.
- A public DNS resolver's page (`/9.9.9.9`) shows its routing only when it is cached, read with no RIPEstat request
  for anyone, and otherwise a `nofollow` link to `/route/<ip>`; the terminal asks for it live for a person (see "Public
  DNS resolvers"). Their prefixes are not in `curatedRoutes()`, on purpose.
- People keep live routing as before: a browser navigation, the terminal's `cidr` and `route` (its fetch asks for
  JSON, so it is a person's unless the user agent says otherwise), curl and scripts. A browser too old to send
  `Sec-Fetch-*` gets the bot's page, whose data marks the missing routing `bot: true`, so its terminal asks
  `/api/route` itself and shows the routing (`cidr()` in `public/app.js`). The page's note is `.route-bot`, and
  the terminal removes it once that request brings routing, so nobody reads "open the page in a browser" above
  routing that loaded. A crawler that runs the page's script (Googlebot, Bingbot) can't fetch `/api/`, which
  robots.txt disallows, or gets the 403 if it ignores that; either way no RIPEstat call, and the page keeps its note.

ASN pages' own RIPEstat calls (holder, prefixes, upstreams) are unchanged: those are the pages the ASN sitemap asks
crawlers to read, each cached six hours. What changed is how many public `/cidr` pages they invite crawlers to: only
ten of the largest prefixes are links, and the terminal's links from one public block to the next are `nofollow`
(see "Shareable pages and search").

`node tools/check_bots.mjs` checks all of this with no server and no network (see "Local development").

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
`no-store` with `X-Robots-Tag: noindex, nofollow`. Each look costs one Worker request and four Durable
Object requests (the two budget counters, and the lists object's VPN and Private Relay status, each its own call); it
never touches IPinfo or proxycheck.io.

| Field (per service) | Meaning |
| --- | --- |
| `on`, `off` | Whether the service is in use, and if not, why (no secret, plan not Core, budget `"0"`) |
| `usedToday`, `dailyLimit` | Fresh lookups since 00:00 UTC, and the daily budget |
| `usedThisHour`, `hourlyLimit` | The same for the current UTC hour (limit `0` = no hourly pacing) |
| `perVisitorHourly` | Each visitor's hourly share (`0` = no cap) |
| `hoursRunOutToday` | UTC hours (`"14"`) whose hourly budget filled. After that, lookups used IPinfo Lite (or skipped proxycheck.io) until the hour ended |
| `dayRanOutAt` | When the daily budget filled, if it did. After that, the fallback lasted until midnight UTC |
| `pastDays` | The same per finished day, newest first: `used`, `hoursRunOut`, `ranOutAt`. A day with no lookups has no entry |

`vpnServers` covers the VPN providers' own server lists (see "Known VPN servers"): `{ "providers": [...] }`, one entry
per provider with `id`, `name`, `addresses` (seen on its list in the last 3 days; `ipv4` and `ipv6` beside it count
them by version), `latestList` (how many its last good download had), `updated` (when that was), `tried` (the last
try), `error` (why the last try's list wasn't taken, or null) and `stale` (no good download for 3 days, so none of its
addresses is used); or `{ "error": "..." }` when there is no `VPN_SERVERS` binding or the object can't be reached.
The text form has one line per provider:
`pia  1724 addresses (1157 on the latest list), updated 2026-10-21 06:17 UTC`, plus the last try's failure if any.
`privateRelay` covers Apple's iCloud Private Relay list the same way (see "iCloud Private Relay"), as one line:
`icloud relay  285106 ranges (1011 IPv4 and 5903 IPv6 merged), updated 2026-10-21 06:17 UTC`.

Not counted: lookups that fell back because one visitor used up their own hourly share, or because Core
errored or refused the token (those are logged; watch with `npx wrangler tail`).

## How the data works

| What | Source | Cost |
| --- | --- | --- |
| Visitor's own IP, city, ASN, timezone, edge location | Cloudflare `request.cf` | Free, unlimited |
| Visitor's other IP version (IPv6 for an IPv4 visit, or the reverse) | [ipify](https://www.ipify.org/) `api.ipify.org` / `api6.ipify.org`, called from the browser | Free, open source, no logging |
| Other IPs: owner and country | IPinfo Lite | Free, unlimited |
| Other IPs: city, coordinates, time zone, connection type (optional) | IPinfo Core, with `IPINFO_PLAN = "core"` | Paid, monthly quota; falls back to Lite. Never for bots, which get it from the cache or Lite |
| VPN / proxy / Tor second opinion, VPN service name (optional) | proxycheck.io, with the `PROXYCHECK_KEY` secret | Free, 1,000 a day; falls back to IPinfo alone. Never for bots, which get it from the cache or not at all |
| Reverse DNS (hostname) | Cloudflare DNS-over-HTTPS | Free |
| An address lookup's `block`: when its network's registry record was created (see "Recently registered blocks") | RDAP, the record and cache entry of `whois <ip>` | Free |
| whois of an ARIN address or AS number when ARIN's RDAP server fails (see "ARIN's records through RIPEstat") | RIPEstat's `whois` and `abuse-contact-finder` data calls, which read ARIN's whois database; never for bots | Free |
| Mail checks: MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT, BIMI | Cloudflare DNS-over-HTTPS, plus the domain's own MTA-STS policy file | Free |
| Report cards (grade): DNSSEC, AAAA, CAA and HTTPS records, the site's redirect and security headers | Cloudflare DNS-over-HTTPS, the mail check, RDAP, plus up to five header-only requests to the domain's own site (`HEAD`, or a `GET` dropped unread when `HEAD` is refused) | Free |
| Networks (ASNs): holder, prefixes, main upstreams | RIPEstat (`as-overview`, `announced-prefixes`, `asn-neighbours`) | Free, no key |
| Routing of a prefix: route, origin, RPKI, visibility, AS paths | RIPEstat (`prefix-overview`, `routing-status`, `rpki-validation`, `bgp-state`) | Free, no key |
| The ASN sitemap's ranking (offline, `tools/build_asn_sitemap.mjs`) | RIPE NCC RIS table dump and AS names list (or CAIDA's prefix-to-AS file) | Free, run by hand |
| Which DNS resolvers a visitor uses (leaktest) | ipterm's own DNS server for `dl.ipterm.net` (`dnsleak-server/`), plus IPinfo Lite for the resolvers' networks | The VPS, about $4 to $6 a month |
| Known VPN servers: whether a VPN provider's own list names an address (lookups, leaktest) | The lists Mullvad, Private Internet Access, IVPN and AirVPN publish, downloaded every 6 hours by a cron trigger (see "Known VPN servers") | Free; four subrequests a run. Lookups search a copy in memory, so bots get it too |
| iCloud Private Relay: whether an address is one of Private Relay's addresses (lookups, leaktest) | Apple's list (`mask-api.icloud.com/egress-ip-ranges.csv`), asked every 6 hours with its ETag (see "iCloud Private Relay") | Free; one subrequest a run, usually a 304 |
| Public DNS resolvers: services, variants, filtering, addresses, DoH and DoT, DNSSEC, ECS and logging | The operators' own documentation, checked by hand into `public/resolvers.js` (see "Public DNS resolvers") | Free; no request at all |
| Whether the visitor's address is a Tor exit (leaktest) | The Tor Project's exit list, cached an hour per data center | Free; at most one subrequest an hour per data center |
| Cloudflare WARP, TLS and HTTP versions, key exchange (leaktest) | Cloudflare's `/cdn-cgi/trace`, read by the browser | Free; the edge answers it, not the Worker |

Lookups of other IPs are cached at the edge for six hours.

**IPinfo's bogons.** For an address it doesn't expect on the public internet, IPinfo answers `{ "ip": ..., "bogon":
true }` and nothing more. ipterm never asks it about an address the special-purpose table calls non-public (see
"Special-purpose ranges"), but IPinfo calls some others bogons too, such as 192.88.99.1 (its free API, on 2026-10-25),
in 192.88.99.0/24, which the table calls public since it is still announced. A lookup keeps just that, from Core,
Lite or the free API alike (`ipinfoCore()`, `provider()`), with the reverse DNS, and goes no further: no
proxycheck.io query and no registry date. Its page is titled `192.88.99.1 IP lookup: IPinfo lists it as a bogon`,
tagged `bogon` and noindex, and says what the table says of the address, then "IPinfo lists it as a bogon: an address
not expected on the public internet" (`IPINFO_BOGON`). The text answer has a `bogon` line in those words and no VPN
line, the JSON is `{ ip, version, source, bogon: true, hostname }`, and the terminal titles and draws it the same way
(`ipTitle()` and `render()` in `public/app.js`). It is cached for six hours like any other lookup.

## Self-hosting

ipterm is MIT-licensed, so you can run your own copy. Follow "Deploy" above, then:

1. In `wrangler.toml`, set `SELF_HOSTED = "true"`. Every page then carries `noindex` (an `X-Robots-Tag` header on
   everything the Worker answers, and a robots meta tag in the pages), `/sitemap.xml` and the other sitemap files are empty, `public/sponsors.json`
   is ignored so no sponsored line appears, reference pages show no "Something wrong here?" line (it would send
   reports about your copy to ipterm's GitHub and email), and the footer, `about` and `/help` say the site is a copy
   of ipterm, not ipterm.net. Copies shouldn't compete with ipterm.net in search or carry its affiliate links.
2. Set `SOURCE_URL` to your fork (or leave it empty), so the footer links the code you actually run.
   `public/changes.js` (`/changes`) is ipterm's own list; keep it, empty it or write your own.
3. Change the two `namespace_id`s under `[[ratelimits]]` if your account already uses 1001 or 1002.
   `DNSLEAK_ZONE` and `DNSLEAK_API` point at ipterm.net's own leak-test server: the test stays off without the
   `DNSLEAK_KEY` secret, but change them to your own (`dnsleak-server/README.md`) or delete both lines.
4. Edit what names ipterm.net: the contact address in `public/privacy.html` (and anything in the policy your copy
   does differently) and the URLs in `public/openapi.json`, `public/llms.txt` and `public/opensearch.xml` (otherwise
   browsers that add your copy as a search engine search ipterm.net). Canonical and share links, the search form on
   `/api` and the terminal's copy of it use your own address automatically, on https.
5. Optional: `npx wrangler secret put IPINFO_TOKEN` (and `PROXYCHECK_KEY`, `STATUS_KEY`), as described above. Your
   copy uses your own IPinfo and proxycheck.io allowances, and keeps IPinfo's attribution in the footer.

The known VPN servers and iCloud Private Relay need Workers Paid, and nothing else: the deployment creates their
Durable Object and cron trigger, and the first lookup after it starts the first download. Their requests name
`SOURCE_URL` in the user agent. Paid, because reading the lists takes more CPU time than the Free plan's 10 ms an
invocation, which holds for Durable Objects too: about 0.5 s for a changed Apple list, and a few tens of milliseconds
for the four VPN lists. On a Free account the downloads are cut off, lookups go on without the lists, and the object
keeps trying again (each cron run, and an alarm at most once an hour), which spends the Free plan's daily Durable
Object requests that the budget counters use too. To switch the lists off there, delete the `[triggers]` cron and the
`[[durable_objects.bindings]]` entry named `VPN_SERVERS` from `wrangler.toml` (the `v2` migration can stay): without
the binding nothing asks the object, lookups and `leaktest` carry no `vpnServer` or `relay`, and `/status` says no
lists are kept.

Everything else (the budgets, the rate limits, the CSP) works the same. `workers_dev = false` means the copy only
answers on a custom domain; set it to `true` to try it on `*.workers.dev` first.

### The map

Each result with a location gets a dot-matrix map drawn on a canvas, with no map service involved.
It marks the reported point and draws a ring for the uncertainty:

- City-level results (your own IP, or other IPs without a token) get a 50 km "approximate area" ring.
  IP location usually points at the ISP's hub, so treat the ring as a hint, not a boundary.
- Country-level results (IPinfo Lite) get a ring sized to the country, centered on its main landmass.
- Anycast addresses (the `anycast` flag, from IPinfo Core or, without a token, IPinfo's free API, as on 8.8.8.8) are
  answered from many places, so the point is only the one their data lists: no ring, only the dot under it lights up,
  and the caption says "anycast · served from many locations" instead of a radius (`locate()` and `geoNote()` in
  `public/app.js`).

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
curl https://your-domain/text         # the same as aligned lines
curl https://your-domain/8.8.8.8      # any IP as JSON
curl https://your-domain/AS13335      # any network (ASN) as JSON, with its main upstreams
curl https://your-domain/route/1.1.1.0/24  # how a prefix (or an address) is routed: origin, RPKI, AS paths
curl https://your-domain/mail/gmail.com  # a domain's email security (SPF, DMARC, DKIM), graded
curl https://your-domain/grade/github.com  # a domain's report card: DNSSEC, email, expiry, security headers, graded
curl -4 https://your-domain/port/22   # is TCP port 22 open on your own IP? (see "Port checker")
curl https://your-domain/help         # the command-line reference as plain text
curl https://your-domain/changes      # real fixes and new pages, newest first, as text (see "Corrections and changes")
curl https://your-domain/public-dns   # public DNS resolvers: addresses, filtering, DoH and DoT (see "Public DNS resolvers")
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
`/mail/...`, `/grade/...`, `/whois/...`, `/cidr/...`, `/route/...`, `/leaktest/r/...` (and their `/api/...` forms) for key/value lines like the terminal draws.
Browsers get the text too. Results that include IPinfo data end with `IP address data powered by IPinfo
(https://ipinfo.io)`, as IPinfo's free-data terms ask. JSON stays the default for command-line clients,
and `curl ipterm.net` still prints the bare address (over plain http, which stays open for them: only pages are sent
to https, see "One copy of the site, on https"). Shells such as zsh treat `?` as a wildcard, so the
reference quotes those URLs: `curl 'ipterm.net/dns/example.com?format=text'`.

**`/text` and `/json` after an address or AS number** say the same without a `?`, so they work unquoted in zsh:
`curl ipterm.net/8.8.8.8/text`, `/2606:4700:4700::1111/text` and `/AS13335/text` answer exactly what `?format=text`
does, and `/8.8.8.8/json` and `/AS13335/json` the default JSON (`formatRoute()` in `src/worker.js`). They are the same
lookup, so the same budgets, rate limit, caching and `Vary` apply, and the path wins over a `?format=` that
disagrees. Browsers get the text or JSON too, so these answers carry `X-Robots-Tag: noindex` and don't become
second copies of the address and network pages in search. They sit next to `/<ip>/<field>` and are matched before
it; the word is `text`, not `txt` (`/dns/<name>/TXT` means TXT records), and `/8.8.8.8/txt` is a 404 that points to
`/8.8.8.8/text`. For your own address, `/text` is `/json?format=text` without the `?`. There is no YAML or XML.

**Colors on request:** `?color=1` with a text answer (`/8.8.8.8/text?color=1`, or `?format=text&color=1` on any
route above) colors the key column like the `/me` card and the verdict that starts the `vpn / proxy` line: a known
VPN, proxy or Tor address bold yellow, a proxycheck.io flag yellow, "not on known VPN or proxy lists" green, "not
checked" dim. `?color=0` or no `?color` means none, and unlike `/me` it is never turned on by default, even for
curl: these answers get piped into `grep`, `awk` and `jq`, where escape codes would break the match. JSON is never
colored. The codes are added after `plain()`, so they are the only escape sequences in the answer (`kvText()`,
`vpnTone()`; the colors are `ANSI` in `src/me.js`).

Text answers carry no sponsored line (that line only exists in the browser terminal), and every value
from upstream (TXT records, registry names) has control characters and bidi overrides replaced with `?`,
so a hostile record can't send escape sequences to the reader's terminal (`plain()` in `src/worker.js`).
Error messages too, since they quote the request back. JSON answers keep the same characters but write
them as `\u` escapes, which decode to the same data (`termSafe()` in `json()`).

**Machine-readable descriptions:** `public/openapi.json` (OpenAPI 3.1), `public/llms.txt` and
`public/opensearch.xml` (see "Address-bar search") are static files, listed in `run_worker_first`'s exclusions
so they don't count as Worker requests. Their links are written for `https://ipterm.net`; change them if you
deploy elsewhere. Edit them whenever a route changes.
`public/_headers` sends both with `Access-Control-Allow-Origin: *`, so browser-based OpenAPI tools and
agents on other sites can load them. That covers only these two public documents: the API's own
cross-site access still follows `PUBLIC_API` (off by default).

The homepage itself carries the visitor's address: the Worker writes their IP, network and location into the
HTML (`homePage()` in `src/worker.js`), so the number is there on first paint and without JavaScript, and the
terminal draws it without a second request. Everything but the hostname comes from Cloudflare's edge, so the rate
limit guards only the reverse DNS: past it, the homepage, `whoami`, `/json`, `/text` and the visitor's own address
asked for by number (as JSON or text) still answer, just without the hostname (`selfInfo()`), and people behind one
busy shared address (an office, a campus, carrier NAT) never see "Too many lookups" there. `/hostname`, `leaktest`'s
`/api/check` and lookups of other addresses keep the limit. Because it's personal, it's sent `private, no-store`, and it's
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
- Nothing copied carries the sponsored line, the `next:` line, the corrections line (see "Corrections and changes"),
  the map or buttons.
- Results about the visitor's own connection (whoami, leaktest, a port check) never share their address. After
  whoami or a port check the link is the page itself (`/`, `/port/<n>`), which shows each visitor their own result,
  so the share sheet says "check yours". After leaktest it is the grade's link (`/leaktest/r/<code>`, with the text
  "my ipterm leak test grade: X"; see "Shared results"), or `/leaktest` with "check yours" when the run has no
  grade. `copy` still copies your own IP after whoami: it goes to your own clipboard, not to anyone else.
- Their Markdown (`[md]`, whose label says "your address, provider and location left out") keeps the findings
  but nothing that identifies or places the visitor:
  - Rows that only hold such values are left out: for whoami and a port check (`SELF_DROP`), those that are the
    address in another form or point at it (hostname, the other IP version, postal code, coordinates, decimal,
    hex, binary, reverse-DNS zone, expanded, /64 prefix) and those that only name the provider or place the
    visitor (network, domain, connection, location, continent, local time, edge); for leaktest (`LEAK_DROP`),
    the browser-language line.
  - Inside sentences, the visitor's addresses read `[hidden]` (`hide`: for leaktest also its WebRTC and DNS
    resolver addresses), and so do the names and places in `terms`, from the result's own data
    (`placeTerms()`): the provider and network names and AS numbers (the ISP, the VPN and its operator from
    proxycheck.io, the other IP version's network, the DNS resolvers' operators), city, region, postal code,
    country and country code, the IP's and the device's time zones, the browser language and its country (only
    a language that names one, like `en-US`: a bare `no` or `it` places no one, and would hide ordinary words),
    and the Cloudflare data center. A port check's terms are the carrier-grade NAT providers its notes can name
    (`CGNAT` in `public/ports.js`). Each term matches as a whole word in any case, the longest first, but a
    code (two or three capitals: a country or data center) only in capitals, since in lower case it's an
    ordinary word (`in`, `it`, `us`, `man`). `UTC` and Cloudflare's `T1` for Tor are left alone. Addresses go
    first, so a number among the terms (a 4-digit postal code) can't match inside one and leave the rest
    showing; a term's own addresses are hidden the same way, so "Cloudflare (1.1.1.1)" still goes whole. Hidden
    parts next to each other read as one: "near [hidden]".
  - After a compare, the previous run's addresses and terms are hidden too (each run keeps its own `hide` and
    `terms`), and the compare's rows show only each run's status ("sites see  [INFO]  →  [OK]",
    "WebRTC  [LEAK]  →  [OK]"): either run's summary and the verdict ("· fixed", "· confirmed leak: …") stay
    on screen (marked `.yours`).
  - Results about other addresses (lookup 8.8.8.8, whois, dig, asn, mail, cidr, route) are copied whole.

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
| `grade github.com`, `report …`, `reportcard …`, `scorecard …`, `badge …` (a domain or URL) | `/grade/github.com` |
| `port 22`, `port:22`, `22/tcp` | `/port/22` (the page explains the port; nothing is checked) |
| a terminal command: `dig gmail.com MX`, `whois AS13335`, `lookup 1.1.1.1` | its page |
| `route 1.1.1.0/24`, `bgp 8.8.8.8` (also `rpki`) | `/route/1.1.1.0/24`, `/route/8.8.8.8`: browsers go on to the `/cidr` page with the routing, `curl -L` gets the routing JSON. Space that isn't routed (`route 10.0.0.0/8`) gets its own `/cidr` or address page |
| `leaktest --result 1bjp` | `/leaktest/r/1bjp` (only a valid code) |
| a router address typo: `192.168.l.l`, `192,168,1,1`, `10.0.0.l` | the curated address's page, `/192.168.1.1`, as the same typo after the slash does (another address typo, like `10.0.0.13l`, is a 400) |
| a tool's name: `whois`, `dig`, `grade`, `leaktest`, `route`, `port`, `help`; or nothing | `/whois`, `/dns`, `/grade`, `/leaktest`, `/cidr`, `/port`, `/api`; `/` |

Anything else is a 400: JSON for command-line clients, and for browsers a `noindex` page in the terminal's style
with examples (a bare number is offered as both `asn AS<n>` and `port <n>`). `/go` is in `robots.txt`'s Disallow,
and a redirect is cached for an hour like the other redirects.

**The Location is never the input.** It is put together only from values that were parsed and written out again
(`canonIp()`, `AS` and a number, `normalizeDomain()`, `CIDR.calc()`, `PORTS.parse()`, the `DNS_TYPES` list,
`dkimSelector()`), and `goLocation()` checks the result before it goes out: a path on this site, made of
`A-Za-z0-9._~:/?=%-` only, not starting with `//` or `/\` (which browsers read as another host), with no dot
segments. Input with control, zero-width or bidi characters, other URL schemes (`javascript:`, `data:`, `ftp:`) or
more than 300 characters is refused before parsing. `tools/check_go.sh` runs 122 inputs against `npx wrangler dev`
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

**Special-purpose ranges.** `SPECIAL` in `public/cidr.js` is the one table of addresses that aren't public: the
subnet calculator's `range` and `rangeNote`, the IP pages (`nonPublicReason()` in `src/worker.js`, and with it
whois, routing, the port check and the rest) and the terminal (`classify()` in `public/app.js`, which adds a hint of
its own such as "Typical home router.") all read it, so they can't disagree. It holds the blocks that IANA's
[IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry) and
[IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry) Special-Purpose Address Registries mark not
globally reachable, plus multicast, each with its kind (`private`, `cgnat`, `loopback`, `link-local`, `docs`,
`benchmark`, `multicast`, `ula`, `unspecified`, `reserved`) and the words the pages use. Beyond the table, IPv4 is
public, and IPv6 is public in 2000::/3 (global unicast) and reserved elsewhere. Two entries are kind `public`: the
NAT64 prefix 64:ff9b::/96, which IANA marks globally reachable, and 192.88.99.0/24, the 6to4 relay anycast range
RFC 7526 deprecated, which is still announced (by AS6939, seen by 199 of 269 RIS peers in RIPEstat on 2026-10-25), so
it is public with its own words, apart from its 6a44 relay address 192.88.99.2. IANA marks five anycast addresses
globally reachable too, the Port Control Protocol's 192.0.0.9 and 2001:1::1 (RFC 7723), TURN's 192.0.0.10 and
2001:1::2 (RFC 8155) and the DNS-SD Service Registration Protocol's 2001:1::3 (RFC 9665), but they stay `reserved`,
with words that name them: IPinfo answers `{ "bogon": true }` for each (its free API, on 2026-10-25), so a lookup
would only spend IPinfo Core budget on an empty answer. IPinfo answers the same for 192.88.99.1, whose page says so in
IPinfo's name (see "IPinfo's bogons" under "How the data works"). The IETF block 2001::/23 is left out as a whole,
since most of what is assigned in it is reachable (Teredo, AS112, AMT), and only its benchmarking block 2001:2::/48
and those three anycast addresses are in the table. A block takes the most specific entry that holds all of it, and
otherwise the kind of the range it starts in (10.0.0.0/7 is private, 100.0.0.0/9 public), as the calculator always
went by its network address. An entry's words go only with a block it holds: a wider one "starts with" it (10.0.0.0/7
"starts with the RFC 1918 private range (10.0.0.0/8)", ::/96 with the unspecified address), and a /0 is "the whole
IPv4 address space" or "the whole IPv6 address space". `rangeIn()` and `rangeIs()` in `cidr.js` put the words in a
sentence ("in the ...", "the loopback address (::1)", "starts with the ..."), on the pages and in error messages,
where the words come last: `curl ipterm.net/192.168.1.1` gets the error "192.168.1.1 is not a public address, so there
is nothing to look up: it is in the RFC 1918 private range (192.168.0.0/16)." `kindWord()` gives each kind the word a
non-public address's page title uses (see "Titles and descriptions").

Until October 2026 the calculator, the IP page and the terminal each had a list of their own. The calculator called
198.18.0.0/15 (benchmarking), 192.0.0.0/24 (IETF protocol assignments) and 3fff::/20 (documentation, RFC 9637) public
space, while the IP page called 198.18.0.1 non-public; the terminal didn't know 192.0.0.0/24; and the IP page looked
up 3fff::/20 and 2001:2::/48 at IPinfo, and the IPv6 space outside 2000::/3 it had no rule for (100::/64, 5f00::/16
and the unassigned rest), which the calculator called reserved.
`node tools/check_pages.mjs` checks every block in both registries (a copy of them is in the script; give it IANA's
CSV files to check the copy too): its first and last address must get the same answer, in the same words, from all
three.

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

The data comes from five RIPEstat calls at most, cached for six hours (ten minutes when a part didn't answer), all
within 6.5 seconds together (`DEADLINE`: each call gets its own limit or what is left, whichever is less):

| Call | For | Limits |
| --- | --- | --- |
| `prefix-overview` | the route and its origins | 6 seconds, one retry while the deadline allows, 200 KB |
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
is over that limit or RIPEstat doesn't answer. A bot never starts a lookup: it gets the routing from the cache or
not at all (`routeData()`; see "Bots never spend the budgets").

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
Cloudflare's public resolver (1.1.1.1) and are cached for five minutes; one that gets no answer within 6.5 seconds
is an error (see "When something fails"). International domain names are converted to their punycode form
automatically.

A DNS result for a domain with MX records or an SPF record links to its mail check (a `mail check` row and the
`next:` line in the terminal, a link on the `/dns/...` page), and so does a domain's whois `next:` line. A domain's
DNS, whois and mail results all link to its report card (see "Domain report card"), and the report card back to them.

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

### Domain report card (grade)

`grade github.com` in the terminal, `/grade/<domain>` as a page, `curl …/grade/github.com` for JSON (`?format=text` for
aligned lines), `/api/grade?domain=` for the terminal. One A to F grade for a domain from what ipterm already reads, as
OK, WARN, FAIL and INFO lines with a `fix:` under each WARN and FAIL, like the mail check (`gradeData()`, `gradeChecks()`
and `headerChecks()` in `src/worker.js`). `report`, `reportcard`, `scorecard` and `badge` are aliases. A DNS record name,
one with a label that starts with `_` (`_dmarc.gmail.com`, `selector1._domainkey.outlook.com`), is not a domain: it has
no site, mail or registration of its own, so `/grade/`, `/api/grade` and `/badge/` answer 400 (`recordName()`), `/go`
doesn't send it there, and no dig or mail page offers a card for it.

- **DNS** (Cloudflare's resolver): DNSSEC (the resolver's AD flag; a SERVFAIL that carries a DNSSEC Extended DNS Error,
  such as `EDE(9): DNSKEY Missing`, is "broken"), an AAAA record, CAA (at the name, or at its closest parent with
  records, as RFC 8659 climbs: up to 6 parent names, asked side by side, never the bare TLD; `issuewild` covers only
  wildcard certificates, so the name itself is judged by `issue`) and an HTTPS record (RFC 9460).
- **Email**: the mail check's grade, from the same cache entries as `mail <domain>`, so the two always agree. A is OK, B
  is WARN, C or worse is FAIL. The first three problems are listed under the line; the fix is the first problem's.
- **Registration**: expiry (FAIL from the moment the expiry time passes), and the transfer lock (`client transfer
  prohibited`, `server transfer prohibited`, or RFC 9083's `locked`, a registry lock such as sidn.nl's), from the same
  RDAP record and cache entry as `whois <domain>`. The .nl and .br registries publish no transfer-lock status at all
  (`NO_TRANSFER_LOCK_TLDS`: their domains show only `active`), so there the lock is INFO, not graded. A subdomain is
  graded with its registered domain's registration.
- **Website**: one `HEAD` request to `https://<domain>/` for the security headers (a `GET` when the server refuses
  `HEAD`), and one to `http://<domain>/` for the redirect to HTTPS (see below).
- Certificates aren't checked: a Worker's `fetch()` never shows them. crt.sh isn't asked either.

The grade counts the lines (`GRADE_GRADES`; the same rubric is in `man grade` and on the `/grade` page):

| Grade | When |
| --- | --- |
| A | no FAIL and no WARN |
| B | no FAIL, one to three WARN |
| C | one FAIL, or four or more WARN |
| D | two FAIL |
| F | three or more FAIL, an expired registration, or broken DNSSEC (validating resolvers refuse the domain) |

INFO lines never count, and neither does a part that couldn't be checked: it is one INFO line, and the tally names it
(`3 WARN; not checked: security headers`, `notChecked` in the JSON). A card with such a gap is cached for a minute
instead of five, so a timeout, a 429 or a record that couldn't be read is soon tried again. A gap a recheck won't fill
is marked `lasting` and keeps the five minutes: the TLD has no RDAP, or the registry has no record of the name; the name
points at a non-public address; the site answers with a 401, a 403 or a bot challenge; `http://` can't be reached while
`https://` answers (a site that serves only HTTPS); no CAA record in the 6 parent names asked. What each line reports:

| | FAIL | WARN | INFO |
| --- | --- | --- | --- |
| DNSSEC | broken: validating resolvers refuse the answers | not signed | the registered domain is signed, but the name is an alias of an unsigned one |
| IPv6 | | no AAAA record (beside an A record) | no A or AAAA record at all; couldn't be read (the AAAA record, or the A record when there is no AAAA) |
| CAA | | no CAA record; records without an `issue` tag (`issuewild` alone covers only wildcards) | couldn't be read, at the name or at a parent closer than the one with records; none in the 6 closest parents of a deeper name |
| HTTPS record | | | none (optional) |
| mail | the mail check's grade is C, D or F | its grade is B | the mail check couldn't run |
| expiry | expired; `redemption period` or `pending delete` | within 30 days | no date published; the TLD has no RDAP; couldn't be read |
| transfer lock | | no transfer-prohibited or `locked` status | the registry publishes no status codes; .nl and .br, whose registries have no transfer-lock status |
| HTTPS | `https://<domain>/` redirects to plain `http://` | | couldn't check (a 403, a challenge, a timeout, an error) |
| HTTP | | `http://<domain>/` serves the site over plain HTTP, or redirects to plain http elsewhere | couldn't check |
| HSTS | | missing; `max-age=0`; under 180 days; no valid `max-age` | |
| CSP | | missing; only `Content-Security-Policy-Report-Only`; no `default-src` or `script-src`; `'unsafe-inline'` without a nonce or hash; scripts from any host (`*`, `https:`, `http:`, `data:`) without `'strict-dynamic'` | |
| nosniff | | the first value of `X-Content-Type-Options` isn't `nosniff` | |
| frames | | neither `X-Frame-Options` (`DENY`, `SAMEORIGIN`) nor CSP `frame-ancestors`; `ALLOW-FROM` or another value; a `frame-ancestors` that lets in any site (`*`, `https:`, `http:`, a `*` host such as `https://*`) | |
| referrer | | `Referrer-Policy: unsafe-url` or `no-referrer-when-downgrade` | not set: browsers default to `strict-origin-when-cross-origin` (the last value a browser knows wins) |

A nonce, a hash or `'strict-dynamic'` in the script policy makes browsers ignore `'unsafe-inline'`, so that CSP is OK.
Only `'strict-dynamic'` also makes them ignore hosts and schemes, so `*`, `https:` or `data:` beside a nonce or hash is
still WARN. A header sent twice arrives as one comma list and is read the way browsers read it: the first
`X-Content-Type-Options` value counts, and a repeated `X-Frame-Options` counts once (several different values that
include `DENY`, `SAMEORIGIN` or `ALLOWALL` refuse all framing, so that is OK). CSP `frame-ancestors` overrides
`X-Frame-Options`, so a `DENY` beside a `frame-ancestors https:` doesn't help.

**The website check** (`webCheck()`, `httpsCheck()`, `httpCheck()`):

- It only runs for a name that has addresses and whose addresses are all public: for IPv6, the port check's rule
  (global unicast `2000::/3`, not 6to4, Teredo or the other IETF blocks), so no form that embeds an IPv4 address
  (`::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`) is tried; a record that doesn't parse counts as non-public. Otherwise
  the website is INFO, not checked. When the A or the AAAA record couldn't be read, the site is checked on the other's
  addresses (an unread AAAA shows on the IPv6 line); when neither gave an address, the website is INFO, not checked. A
  name with no address gets one INFO line: there is no website to check.
- `redirect: 'manual'`, always. A redirect is followed only over https, to a host name (never an IP address) on the
  default port with no user name or password, within the domain (the name without a leading `www.`, and anything under
  it), at most twice: three requests at most along the https chain, a `GET` included when a server refuses `HEAD` with a
  405 or 501 (its body is cancelled unread). The headers come from the page that finally answers 2xx.
- A redirect to another host within the domain is followed only once that host's own A and AAAA records pass the same
  test, on the same terms when one of them can't be read (up to 6 queries for both chains together, `WEB_DNS_BUDGET`;
  a host both chains go to is asked once). Otherwise it is INFO: "redirects to an address ipterm doesn't follow" for a
  non-public address, "redirects to www.example.com, whose address couldn't be read" when neither record gave one, or
  "..., which has no address". None of this is a guarantee: `fetch()` resolves the name again and may get a different
  answer (DNS rebinding), which a Worker can't prevent. The real control is Cloudflare's: Workers can't reach private
  networks. The checks here are defence in depth.
- A redirect to plain `http://` is a FAIL and isn't followed. A redirect to another domain (gmail.com to mail.google.com)
  is OK for HTTPS, and the headers are INFO, not checked, since they belong to someone else's site.
- `http://<domain>/`: a redirect to any https address is OK; one redirect on plain http within the domain is followed
  first.
- Time limits: 5 seconds for the whole https chain and 4 for http (the lookups for redirect hosts included; running
  out is a timeout), side by side, and beside the DNS and RDAP reads.
- At most 100 response headers are looked at, and only the 9 the checks use are kept, each capped at 4,000 characters
  (1,000 in the JSON, which shows only the 6 security headers). No body is ever read.
- A 401, a 403, a 429, a bot challenge, any other answer that isn't 2xx or a redirect, a timeout or a connection error
  is INFO ("couldn't check"), never a FAIL. A challenge counts even when it comes with a 2xx: Cloudflare's
  (`cf-mitigated`), AWS WAF's (`x-amzn-waf-action`, a 202), and a `GET` answer that lacks a security header the
  server's own refusal of `HEAD` carried (Akamai's interstitial, a 200 with no marker; amazon.com answers with one or
  the other). The refusal's headers are never graded in the page's place.
- The requests say who they are: `User-Agent: Mozilla/5.0 (compatible; ipterm-grade/1.0; +https://ipterm.net/grade)`.
  They come from Cloudflare's network, never from the visitor's browser, and carry nothing about the visitor.
- The Worker's own host (`grade ipterm.net` on ipterm.net, or a copy's on its own domain) is the exception: a Worker's
  `fetch()` to the hostname it runs on never reaches it (Cloudflare answers HTTP 522, so the card used to say the
  headers weren't checked). There `/` is answered in-process: the same request, with the user agent and `Accept`
  above, through the Worker's own `route()` and `secure()`, which is what every visitor gets, with no network hop and no
  visitor's address in it. The https check then reads the site's headers, and the http check gets the 301 to https
  (the request asks for HTML). Only `/` on that host, whose answers are the homepage and that 301, so the card can
  never start another card; other domains, and ipterm.net graded from any other host, are fetched as before. A header
  a Cloudflare rule would add or change on the way out isn't seen there; ipterm sets all of its own in `secure()`.

What it gave in October 2026 (checked by hand against the rubric): github.com B (no DNSSEC, no AAAA record, mail B for
1024-bit DKIM keys; every header passes); cloudflare.com C (mail C, since its MTA-STS policy host has no address, and a
CSP with `'unsafe-inline'`); example.com C (no CAA record, plain HTTP served without a redirect, and none of HSTS, CSP,
nosniff or frame protection); gmail.com B (no DNSSEC, mail B for DMARC `p=none`; it redirects to mail.google.com, so its
headers aren't checked); openssh.com C (mail F, expiring in 8 days, no transfer lock, no DNSSEC or CAA);
dnssec-failed.org F (broken DNSSEC). openai.com (a bot challenge), www.zillow.com (a 403) and a name pointing at an
address that drops everything (a timeout) got INFO lines for the website, never a FAIL.

**Badges** (`badgeRoute()`):

- `/badge/<domain>.json` is a [shields.io endpoint](https://shields.io/badges/endpoint-badge):
  `{"schemaVersion": 1, "label": "domain security", "message": "B", "color": "green", "cacheSeconds": 3600}`, and
  nothing else, since shields.io's schema refuses unknown keys (`isError: true` and grey for "no such domain" and the
  like). In a README:
  `[![domain security grade](https://img.shields.io/endpoint?url=https%3A%2F%2Fipterm.net%2Fbadge%2Fgithub.com.json)](https://ipterm.net/grade/github.com)`.
  shields.io fetches the JSON from its servers, and GitHub's image proxy fetches shields.io's image, so a reader's browser
  never contacts ipterm and no reader's IP reaches it.
- `/badge/<domain>.svg` is the same badge drawn by ipterm: flat style, with text widths estimated for 11px Verdana and
  pinned with `textLength`. It holds only the label and the grade (escaped anyway), never the domain. Where no proxy
  sits in between (a website, a docs page, GitLab), each reader's browser fetches it from ipterm, which then sees their IP
  address, as any image host does, and stores nothing. It is the one answer sent with
  `Cross-Origin-Resource-Policy: cross-origin`, so other sites can show it; everything else stays `same-origin`.
- Both are cached for an hour in the data center's cache (ten minutes when part of the card couldn't be checked and a
  recheck might fill it; a `lasting` gap keeps the hour). A cached copy is sent with the time it has left, in
  `Cache-Control` (never under a minute) and in `cacheSeconds` (never under 300, shields.io's minimum), so shields.io,
  GitHub's image proxy and browsers let go of it about when ipterm does, not an hour later. shields.io gives up on an endpoint after 3.5 seconds,
  so a badge whose card isn't ready within 2.8 seconds answers "checking…" (cached a minute) while the card finishes in
  the background (`ctx.waitUntil`), and the next fetch gets the grade. When the card can't be had (rate limited, a data
  source down), the last grade, kept for a week, is served for five minutes, or "busy, try later" or "unavailable" if
  there is none. Neither is saved as the badge, so the next fetch tries again.
- A badge is graded again about once an hour per data center (every ten minutes with a gap a recheck might fill).
  Fetches that arrive while its card is being made share that card within a Worker instance, as do `grade` lookups of
  the same domain; separate instances may each make one. A card is shared for its first 30 seconds only
  (`GRADE_SHARE_MS`: `ctx.waitUntil` keeps it alive no longer once its first requester has gone), and a fetch still
  waiting on it then makes its own.
- shields.io fetches every README's badge from a few addresses, so its fetches share those addresses' 30 lookups a
  minute. A fresh card is one of them, so that is about 30 new or expired badges a minute per address per data center.
  Anyone can ask shields.io for badges of made-up names and use those lookups up: ipterm never sees who is asking, which
  is the point of the endpoint, so that is accepted. Meanwhile existing badges show their last grade and new ones "busy,
  try later". `/badge/` is in `robots.txt`'s Disallow.
- The terminal prints both snippets after each card, with a copy button each; `copy badge` copies the shields.io one.
  The `/grade/<domain>` page shows both too, and `?format=text` ends with them.

**Cost.** Measured under `wrangler dev` by wrapping `fetch()` and the Cache API, on five domains nothing had cached
(wikipedia.org, mozilla.org, debian.org, bbc.co.uk, python.org): a fresh card made 24 to 30 fetches (4 DNS queries,
the mail check's 13 to 19, 1 or 2 RDAP requests, 2 or 3 requests to the site, and 2 DNS queries for the `www.` name
each of them redirects to) and 8 to 11 cache reads and writes, so 33 to 41 subrequests, in 0.8 to 1.1 seconds. A fresh
badge cost 41 (the card plus the badge's own cache calls); a cached card or badge is one cache read. Each part has a
budget: 6 DNS queries (`GRADE_DNS_BUDGET`, retries included), up to 8 for CAA at parent names (`GRADE_CAA_PARENTS` and
two retries), 3 requests along the https chain and 2 along the http one, 6 DNS queries for the hosts those redirect to
(`WEB_DNS_BUDGET`), plus the mail check's own (22 and 7) and whois's (two registry names with a retry each, the
registrar's record, and IANA's bootstrap file once a day per data center). The worst case, every cache cold and every
retry firing, is about 71 subrequests, and 75 for a badge: far inside Workers Paid's limit of 10,000 a request, but
above the Free plan's 50. On a copy run on the Free plan, the extra calls would fail and the parts they belong to
should show as not checked (not tested). A fresh card counts as one of the visitor's 30 lookups a minute, however many
of its parts (the mail records, the DKIM selectors, whois) it has to fetch (`io.paid` in `limit()`), so one address
gets at most 30 fresh cards a minute; a cached card counts as none. It never touches IPinfo or proxycheck.io.

### Registry records (whois)

`whois 8.8.8.8` or `whois AS13335` in the terminal, `/whois/<ip, ASN or domain>` as a page, `curl …/whois/8.8.8.8` for JSON.
It shows the registered owner, address block, registration dates and abuse contact, straight from the
regional internet registry (ARIN, RIPE NCC, APNIC, LACNIC or AFRINIC) over RDAP. IANA's bootstrap files
pick the right registry; they're cached for a day, and each record for a day. Part of APNIC's and LACNIC's space
is kept by national registries (NIRs), and the record says which: APNIC answers for IDNIC, JPNIC, KRNIC and TWNIC
from mirrors whose "Source" notice names them, and LACNIC sends Brazil's addresses to NIC.br's own server, so
`registry` (here and in a lookup's `block`) is the NIR's name, never a server's hostname (`registryOf()`). CNNIC's,
VNNIC's, IRINN's and NIC Mexico's records are in the RIR's own database and say APNIC or LACNIC. Some registries
(RIPE NCC in particular) hide abuse emails in RDAP; ipterm then shows the contact's handle instead.

`whois example.com` (or a pasted URL) looks up a domain's registration: registrar, registration and expiry
dates, status codes, name servers, DNSSEC and the registrar's abuse contact. ipterm asks the registry for
the domain's extension (Verisign for .com/.net, PIR for .org, and so on), then follows its link to the
registrar's own record for the abuse contact and any published owner details. Owner names are usually
redacted for privacy since GDPR, so "not published" is normal. Subdomains are looked up as their
registered domain (`whois blog.github.com` shows github.com). Domain records are cached for six hours.
Every generic extension (.com, .org, .app, .xyz …) publishes RDAP, because ICANN requires it; some
country extensions don't (.de and .io, for example), and ipterm says so instead of guessing. A registry server that
doesn't answer within 6.5 seconds, can't be reached or answers with a failure is named in the error, as theirs (see
"When something fails").

### Recently registered blocks

Two sites often name two different cities for one address, and neither is necessarily broken. Location databases
(IPinfo, which ipterm uses; IP2Location and MaxMind, which many other sites use) place a block from its registry
record, its holder's geofeed and their own measurements, and for weeks or months after a block goes to someone new
(a new customer, or a block leased through a broker) they often still place it where its previous user was, or
each somewhere different. The case that prompted this: a /24 reassigned three months earlier (its record pointed to
an address-leasing marketplace's geofeed, which had no entry for it), placed by IPinfo in one state and by
IP2Location-based sites, as a data center, in the next state over, where a traceroute ended at the provider's router.

So every lookup of a public address other than your own (`/<ip>`, `/<ip>/text`, `/<ip>/json`, `/api/lookup?ip=`,
the page and the terminal's `lookup`) carries `block`: when the registry record of the most specific network the
address is in was created, as `whois <ip>` shows it:

```json
"block": { "network": "8.8.8.0/24", "registry": "ARIN", "registered": "2023-12-28", "days": 1024, "recent": false }
```

`registered` is the date part of the registry's own timestamp and `days` the calendar days from then to today
(UTC), worked out at each answer, so a cached record never shows a stale count. When the record is at most 180
days old (`BLOCK_RECENT_DAYS` in `src/worker.js`), `recent` is true and the text answer, the page and the terminal
add one line, worded the same everywhere (`blockText()` in the Worker, `blockLine()` in `app.js`):

```
block        203.0.113.0/24 registered with ARIN on 2026-08-31 (47 days ago): IP location databases often take
             months to catch up with new or reassigned blocks, so sites may disagree about where this address is
```

(one line in the real answer). It says when the record was made, not why: a new customer, a lease and a registry
clean-up all look the same in RDAP, so ipterm doesn't guess. It isn't added to the one-value routes (`/8.8.8.8/org`
stays one bare line).

Your own address never gets it, so a lookup never sends a visitor's address to a registry (only `whois` of it does):
not `/json`, `/text`, `whoami` or the homepage, not your address asked for by number (`/<your ip>`,
`/<your ip>/json`, `/api/lookup?ip=`, the terminal's `lookup`, all answered from the edge like `/json`), and not its
page in a browser (`sameIp()` in `ipRoute()`). `?block=0` leaves the field out of any lookup, with no registry
request. The terminal sends it for the addresses it knows are yours but the Worker can't tell from anyone else's
(`ownIps` in `app.js`): your other IP version from ipify, which `leaktest` looks up, the public addresses WebRTC
shows, and the one you connected from before a VPN came on. Its links to them and the address bar after looking
one up carry `?block=0` too (`ipPath()`), so a new tab or a reload, which the Worker answers as a page, asks the
same, and a page opened that way keeps the address as yours for Back and Forward.

What it costs, and the limits on it (`blockData()` in `src/worker.js`):

- No IPinfo or proxycheck.io budget: RDAP only, and from the same cache entry as `whois <ip>` (a day), so a whois
  and a lookup of the same address share one registry request. It never asks RIPEstat for ARIN's record itself, but a
  record whois got that way (kept an hour) gives it its date like any other. An uncached address adds one RDAP request (plus
  IANA's bootstrap file, kept a day, when an isolate has no copy yet). Lookups of an address that arrive while its
  registry request is still out share that request (per isolate) instead of sending their own.
- It can hold a lookup up by 0.3 seconds at most (`BLOCK_GRACE`). The registry request starts once the IPinfo
  answer is in and runs beside the proxycheck.io check; once the rest of the answer is ready, the registry gets
  that much longer, and past it the answer goes out without `block`. The request still finishes in the background
  (`waitUntil`) and fills the cache, so the next lookup has the date; the answer that went without it is sent with
  `Cache-Control: no-store`, so a browser asks again rather than reusing it. In practice the wait shows on a lookup whose
  other data was already cached, once a day per address and data center.
- A registry that fails (a timeout, a 5xx, a 429) just leaves `block` out, and is then left alone for a minute, or
  ten after a 429 (per isolate, keyed by the server that failed: the one ARIN redirected to, when that one answered
  with the failure, and otherwise the one asked): lookups
  of addresses it holds skip the date without waiting, counting or adding to its load until then, and do the same
  for a minute after whois found the registry silent (`rdapFetch()`, see "When something fails"). One bad record
  (another 4xx, a reply that doesn't parse) just leaves `block` out and pauses nothing. When IANA's bootstrap file can't be read, lookups use rdap.org (which redirects to the
  registry), and the file isn't asked for again for a minute.
- Bots (`isBot()`, see "Bots never spend the budgets") only read the cache: a page they fetch shows the line
  only if someone else's lookup or whois already asked the registry, so crawling address pages never sends a
  request to RDAP.
- Anyone else's registry request counts toward their rate limit (30 a minute), but rides on the lookup's own count
  when the lookup made one (`limit()` sets `io.charged`), and otherwise shares one count with the proxycheck.io
  check (`io.extra`). So a fresh lookup still costs one count, or two with proxycheck.io, as before; one answered
  from IPinfo's cache costs one when it asks proxycheck.io, the registry or both; and one that asks neither (or
  joins a registry request already out, or finds the registry paused) costs none.

### Privacy check (leaktest)

`leaktest` (or `dnsleak`) in the terminal, or the page `/leaktest` (which runs it on load; `/dnsleak`
redirects there), is a VPN and DNS leak test: it checks whether the browser gives away more than its IP
address, and grades the leaks A to F. Each line is marked OK, LEAK or INFO:

- **Sites see:** the visitor's IP, with its network and rough location: their provider's without a VPN,
  the VPN's with one. Always INFO, and never graded: every connection without a VPN shows these, and the
  grade is about leaks, not about whether someone uses a VPN.
- **VPN detection:** IPinfo Core's classification of the visitor's IP (VPN/proxy/Tor, hosting
  flag, or a network whose type is hosting), plus proxycheck.io's when `PROXYCHECK_KEY` is set
  (which can name the VPN service). An address on a VPN provider's own server list (see "Known VPN servers")
  is that provider's server, entry or not, since the visitor's traffic reaches ipterm from it: the line names
  it ("your IP is a known Mullvad VPN server (on Mullvad's own server list)"), it counts as a VPN, and
  proxycheck.io isn't asked. Three services are named outright: **Cloudflare WARP**, when
  Cloudflare's edge says the request came through it (`warp=on` or `warp=plus` in `/cdn-cgi/trace`, which
  the page reads itself); **Tor**, when the address is on the Tor Project's exit list (see "Tor exits"
  below) or Cloudflare gives it the country code `T1`, or when proxycheck.io knows it as Tor (then this line
  says "a known Tor address"); and **iCloud Private Relay**, when Apple's own list has the address (see
  "iCloud Private Relay"; proxycheck.io isn't asked then). Each counts as a VPN for the grade (a relay, worded as
  one), and the header tag (`warp on`, `tor`, `relay on`), the verdict and the tally ("no leaks past Tor"), the
  advice under a LEAK and the compare all name the same one. A shared result's code has one flag for all of these,
  so it says "a VPN was on" for any of them. Without any of these, this line
  says it wasn't checked. An unflagged address on a home or mobile provider's network (IPinfo type "isp",
  a mobile network, or proxycheck.io's "Residential" / "Wireless") is reported plainly as "no VPN", since
  commercial VPN servers run in data centers. Any other unflagged address stays hedged. An
  unlisted IP isn't treated as proof of no VPN: mismatches below still carry "(a leak if you use
  a VPN)", just marked INFO instead of LEAK. proxycheck.io's `anonymous` or `compromised` flag
  alone (see the table above) doesn't count as a VPN: on a hosting network the address counts as
  one anyway, as any hosting address does; elsewhere the tag says "vpn unclear" and the check
  treats it like an address it couldn't classify (mismatches marked LEAK, with the "if you use a
  VPN" caveat), and the sponsored line shows, since detection ran and found no VPN.
- **DNS:** which resolvers look up names for the visitor. The page looks up six random, single-use names
  under the test zone (`<token>.dl.ipterm.net`, 20 hex characters from `crypto.getRandomValues`) with a
  `no-cors` fetch and a 3-second abort. Each fails within milliseconds, since the zone's server answers
  NXDOMAIN, but by then the visitor's resolvers have asked that server. Then `/api/dnsleak` asks which
  resolvers those were, and names each one's network with IPinfo Lite. On a VPN, resolvers outside the
  VPN's network (another AS number and name) are a LEAK, called "your ISP" when they belong to the network
  the other IP version leaked to; resolvers inside it are OK. Through Tor the exit relay picks the
  resolver, and through iCloud Private Relay the relay does, so there only the visitor's own provider's is a LEAK
  (and the other IP version counts as relayed, not leaked, when Apple's list has it too). Without a VPN they're named, as INFO:
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
check (it uses the Core daily budget), and the privacy policy says so. Neither it nor their other IP
version goes to a registry: `/api/check` asks for no registration date, and the other version's lookup
asks with `block=0` (see "Recently registered blocks"). That lookup also asks with `lite=1`: IPinfo Lite and no
VPN check, so it spends neither paid budget and the other address never goes to proxycheck.io. Only its network
is compared (the IPv6 / IPv4 line, and "your ISP" on the DNS line), and Lite names the same AS number and network as
Core; VPN detection is about the address sites see, from `/api/check`, so the grade and the verdict come out the same.
When VPN detection ran (IPinfo Core or proxycheck.io answered for the visitor's address, or a VPN provider's own list
named it, which makes it a VPN) and found no VPN, the
verdict is always followed by the sponsored line (any sponsor with `"check"` in its `on` list in `sponsors.json`,
currently Proton VPN). When it couldn't run (both services' budgets spent for the hour, say, which on a busy day is
most runs), the VPN line says "unavailable" and no sponsored line follows: the visitor may well be on a VPN
already. A run that detects a VPN never shows it, and neither does any later run in the
same tab: someone who turns their VPN off to compare already has one. (That's kept in memory with the
last result, so a reload forgets it.) A DNS LEAK only happens on a VPN, so it never brings the line.

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
  a VPN is detected (a known VPN, proxy or Tor address, a hosting network, Cloudflare WARP, or iCloud Private
  Relay, a relay counted the same way).
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
on". With the VPN in the same state both times it says "fixed", "still leaks" or "new leak". `copy md` gives
each compare row as the two statuses only, OK, LEAK or INFO ("sites see  [INFO]  →  [OK]"): each run's summary
(its addresses, networks and time zones) and the verdict stay on screen (see "Share, copy and copy md").

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
  in the sitemap. Command-line clients get the decoded result as JSON, `{code, grade, vpn, checks: {dns,
  webrtc, ipv6, tz}}` (`?format=text` for lines), and a bad code as a 404 with `{error}`: `LeakResult` in
  `public/openapi.json`, a line in `public/llms.txt` and in `/help`.
- A run that can't be graded has no code: `share` then copies `/leaktest` and says why.

#### Tor exits

To say "Tor", the Worker checks the visitor's address against the Tor Project's exit list
(`https://check.torproject.org/torbulkexitlist`, about 1,200 IPv4 addresses, 17 KB). Each Cloudflare data
center keeps a copy in its cache for an hour, and each Worker instance remembers it for ten minutes, so
the list costs at most one subrequest an hour per data center, and only when someone there runs leaktest.
The visitor's address is looked up in that copy, never sent to the Tor Project. A slow download doesn't
hold the check up (it waits 1.5 seconds, then finishes in the background and fills the cache); if the
list can't be had, leaktest runs without it and tries again ten minutes later. iCloud Private Relay's list is
larger, so it is kept by the Durable Object instead (see "iCloud Private Relay").

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
- **Rate limits on the VPS's API:** it checks the key before any limit. The Worker's `/v1/resolvers` calls
  share 200 requests a second (bursts of 400); everything else (`/healthz`, a missing or wrong key, other
  paths or methods) gets its own 5 a second per calling network (bursts of 10, then 429), so no flood of
  requests to `dlapi.ipterm.net` without the key can switch the leak test off for everyone. A change to
  `dnsleak-server/` takes effect only after `sh setup.sh <vps-ip>` is run again.
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
  resolver addresses are shown as such and never sent anywhere (in the text answer,
  `10.0.0.1  non-public: RFC 1918 private range (10.0.0.0/8)`). JSON, or aligned text with
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
carrier-grade NAT (Starlink, T-Mobile, Verizon Wireless, AT&T Mobility: `CGNAT` in `public/ports.js`, shared
with the page, which hides these names in a port result's Markdown) the provider is named. Only TCP can be
tested; for UDP services (WireGuard, Valheim, Minecraft Bedrock) the result says so. No sponsored line follows any port result.

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
`cidr.js`; add a port by adding a line to its `LIST`, and its IANA names and the date below with it.

- **IANA's name.** Each port's page, the Worker's and the terminal's (`portAbout()` in `public/app.js`), has an
  "IANA name" row: the service name(s) IANA registered for that port on the protocol(s) of its row, from the
  [Service Name and Transport Protocol Port Number Registry](https://www.iana.org/assignments/service-names-port-numbers)
  (`IANA` in `public/ports.js`, from the CSV of 2026-10-25), such as "ssh (TCP)" or "domain (TCP and UDP)", or "not
  registered with IANA" (Minecraft's 25565, WireGuard's 51820 and eight more). Some names belong to another service
  than the one people use the port for (5000 is `commplex-main`, 7777 `cbt`), and the row says what IANA has, as it
  is. The row links IANA's registry, searched for the port (it has no page per port:
  `https://www.iana.org/assignments/service-names-port-numbers?search=<n>`), and whatportis.com's page for it
  (`https://whatportis.com/ports/<n>`), both `rel="noopener"`; they are on 42 pages, not thousands, so not
  `nofollow`. whatportis has no page for four of the ports, 8096, 28015, 51413 and 64738 (a 404 on 2026-10-25, when
  the others answered 200, or 308 to a page that did), so theirs link IANA alone: `NO_WHATPORTIS` in
  `public/ports.js`, with the day it was checked, which `PORTS.refs()` reads. Check the 42 again when the IANA names
  are, following redirects, and change the set and its date together. Ports outside the list have no row: only the
  listed ones were checked against the registry. To check them again, download the registry's CSV and run
  `node tools/check_pages.mjs service-names-port-numbers.csv`.
- **Sitemap and date.** `/port` and the 42 pages have a sitemap file of their own, `/sitemap-ports.xml`
  (`portPaths()` in `src/worker.js`), so Search Console shows how they are indexed. Every URL in it, and its line
  in `/sitemap.xml`, carries `<lastmod>`: `PORTS.updated`, the `UPDATED` date in `public/ports.js`, the day the
  port pages' content last changed. Change it in the same commit as a change to a port's row, the IANA names or the
  page itself (`portPage()`, `portAbout()`), to the day it goes live, and at no other time: search engines ignore a
  `lastmod` that is always new. The pages draw only on `public/ports.js` and never run a check, so a crawl of them
  makes no outside request (`tools/check_pages.mjs` checks).

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

### Public DNS resolvers

`public/resolvers.js` holds eleven public DNS services and every address they document, 118 in all: Google Public DNS,
Cloudflare (1.1.1.1 and 1.1.1.1 for Families), Quad9, OpenDNS (with FamilyShield and Sandbox), AdGuard DNS,
CleanBrowsing, Control D, Yandex DNS, 114DNS, AliDNS and DNS.SB. For each service: its operator, its variants (each
with what it filters, its IPv4 and IPv6 addresses, DoH URL and DoT host), what the operator documents about DNSSEC,
EDNS Client Subnet (ECS) and logging, the operator's page that says it is anycast where one does (`anycast`), and the
operator's pages all of it comes from (`sources`). It is shared by the page and the Worker, like `ports.js`, and served
as a static file (`run_worker_first`).

- **Only what the operator documents.** Every fact is from the operator's own pages, listed with its service. What an
  operator doesn't document is `''` or `[]`, and the pages leave its line out: no DNSSEC line for CleanBrowsing (its
  pages say it validates, but tests on 2026-10-28 disagreed between its addresses), no ECS or logging line for
  OpenDNS, no DoT host for OpenDNS (Cisco says DoT runs on all its resolvers but names no host), and no filtering for
  OpenDNS's Sandbox or AliDNS (no row on the page, no line in the text, and the variant's name alone in the table).
  What a variant filters starts with "none" where the operator says it blocks nothing (`filters()` tells the two
  apart). Where an operator's own pages disagree, the line says both (Quad9's DNSSEC); where several give an endpoint,
  the newest does (OpenDNS's DoH URL is from Cisco's document 224705 of 2025-10-17). Short comments above a service in
  the file say why its rows read as they do.
- **Anycast only where the operator says so.** `anycast` is the operator's page saying its addresses are anycast, one
  of its `sources`, and 9 of them have one: Google's FAQ, Cloudflare's report on its 2025-07-14 outage (the 1.1.1.1
  docs say only that it runs in hundreds of cities), Quad9's FAQ, Cisco's Umbrella DoH article for OpenDNS ("our
  well-known anycast addresses"), AdGuard's list of DNS providers ("Public anycast resolvers"), CleanBrowsing's "How it
  works", Control D's free-DNS docs, 114DNS's FAQ and DNS.SB's FAQ. Only their pages get the "served from" row, the `anycast` tag and "Anycast:
  answered from many locations." in the summary, and only they are marked anycast on `/public-dns` (`anycast` and
  `anycastSource` in its JSON). Yandex and AliDNS get none of it. To add one, put the page in
  `anycast` and in `sources`.
- **Checking it again.** `LAST_CHECKED` (`RESOLVERS.checked`) is the day every row was last checked against its
  sources. To check again: open each service's sources; compare each variant's addresses, filtering, DoH URL and DoT
  host, the DNSSEC, ECS and logging lines, and the `anycast` page; fix what changed, with the page that says so in
  `sources`; then move `LAST_CHECKED` to the day it goes live, add a line to `public/changes.js` for what changed, and
  run `node tools/check_resolvers.mjs`. Move the date only after checking them all: the resolver pages and `/public-dns`
  say "last checked <date>", and `/sitemap-resolvers.xml` gives it as every page's `<lastmod>`. Addresses are in the
  operator's order, IPv6 in its short form (RFC 5952), as the pages write them; `RESOLVERS.get()` finds an address
  however it is written (`2606:1a40::0`, `2606:1a40:0:0:0:0:0:0`).
- **Their pages.** Each address keeps its IP page (`/9.9.9.9`), with its lookup as before, and adds the resolver block
  (`resolverBlock()` in `src/worker.js`; `resolverAbout()` in `public/app.js` draws the same after a `lookup`): the
  service and operator, the variant and what it filters, the variant's IPv4 and IPv6 addresses, DoH and DoT, "served
  from: anycast: answered from many locations" where the operator says so, its routing, the DNSSEC, ECS and logging
  lines where documented, the other variants with their addresses, a link to `/public-dns#<id>` (the terminal's too),
  the sources and "last checked", "See which resolver you actually use: leaktest", and the corrections line with the
  field `resolver`. The title is `9.9.9.9 · Quad9 DNS: addresses, DoH, DoT
  and filtering` (DoH and DoT only where the variant has them, and filtering only where one of the service's variants
  filters: Google's, AliDNS's and DNS.SB's titles end "addresses, DoH and DoT"), and the description says what the
  address is and the addresses set beside it: "9.9.9.9 is Quad9's public DNS resolver (Recommended / Secure).
  Secondary 149.112.112.112, IPv6 2620:fe::fe. DoH, DoT, filtering variants and live routing." (`RESOLVERS.title()`,
  `lead()` and `others()`, which the terminal's `ipTitle()` shares; `resolverText()`; "filtering variants" on the same
  terms). The summary adds "Anycast: answered from many locations." where the operator says so. None of it names a
  place, anycast or not, from IPinfo Core or a bot's IPinfo Lite alike (Lite places 1.1.1.1 in Australia), and the
  "Location wrong?" pointer to IPinfo is left out; IPinfo's location row stays with the lookup's other rows.
  "Secondary" is the operator's second address and "Primary" its first; Google says either can be primary, and
  Yandex's two pages order them differently, so theirs say "Also" (`either`). A resolver's address is curated
  (`curatedIps()`), so one that starts a network (76.76.2.0, 2606:1a40::, 2a09::) is indexed, whois links its page,
  and a typo of it (`/l.l.l.3`) gets a 301 to it, as a router address's does (`routerTypo()`). No sponsored line
  follows any of it, on the page or in the terminal.
- **Routing, and what a crawl costs.** The page shows how the address is routed only when the cache has it (someone's
  `route` in the last six hours, per data center), read in `ipRoute()` with no RIPEstat request for anyone, and
  otherwise a `nofollow` link to `/route/<ip>`. The terminal asks for it live (`/api/route`) for a person, counted and
  cached like any routing lookup. So a crawler's resolver page costs what any IP page costs it, IPinfo Lite and reverse
  DNS, and never Core, proxycheck.io or RIPEstat (see "Bots never spend the budgets"). The resolvers' prefixes are not
  in the curated routing list (`curatedRoutes()`), on purpose.
- **`/public-dns`** lists every service in one table: service and operator (marked anycast where the operator says so),
  variant and filtering, IPv4 (the operator's first and second), IPv6, DoH and DoT, each address linked to its page,
  each service's rows anchored by its `id` (`/public-dns#quad9`, which the resolver pages link). Then the sources and
  the corrections line. Its description counts the services itself ("Google, Cloudflare, Quad9, OpenDNS, AdGuard and 6
  more public DNS resolvers"), and so does the line under its heading (11 services, 118 addresses).
  Browsers get a document page like `/changes` (`docPage()`), curl plain text (`publicDnsText()`: 80 columns but for
  long source addresses), and `?format=json` the list as JSON, with `null` for what isn't documented. It asks no one
  anything. The guides "What your IP address reveals" and "IPv4 vs IPv6" link it, and so do `/help`, `public/llms.txt`
  and `openapi.json`. The terminal's `public-dns` (or `resolvers`; `public-dns quad9` for one service) prints the same
  list with each address linked.
- **Sitemap.** `/public-dns` and the resolver pages have a file of their own, `/sitemap-resolvers.xml`
  (`resolverPaths()`), as the ports do: so every URL can carry `RESOLVERS.checked` as its `<lastmod>`, Search Console
  shows how this family is indexed, and the list can't drift from the data. The thirteen resolver addresses
  `SITEMAP_PATHS` used to list moved there. It holds 119 URLs: `/public-dns` and the 118 addresses.
- **Control D.** Only its own six variants are here (Unfiltered, Malware, Ads & Tracking, Social, Family Friendly and
  Uncensored). Its docs also list 13 presets that only apply third-party blocklists it doesn't maintain (OISD, Hagezi,
  1Hosts, StevenBlack, AdGuard); their addresses are ordinary IP pages.
- **Adding a service.** Add it to `LIST` with every field from the operator's pages and its `sources`, plus `short` and
  `brand` for the titles and descriptions; `id` is its anchor on `/public-dns`. Its addresses get the resolver block
  and join the sitemap and `curatedIps()` by themselves.

`node tools/check_resolvers.mjs` checks all of this with no server (see "Local development").

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
  and `?format=text` still win, and curl, scripts and other clients still get JSON. Who counts as a bot for the
  IPinfo and proxycheck.io budgets is a wider test (`isBot()`: see "Bots never spend the budgets").
- Private addresses like `/192.168.1.1` get a page explaining the range and how to reach a router,
  a popular search topic, without any upstream lookup. Only the router and well-known addresses in `SITEMAP_PATHS`
  (`/192.168.1.1`, `/10.0.0.1`, `/127.0.0.1` ...) are indexed; the page of any other non-public address (private,
  CGNAT, loopback, link-local, documentation, IPv6 unique local ...) carries `<meta name="robots" content="noindex,
  follow">`, since the private space is millions of near-identical pages (`curatedIps()` in `src/worker.js`).
- A network's first address (IPv4 ending in `.0`, IPv6 with its low 64 bits zero: `netStart()` in `src/worker.js`) has
  a working page that is `noindex, follow` unless it is in `SITEMAP_PATHS`. It places one address of a block that may
  hold millions ("73.0.0.0 ... located in Coral Springs" for Comcast's /8), and the block's `/cidr` page is the one that
  answers a search for it; Google had indexed 21 such pages (`/104.21.0.0`, `/2603:2000::`) from ASN pages
  that used to link each prefix's first address. The page stays reachable with its own canonical, and leads with a
  link to its registered block's `/cidr` page when the lookup has the registry date (`block`). The whois page of a
  registry block's first address (`/whois/75.0.0.0` when the record is 75.0.0.0/8) links that block's `/cidr` page
  instead of the address, on the page and in the terminal (`whoisPage()`; `blockStart()` in `public/app.js`); other
  addresses, curated ones included, keep their "location and network" link.
- Typos of the addresses in `SITEMAP_PATHS`, and of every public DNS resolver's address in `public/resolvers.js`, get a
  301 to the exact address as that list writes it (`curatedIps()`): `/192.168.l.l`, `/192.168.1.l`, `/192,168,1,1`,
  `/192.168.0.l`, `/10.0.0.l`, `/l92.168.1.1`, `/192.168.o.1`, `/192.168.001.001`, `/192;168;1;1`, `/192.168.1.1.`,
  `/l.l.l.3`, `/9.9.9.l0` (l, i, I, `|` and `!` read as 1, o and O as 0, commas, semicolons, underscores and spaces as
  dots). The Location is always the list's own string, never built from the request, so it can't redirect anywhere
  else, and a query string is dropped (`routerTypo()`). A typo of an address in neither list (`/192.168.5.l`) gets the
  404 page with "did you mean lookup 192.168.5.1", not a redirect. `tools/check_seo.sh` tests valid, typo and hostile
  paths, and `tools/check_resolvers.mjs` a typo of every resolver IPv4 address.
- `/whois`, `/dns`, `/mail`, `/grade` and `/cidr` on their own are landing pages for each tool (what it does, usage and
  example links), and typing `whois`, `dig`, `mail`, `grade` or `cidr` with nothing after it shows the same thing.
  `/api` is the API docs page (the terminal runs `api`; the plain-text reference stays in the HTML for
  visitors without JavaScript), and it is in the sitemap.
- Addresses that don't exist get a 404 page in the terminal's style with a "did you mean" link when
  the address looks like an IP, ASN or domain. A domain typed straight after the slash
  (`/github.com`) redirects to its DNS page. Invalid lookups (`/whois/not-a-domain!`) show the error
  in the terminal instead of raw JSON. None of these pages are indexed by search engines.
- A page opened from a link (a result such as `/grade/github.com`, `/8.8.8.8`, `/AS13335` or `/mail/gmail.com`, a
  tool page such as `/leaktest`, a port page, a shared leak test result) opens on the start of its result, the command
  and the headline (the grade, the verdict), whenever the result is taller than the terminal, on phones and desktops
  alike, not on its last lines (`revealFrom()` in `public/app.js`). On a phone `/leaktest` used to open on the
  sponsored line, with the grade out of view. Commands typed afterwards follow the output as a terminal does (on a
  phone, each result starts at its command too), and typing brings the prompt back into view.
- Inside the terminal, every lookup updates the address bar, Back/Forward replay results, ASNs and
  prefixes are clickable, and each result's `[share] [copy] [md]` buttons (and the `share` command) share its
  link (see "Share, copy and copy md"; after `leaktest`, the link is to the grade: see "Shared results"). Prefixes on ASN pages
  open the subnet calculator (`/cidr/<prefix>`), whose routing section asks RIPEstat only, and upstreams open their
  own ASN pages (RIPEstat too). Keep it that way: an ASN page must not link to an IP lookup (`/<ip>`). A prefix's
  page is the one that answers a search for it, and linking each prefix's first address had Google crawl and index
  thin address pages. Links are not what keeps crawlers off the budgets, though: they reach address pages anyway,
  from whois, DNS and `/cidr` pages, and those cost nothing only because of `isBot()` (see "Bots never spend the
  budgets").
- **Few links to public prefixes.** An ASN page links only ten of its largest prefixes, up to four of them IPv6
  (`asnLinked()` in `src/worker.js`; the terminal's `renderAsn()` picks the same ten). The Worker's page lists the
  rest as text, and the terminal shows them as `rel="nofollow"` links: a click opens them as ever, but crawlers aren't
  invited to 30 public `/cidr` pages from each of the sitemap's 10,000 ASN pages (that is how one crawled about 155 a
  minute). For the same reason the terminal's "splits into" and "part of" links on a `/cidr` result, and its `next:`
  suggestions for the block twice the size and the first half, are `rel="nofollow"` when the block they open is
  public (`cidrRel()` in `public/app.js`): otherwise each public block's page leads to the next without end. Links to
  private and other non-public ranges (whatever `cidr.js` doesn't call public: `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7` and the rest) stay ordinary: those pages make no outside call, and
  they rank. It goes by the block the link opens, so `100.64.0.0/10`'s "part of", `100.0.0.0/9`, is public and
  `nofollow`. The Worker's own `/cidr` page lists "splits into" and "part of" as text, not links.
- **One copy of the site, on https.** Plain `http://ipterm.net` stays open: `curl ipterm.net`, the README's first
  line, goes over http, and curl doesn't follow redirects. Until October 2026 the pages answered over http as well,
  each naming its http address as canonical, and over http robots.txt and the sitemaps listed http URLs, so Google
  indexed `http://ipterm.net/` and `https://ipterm.net/` as two pages. Now `route()` answers a request over http in
  one of two ways:
  - Whatever gets pages (`wantsHtml()`: browsers, crawlers and link previews, for robots.txt and the sitemaps too)
    gets a 301 to the same address on https, path and query kept (and a port such as 8080 dropped), before any route
    runs, so a router typo is one hop to https and then its own 301.
  - Everyone else is answered over http as before: `curl ipterm.net` prints the address, and
    `curl -fs ipterm.net/expect/AS13335 || pkill ...` still gets its 412. A 301 would print nothing, and `-f` only
    fails on 400 and above, so the kill switch would exit 0 and never fire.

  Either way the Worker treats the request as https from then on, so everything it builds from its own address names
  https: the canonical, `og:url`, `og:image` and JSON-LD of every page, the guides' `%ORIGIN%`, robots.txt's
  `Sitemap:` line, every sitemap `<loc>`, the `/api` and badge snippets, and the Cache API keys (http and https share
  one cache, so an http lookup doesn't pay again). `wrangler dev`'s hosts (127.0.0.1, localhost, `[::1]`) are left
  on http (`localHost()`). **Leave Cloudflare's "Always Use HTTPS" off and add no http-to-https Redirect Rule**:
  they redirect curl too. HSTS stays as it is (`max-age=31536000; includeSubDomains` from `secure()` and
  `public/_headers`) and isn't preloaded, since preloading requires redirecting every client on the apex. Static
  files that skip the Worker (`run_worker_first`'s exclusions: `/app.js`, `/og.png`, `/openapi.json`, `/llms.txt`
  ...) still answer over http; pages load them over https, and the three documents name https URLs.
  `node tools/check_https.mjs` checks all of this with no server, and `tools/check_seo.sh` run against the live site
  asks it over http too. After a deploy that changes this, in Search Console: make sure the submitted sitemap is
  `https://ipterm.net/sitemap.xml`, inspect `http://ipterm.net/` (it should report the redirect) and request
  indexing for `https://ipterm.net/` only. The http URLs then move to "Page with redirect", which is the goal.
- `/robots.txt` and the sitemaps are generated. `/sitemap.xml` is a sitemap index (submit that one in Google Search
  Console and Bing Webmaster Tools) listing:

  | File | What | URLs (October 2026) |
  | --- | --- | --- |
  | `/sitemap-pages.xml` | `SITEMAP_PATHS` in `src/worker.js`: the home page, tools, guides, `/privacy` and `/changes`, router addresses, subnet and routing examples, DNS, mail, report card and whois pages | 73 |
  | `/sitemap-ports.xml` | `/port` and every port page in `public/ports.js` (`portPaths()`), each with its `<lastmod>` | 43 |
  | `/sitemap-resolvers.xml` | `/public-dns` and every resolver address in `public/resolvers.js` (`resolverPaths()`), each with its `<lastmod>` | 119 |
  | `/sitemap-asn-1.xml` | the 1,000 largest networks by announced IPv4 space | 1,000 |
  | `/sitemap-asn-2.xml` | the rest of the 10,000 largest | 9,000 |

  More ASN files, up to 40,000 URLs each (a sitemap file may hold 50,000), follow automatically if the list grows
  (`ASN_TIERS`, `asnSitemapFiles()`). The tiers let Search Console show how each is indexed. The index gives each ASN
  file a `<lastmod>`: the day the list was generated. The ports file's URLs carry the day the port pages last changed
  (`PORTS.updated`: see "Port checker"), and the index gives the file the same; so do the resolver pages' file and
  `RESOLVERS.checked` (see "Public DNS resolvers"). `/sitemap-pages.xml` has no
  `<lastmod>`: its pages change with live data, and a date that is always today is one search engines ignore. Every
  file is checked against the sitemaps.org schemas.
- **Titles and descriptions.** A title says what the page is for, its subject first, and ends in ` | ipterm`; the
  h1 is the title without that, and `og:title` the same. An IP page is `<ip> IP lookup: <org> (<ASN>), <hostname>`,
  leaving out what the lookup doesn't have (`8.8.8.8 IP lookup: Google LLC (AS15169), dns.google`, or just
  `<ip> IP lookup`); `ipTitle()` in `public/app.js` words it the same. A public DNS resolver's is the resolver's own,
  `9.9.9.9 · Quad9 DNS: addresses, DoH, DoT and filtering` (see "Public DNS resolvers"). A non-public address's page is titled with
  its kind's word from the special-purpose table (`kindWord()` in `public/cidr.js`; see "Subnet calculator"):
  `192.168.1.1 · private IPv4 address` for RFC 1918 and unique local (fc00::/7) space, the word the router pages'
  searches use, and `loopback`, `link-local`, `carrier-grade NAT (shared)`, `documentation`, `benchmarking`,
  `multicast` or `reserved` for the others, `non-public` only for a kind without a word (the unspecified address ::).
  The terminal titles its tab the same way (`lookup()`), and the page is tagged with the kind itself (`private`,
  `docs`, `benchmark` ...). An address IPinfo calls a bogon is `<ip> IP lookup: IPinfo lists it as a bogon` (see
  "IPinfo's bogons"). An ASN page is
  `AS13335 Cloudflare, Inc.: ASN, IP ranges and upstreams` (the name as RIPEstat gives it; `asn()` in `app.js` the
  same), and a `/cidr` page
  `10.0.0.0/22 subnet: 255.255.252.0, 1,022 usable hosts`, or `a single address` for a /32 (`cidrTitle()` in
  `app.js`), unless its routing names it. Search results show about 155 characters of a description, so each page
  gives `descFit()` its summary and shorter versions of it, key fact first, and gets the first that fits in
  `DESC_MAX` (155); one still too long is cut at a word. The page itself keeps the whole summary, and `og:description`
  is the same as the description. An IP page's description says where IPinfo locates the address, except for an
  anycast one (`flags.anycast`), which is answered from many places: it says "anycast (served from many locations)"
  instead. A public DNS resolver's page names no place either, whatever IPinfo says: IPinfo Lite, which bots get, has
  no anycast flag and gives only a country (Lite places 1.1.1.1 in Australia), and the page is about the resolver,
  "1.1.1.1 is Cloudflare's public DNS resolver. Secondary 1.0.0.1, IPv6 2606:4700:4700::1111. ..." Other Lite answers
  keep their country, and the location row is there either way. The tool
  pages keep their longer summary as `desc` and give search results `meta`; a guide's `meta` (in
  `tools/build_guides.py`) does the same where its blurb on `/guides` runs long. `node tools/check_pages.mjs` checks
  the titles, the descriptions and the terminal's titles.
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
  canonical link, share tags, breadcrumbs and Article structured data. A guide's `desc` is its blurb on `/guides`; where
  that runs past about 160 characters, a shorter `meta` is the description in search results, `og:description` and the
  structured data.
- **Homepage section:** plain HTML below the terminal (in `public/index.html`) explains ipterm and links to
  popular lookups and the guides, so search engines see real text and links. Clicking a lookup there runs it
  in the terminal.
- **Share image:** `public/og.png` (1200×630) is used when any page is shared, except a shared leak test result, which uses its grade's `public/og-leak-<a-f>.png` (made by `tools/build_og_leak.mjs`).
- **Placeholders:** static pages use `%ORIGIN%`, which the Worker replaces with your site's https address, and each
  guide ends with `<!--FIX-->`, which it replaces with the guide's corrections line (see "Corrections and changes").
- **Sitemap:** `/sitemap.xml` is an index of `/sitemap-pages.xml` (`SITEMAP_PATHS` in `src/worker.js`: guides,
  router addresses and more), `/sitemap-ports.xml` (every port page, with `<lastmod>`), `/sitemap-resolvers.xml`
  (`/public-dns` and the resolver pages, with `<lastmod>`) and the ASN files (`/sitemap-asn-<n>.xml`, from
  `src/asn-sitemap.js`). See "Shareable pages and search".

## Corrections and changes

**The line.** Reference pages end with "Something wrong here? Suggest a fix on GitHub (public, needs an account) or by
email." They are `/port` and every port page (`portPage()`, and the `/port` tool page), the tool pages `/whois`,
`/dns`, `/mail`, `/grade`, `/cidr` and `/api` (`toolRoute()`), every guide (the `<!--FIX-->` that
`tools/build_guides.py` puts at its end, filled in by `withOrigin()`), a public DNS resolver's block on its IP page
(`resolverBlock()`) and `/public-dns` (`publicDnsRoute()`). The terminal prints the same line after the same pages
(`port <n> --info`, `port`, `whois`, `dig`, `mail`, `grade`, `cidr` and `api` on their own, a resolver's `lookup`
and `public-dns`), and drops the server's copy (`.fix`) on boot so it doesn't show twice; `copy md` leaves it out.

- **What it sends.** The GitHub link opens the correction form in `SOURCE_URL`'s repository,
  `<SOURCE_URL>/issues/new?template=correction.yml&title=Correction: <path>&page=<the page's address>`, and the email
  link is `mailto:contact@ipterm.net?subject=Correction: <the page's address>`. Nothing else: never the visitor's
  address, results or anything about them, and no `labels=` (GitHub answers 404 to a visitor who can't set a label).
  A page can name the field the line is about (`fixLine(io, path, field)` in `src/worker.js`, `fixLine(path, field)`
  in `public/app.js`): it goes into the title, the subject and the form's `field`. A resolver's block passes
  `resolver`, so a report about its rows isn't taken for one about IPinfo's. ipterm
  stores nothing about any of it; the GitHub link is `rel="nofollow noopener"`.
- **Where it never goes.** Not on the visitor's own results: the homepage (`whoami`), `/leaktest` and a port check, so
  nobody is invited to post their own IP in public. Nor on IP (but a resolver's), ASN, `/cidr`, DNS, whois, mail or
  report card results, shared leak test results, 404s, `/guides`, `/privacy` or `/changes`, and never in the text or
  JSON that curl gets (curl gets a guide as HTML, line and all). A request to remove a person's name goes by email only
  (the form says so).
- **IP pages point to the data's source instead:** "Location wrong? IPinfo takes corrections at ipinfo.io/corrections",
  where the page shows a place from IPinfo Core or IPinfo's free API (`ipinfoFixes()` and `IPINFO_FIX` in
  `src/worker.js`, `ipinfoFix()` after `lookup` in `public/app.js`). Not for an anycast address, whose place is one of
  many, nor for IPinfo Lite (bots get it), which has no anycast flag and gives only a country (a bot's `/1.1.1.1` would
  read "Australia"), nor for a public DNS resolver, whose block has the corrections line instead. Copies show it too:
  it points to IPinfo, not to ipterm.
- **Copies.** `SELF_HOSTED = "true"`, an empty `SOURCE_URL` or one that isn't a GitHub repository
  (`https://github.com/<owner>/<repo>`) leave the line out everywhere (`fixRepo()`): the pages, the guides, and the
  footer's `data-fix` and `data-fix-mail`, which is how the terminal knows where the line goes (`footBuild()`).

**The issue forms** live in `.github/ISSUE_TEMPLATE/` and take effect once they are on the default branch:

| File | What |
| --- | --- |
| `correction.yml` | "Correction": a notice that issues are public and not to paste your own IP, then Page (required; the link fills it in), Field (optional; filled in where a page names one), What's wrong (required) and Source (required). Label `correction` |
| `new-port.yml` | "Suggest a port": the same notice, then the port, protocol, what uses it, the maker's own documentation (required) and notes. Label `new-port` |
| `config.yml` | the template chooser: locations go to IPinfo (`ipinfo.io/corrections`), whois records of addresses and networks to the regional internet registries (`nro.net/about/rirs`), domains' to ICANN Lookup, and privacy matters to `contact@ipterm.net` (the link opens `/privacy`, which gives the address too). Blank issues stay open for bugs |

The links fill in the form's fields by their `id`s (`page`, `field`), so renaming one, or the file, breaks the
prefill; `tools/check_corrections.mjs` checks they match. The forms name three labels, which GitHub only applies
if they exist in the repository: `correction` and `new-port` (each form adds its own) and `upstream`, which the owner
adds to a correction whose fix belongs to the data's source (IPinfo, a registry) and says where in the issue. To
create them: on GitHub, open the repository's **Issues** tab, then **Labels**, then **New label**, and add
`correction`, `new-port` and `upstream` (any colors), or run `gh label create correction`, and so on, with the GitHub
CLI. Each fix is checked against the source given before anything changes.

**`/changes`** lists real fixes and new pages, newest first, from `public/changes.js`: `[date, what changed, pages]`
rows, written by hand in the same commit as the change and dated the day it goes live. It names no one: the GitHub
issue already credits whoever reported it. Browsers and crawlers get a page in the style of `/privacy`, curl and
scripts plain text wrapped to 80 columns with each page's full address (`changesText()`), and `?format=json` the same
list as JSON (`changesRoute()`). It makes no outside request, is in `/sitemap-pages.xml`, `/help`, `public/llms.txt`
and the footer, and `public/changes.js` is served as a static file too (`run_worker_first`). When a change alters the port pages, move
`PORTS.updated` with it (see "Port checker"); the corrections line did, to 2026-10-29, the day it went live.

`node tools/check_corrections.mjs` checks all of this with no server (see "Local development").

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
| `on` | Which results it can appear after: `whoami` (visitor's own IP), `check` (the leaktest verdict when its VPN detection ran and found none), `ip`, `asn`. Leave out for all |
| `weight` | Relative chance when several sponsors match (default 1) |
| `label` | Optional tag text instead of `sponsored`, e.g. `affiliate` |

Nothing the visitor copies or shares (`copy`, `copy md`, `share`) carries the sponsored line.
Targeting by result type works without tracking: a VPN offer fits `check`, a hosting offer fits `asn`.
`whoami` has no VPN signal, so a VPN offer on `whoami` is also shown to visitors who are already on a VPN;
`check` only appears when leaktest's VPN detection ran and found no VPN, and not after an earlier run in the same
tab found one.
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
| Accessibility help | `access` command, or the "accessibility" link in the footer. It lists the commands to type (theme contrast, theme paper, crt off, keys, reset) apart from what happens by itself (reduced motion, screen reader summaries); typing `motion` or `screen readers` explains that there is nothing to switch |
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
and, once the DNS leak test is set up, `/api/dnsleak`), plus one for the other IP version's lookup when there is one
(IPinfo Lite: no Core or proxycheck.io budget); its `/cdn-cgi/trace` read and a shared result page's images are free. A shared result page (`/leaktest/r/<code>`) is one request. A report card (`/grade/<domain>`) is one request, with 33 to 41 subrequests when it isn't cached (see "Domain report card"); each badge fetch is one request, and shields.io and GitHub's image proxy keep the image for as long as ipterm's copy has left (an hour at most; at least five minutes through shields.io, whose minimum that is, and a minute for the `.svg`). `ping` costs nothing: it times requests to `/cdn-cgi/trace`,
which Cloudflare's edge answers before the Worker runs. The Workers Paid plan ($5/month) includes 10 million
requests. The known VPN servers' cron trigger runs four times a day: one invocation, five subrequests (one per VPN
list, and Apple's iCloud Private Relay list, usually a 304) and one Durable Object request each time. A lookup reads the lists from memory, and each Worker refreshes its copy
at most every 10 minutes, from the data center's cache or with one Durable Object request per list; while the object has
no copy of a list yet (a new deployment before its first good download), every minute, and a lookup then also starts
a download of that list by an alarm at most once an hour. `/me`, `/line` and `/expect/...` are one request each, with no other cost: no subrequest, no Durable
Object call, no rate-limiter call.

**If you add a new static file** (an image, a script, like `cidr.js` was), add a `"!/<file>"` line to `run_worker_first`
so it doesn't count against the limit. Watch usage under **Workers & Pages → ipterm → Metrics**.

**What crawling the network pages costs.** The sitemap lists 10,000 ASN pages, each linking ten of its largest
prefixes to `/cidr` (30 until October 2026) and up to 5 upstreams to other ASN pages. None of them ever reaches IPinfo
or proxycheck.io, and a crawler's `/cidr` page makes no RIPEstat call: it reads the cache, unless the prefix is one of
the three public ones in `SITEMAP_PATHS` (`routeData()`; see "Bots never spend the budgets"). A public `/cidr`
page links its whois page, which links an address page (or, for a block's first address, the block's `/cidr` page):
for a crawler, that address page is IPinfo Lite or the cache (`isBot()`), so it adds a request and no budget. Measured under
`wrangler dev` (subrequests by wrapping `fetch` and the Cache API; CPU time by running the Worker's own code in Node
with RIPEstat's answers replayed, on a laptop, so treat it as an estimate):

| Request | Subrequests (uncached / cached) | CPU time (uncached / cached) |
| --- | --- | --- |
| `/cidr/<public prefix>` page | 6 (4 RIPEstat, 2 cache) / 1; for a bot 1 (the cache), unless in `SITEMAP_PATHS` | about 1 ms (IPv6 about 2.4 ms) / 0.3 ms |
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
| Rate limit: 30 uncached lookups per minute per visitor IP (per /64 network for IPv6, so rotating addresses doesn't help), then HTTP 429. Cached pages are never limited, so search crawlers can read them. The visitor's own details (the homepage, `whoami`, `/json`, `/text`) are never refused: past the limit they come without the hostname, the only part that asks anybody | `[[ratelimits]]` in `wrangler.toml`; `selfInfo()` in `src/worker.js`; `tools/check_bots.mjs` | Edit `limit` (period must be 10 or 60 seconds) |
| Bots never spend IPinfo Core or proxycheck.io: named crawlers and link previews, `BOT_UA`, and anything asking for HTML without a browser's `Sec-Fetch-*` get Core's answer only from the cache, otherwise IPinfo Lite, and a VPN check only from the cache; command-line tools and scripts asking for JSON keep full data | `isBot()`, `ipData()`, `privacyData()`, `blockData()` in `src/worker.js`; `tools/check_bots.mjs` | See "Bots never spend the budgets" |
| Bots never start a RIPEstat routing lookup: a public `/cidr` page shows them the calculation, with the routing only when it is cached; `/route/<ip>` sends them to a cached route or the address's `/32`; JSON and text answer 403. The three public `/cidr` pages in `SITEMAP_PATHS` are the exception. People, the terminal, curl and scripts keep live routing | `routeData()`, `cidrRoute()`, `routeRoute()` in `src/worker.js`; `tools/check_bots.mjs` | `curatedRoutes()`; see "Bots never spend the budgets" |
| A lookup's registry date (`block`): RDAP only, never IPinfo or proxycheck.io; never for the visitor's own address (`?block=0` from the terminal for their other IP version); bots (`isBot()`) only read the cache (shared with `whois <ip>`, a day); anyone else's registry request counts toward their rate limit, riding on the lookup's own count or sharing the VPN check's; 0.3 seconds at most once the rest of the answer is ready, then the answer goes without it and the request finishes in the background; lookups of one address share a request in flight; a registry that fails is left alone for a minute (ten after a 429) | `blockData()` in `src/worker.js`; `tools/check_block.mjs` | `BLOCK_RECENT_DAYS`, `BLOCK_GRACE`; see "Recently registered blocks" |
| iCloud Private Relay: Apple's list asked with its ETag (a 304 when unchanged), 60 seconds and a 32 MB cap, read a chunk at a time; a list that fails, isn't ranges or has fewer than 10,000 never replaces the last good one, which isn't used once 3 days old; ranges read field by field (public only, IPv4 /8 or narrower, IPv6 /16 to /64) | `src/relay-list.js`, `refreshRelay()` in `src/worker.js`; `tools/check_vpnlists.mjs` | `RELAY`; see "iCloud Private Relay" |
| Known VPN servers: downloaded by the cron trigger, and by an alarm at most hourly while the object has no lists (after a deployment, until the first good download), one request per provider, 20 seconds and a size cap each, no retries; read field by field, keeping only public IPv4 and global IPv6 addresses; a broken or short list removes nothing; an address is dropped 3 days after it was last listed, and a provider taken out of the code at once; lookups match exact addresses only and send nothing anywhere | `src/vpn-lists.js`, `VpnServers` in `src/worker.js`; `tools/check_vpnlists.mjs` | `VPN_PROVIDERS`, `VPN_MAX_AGE`; see "Known VPN servers" |
| Port checks: only the visitor's own address, one port at a time, only from the ipterm page (same-origin) or a command-line tool, never on page load; 10 a minute per address (`PORT_LIMITER`) | `portRoute()` in `src/worker.js`, `[[ratelimits]]` | See "Port checker" |
| DNS leak test: `/api/dnsleak` only from the ipterm page or a command-line tool, well-formed tokens only, rate limited; the VPS's API needs the `DNSLEAK_KEY` secret (compared in constant time), listens on 127.0.0.1 behind Caddy, hands each token's resolvers over once and forgets them; non-public resolver addresses never go to IPinfo | `dnsleakRoute()` in `src/worker.js`, `dnsleak-server/` | See "DNS leak test server" |
| Shared leak test results: the code is made in the browser and holds only the grade and per-check flags (no IP, provider, location or resolver); the Worker decodes it strictly (a letter that doesn't match its checks is a 404); the page never runs the test, and isn't indexed | `public/leakgrade.js`, `leakShareRoute()` in `src/worker.js` | See "Shared results" |
| Every value from DNS or a data provider is HTML-escaped; the JSON embedded in pages cannot break out of its script tag; page text is inserted with replacer functions so `$` sequences stay literal. A page's rows print markup only for a `Markup`, a class private to the Worker (a port page's IANA links), so no upstream value, `{ "html": ... }` or not, passes for markup; anything else is made a string and escaped | `esc()`, `safeJson()`, `shell()`, `staticBlock()` and `Markup` in `src/worker.js`; `tools/check_pages.mjs` | |
| Plain-text answers (`?format=text`, `/<ip>/text`, one-value endpoints, `/line`, `/expect`, the `/me` card, and their error messages) have control characters and bidi overrides replaced, so upstream data or a crafted link can't send escape sequences to a terminal. JSON answers write the same characters as `\u` escapes. The only escape sequences are ipterm's own colors: the `/me` card's, and `?color=1`'s on text answers, added after `plain()` | `plain()`, `kvText()`, `termSafe()` in `src/worker.js`, `meRoute()` | |
| Upstream data is checked before use: AS numbers must look like `AS123`, IPinfo's other fields must be strings (country codes two letters) or are dropped, abuse emails must be plain addresses (no `mailto:` extras), registry responses are read with a size cap, and the registrar link is only followed to a public https host, without redirects | `ipinfoCore()`, `provider()`, `validEmail()`, `readJson()`, `safeRdapLink()` in `src/worker.js` | |
| The report card's requests to a domain's own site: HEAD only (a GET only after a refused HEAD, its body never read), only to `https://` and `http://` on the default port for a validated name whose addresses are all public, redirects followed only over https within the domain, only to hosts whose addresses are public, and at most twice, 5- and 4-second limits, at most 100 headers looked at and 9 kept, each capped. A 403, a challenge or a timeout is "couldn't check", never a FAIL | `webCheck()`, `httpsCheck()`, `httpCheck()`, `redirectTarget()` in `src/worker.js` | |
| Badges: the JSON holds only shields.io's schema fields; the SVG holds only a fixed label and the grade (escaped anyway), and is the only answer sent with `Cross-Origin-Resource-Policy: cross-origin` | `badgeReply()`, `badgeSvg()`, `secure()` in `src/worker.js` | |
| The mail check's one outside fetch, the MTA-STS policy, goes only to `https://mta-sts.<domain>/.well-known/mta-sts.txt` for a validated domain name: no redirects followed, 5-second limit, 64 KB cap. Policy lines, report addresses and logo links are checked before use (host names, plain emails, https URLs only) | `stsPolicy()`, `parseSts()`, `reportUris()`, `httpsUrl()` in `src/worker.js` | |
| Cross-site browser access (CORS) off by default. Only the static `/openapi.json` and `/llms.txt` allow any origin | `PUBLIC_API` in `wrangler.toml`; `public/_headers` for the two documents | Set to `"true"` to offer a public browser API |
| Private, loopback, CGNAT, multicast, documentation and other special-purpose addresses rejected before any upstream call; an address IPinfo answers `bogon` for goes no further (no proxycheck.io, no registry) | `nonPublicReason()` in `src/worker.js` (the table in `public/cidr.js`), `withPrivacy()`, `blockData()` | See "Special-purpose ranges" and "IPinfo's bogons" |
| Redirects for address typos take their Location from `SITEMAP_PATHS` or `public/resolvers.js` (`curatedIps()`), never from the request, so they can't be pointed anywhere else; the query string is dropped | `routerTypo()` in `src/worker.js`, tested by `tools/check_seo.sh` and `tools/check_resolvers.mjs` | |
| Plain http: pages (browsers, crawlers, link previews) get a 301 to the same path on https and the same host; curl and scripts are answered over http (`curl ipterm.net`, the `/expect` kill switch), and every link and cache key names https either way. HSTS on every answer, not preloaded | `route()` in `src/worker.js`; `tools/check_https.mjs` | Don't turn on Cloudflare's "Always Use HTTPS": see "One copy of the site, on https" |
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
- The Worker stores and logs nothing about visitors. Cloudflare still keeps its own records of the zone's traffic, and
  its dashboard shows up to the last 31 days of them: its analytics, mostly in aggregate (countries, paths, user
  agents), plus a sample of individual requests with their IP, country, path and user agent, whether or not a firewall
  or bot rule acted on them (Security Analytics, on every plan, Free included). Browsers may also send Cloudflare
  Network Error Logging reports, which the owner never sees.
  `public/privacy.html` says so, and the README, `/help`, `public/llms.txt` and `public/openapi.json` say "ipterm's
  code stores and logs nothing" rather than "nothing is stored". If you turn on Workers Logs or add analytics or ads,
  update the privacy policy first: IP addresses count as personal data under GDPR.

## When something fails

Every call to an outside service (IPinfo, RIPEstat, the registries, DNS) has a time limit and is retried
once after a short pause, so brief hiccups don't reach visitors. If IANA's registry directory is down,
whois falls back to rdap.org. When a lookup still fails, the visitor sees "A data source didn't respond"
(HTTP 502; whois names the registry server instead, below) and the Worker logs which service failed. Watch live with:

```sh
npx wrangler tail
```

Logs name the service and error only: never the visitor's IP or your API token.

**Deadlines.** The terminal waits 9 seconds for an answer (`getJson()` in `public/app.js`). whois, dig and routing
give up sooner, so the visitor gets the Worker's own words: the whole answer, every try and redirect included, gets
`DEADLINE` (6.5 seconds, the `by` of `fetchRetry()` in `src/worker.js`). Within it a server that doesn't answer gets
one try, not two: the retry comes only after a quick failure (a 5xx, a 429, a refused connection) with a second left.
For whois, IANA's file gets 3 seconds of it at most (`BOOT_WAIT`), so rdap.org still has time when IANA is down, and
the registrar's record 4 seconds or what is left. Until October 2026 a silent registry took about 17 seconds (8
seconds, twice), so the terminal gave up first and said "network error. Check your connection".

**A registry that fails is named** (`rdapFetch()`, `RegistryFailed`), whatever the failure. One that doesn't answer
within the deadline: "The .ng registry's whois server (rdap.nic.net.ng) didn't answer. That's on their side; try again
later." for a domain, and "ARIN's whois server (rdap.arin.net) didn't answer. ..." for an address or AS number (the
registry known by its server, as in `REGISTRY`; rdap.org by name, while IANA's list can't be read). One that still
fails after the retry says how: "ARIN's whois server (rdap.arin.net) failed to answer (HTTP 525). That's on their side;
try again in a moment." for an answer that is a failure (a 5xx, Cloudflare's 525 for a TLS handshake that failed, a
429, or another status whois can't read), and "AFRINIC's whois server (rdap.afrinic.net) couldn't be reached. ..." for
a refused or reset connection. The answer's body is read within the same deadline (`rdapFetch()`'s `json()`), and is
the server's too: one cut off after its headers "couldn't be reached", and one still unfinished at the deadline "didn't
answer". It is the same in JSON, as text and on the `/whois/` page, always with HTTP 502, and the report card's
registration line says "the registry record couldn't be read (rdap.nic.net.ng didn't answer)", or "(rdap.arin.net
failed to answer: HTTP 525)". The logs get the status and the server's host only: "rdap 525 from rdap.arin.net",
"rdap: couldn't reach rdap.afrinic.net", "rdap: no answer from rdap.nic.net.ng". An answer that isn't JSON, or is past
`readJson()`'s size cap, is one bad record rather than the registry failing, and gets the general "A data source
didn't respond. Try again in a moment."

Redirects are left to `fetch`, which follows them itself, so the server named is the one ipterm asked, from IANA's
list, unless an answer came back after a redirect: then it is the server that answered (the answer's `url`), RIPE
NCC's when ARIN sends a transferred block on and RIPE NCC answers 503. A server that goes silent behind a redirect is
reported as the one asked, since redirects are no longer followed by hand: LACNIC, not NIC.br, when LACNIC sends a
Brazilian address on and NIC.br doesn't answer, and rdap.org, not the registry it sent the request to.

Only silence pauses a server. One that had 3 seconds or more and didn't answer (or didn't finish its answer) is then
left alone for a minute (`RDAP_PAUSE`, per isolate, keyed by the origin ipterm asked, as a lookup's registry date
already was): whois, the report card and the registry date fail at once, in the same words, instead of each waiting
the deadline out. That is the server asked even when the silent one is behind it, so while NIC.br is silent LACNIC's
own addresses fail at once too, for that minute. A 5xx, a 525, a 429, a refused connection or an answer cut off pauses
nothing for whois (the registry date keeps its own pause, see "Recently registered blocks"), so one bad handshake
doesn't block a minute of lookups. A registry that answers within the deadline, however slowly, is not affected.
While ARIN is left alone, whois of its addresses and AS numbers goes to RIPEstat at once instead (below).

From 25 October 2026 `rdapFetch()` followed redirects by hand (`redirect: 'manual'`, three at most), so that the
silent server behind a redirect could be named. ARIN lookups then often failed with HTTP 525 (Cloudflare's TLS
handshake with rdap.arin.net, an old Apache and OpenSSL 1.0.2k, failing), and the release was rolled back. A throwaway
test Worker later saw the same 525s with redirects followed either way, and from the old release too: they come and go
with the time and the Cloudflare location (about 12 to 40% of fresh lookups still failing after the retry), not with
how ipterm asks. `fetch` follows redirects itself again all the same (the deadline stays). A longer pause before the
retry didn't help either: on 31 October 2026, from IAD, 3 of 25 fresh lookups still failed after a 0.4-second pause
and 3 of 25 after a 2-second one, so the retry stays at 0.4 seconds. The 525s don't show locally: `wrangler dev` and
Node connect to ARIN directly, so `tools/check_timeouts.mjs` checks the logic only. Try a change to how registries
are asked on a throwaway Worker on workers.dev, against fresh ARIN lookups, before it serves visitors: Cloudflare
makes no preview address for a version of a Worker with Durable Objects, as ipterm is.

**ARIN's records through RIPEstat.** RIPEstat's `whois` data call reads ARIN's whois database, and Cloudflare reaches
RIPEstat without trouble, so when rdap.arin.net fails a whois of an address or AS number with a `RegistryFailed` (an
error status such as a 525 after the retry, a refused or reset connection, no answer, or being left alone for a minute
after it went silent), and at least 1.5 seconds of the deadline are left (`RELAY_MIN`), whois asks RIPEstat for ARIN's
record instead (`whoisLookup()`, `arinRelay()` and `relayAbuse()` in `src/worker.js`). An ARIN answer that isn't JSON
is one bad record, as before, and gets no second way. An address is asked as its /32 or its /64 (RIPEstat has no match
for a bare IPv6 address), which gives every ARIN network around it, and the record is the smallest of them, as RDAP's
is: a customer's network inside its provider's, which gets the provider's abuse contact as in RDAP, or of two the same
size the one reassigned, whichever RIPEstat lists first. RIPEstat sorts the records by kind, so which contact belongs
to which holder is lost, and ARIN's own records come with every answer: the networks it keeps for itself and, in
early-registration space (as in 128/8, 156/8, 157/8 and 192/8), its "Various Registries" network and that one's "No, Contact Known"
placeholder (nobody@example.com), all left out (`ARIN_ORGS`, `ARIN_POCS`). The abuse contact is then, in this order:
the holder's only one; the holder's that the network names too; with one holder, its first; the first of the
holder's, then of the network's, whose email RIPEstat's `abuse-contact-finder` lists (asked beside the whois call,
waited for only here), or else the first email it lists; and with no holder's contact at all, the network's own if it
has just one. The answer says where it came from: `source: "ripestat"` and `registryError` (ARIN's failure) in JSON,
and a source line, "ARIN's whois data, relayed by RIPEstat (rdap.arin.net failed to answer: HTTP 525)", as text, on
the page and in the terminal (with a `ripestat` tag). It is kept an hour rather than a day, ten minutes when the abuse
contact couldn't be told because abuse-contact-finder failed, so RDAP's fuller record comes back soon: RIPEstat leaves
out when a record last changed. Only whois itself does this, and not for bots, AI assistants included, as with routing
(RIPEstat's fair use). A lookup's registry date ("Recently registered blocks") never asks RIPEstat, but uses a relayed
record whois left in the cache like any other.

A block or AS number ARIN passed on to another registry (RIPE NCC, APNIC, LACNIC or AFRINIC), which ARIN's RDAP would
have redirected to that registry, comes back from RIPEstat in that registry's own words. whois then asks that
registry's RDAP server for the record (`RIR_RDAP`), with what is left of the deadline if a second is: an ordinary RDAP
record, kept a day, with no source line (its link that registry's). If that server fails too, whois names it, not ARIN,
as ARIN's redirect would have; but if it is only silent, with under 3 seconds (`RDAP_FAIR`) to answer, ipterm's
deadline cut it off, so ARIN's failure stands. Either way it is never left alone for a minute (`rdapFetch()`'s
`pause`): a registry given only what was left is no silent one, and its own addresses still get the full deadline.
Before this, on 31 October 2026, whois of 173.249.41.192, a Contabo block ARIN passed on to RIPE NCC, got ARIN's
failure. Otherwise ARIN's failure stands,
in the same words as before, when RIPEstat has no match, fails too, or takes past the deadline. A large network's
record that RIPEstat hasn't read lately can take it several seconds (five, Level 3's, Amazon's, Microsoft's, a hosting
company's and a root server's, ran past 6.5 seconds once, and came in about half a second a few minutes later), and so
can a block another registry holds (2.5 to 6.5 seconds for the five asked), so trying again a moment later usually works; a fresh
address in an ordinary network took 0.8 seconds (the median of 16, none over 1.5). A silent ARIN at the deadline
leaves no time for it. RIPEstat failing (an error, or no answer while abuse-contact-finder failed too) is left alone
for a minute (`relayQuiet`, per isolate, like `RDAP_PAUSE`), so while it is down ARIN's failures are reported at once;
one slow record, or one past `ripestat()`'s 1 MB cap, pauses nothing (a root server's answer runs past 500 KB with its
route objects).

Compared on 31 October 2026, from a machine that reaches ARIN directly, with ARIN made to fail: of 40 addresses and AS
numbers (IPv4 and IPv6, customers' networks, reassignments, early-registration space, AS ranges, root servers), the 35
that RIPEstat answered in time and the 5 retried gave ARIN's record, field for field but the last-changed date, for
37; the other 3 got another of the holder's contacts than RDAP's first: AS701 another of Verizon's abuse contacts, and
157.240.1.1 and 156.154.70.1 the same contact with another of its emails (RIPEstat gives one email and one phone
each). On Cloudflare's network, a throwaway Worker running this code from IAD the same day made 100 fresh
ARIN lookups: ARIN failed 14 of them even after its retry, and RIPEstat answered all 14, in 1.2 to 2.9 seconds; none
failed. `tools/check_relay.mjs` checks it (see "Local development").

**The terminal's own message** doesn't blame the visitor's connection when ipterm is slow. When its 9-second timer
fires it says "No answer from ipterm within 9 seconds: a registry or data source may be slow or down. Try again in a
moment."; when the request itself fails (a `TypeError`: no connection, or ipterm can't be reached), or the browser
says it is offline, "Couldn't reach ipterm. Check your connection, or try again in a moment." Both, like the Worker's
messages, offer `retry` (`RETRYABLE`).

**Worst cases**, with every outside service silent and every retry firing (anything over 9 seconds ends in the
terminal's own message):

| Request | Longest wait | Made of |
| --- | --- | --- |
| whois (`/api/whois`, `/whois/<x>`) | 6.5 s | `DEADLINE` (about 17 s before) |
| dig (`/api/dns`, `/dns/<name>`) | 6.5 s | `DEADLINE`, one try per record type (about 16 s before) |
| routing (`/api/route`, a public `/cidr` page) | 6.5 s | `DEADLINE`: prefix-overview 6 s, the other calls what is left (about 17 s before) |
| port check (`/api/port`) | 5 s | `PORT_TIMEOUT` |
| a lookup (`/api/lookup`, `/<ip>`) | about 27 s | IPinfo Core 6 s, then Lite 8 s twice, then proxycheck.io 4 s and the registry date's 0.3 s |
| leaktest (`/api/check`) | about 30 s | reverse DNS 3 s twice, then the lookup's Core and Lite, then up to 1.5 s for the Tor list |
| asn (`/api/asn`, `/AS<n>`) | about 20 s | RIPEstat 8 s twice, then 4 s for the upstreams' names |
| mail (`/api/mail`, `/mail/<domain>`) | about 25 s, more for a chain of slow SPF includes | DNS 4 s twice a query, in three rounds: the records; SPF includes, DMARC parents and the MTA-STS policy (5 s); DKIM |
| grade (`/api/grade`, `/grade/<domain>`) | about 40 s | its DNS in two rounds (4 s twice each), then the mail check beside whois (6.5 s) and the site (5 s) |

The last five have no deadline yet: each would need one through several parts, and one under 9 seconds would cut
real answers short. RIPEstat's announced-prefixes takes 3.5 to 5.4 seconds for the largest networks (AS3356, AS174
and AS13335, measured 2026-10-25), and IPinfo Lite is the fallback after a Core timeout of 6 seconds. Until then a
silent IPinfo, resolver or RIPEstat there ends in the terminal's own message, which no longer blames the visitor.

## Local development

```sh
npx wrangler dev
```

`sh tools/check_previews.sh` (link previews and crawlers get pages, scripts get JSON), `sh tools/check_go.sh`
(address-bar search, hostile inputs included), `sh tools/check_seo.sh` and the second part of
`node tools/check_block.mjs` (a lookup's registry date) run against it, by hand. The rest need no server (Node 22.15
or later), and `npm test` runs them all: `node tools/check_bots.mjs` (bots never spend the budgets),
`node tools/check_https.mjs` (plain http), `node tools/check_vpnlists.mjs` (the known VPN servers),
`node tools/check_pages.mjs` (the ports sitemap, the IANA row, titles and descriptions, special-purpose ranges),
`node tools/check_timeouts.mjs` (silent registries and the terminal's time limit), `node tools/check_relay.mjs`
(ARIN's records through RIPEstat when ARIN fails), `node tools/check_corrections.mjs` (the corrections line, the issue
forms and `/changes`), `node tools/check_resolvers.mjs` (the public DNS resolvers' data, pages, sitemap,
`/public-dns` and the terminal), the first part of `node tools/check_block.mjs` and dnsleak-server's own tests
(`npm test` in `dnsleak-server/`).

**`npm test`** (`tools/test.mjs`) runs those one at a time, each in its own Node process (never side by side:
dnsleak-server's tests open ports, and `check_timeouts.mjs` and `check_relay.mjs` time real waits), and prints a line
for each and a total, in about 30 seconds. It exits 1 if any of them fails, crashes or runs over 5 minutes, and prints what that
one printed, less the lines that passed. `check_block.mjs` gets `http://127.0.0.1:1`, which `fetch` never connects
to, so its part against a running copy says SKIP even while `wrangler dev` runs. Nothing to install: no check needs
a package, wrangler included. On older Node it stops at once and says which version it needs. On Windows,
dnsleak-server's server tests now and then fail with `listen EACCES`: their TCP server takes the port Windows gave
UDP, which may be in a range Windows keeps from TCP (`netsh int ipv4 show excludedportrange protocol=tcp`) or one
another program listens on. The tests don't work around that yet, and it isn't a fault in the server: run it again.

**On GitHub**, `.github/workflows/test.yml` runs `npm test` on every push to `master` and every pull request: one job
on Ubuntu with Node 24, `actions/checkout` and `actions/setup-node` at their current major version (v7), a token
that can only read, no secrets and no `npm install`. A Linux checkout has LF line endings where a Windows one has
CRLF, and the checks turn CRLF into LF when they read a file's text, so both pass alike. The checks against a running
copy (`check_previews.sh`, `check_go.sh`, `check_seo.sh` and the second part of `check_block.mjs`) aren't run there:
they need `wrangler dev`, and they ask outside services (RIPEstat, the registries, IPinfo's free API).

Under `wrangler dev` the first lookup starts the VPN lists' first download (the Durable Object's alarm), from the
providers' real lists. To run the cron trigger itself, start it with `npx wrangler dev --test-scheduled` and ask
`curl "http://localhost:8787/__scheduled?cron=17+*/6+*+*+*"`.

Note that `request.cf` location data is limited when running locally, and `ping` says it can't run there:
it needs Cloudflare's edge, which answers `/cdn-cgi/trace` on the deployed site. The port check sees
your address as `127.0.0.1` locally, so it answers "not tested". `wrangler dev` passes a
`CF-Connecting-IP` header through (Cloudflare's network replaces it), so sending your own public address
in it exercises the whole check locally.

Two scripts check a running copy (`wrangler dev` by default, or pass the site's address): `tools/check_previews.sh`
(link previews and crawlers get HTML, curl gets JSON; `/text` and `/json` after an address or AS number answer text
or JSON for every client, with colors only for `?color=1` and never on JSON, and `/8.8.8.8/txt` is a 404 pointing to
`/8.8.8.8/text`) and `tools/check_seo.sh` (typo redirects with valid, typo and
hostile paths, noindex on non-public addresses and on the ASN, whois and `/cidr` pages that name a network holder who
may be a private person, such an upstream listed by number only, `X-Robots-Tag: noindex` on the `/text` and `/json`
forms, the sitemap index and its URL counts; `ROUTES=1` adds the routing section; against the live site it also asks
over plain http, since `wrangler dev`'s 127.0.0.1 stays on http). Neither makes an IPinfo lookup;
the `/text` and `/json` checks use the caller's own address (answered from `request.cf`), non-public addresses and
AS13335, the ASN pages and the routing section ask RIPEstat, and the whois pages RDAP. In Git Bash on Windows, run them with `MSYS_NO_PATHCONV=1` so paths like
`/192.168.l.l` aren't rewritten.

`node tools/check_block.mjs [site]` checks a lookup's `block` (see "Recently registered blocks"). First, with no
server, the logic itself: `registryOf()`, `blockOf()` and `blockText()` read out of `src/worker.js` and
`blockLine()` out of `app.js`, run on records dated relative to today (so the checks never age out the way a real
recent block does), including the 180-day edge, the terminal's wording and the registry named for RDAP answers
shaped like the RIRs' and the NIRs' (never a hostname). Then `ipText()`, `ipPage()` and the terminal's `render()`
(read out the same way, what it draws on stubbed) get a recent block and an old one: the line must be in the text
answer, the page and the terminal's lookup for the first, and in none of them for the second. Then, against the
running copy, that your own address asked
for by number (`/<ip>/json`, `/api/lookup?ip=`, `/<ip>/text`) has no `block`, answered from the edge with no IPinfo
lookup. Locally `wrangler dev` lets the script choose its address through `CF-Connecting-IP`, and it follows a fresh
address in Google's IPv6 block: asked for by itself, with `?block=0` and by a crawler, it has no `block` (none of
them asked the registry); then curl gets one, with the right shape and a text line only if `recent` is true
(Google's block is old, so no line: the recent case is the first part's), and the crawler gets the same from the
cache. That is one ordinary lookup, from IPinfo's free API under `wrangler dev` (which has no `IPINFO_TOKEN` unless
`.dev.vars` sets one); live, these are left out. `LOOKUPS=1` adds a lookup of 8.8.8.8, with and without
`?block=0` (live, unless cached, that is one IPinfo Core lookup and one proxycheck.io query of their budgets), and
checks that `/8.8.8.8/org` (IPinfo Lite, free) is still one bare line.

`node tools/check_bots.mjs` (Node 22.15 or later) checks that bots never spend the budgets nor start a routing lookup (see "Bots never
spend the budgets"), with no server and no network: it runs the whole Worker in Node with `IPINFO_PLAN = "core"`, an `IPINFO_TOKEN` and a
`PROXYCHECK_KEY`, a budget counter that throws when a bot reaches it, and `fetch` stubbed to answer as IPinfo,
proxycheck.io, RDAP, DNS and RIPEstat would and to note every request. First `isBot()` itself, on the user agents of crawlers,
link previews, AI and SEO bots and headless browsers, and of browsers (a Cubot phone's included) and command-line
tools. Then Googlebot, a link preview, GPTBot and an unnamed client asking for an address's page without
`Sec-Fetch-*`, GPTBot on `/api/lookup`, ClaudeBot on `/<ip>/json`, an HTML client on `?format=json` and Googlebot
rendering leaktest (`/api/check`) must get IPinfo Lite with no VPN check or registry date, and never reach the budget
counter, Core, proxycheck.io or a registry; a browser navigation, the terminal's own fetch, curl, a Cubot phone and
leaktest in a browser must still get Core and proxycheck.io, but leaktest's lookup of the other IP version
(`?block=0&lite=1`, which `public/app.js` must send) gets IPinfo Lite only, with no budget counter; then Googlebot
gets the Core answer one of them cached, for free. Then the pages: whois of a registry block's first address links the block's `/cidr` page (the Worker's
page and the terminal's `renderWhois()`), other addresses and curated ones keep their lookup link, and a network's
first address has a noindex page with its own canonical and, when the lookup has it, its registered block. Then
routing (`routeData()`; `fetch` answers as RIPEstat too): Googlebot, bingbot, GPTBot and an unnamed client asking for
an uncached public `/cidr` page get the calculation and the "Routing data skipped" line with no RIPEstat request, and
the routing from the cache once a browser navigation has looked it up; the terminal's `/api/route`, curl and a script
still ask RIPEstat, and so does the terminal on the page a browser too old to send `Sec-Fetch-*` gets
(`bot: true`) and then drops the page's `.route-bot` note, while Googlebot's renderer gets the 403 (or, obeying
robots.txt, no answer) and the note stays, never an error line in its place; a private `/cidr` page is the same for a bot and a person
and asks nothing; a bot's `/route` asks nothing (a redirect, or a 403 for JSON and text); and the three public
`/cidr` pages in `SITEMAP_PATHS` keep live routing for bots, and only they. Then the links: the Worker's ASN page links ten of its largest prefixes (up to four
IPv6) and lists the rest as text, its `/cidr` page has no "splits into" or "part of" links, and the terminal's
`renderAsn()`, `renderCidr()`, `cidr()` and `next:`, run against a stand-in DOM, make the same ten ASN prefixes
ordinary links and the rest `nofollow`, and a block's "splits into", "part of" and `next:` links `nofollow` when the
block they open is public. Then a busy shared address (`selfInfo()`): with a rate limiter that refuses everything, the
homepage still carries the visitor's IP, and `/json`, `/text`, `/?format=text`, the terminal's `/api/lookup` and their
own address by number answer 200 with `hostname: null`, while lookups of other addresses, `/hostname` and `/api/check`
still get the 429. Last, proxycheck.io's catch-all `anonymous` flag on an anycast address: the JSON keeps the flags,
the text answer, the IP page and the terminal say "not a known VPN, proxy or Tor service" and name the flag, and the
terminal's map caption (`geoNote()`) gives the anycast address no radius.

`node tools/check_vpnlists.mjs` (Node 22.15 or later) checks the known VPN servers (see "Known VPN servers"), with no
server and no network. First the parsers, on a few real entries of each provider's list saved in
`tools/fixtures/vpn-lists/` (2026-10-21) plus odd ones: every address an entry, and what isn't a VPN entry skipped
(Mullvad's in-tunnel gateways, PIA's API proxies and signature lines, private, documentation and malformed
addresses). Then what is kept and found: a provider's lists add up, each address with when it was last listed, a
failed download only lets addresses expire, exact addresses only, IPv6 in any spelling, an exit before an entry, an
address listed more than 3 days ago passed over, a damaged blob refused. Then the refresh, on a stand-in for the
Durable Object's storage: one request per provider with ipterm's user agent; a download that fails, an HTML page, a
list under the minimum or over the size cap each change nothing and say why; PIA's changing lists add up; a short
list removes nothing; an address drops out 3 days after it was last listed, and the blob once none is left; an empty
object sets one alarm an hour; two refreshes at once share one set of requests; the cron trigger runs one. Last, the
whole Worker in Node: a listed address's JSON, text answer (with `?color=1`), IP page and terminal lookup (IPv4 and
IPv6), a neighbour and an unlisted address unchanged, Googlebot getting the listing without spending a budget,
leaktest's `/api/check` from a listed address skipping proxycheck.io, a made-up provider's exit skipping it in a lookup
too, a Worker's index past its 10 minutes answering at once while the next loads, a Worker with none asking the
object once a minute rather than every lookup and never waiting long on a load that doesn't settle, a provider taken
out of the code answering nothing, `/status`, the Worker without the binding, and leaktest in `public/app.js`: a
listing counts as a VPN, so the sponsored line never follows it, and the copied Markdown's masking hides each
provider's name. Then iCloud Private Relay: a few of Apple's real lines plus junk (`icloud-relay.csv`), read and merged,
with 28 addresses at range edges in both IP versions (first and last addresses in, neighbours out, adjacent ranges
merged, also across a 32-bit word); the refresh (no If-None-Match the first time, Apple's ETag the next, a 304, a
failure, a list far too short, a copy 3 days old, an old format); and lookups (JSON, text, page and terminal in both
versions, `?lite=1`, a bot, leaktest's check, `/status`, no proxycheck.io query) and leaktest's verdict.

`node tools/check_https.mjs` (Node 22.15 or later) checks plain http (see "One copy of the site, on https"), also
with no server and no network: the whole Worker in Node, its static files read from `public/`, and `fetch` stubbed. Over
`http://ipterm.net`, Googlebot, a link preview and a browser navigation get a 301 to the same path and query on https
(a port dropped, the HSTS header kept, `Vary: Accept, User-Agent`), robots.txt and the sitemaps included, while curl
gets the bare address, `/expect` its 200 or 412, and a script or `?format=json` its JSON. What curl gets over http
names https: robots.txt's `Sitemap:` line, every sitemap `<loc>` and a guide's `%ORIGIN%`; a lookup over http writes
an `https://` cache key, which the same lookup over https then reads; and the homepage a script gets over http (one
that doesn't ask for HTML still gets it at `/`), like a page after the redirect, has an https canonical, `og:url`,
`og:image` and JSON-LD. Then 127.0.0.1, localhost and `[::1]` stay on http, and `DNSLEAK_API` may still be plain
http there only. Last, the report card of the Worker's own host (`fetch` answers its DNS, and HTTP 522 for the site as
live): `grade ipterm.net` asked on ipterm.net shows HTTPS OK with every header line OK (CSP `default-src 'none'`, HSTS,
nosniff, frames, referrer) and HTTP OK, the 301 to https, with no request to ipterm.net over the network; asked on
another host it is fetched over the network as before (and so says HTTP 522), and so is example.com. (Under
`wrangler dev`, a request sent with `Host: ipterm.net` does get the 301, but wrangler's proxy rewrites its Location
to `http://`, so test the redirect here or on the live site.)

`node tools/check_pages.mjs` (Node 22.15 or later) checks the reference-page groundwork, with no server and no
network: the whole Worker in Node, as `check_bots.mjs` runs it, with `fetch` answering as IPinfo, proxycheck.io, DNS,
RDAP and RIPEstat would and noting every request, and parts of `public/app.js` run against a stand-in DOM. First the
ports sitemap: `/sitemap.xml` lists `/sitemap-ports.xml` with its `<lastmod>`, that file lists `/port` and all 42
port pages with the same real date (`PORTS.updated`, not in the future), `/sitemap-pages.xml` lists none of them, and
Googlebot gets each as an indexable page with no outside request. Then the IANA row on every port page, the
Worker's and the terminal's (`portAbout()`): the names and protocol or "not registered with IANA", linked to IANA's
registry and whatportis.com with `rel="noopener"`, the four ports whatportis has no page for to IANA alone
(`NO_WHATPORTIS`, with a real check date), and no row for a port outside the list. Then titles and descriptions: IP
pages with and without a hostname, with an AS number but no name, a bot's IPinfo Lite answer, an anycast address
(never "located in") and a bot's /1.1.1.1 (no place at all), non-public addresses of every kind (titled with the
kind's word and tagged as the terminal does, with no outside request; every indexed RFC 1918 page "private"), ASN
pages (a long holder name too), `/cidr` pages (a /32 is "a single address"; ::/0,
0.0.0.0/0 and blocks wider than their entry, such as ::/96 and 10.0.0.0/7, in honest words) and routed prefixes,
IPv6 too, that keep the block's size, each against the terminal's own title where it has one (`ipTitle()`, `asn()`,
`cidrTitle()`); every description, those of the port, tool, DNS, whois, mail and report card pages too, 155
characters or less, leading with the page's subject, the same in `og:description`. Then the special-purpose ranges:
every block of IANA's two registries (a copy in the script), first and last address, gets the same answer from the
calculator, the IP page's lookup and the terminal's `classify()`, as `SPECIAL` says. Last, the messages that name a
range (the lookup, whois, routing and port check errors, and the whois page) give its words once, at the end, with no
parentheses inside parentheses. Then IPinfo's bogons: the anycast addresses 192.0.0.9, 192.0.0.10, 2001:1::1,
2001:1::2 and 2001:1::3 are non-public and never looked up, and 192.88.99.1, which the stub has IPinfo Core, Lite and
the free API answer `{ "bogon": true }` for, gets its page (Googlebot's and a browser's), JSON, text answer and
terminal lookup in IPinfo's name, with no empty range, no fields of nulls and no request but IPinfo and reverse DNS.
Then markup: IPinfo answering `{ "html": "<b>x</b>" }` for a network's name, domain or place puts no markup on the
page (those fields are null), and `staticBlock()` prints only the Worker's own `Markup` as markup, escaping anything
else. Give it IANA's CSV files (`node tools/check_pages.mjs service-names-port-numbers.csv
iana-ipv4-special-registry-1.csv iana-ipv6-special-registry-1.csv`, from iana.org/assignments) and it also checks
every port's names and the registry copy against them.

`node tools/check_timeouts.mjs` (Node 22.15 or later) checks the deadlines and the registry messages (see "When
something fails"), with no server and no network: the whole Worker in Node with `fetch` stubbed, where a server that
never answers holds each request until the request's own time limit aborts it, and redirects are followed as the
platform's `fetch` follows them (unless a request says `redirect: 'manual'`). The deadlines are real, so it takes about
9 seconds, the slow cases side by side. First the quick failures, each a 502 well within the deadline after one
retry, naming the registry in its own words: ARIN answering 525 twice ("failed to answer (HTTP 525)", in JSON, as text
and on the page), the .ng registry 503 twice (and the report card's line), AFRINIC resetting the connection twice
("couldn't be reached"), APNIC 429 twice, and ARIN's redirect to a RIPE NCC server that answers 503 (RIPE NCC's, the
server that answered). ARIN's answer cut off after its headers "couldn't be reached" too (at once: the body gets no
retry), while a maintenance page instead of JSON is one bad record, with the general message. None of them pauses its
server: ARIN answering 525 and then the record, right after, gives the record through the retry, and AFRINIC is asked
again. LACNIC's redirect to a NIC.br that answers gives NIC.br's record, and no RDAP request may say
`redirect: 'manual'`. Then whois of unijos.edu.ng, whose registry server (rdap.nic.net.ng) never answers, must be a 502 within the deadline, well inside the terminal's 9 seconds, after one
request to that server, naming the .ng registry and its server; then the text answer, the page (and the
`initial.error` the terminal boots from) and the report card's registration line say the same at once, with no new
request, since the server is left alone for a minute. A silent ARIN must be named ARIN's, a silent NIC.br behind
LACNIC's redirect LACNIC's (the server asked, then left alone), a server that sends its headers and then nothing
"didn't answer" (and is left alone too), and a registry that answers in 2 seconds, or after one 503, still gives its
record; with IANA's file silent, whois of an AS number gets its record through rdap.org after IANA's 3 seconds. dig and routing with a silent resolver or RIPEstat must be a 502 within the deadline, one try per
query. Then the terminal's `getJson()` and `RETRYABLE`, read out of `public/app.js`:
its own abort says "No answer from ipterm within 9 seconds", with no word about the connection; a `TypeError`, or an
abort while the browser is offline, "Couldn't reach ipterm"; answers that came pass as before; and these messages and
the Worker's offer `retry`, while a typo doesn't. ARIN's failures there also ask RIPEstat for its copy of the record,
which has no match for any of them, so ARIN's failure stands, as quickly; the silent ARIN must not ask it.

`node tools/check_relay.mjs` (Node 22.15 or later) checks ARIN's records through RIPEstat (see "When something
fails"), the same way, with ARIN answering 525 and RIPEstat answering from records shaped like its real ones, cut down
to what whois reads. It takes about 7 seconds, for a silent ARIN's deadline. Each record must be RDAP's: a customer's
network inside Comcast's, with Comcast's abuse contact; Linode's reassignment of a whole Akamai block, with Linode's
own, in either order; AT&T's name unescaped; two CIDRs in address order; an answer of about 900 KB; an IPv6 address
asked as its /64, its CIDR as ARIN writes it; an AS range; early-registration space, where ARIN's "Various Registries"
placeholder must not hide the holder's own contact (one or two of them), whether abuse-contact-finder answers or
fails; and two holders sorted out by the email abuse-contact-finder lists (not just its first), or no abuse contact
when it fails, which is then kept ten minutes. abuse-contact-finder must be waited for only then. Each must carry
`source` and `registryError`, the source line as text and on the page (and app.js must word it the same), and be kept
an hour. A block ARIN passed on to RIPE NCC, and an AS number it passed on to APNIC, must come from that registry's own
RDAP, kept a day, within the one deadline; RIPE NCC answering 503, or silent with 3.5 seconds left, must be named;
silent with 1.3 seconds left, or under a second left once RIPEstat names it, ARIN's failure must stand; and RIPE NCC
must not be left alone after either silence (the next whois of a RIPE NCC address asks it). So must it when RIPEstat has no match, sends more than 1 MB or takes past
the deadline, for a bot, and with no time left after a silent ARIN; the next whois, ARIN left alone, gets RIPEstat's
copy at once (the slow and the oversized answers paused nothing), and after RIPEstat fails twice the one after that
gets ARIN's failure at once, RIPEstat left alone. APNIC failing asks RIPEstat nothing, and neither does a lookup's
registry date, ARIN failing.

`node tools/check_corrections.mjs` (Node 22.15 or later) checks the corrections line, the IPinfo pointer, the issue
forms and `/changes` (see "Corrections and changes"), with no server and no network: the whole Worker in Node with its
static files read from `public/` and `fetch` stubbed, and the terminal's `fixLine()` and `ipinfoFix()` run against a
stand-in DOM. First the line: `/port`, all 42 port pages, a port outside the list, the tool pages but `/leaktest` and
every guide end with it once, its GitHub link holding only the form, the title and the page's address (`SOURCE_URL`
from `wrangler.toml`) and its email link only the subject, never the visitor's address; the port pages still make no
outside request; `/public-dns` and a resolver's block (with the field `resolver`) have it too. None on the homepage,
`/leaktest`, a shared leak test result, other IP pages, ASN, `/cidr` and 404 pages, `/guides`, `/privacy`, `/changes`
or in curl's text and JSON (a guide, which curl gets as HTML, keeps it), and in `src/worker.js` only `portPage()`,
`toolRoute()`, `withOrigin()`, `resolverBlock()` and `publicDnsRoute()` call `fixLine()`. A copy (`SELF_HOSTED`, no
`SOURCE_URL`, or one that isn't a GitHub repository) gets no line, no `data-fix` and no placeholder left behind. Then
the terminal: the same links as the page from the footer's `data-fix`, with a field too (against the Worker's
`fixLinks()`), nothing without it, and only `portAbout`, `portIntro`, `toolIntro`, `apiHelp`, `resolverAbout` and
`publicDns` call it; the server's copy goes on boot and `copy md` leaves it out. Then IP pages: IPinfo's corrections
for IPinfo Core and its free API with a place, none for anycast, a resolver, IPinfo Lite, non-public addresses or a
bogon, the terminal's `ipinfoFix()` the same, and only after `lookup`. Then the issue forms: the fields and labels the
links and the owner use, the public notice, a required source, a description naming every kind of page whose line
opens it, and the contact links. Last `/changes`: real dates, newest first, no names, the entries with numbers or the
site's own words agreeing with it (the port pages' counts, the line's pages, the terminal's timeout); the page
(indexable, no outside request, Googlebot's the same), the text (80 columns, every entry and address), the JSON, every
linked page answering, the sitemap, `/help`, the footer and the static file.

`node tools/check_resolvers.mjs` (Node 22.15 or later) checks the public DNS resolvers (see "Public DNS resolvers")
with no server and no network, as above. The data: every address public, in its short form and listed once, found
however it is written; every service with an operator, variants, sources and only ASCII text; `LAST_CHECKED` a real
date; `anycast` for exactly the seven services whose operator says so, its page among their sources; Control D's own
six variants only; filtering left empty only for OpenDNS's Sandbox and AliDNS; and the rows the last check against the
sources fixed (OpenDNS's DoH URL, 114.114.114.110's name, Google's ECS line, Cloudflare's aggregates). Every resolver
page, as Googlebot sees it: indexable, titled and described as the resolver with no place ("filtering" only for a
service with a variant that filters), the anycast sentence only where the operator says so, its block row for row
(the service, variant, filtering where documented, its own addresses, DoH and DoT, "served from" and the anycast tag
where the operator says so, the other variants' addresses, the DNSSEC, ECS and logging lines only where documented,
the sources, "last checked", leaktest, `/public-dns#<id>` and the corrections line), no sponsored line, and no request
but IPinfo Lite and reverse DNS. A person's page: no RIPEstat request, then the routing a `route` lookup cached, which
Googlebot then sees too; a page that throws while it is drawn still gets `guard()`'s 502 page and log line
(`ipRoute()`'s `ok` is async, so `guard()` awaits it). `/public-dns` as a page (every address linked once, the counts,
anycast marked where the operator says so, every source, the line), as text (every address, endpoint and source, no
empty filtering line, 80 columns but for long source addresses) and as JSON (the same as `public/resolvers.js`), with
no outside request. The sitemaps: the index, `/sitemap-resolvers.xml` (every address, each with `RESOLVERS.checked`)
and none of them in `/sitemap-pages.xml`, and the curated routing list unchanged. Then the terminal, read out of
`public/app.js` against a stand-in DOM: `resolverAbout()` draws the Worker's rows and tags in the same order, links
`/public-dns#<id>` and asks for the routing, `lookup()` draws it in place of IPinfo's pointer and the sponsored line,
`public-dns` lists every address and takes a service, and the command is in `help`, `man`, the aliases and the
did-you-mean list. Last the wiring (`index.html`, `wrangler.toml`), the guides' links, `/help`, `llms.txt`,
`openapi.json`, `/changes` (its count) and this handbook (its counts).

## License

The code is MIT-licensed (`LICENSE`). If you'd rather it name you, change "the ipterm authors" there. Other parts
keep their own terms: the fonts in `public/fonts/` are under the SIL Open Font License (license files alongside),
the map outlines in `public/land.js` (and the land mask made from them) are from Natural Earth, public domain, and
IPinfo's data comes with its own attribution condition (see "Recommended: add a free IPinfo token").

## Next steps worth considering

- Exits for the known VPN servers. AirVPN's servers each answer a public DNS name, `<server>_exit.airservers.org`,
  with their exit address (AirVPN's app builds the same name), but it is undocumented, AirVPN says resolving by server
  name is limited, and it would take 250 DNS queries a refresh. NordVPN's list, likely exits, needs Nord's written
  permission. Either would turn many entries into exits, which also show up in `leaktest`.

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
- The report card's worst case, about 71 subrequests, is above the Workers Free plan's 50 (ipterm.net runs on Paid, whose
  limit is 10,000). A copy on the Free plan could give the mail check a smaller budget when it runs inside `grade`.
- The report card grades a subdomain's own mail records (`grade docs.example.org` asks for SPF at docs.example.org), as
  `mail` does. Grading the registered domain's mail instead would fit a website on a subdomain better, but the two
  checks would then disagree.
- Domain whois pages show a registrant's name when the registrar publishes one, often a person's. The same caution
  could apply in `domainWhoisPage()`, though the rules were written for network holders' names.
