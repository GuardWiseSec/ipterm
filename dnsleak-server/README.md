# dnsleak-server: the DNS half of ipterm's DNS leak test

A small program for a small rented server (a VPS), outside Cloudflare. It does two things:

1. It is the authoritative DNS server for `dl.ipterm.net`. When `leaktest` runs, the visitor's browser
   looks up a few random, single-use names such as `3f9a0c41d27be5806a11.dl.ipterm.net`. Their DNS
   resolver (their provider's, their VPN's, or a public one like Cloudflare's 1.1.1.1) asks this server,
   and the server notes the resolver's address against that name. Every one of those names gets
   NXDOMAIN ("no such name"), so the browser's request fails at once.
2. It has a small API, `https://dlapi.ipterm.net/v1/resolvers?t=<token>,...`, which the ipterm Worker
   calls with a shared key. It answers with the resolver addresses for those tokens, once, and forgets them.

```
browser ── looks up <token>.dl.ipterm.net ──> the visitor's resolver ──> this server, port 53
   │                                                                          (notes the resolver's IP)
   └── GET /api/dnsleak?t=<token> ──> ipterm Worker ── GET /v1/resolvers ──> Caddy :443 ──> this server
                                         │                (x-dnsleak-key)      (HTTPS)       127.0.0.1:8053
                                         └── each resolver's network: IPinfo Lite (never Core or proxycheck.io)
```

Why a separate server: Cloudflare's DNS can't tell anyone which resolver asked for a name, so the zone
has to be delegated to a server that can. Why the API runs behind HTTPS on a host name: a Worker can't
fetch a bare IP address, and the key shouldn't cross the internet in the clear.

It is plain Node.js with no dependencies (Go wasn't installed on the machine it was written on). Debian 12 and 13
and Ubuntu 24.04 ship a new enough Node (18 or 20), and Caddy, so the server needs nothing from outside the
distribution, no build step and no `npm install`.

## What it keeps (privacy)

- **Only the resolver's address**, the address that sent the DNS query, against the random name it asked
  for. That is usually a resolver run by the visitor's provider, VPN or a public DNS service, not the
  visitor. (If someone runs their own recursive resolver at home, it is their home address.)
- **In memory only**, for at most 110 seconds (it is swept every 5, so nothing lasts two minutes), and
  the first read through the API removes it. A restart forgets everything. Nothing is written to disk.
- **No logs of queries or addresses.** The program prints one line when it starts and, if a socket
  fails, the error code. Caddy has no `log` directive, so it keeps no access log.
- **EDNS Client Subnet is ignored.** Some resolvers attach part of the visitor's own address to their
  queries. The server never reads those options (`dns.js` skips them unread), so that never reaches memory.
- **Only well-formed tokens are kept**: one label of exactly 20 lowercase hex characters directly under
  the zone (`TOKEN_RE` in `dns.js`, the same format as in `public/app.js` and `src/worker.js`). Anything
  else gets an answer and is not noted.
- **Memory is capped:** 50,000 tokens of up to 16 addresses each; past that the oldest go first.

## Costs

- The server: about $4 to $6 a month. 512 MB of memory is plenty; the program uses about 60 MB.
- Data: each test is six small DNS queries and one API call, a few kilobytes. Any plan's included traffic covers it.
- The Worker: each `leaktest` makes one more Worker request (`/api/dnsleak`). The resolvers' networks come
  from IPinfo Lite (free, unlimited, cached six hours), never the paid Core budget or proxycheck.io.
- Let's Encrypt and Caddy: free.

## Setting it up

You'll need the server's public IPv4 address in several places; below it is `<vps-ip>`.

### a. Create the server

Any of these works. Pick the smallest plan with a fixed (static) public IPv4 address, about $4 to $6 a month:

- **Hetzner Cloud:** Create Server, image **Debian 13** (or 12), type CX22 (or the cheapest shared-CPU type offered),
  with a public IPv4 address. Add your SSH key.
- **Vultr:** Deploy, Cloud Compute (shared CPU), **Debian 13** (or 12), the cheapest plan with IPv4. Add your SSH key.
- **DigitalOcean:** Create Droplet, **Debian 13** (or 12), Basic, Regular, the $4 or $6 plan. Add your SSH key.

Ubuntu 24.04 works too, if Debian is not offered. Ubuntu 22.04 and Debian 11 don't (their Node is older than 18). The region doesn't
matter much: resolvers from everywhere will ask it, and one query takes a few milliseconds more or less.

Note the public IPv4 address. These providers keep it for as long as the server exists (on Hetzner, the
primary IP; on DigitalOcean, the droplet's IP; a reserved/floating IP is not needed).

### b. Open the ports

In the provider's firewall (Hetzner: Firewalls; Vultr: Firewall; DigitalOcean: Networking, Firewalls),
allow these inbound and nothing else:

| Port | For |
| --- | --- |
| UDP 53 | DNS queries from resolvers |
| TCP 53 | DNS over TCP (resolvers retry over TCP when told to) |
| TCP 443 | the API, and Let's Encrypt's certificate check |
| TCP 22 | SSH, for you (from your own address only, if the firewall lets you set a source) |

Port 80 stays closed: Caddy gets its certificate over 443.

### c. Add three records in Cloudflare

In the Cloudflare dashboard, **ipterm.net → DNS → Records**, add these. Set both A records to
**DNS only** (the grey cloud, not proxied): DNS queries and the Worker's API calls must reach the server itself.

| Type | Name | Content | Proxy status |
| --- | --- | --- | --- |
| A | `ns1.dl` | `<vps-ip>` | DNS only |
| NS | `dl` | `ns1.dl.ipterm.net` | (NS records are never proxied) |
| A | `dlapi` | `<vps-ip>` | DNS only |

The NS record hands `dl.ipterm.net` and everything under it to your server. Because its name server is
inside that zone, the `ns1.dl` A record is what Cloudflare hands out alongside it (the "glue"), so
resolvers can find the server. Add the A records first, then the NS record.

### d. Install the server

From your computer, in this repository (Windows has `scp` and `ssh` built in):

```sh
scp -r dnsleak-server root@<vps-ip>:
ssh root@<vps-ip> "cd dnsleak-server && sh setup.sh <vps-ip>"
```

(If your provider makes you log in as another user, use that user and `sudo sh setup.sh <vps-ip>`.)

`setup.sh` installs Node.js and Caddy from Debian, puts the program in `/opt/dnsleak`, writes its settings
to `/etc/dnsleak/dnsleak.env` with a new random key, starts the `dnsleak` service and Caddy, and opens the
ports in `ufw` if `ufw` is turned on. At the end it prints the key. Running it again later is safe: it
updates the program and keeps the key.

Caddy asks Let's Encrypt for the `dlapi.ipterm.net` certificate as soon as it starts, which works once the
`dlapi` record from step c points to the server. If you added the record only just now, give it a minute
and run `systemctl restart caddy`.

### e. Give the Worker the key

On your computer, in this repository:

```sh
npx wrangler secret put DNSLEAK_KEY
```

and paste the key `setup.sh` printed. `wrangler.toml` already sets `DNSLEAK_ZONE = "dl.ipterm.net"` and
`DNSLEAK_API = "https://dlapi.ipterm.net"`; the test turns on once the secret exists too. Then deploy as
usual (`npx wrangler deploy`). Until then, `leaktest` keeps saying DNS leaks weren't tested.

### f. Check that it works

1. **The server answers** (from your computer):

   ```sh
   dig @<vps-ip> test.dl.ipterm.net
   ```

   Expect `status: NXDOMAIN`, `flags: qr aa` (an authoritative answer) and, under AUTHORITY, an SOA record
   naming `ns1.dl.ipterm.net`. `dig @<vps-ip> dl.ipterm.net SOA` gives that SOA as the answer. On Windows,
   without `dig`:

   ```sh
   nslookup test.dl.ipterm.net <vps-ip>
   ```

   says `Non-existent domain`, and `nslookup -type=SOA dl.ipterm.net <vps-ip>` shows
   `primary name server = ns1.dl.ipterm.net`.

2. **The delegation works** (through a public resolver, the way visitors' lookups go):

   ```sh
   dig dl.ipterm.net SOA @1.1.1.1
   ```

   The SOA must be `ns1.dl.ipterm.net`, not Cloudflare's. (`nslookup -type=SOA dl.ipterm.net 1.1.1.1` on Windows.)

3. **The API is up, with a certificate, and wants the key:**

   ```sh
   curl https://dlapi.ipterm.net/healthz
   curl "https://dlapi.ipterm.net/v1/resolvers?t=0123456789abcdef0123"
   ```

   The first answers `{"ok":true}`, the second `{"error":"Wrong or missing key."}` with HTTP 401.

4. **End to end, after deploying** (macOS or Linux; this is what the page does, by hand):

   ```sh
   T=$(openssl rand -hex 10)
   dig +short $T.dl.ipterm.net
   curl "https://ipterm.net/api/dnsleak?t=$T&format=text"
   ```

   `dig` prints nothing (the name doesn't exist, as intended). `curl` lists the resolver or resolvers that
   asked, with their networks, and `names seen  1 of 1`. Run the `curl` line again and it says
   `0 of 1`: the server forgot the token after the first read. In Windows PowerShell:

   ```powershell
   $T = -join ((1..10) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
   Resolve-DnsName "$T.dl.ipterm.net" -ErrorAction SilentlyContinue
   curl.exe "https://ipterm.net/api/dnsleak?t=$T&format=text"
   ```

5. **In a browser:** open https://ipterm.net/leaktest. A `DNS` line shows which resolvers looked up the
   test names, and the "Not tested: DNS leaks" line is gone. Try it with your VPN on and off.

## Running and updating it

| Task | Command (on the server) |
| --- | --- |
| Status | `systemctl status dnsleak caddy` |
| Its messages (start-up and errors only) | `journalctl -u dnsleak -n 50` |
| Certificate trouble | `journalctl -u caddy -n 50` |
| Restart | `systemctl restart dnsleak` |
| Update | copy the new `dnsleak-server` directory over with `scp -r` as in step d, then `sh setup.sh <vps-ip>` again |
| New key | delete the `DNSLEAK_KEY=` line from `/etc/dnsleak/dnsleak.env`, run `sh setup.sh <vps-ip>`, then `npx wrangler secret put DNSLEAK_KEY` with the new key |
| Turn the test off | remove `DNSLEAK_ZONE` or `DNSLEAK_API` from `wrangler.toml` (or delete the secret: `npx wrangler secret delete DNSLEAK_KEY`) and deploy |

Settings (`/etc/dnsleak/dnsleak.env`; `setup.sh` writes the first six):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DNSLEAK_ZONE` | (required) | The zone it answers for |
| `DNSLEAK_NS` | `ns1.<zone>` | Its own name, as in the NS record |
| `DNSLEAK_NS_IPV4` | (required) | Its public IPv4 address, given out for `ns1.<zone>` |
| `DNSLEAK_NS_IPV6` | none | Its IPv6 address, if you also add an AAAA record for `ns1.dl` in Cloudflare |
| `DNSLEAK_DNS_BIND` | `DNSLEAK_NS_IPV4` | The address DNS listens on (UDP and TCP) |
| `DNSLEAK_DNS_BIND6` | `DNSLEAK_NS_IPV6` | The IPv6 address DNS listens on, if any |
| `DNSLEAK_DNS_PORT` | `53` | |
| `DNSLEAK_API_BIND`, `DNSLEAK_API_PORT` | `127.0.0.1`, `8053` | Where the API listens; Caddy forwards to it |
| `DNSLEAK_KEY` | (required) | The shared key, 32 characters or more |
| `DNSLEAK_HOSTMASTER` | `hostmaster.<zone>` | The SOA's contact field |

## Limits and safety

- **Answers:** SOA and NS for the zone (with the glue address), A (and AAAA, if set) for `ns1`, NXDOMAIN for
  every other name in the zone, REFUSED for names outside it (it never looks anything up for anyone),
  FORMERR for malformed queries, NOTIMP for other opcodes, BADVERS for EDNS versions above 0.
- **DNS rate limit:** 50 answers a second per asking network (/24 for IPv4, /56 for IPv6), bursts of 100.
  Its answers are at most about twice the size of the queries, so it is a poor tool for flooding anyone with forged queries.
- **TCP:** at most 200 connections, 10 seconds idle, queries up to 4 KB.
- **API:** GET only (and HEAD, for uptime monitors that check `/healthz` with it; HEAD never reads
  `/v1/resolvers`), the key compared in constant time, 1 to 10 tokens per request. It listens on 127.0.0.1
  only; Caddy serves just `/v1/resolvers` and `/healthz`. The key is checked before the rate limits, which
  are two separate allowances, so calls without the key can't turn the leak test off for everyone:
  - `/v1/resolvers` with the key (only the Worker has it): 200 requests a second in all, bursts of 400.
  - Everything else (`/healthz`, a missing or wrong key, other paths and methods): 5 a second per calling
    network (/24 for IPv4, /56 for IPv6), bursts of 10, then 429. The caller is the address Caddy puts in
    `X-Forwarded-For` (Caddy 2.5 and later, as Debian and Ubuntu ship, replace whatever the caller sent
    there, since this Caddyfile trusts no proxies), so a flood from one place leaves `/healthz` answering
    for an uptime monitor elsewhere. Like the DNS limit, it holds only the network, for the seconds it
    takes to refill; visitors never call the API, the Worker does.
- **The service** runs as a throwaway user (`DynamicUser`) allowed to open port 53 and nothing else, with
  a read-only view of the system and 256 MB of memory at most (`dnsleak.service`).

## Why NXDOMAIN, and not an address

The token names could also answer with a harmless address such as 192.0.2.1 (TEST-NET-1, reserved for
documentation). Tested in Chrome 155, with headless Chrome given each kind of answer for a real
`<token>.dl.ipterm.net` name and fetched from a public page (`fetch(url, { mode: 'no-cors' })` with a 3-second
`AbortController`, as `leaktest` does):

| Answer | What the fetch did |
| --- | --- |
| NXDOMAIN | failed in 3 to 95 ms (`net::ERR_NAME_NOT_RESOLVED`) |
| A 192.0.2.1 | hung until the page gave up at 3 s (`net::ERR_ABORTED`): Chrome waits on a connection that never answers |
| A 10.0.0.1 (private) | the same hang; in a normal window, Chrome's Local Network Access permission prompt would come into it too |
| A 0.0.0.0 | failed at once, but only because Chrome blocks that address on purpose |

The home router on the test connection also dropped the answer for a 192.0.2.1 name entirely (DNS rebinding
protection), as many routers do. With NXDOMAIN the resolver has already asked this server before the
browser learns the name doesn't exist, so nothing is lost, the browser never connects anywhere, and the
page doesn't wait. Each name is used once, so negative caching (60 seconds) doesn't matter.

## Testing it locally

```sh
cd dnsleak-server
npm test
```

runs the tests (`node --test`, nothing to install): the DNS answers (every case above, 0x20 mixed case,
EDNS and Client Subnet, malformed and oversized queries), the store's two-minute expiry and memory caps,
and the running server over UDP, TCP and the API, including that a flood of calls without the key leaves
the Worker's whole allowance untouched. `npm test` at the top of the repository runs them too, after the
Worker's checks, and GitHub runs that on every push to `master` and every pull request.

To try it by hand on a high port:

```sh
DNSLEAK_ZONE=dl.ipterm.net DNSLEAK_NS_IPV4=203.0.113.7 DNSLEAK_KEY=$(openssl rand -hex 24) \
DNSLEAK_DNS_BIND=127.0.0.1 DNSLEAK_DNS_PORT=5300 DNSLEAK_API_PORT=8153 node server.js
dig @127.0.0.1 -p 5300 0123456789abcdef0123.dl.ipterm.net
curl -H "x-dnsleak-key: <that key>" "http://127.0.0.1:8153/v1/resolvers?t=0123456789abcdef0123"
```

The Worker can use a local server under `wrangler dev`: put `DNSLEAK_API=http://127.0.0.1:8153` and
`DNSLEAK_KEY=<that key>` in `.dev.vars` (plain `http://` is accepted only for 127.0.0.1 and localhost).
The browser's own test lookups still go out to the real DNS, so locally they never reach this server; use
`dig` as above for the DNS half, then `curl -A curl "http://127.0.0.1:8787/api/dnsleak?t=<token>"`.
