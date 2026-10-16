# Show HN launch kit

Everything for posting ipterm's curl layer to Hacker News: the post, a checklist for the week before, and
answers to the questions people are likely to ask. Not deployed and not linked from the site (it lives outside
`public/`).

## The post

**Title** (36 characters; HN allows 80):

```
Show HN: ipterm – curl ipterm.net/me
```

Leading with the command itself is what worked for wttr.in's posts. Alternatives if that one feels too bare:

- `Show HN: curl ipterm.net/me – your IP on a Braille world map, no tracking`
- `Show HN: ipterm – what's-my-IP for the terminal, open source, no cookies`

**URL:** `https://ipterm.net`. People who click it get the browser terminal; the post text gives them the curl
lines. Link the GitHub repository in the text rather than as the URL, so the first thing people see is the thing
itself.

**Text** (HN formatting: a blank line between paragraphs, lines indented two spaces show as code, and `*` makes
italics, so there are no bullet stars below):

```
  curl ipterm.net/me

draws your IP, network, rough location, time zone and the Cloudflare data center that answered, under a small Braille world map with your location lit. It's built from what Cloudflare already knows about the connection (request.cf), so that request makes no third-party call at all.

ipterm started as a terminal-style "what's my IP" page and grew a command-line layer. A few things it does:

  curl ipterm.net                     # just your IP
  curl ipterm.net/line                # IP, network, country, data center on one line, for a prompt or tmux
  curl -fs ipterm.net/expect/AS13335 || pkill -f my-job    # 200 on that network, 412 off it: a VPN kill switch
  curl ipterm.net/8.8.8.8/org         # one value for any address
  curl 'ipterm.net/8.8.8.8?format=text'
  curl ipterm.net/mail/gmail.com      # SPF, DMARC, DKIM, MTA-STS, graded A to F
  curl -4 ipterm.net/port/22          # is a port open on your own IP?
  curl ipterm.net/help                # everything else

The card takes ?w=$COLUMNS to fit your terminal, ?color=0, and ?redact to hide the IP for screenshots. (In Windows PowerShell, type curl.exe: plain curl there is Invoke-WebRequest.)

What I tried to do differently: no cookies, no analytics, no accounts, and nothing about visitors is stored. The CSP is default-src 'none', with scripts and styles only from the site itself and one outside host (ipify, so the page can show your other IP version). Values from DNS and the registries are stripped of control characters before they reach your terminal. It's MIT-licensed, and the footer shows the commit that's deployed, so you can read the code that is running: <REPO URL>

How it's run: one Cloudflare Worker, vanilla JS, no build step. Your own address comes from Cloudflare's edge; other addresses from IPinfo (with a daily budget for city-level lookups), networks from RIPEstat, whois over RDAP, DNS from 1.1.1.1. Uncached lookups are limited to 30 a minute per address. The port checker only ever connects to the address the request came from, one port at a time, 10 a minute.

The browser version at ipterm.net is the same thing as a terminal, plus a VPN leak test (WebRTC, IPv6, time zone) and a subnet calculator. Happy to answer questions, and I'd like to hear what you'd want from the command line.
```

Before posting, replace `<REPO URL>`, and run every line in the text from a clean shell (see the checklist).

### What it looks like

`curl ipterm.net/me` at the default width (64 columns), with documentation values in place of a real address.
In a terminal the land is green and the marker a bright yellow `⣿`; with `?color=0` the marker is `@`:

```
╭─ ipterm.net/me ──────────────────────────────────────────────╮
│                                                              │
│          ⣀⣠⡤⡀⣄⡶⣿⣿⡛⠻⠷⢿⣿⣿⣿⣿⣿⡗⠉    ⠲⠒     ⡀⠄⢄ ⢀⣀⣴⣶⣦⣤⣀⣀⡀ ⢤       │
│ ⠲⠆⢴⣿⣿⣿⣷⣶⣿⣿⣾⣿⣿⣶⡿⠿⠋⣽⠷⠆ ⢿⣿⠟⠛⠋⠥⠄   ⣠⣴⢿⣿⣷⣶⣶⣶⣶⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⡷ │
│    ⠉⠁  ⠙⠻⣿⣿⣿⣿⣿⣷⣶⣤⣿⣿⣷⣤       ⠰⣳⣤⣽⣿⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣭⠁ ⠞    │
│          ⢿⣿⣿⣿⣿⣿⣿⣿@⠋⠉        ⢰⣾⢟⡛⠻⢿⢿⣭⣽⣿⣝⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⡟⠋⡔       │
│           ⠙⡿⣿⣿⠛⠛⠏⠁         ⢀⣼⣿⣿⣿⣶⣶⣶⣶⣿⣿⡻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠆⠑⠉⠁       │
│             ⠙⠻⠴⣦⠈⠂⠂        ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣞⣿⠿⠋ ⠈⢿⡿⠋⠹⢿⣿⡋⠁⠅          │
│                ⠈⢀⣾⣿⣷⣦⡄     ⠈⠻⠿⠛⢿⣿⣿⣿⣿⣿⡿⠃   ⠈⠃  ⢴⡍⣀⣤⠐          │
│                 ⠸⣿⣿⣿⣿⣿⣷⣶⠄      ⠈⣿⣿⣿⣿⣏         ⠈⠳⠍⠉⠁ ⠑⠷⢆⠂     │
│                  ⠙⣿⣿⣿⣿⣿⠇        ⣿⣿⣿⣿⠋⣴⠇          ⣀⣴⣾⣿⣼⣆      │
│                   ⣿⣿⣿⠟          ⠘⣿⡿⠃ ⠈           ⣿⡿⠿⢿⣿⣿⠇     │
│                  ⢸⣿⠏⠁                                ⠈⠍   ⡤⠃ │
│                  ⠘⠫                                          │
│ @ about here (your provider's hub, not your home)            │
│                                                              │
│ ip         203.0.113.4  IPv4                                 │
│ network    AS64500  Example ISP                              │
│ location   Newark, New Jersey, United States [US]            │
│ time zone  America/New_York  10:42 (UTC-4)                   │
│ edge       EWR (Cloudflare data center)                      │
│                                                              │
╰─ no cookies · no tracking · ipterm.net/help ─────────────────╯
```

A screenshot of the colored version (taken with `?redact`) is worth putting at the top of the GitHub README.

## Pre-launch checklist

### Code and repository

- [ ] Merge this branch and the DNS leak test branch into master, then run `sh tools/check_previews.sh` against
      `npx wrangler dev` (36 checks), `node --check` on every JS file, and make sure `public/openapi.json` parses.
- [ ] `LICENSE` says "Copyright (c) 2026 the ipterm authors". Put your own name there if you prefer.
- [ ] Create the GitHub repository (public) and push **master only**. The `claude/*` branches are working copies
      and don't belong in the public repo.
- [ ] Every commit carries the author address `your personal email address`, and that becomes public with the push.
      If you'd rather it didn't, set `git config user.email <id>+<user>@users.noreply.github.com` for future commits;
      the existing ones keep the old address unless the history is rewritten, which this kit doesn't do.
- [ ] Set `SOURCE_URL` in `wrangler.toml` to the repository's address (`https://github.com/<you>/ipterm`), commit and
      push, so the footer's SHA links to the commit. `npm run deploy` warns if the commit isn't pushed yet.
- [ ] Replace `<REPO URL>` in the post text above.

### Cloudflare

- [ ] **Move to Workers Paid ($5 a month) the week of the launch** (Workers & Pages → Plans). The Free plan stops at
      100,000 requests a day, and past that every request fails until 00:00 UTC; a front-page day with curl scripts
      can pass that. Paid includes 10 million requests a month and raises the CPU limit from 10 ms to 30 s a request.
- [ ] **Turn off Cloudflare Web Analytics' automatic injection** for ipterm.net (Analytics & Logs → Web Analytics →
      the site → turn off the automatic setup, or remove the site). Right now Cloudflare injects its beacon script
      into the pages. The CSP blocks it, so nothing is measured, but it's in the HTML, and the first person to view
      source will ask why a "no tracking" site ships a beacon.
- [ ] While there, view source on `/`, `/privacy` and `/8.8.8.8` on the live site and check that no `<script>` appears
      that isn't ipterm's own. Rocket Loader, Zaraz and Email Address Obfuscation (Scrape Shield; `/privacy` has an email
      address) all inject scripts and should stay off.
- [ ] Deploy with the exact command (after merging, committing and pushing):

      ```sh
      npm run deploy
      ```

      Then check that the footer shows "the code we deploy: <sha>" linked to the commit, and that
      `curl ipterm.net/help` ends with the same SHA.
- [ ] Confirm the rate limits. Uncached lookups of 35 different addresses should give about 30 answers of 200 and then
      429s. This spends about 30 IPinfo Core lookups and as many proxycheck.io queries, and the limiter counts per
      Cloudflare location, so the cut-off can be a little loose:

      ```sh
      for i in $(seq 1 35); do curl -s -o /dev/null -w '%{http_code}\n' "https://ipterm.net/1.0.0.$i"; done | sort | uniq -c
      ```

      And the port checker, 10 a minute:

      ```sh
      for i in $(seq 1 12); do curl -4 -s -o /dev/null -w '%{http_code}\n' https://ipterm.net/port/443; done | sort | uniq -c
      ```

- [ ] Check `/me`, `/line` and `/expect` live, where `request.cf` has real data: `curl ipterm.net/me`,
      `curl 'ipterm.net/me?w=40&color=0'`, `curl 'ipterm.net/me?redact'`, `curl ipterm.net/line`,
      `curl -fsS ipterm.net/expect/$(curl -s ipterm.net/asn) && echo match` and `curl -fsS ipterm.net/expect/AS1 || echo "412 as it should"`.
- [ ] Pre-warm the caches of the post's example URLs, which also checks that each one answers:

      ```sh
      for p in 8.8.8.8 8.8.8.8/org AS13335 mail/gmail.com dns/example.com whois/github.com cidr/10.0.0.0/22 \
               '8.8.8.8?format=text' help api openapi.json llms.txt; do
        curl -s -o /dev/null -w "%{http_code} %{time_total}s  $p\n" "https://ipterm.net/$p"; done
      ```

      Cloudflare's cache is per data center, so this warms the one near you; visitors elsewhere cause one upstream
      lookup each the first time, which the budgets are built for.
- [ ] Run each line of the post from bash or zsh (zsh needs the quotes around URLs with `?`), and from Windows
      PowerShell with `curl.exe`. Check the card in Windows Terminal, macOS Terminal and one Linux terminal.

### During the launch

- [ ] Watch the budgets: `curl -H "x-status-key: <your key>" "https://ipterm.net/status?format=text"`. When the
      hourly IPinfo Core budget (375) runs out, lookups fall back to country-level Lite until the next hour, which is
      fine; raise `IPINFO_HOURLY_BUDGET` for the day if the monthly quota allows.
- [ ] Watch Workers & Pages → ipterm → Metrics (requests, errors, CPU time) and keep `npx wrangler tail` open for
      upstream failures. It logs which service failed, never a visitor's address.
- [ ] Be around for the first few hours to answer comments.

## Likely questions, with honest answers

**How accurate is the location?** Roughly: the right country almost always, often the right metro area, and
frequently 50 to 200 km off, because IP geolocation maps address blocks to where the provider registers or routes
them, not to buildings. Mobile networks and carrier-grade NAT are worse, and on a VPN you see the exit server. The
card says "your provider's hub, not your home", and the browser map draws a ring instead of a pin for the same reason.
Your own address is located by Cloudflare's data; other addresses by IPinfo.

**Why IPinfo, and not MaxMind or a free API?** IPinfo Lite is free for unlimited requests, with one condition:
credit IPinfo where the data is shown, which the footer and text answers do. Core (paid) adds city, coordinates and
VPN or hosting flags. The Worker spends at most 4,500 fresh Core lookups a day, paced per hour and per visitor, and
falls back to Lite, so a scraper can't run up the bill. Your own address never goes to IPinfo unless you run
`leaktest`; `/me`, `/line`, `/json` and the one-value endpoints use Cloudflare's data.

**What do you log?** ipterm logs nothing about visitors: no Workers Logs, no analytics, no Analytics Engine, no
cookies. What exists briefly: the rate limiter counts requests per address (per /64 for IPv6) for a minute; the
per-visitor share of the Core budget is a salted hash held in memory, with the salt replaced every hour; and lookups
of *other* addresses are cached for up to six hours, keyed by the address looked up, not by who asked. Cloudflare,
which runs the site, processes requests like any host (its own privacy policy applies). The code is public, so all
of this can be checked.

**How is the port checker kept from being a scanner?** It only connects to the address the request came from,
taken from `CF-Connecting-IP`, which Cloudflare sets itself and overwrites if a client sends one. There is no
parameter for any other address. One port per request, 10 checks a minute per address (per /64), nothing is sent over
the connection and it's closed at once. Non-public addresses and Cloudflare's own ranges are refused before any
connection. Only the ipterm page itself (same-origin) or a command-line client can start a check, so other sites
can't make their visitors' browsers run checks, and crawlers never do. Port 25 is blocked by Cloudflare anyway.

**What does it cost to run?** Workers Paid is $5 a month and covers 10 million requests. The IPinfo Core
subscription is the main cost: <fill in your plan's price>. Durable Objects (the budget counter) and the rate limiter
are within the included amounts, and static files are served without running the Worker, so they're free. The
domain is the rest.

**How do you make money?** Barely. In the browser terminal there is one labeled affiliate line (Proton VPN), shown
only after `leaktest` finds no VPN. It's a plain link: no ad script, no tracking pixel, and its sub-ID names the
placement, never the visitor. Nothing sponsored ever appears in curl output, and self-hosted copies show none.

**Can I trust `/expect` as a kill switch?** It tells you which network Cloudflare saw the request come from,
compared against what you asked for, with `no-store` so nothing caches the answer. `curl -f` fails on 412, but also
on a timeout or if ipterm is down, so `|| stop-something` fails closed, which is what you want. It checks the route
to Cloudflare only: with split tunneling, other traffic can take another path. For anything serious, also use your
VPN client's own kill switch.

**Why does `curl ipterm.net/me` show garbage, or nothing like a map?** Braille needs a font that has it (most
terminal fonts do: Cascadia, Menlo, DejaVu Sans Mono, JetBrains Mono). In Windows PowerShell 5.1, `curl` is an alias
for `Invoke-WebRequest`; use `curl.exe`. `?color=0` helps where ANSI colors aren't supported.

**Can I run my own?** Yes: MIT. Set `SELF_HOSTED = "true"` in `wrangler.toml` and the copy marks itself `noindex`,
empties its sitemap, drops the sponsored line and says in the footer that it's a copy. See "Self-hosting" in the
README.

**Why not IPv6?** It is: `/me` shows whichever address you connected with. `curl -6 ipterm.net/me` and
`curl -4 ipterm.net/me` pick one.
