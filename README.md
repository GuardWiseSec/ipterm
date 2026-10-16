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

### City-level lookups: IPinfo Core (paid)

IPinfo Core adds city, region, coordinates, time zone and a connection type (mobile network,
hosting or data center, anycast) to lookups of other IPs, and the map zooms to the city. Each
public lookup also gets a **vpn / proxy** row: "yes" when Core flags the address as VPN/proxy/Tor;
otherwise "not on known lists", with a note that hosting networks are where VPN servers usually
live, or that a clean result is not a guarantee (new VPN servers are often unlisted). Lookups
answered without Core say "not checked". To switch:

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
own location comes from Cloudflare), DNS, whois and the subnet calculator never use the quota. If
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
  IPinfo hasn't already flagged. Not for whoami, DNS, whois or the "hosted by" lines.
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

The verdict on the **vpn / proxy** line combines both sources: flagged by either one means "yes".

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
```

Add `?format=json` to force JSON from a browser.

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
reverse lookup. Pages live at `/dns/<domain>` and `/dns/<domain>/<TYPE>`; curl gets JSON. Answers come from
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
  a VPN)", just marked INFO instead of LEAK.
- **WebRTC:** asks Cloudflare's public STUN server (`stun.cloudflare.com:3478`) which public
  addresses the browser reveals, and flags any that differ from the IP websites see.
- **IPv6 / IPv4:** compares the network of the visitor's other IP version (via ipify) with the one
  they connected over. On a VPN, a different network means that traffic bypasses the VPN.
- **Time zone:** the device's time zone versus the IP's location (compared by UTC offset).

Findings count as LEAK only when the visitor appears to be on a VPN; otherwise the same facts are
shown as INFO. DNS leaks are not tested (that needs a custom DNS server). Nothing is stored. The
visitor's own IP is sent to IPinfo only when they run the check (it uses the Core daily budget),
and the privacy policy says so. When no VPN is detected, the Proton VPN line can appear
afterwards (`"on": ["whoami", "check"]` in `sponsors.json`).

## Shareable pages and search

- `/<ip>` and `/AS<number>` are real pages with their own title, description, canonical link and
  social-share tags, plus a plain summary of the result in the HTML itself. That summary is what
  search engines index and what visitors without JavaScript see; the terminal replaces it on load.
- Private addresses like `/192.168.1.1` get a page explaining the range and how to reach a router,
  a popular search topic, without any upstream lookup.
- `/whois`, `/dns` and `/cidr` on their own are landing pages for each tool (what it does, usage and
  example links), and typing `whois`, `dig` or `cidr` with nothing after it shows the same thing.
- Addresses that don't exist get a 404 page in the terminal's style with a "did you mean" link when
  the address looks like an IP, ASN or domain. A domain typed straight after the slash
  (`/github.com`) redirects to its DNS page. Invalid lookups (`/whois/not-a-domain!`) show the error
  in the terminal instead of raw JSON. None of these pages are indexed by search engines.
- Inside the terminal, every lookup updates the address bar, Back/Forward replay results, ASNs and
  prefixes are clickable, and the `share` command copies the current link.
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
      "on": ["whoami", "ip"],
      "weight": 2
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | `false` hides the line everywhere |
| `every` | Show after the 1st result, then every Nth (default 3) |
| `text` | Up to 160 characters, shown as plain text |
| `url` | Optional `https://` link, opened in a new tab with `rel="sponsored"`. Anything else is ignored |
| `on` | Which results it can appear after: `whoami` (visitor's own IP), `ip`, `asn`. Leave out for all |
| `weight` | Relative chance when several sponsors match (default 1) |
| `label` | Optional tag text instead of `sponsored`, e.g. `affiliate` |

Targeting by result type works without tracking: a VPN offer fits `whoami`, a hosting offer fits `asn`.
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
headers from `public/_headers`. A first visit costs about 2 Worker requests and each further lookup 1,
so the free plan's 100,000 requests a day covers roughly 50,000 visits. The Workers Paid plan ($5/month)
includes 10 million requests.

**If you add a new static file** (an image, a script, like `cidr.js` was), add a `"!/<file>"` line to `run_worker_first`
so it doesn't count against the limit. Watch usage under **Workers & Pages → ipterm → Metrics**.

## Security

| Protection | Where | How to change it |
| --- | --- | --- |
| Rate limit: 30 uncached lookups per minute per visitor IP (per /64 network for IPv6, so rotating addresses doesn't help), then HTTP 429. Cached pages are never limited, so search crawlers can read them | `[[ratelimits]]` in `wrangler.toml` | Edit `limit` (period must be 10 or 60 seconds) |
| Every value from DNS or a data provider is HTML-escaped; the JSON embedded in pages cannot break out of its script tag; page text is inserted with replacer functions so `$` sequences stay literal | `esc()`, `safeJson()` and `shell()` in `src/worker.js` | |
| Upstream data is checked before use: AS numbers must look like `AS123`, abuse emails must be plain addresses (no `mailto:` extras), registry responses are read with a size cap, and the registrar link is only followed to a public https host, without redirects | `provider()`, `validEmail()`, `readJson()`, `safeRdapLink()` in `src/worker.js` | |
| Cross-site browser access (CORS) off by default | `PUBLIC_API` in `wrangler.toml` | Set to `"true"` to offer a public browser API |
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

Note that `request.cf` location data is limited when running locally.

## Next steps worth considering

- City-level data for every lookup: upgrade to IPinfo Core, or swap the provider function for another API.
- VPN / proxy detection, bulk lookups, and a DNS / WebRTC leak test page.
