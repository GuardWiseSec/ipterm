"""Builds the guide pages in public/guides/ and the index at public/guides.html.

Run from the project root:  python3 tools/build_guides.py
Edit the GUIDES list below, then re-run and redeploy. %ORIGIN% is replaced with the site's
address by the Worker when a page is served, so canonical links and structured data stay correct
on any domain.

Each guide's desc is its blurb on /guides; meta, when there is one, is a shorter version (about 155
characters) for search results, og:description and the Article's structured data.
"""
import html
import json
from pathlib import Path

UPDATED = '2026-10-12'
UPDATED_LABEL = 'October 12, 2026'
OUT = Path(__file__).resolve().parent.parent / 'public'

def _subnet_table():
    rows = []
    for n in range(8, 33):
        mask = (0xFFFFFFFF << (32 - n)) & 0xFFFFFFFF
        wild = ~mask & 0xFFFFFFFF
        q = lambda v: '.'.join(str((v >> s) & 255) for s in (24, 16, 8, 0))
        total = 2 ** (32 - n)
        usable = 1 if n == 32 else 2 if n == 31 else total - 2
        rows.append(f'<tr><td><a href="/cidr/10.0.0.0/{n}">/{n}</a></td><td>{q(mask)}</td><td>{q(wild)}</td><td>{total:,}</td><td>{usable:,}</td></tr>')
    return ('<div class="table-wrap"><table class="doc-table"><thead><tr><th>Prefix</th><th>Subnet mask</th><th>Wildcard</th>'
            '<th>Addresses</th><th>Usable hosts</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div>')


GUIDES = [
    {
        'slug': 'find-router-ip',
        'title': "How to find your router's IP address",
        'crumb': 'router IP',
        'cmd': 'man router-ip',
        'desc': "Find your router's IP address (default gateway) on Windows, Mac, Linux, iPhone and Android, plus the most common default addresses and what to do if you can't log in.",
        'meta': "Find your router's IP address (default gateway) on Windows, Mac, Linux, iPhone and Android, plus the most common default addresses.",
        'lede': "Your router's IP address, also called the <em>default gateway</em>, is the address you type into a browser to open the router's settings page. It is usually 192.168.1.1 or 192.168.0.1, but it varies by brand and internet provider, so the surest way is to ask your device.",
        'body': '''
<h2>Windows</h2>
<p>Open <strong>Command Prompt</strong> or <strong>PowerShell</strong> and run:</p>
<pre class="doc-pre"><code>ipconfig</code></pre>
<p>Find the adapter you're connected with (Wi-Fi or Ethernet). The address next to <strong>Default Gateway</strong> is your router.</p>

<h2>Mac</h2>
<p>Open <strong>System Settings → Wi-Fi</strong> (or <strong>Network</strong> for a cable connection), click <strong>Details</strong> next to your network, then open <strong>TCP/IP</strong>. The <strong>Router</strong> field is the address. In Terminal:</p>
<pre class="doc-pre"><code>route -n get default | grep gateway</code></pre>

<h2>Linux</h2>
<pre class="doc-pre"><code>ip route | grep default</code></pre>
<p>The address after <code>default via</code> is your router.</p>

<h2>iPhone and iPad</h2>
<p>Go to <strong>Settings → Wi-Fi</strong>, tap the <strong>ⓘ</strong> next to your network, and look for <strong>Router</strong>.</p>

<h2>Android</h2>
<p>The location varies by phone maker. It is usually under <strong>Settings → Network &amp; internet → Wi-Fi</strong> (or <strong>Connections</strong>): tap your network, open its details or advanced options, and look for <strong>Gateway</strong> or <strong>Router</strong>.</p>

<h2>Common default router addresses</h2>
<div class="table-wrap"><table class="doc-table">
<thead><tr><th>Address</th><th>Often used by</th></tr></thead>
<tbody>
<tr><td><a href="/192.168.1.1">192.168.1.1</a></td><td>The most common default across many router brands</td></tr>
<tr><td><a href="/192.168.0.1">192.168.0.1</a></td><td>Another very common default</td></tr>
<tr><td><a href="/10.0.0.1">10.0.0.1</a></td><td>Many internet provider gateways, including Xfinity</td></tr>
<tr><td><a href="/192.168.1.254">192.168.1.254</a></td><td>Some provider gateways, including AT&amp;T</td></tr>
<tr><td><a href="/192.168.100.1">192.168.100.1</a></td><td>Status pages of many cable modems (separate from the router)</td></tr>
</tbody></table></div>

<h2>Why the address works for everyone</h2>
<p>These are <a href="/guides/private-ip-ranges">private addresses</a>. They only exist inside your home network, so millions of homes can use 192.168.1.1 at the same time without conflict. That also means nobody can reach your router at that address from the internet, and it can't be traced to a location.</p>

<h2>If you can't log in</h2>
<ul>
<li>The default username and password are usually printed on a label on the router. If you've never changed them, change them now: a default admin password is one of the most common ways home networks get taken over.</li>
<li>Some provider gateways and mesh systems (such as Google Nest Wifi or Eero) are managed through a phone app instead of a web page.</li>
<li>If nothing loads, check that you're on the router's network, not mobile data or a VPN.</li>
</ul>
''',
        'try': 'Look up <a href="/192.168.1.1">192.168.1.1</a> or <a href="/192.168.0.1">192.168.0.1</a> to see what ipterm says about common router addresses.',
        'related': ['private-ip-ranges', 'what-your-ip-reveals'],
    },
    {
        'slug': 'private-ip-ranges',
        'title': 'Private IP address ranges explained',
        'crumb': 'private ranges',
        'cmd': 'man private-ip',
        'desc': 'What 10.x.x.x, 172.16–31.x.x and 192.168.x.x addresses are, why they cannot be located, and the other special ranges you will see: loopback, link-local, carrier-grade NAT and documentation.',
        'meta': 'What 10.x.x.x, 172.16–31.x.x and 192.168.x.x addresses are, why they cannot be located, and other special ranges such as loopback and carrier-grade NAT.',
        'lede': 'Some IP addresses are reserved for use inside local networks and are never routed on the public internet. Your laptop, phone and router almost certainly use one of them right now, and they look the same in millions of homes and offices.',
        'body': '''
<h2>The three private ranges (RFC 1918)</h2>
<div class="table-wrap"><table class="doc-table">
<thead><tr><th>Block</th><th>Range</th><th>Addresses</th></tr></thead>
<tbody>
<tr><td>10.0.0.0/8</td><td>10.0.0.0 – 10.255.255.255</td><td>16,777,216</td></tr>
<tr><td>172.16.0.0/12</td><td>172.16.0.0 – 172.31.255.255</td><td>1,048,576</td></tr>
<tr><td>192.168.0.0/16</td><td>192.168.0.0 – 192.168.255.255</td><td>65,536</td></tr>
</tbody></table></div>
<p>Home routers usually hand out 192.168.x.x addresses. Larger networks and many provider gateways use 10.x.x.x. Note that 172.16 through 172.31 is private, but 172.32 and above is ordinary public address space.</p>

<h2>Why private addresses can't be looked up</h2>
<p>Your router translates between your private addresses and the single public address your provider gives you. This is called <strong>NAT</strong> (network address translation). Websites only ever see the public address, which is what <a href="/">whoami</a> shows. A private address has no owner on the internet and no location, so a lookup can only tell you which range it belongs to.</p>

<h2>Other special ranges you may see</h2>
<div class="table-wrap"><table class="doc-table">
<thead><tr><th>Block</th><th>Name</th><th>What it means</th></tr></thead>
<tbody>
<tr><td>127.0.0.0/8</td><td>Loopback</td><td>Your own device. 127.0.0.1 is "this computer".</td></tr>
<tr><td>169.254.0.0/16</td><td>Link-local</td><td>The device asked for an address and got no answer, usually a DHCP problem.</td></tr>
<tr><td>100.64.0.0/10</td><td>Carrier-grade NAT (RFC 6598)</td><td>Your provider shares one public address among many customers.</td></tr>
<tr><td>192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24</td><td>Documentation (RFC 5737)</td><td>Reserved for examples in manuals and articles.</td></tr>
<tr><td>224.0.0.0/4</td><td>Multicast</td><td>One sender, many receivers, such as streaming on a local network.</td></tr>
<tr><td>240.0.0.0/4</td><td>Reserved</td><td>Set aside and not used on the public internet.</td></tr>
</tbody></table></div>

<h2>IPv6 equivalents</h2>
<ul>
<li><strong>fc00::/7</strong> (in practice fd00::/8): unique local addresses, the IPv6 version of private ranges.</li>
<li><strong>fe80::/10</strong>: link-local, present on every IPv6 interface.</li>
<li><strong>::1</strong>: loopback.</li>
</ul>
<p>Most IPv6 devices also have a public, globally routable address, so NAT is far less common with IPv6. See <a href="/guides/ipv4-vs-ipv6">IPv4 vs IPv6</a>.</p>
''',
        'try': 'Look up <a href="/10.0.0.1">10.0.0.1</a>, <a href="/172.16.0.1">172.16.0.1</a> or <a href="/100.64.0.1">100.64.0.1</a> to see how ipterm labels each range.',
        'related': ['find-router-ip', 'ipv4-vs-ipv6'],
    },
    {
        'slug': 'what-your-ip-reveals',
        'title': 'What your IP address reveals (and what it doesn’t)',
        'crumb': 'what your IP reveals',
        'cmd': 'man ip-privacy',
        'desc': 'What a website can learn from your IP address: your provider and an approximate location. What it cannot: your name, street address or browsing history. Plus how dynamic IPs, CGNAT and VPNs change the picture.',
        'meta': 'What a website can learn from your IP address: your provider and an approximate location. What it cannot: your name, street address or browsing history.',
        'lede': 'Every website you visit sees your public IP address, because that is where it sends its reply. On its own, the address says less than many people fear, and more than some people assume.',
        'body': '''
<h2>What an IP address does reveal</h2>
<ul>
<li><strong>Your network.</strong> Every public address belongs to an organization: usually your internet provider, but sometimes a mobile carrier, university, company, cloud host or VPN service. Its <a href="/guides/what-is-an-asn">ASN</a> identifies it.</li>
<li><strong>An approximate location.</strong> Usually a city or region, sometimes only a country. It often points to your provider's regional hub, which can be tens or even hundreds of kilometers from where you are.</li>
<li><strong>A guess at your time zone</strong>, based on that location.</li>
<li><strong>Whether it's a datacenter or VPN address</strong>, to services that keep lists of those.</li>
</ul>

<h2>What it does not reveal</h2>
<ul>
<li>Your name, email address or phone number.</li>
<li>Your street address or precise location.</li>
<li>Your browsing history or which devices are on your network.</li>
</ul>

<h2>Who can connect an IP address to you</h2>
<p>Your internet provider knows which customer had which address at a given time. Providers generally disclose that only through a legal process, such as a court order or subpoena, and the rules differ by country. Websites themselves can link visits to you only if you also sign in or share identifying details.</p>

<h2>Why your address changes, or is shared</h2>
<ul>
<li><strong>Dynamic addresses:</strong> most home connections get an address that can change from time to time, for example when the router restarts.</li>
<li><strong>Carrier-grade NAT:</strong> many mobile and some home providers put many customers behind one public address, so the address points to the provider more than to you.</li>
</ul>

<h2>Showing websites a different address</h2>
<p>A <strong>VPN</strong> routes your traffic through the VPN provider, so websites see the provider's address instead of yours. Your internet provider then sees only that you're connected to the VPN, while the VPN provider can see where your traffic goes, so choose one you trust. <strong>Tor</strong> spreads traffic across volunteer relays for stronger anonymity at the cost of speed. Neither changes what you reveal by signing in to accounts.</p>
''',
        'try': 'Run <a href="/" data-cmd="whoami">whoami</a> to see exactly what your own address shows.',
        'related': ['private-ip-ranges', 'what-is-an-asn'],
    },
    {
        'slug': 'ipv4-vs-ipv6',
        'title': 'IPv4 vs IPv6: what’s the difference?',
        'crumb': 'IPv4 vs IPv6',
        'cmd': 'man ipv6',
        'desc': 'How IPv4 and IPv6 addresses differ, why IPv4 ran out, how to read shortened IPv6 addresses, and which one your connection is using.',
        'lede': 'IPv4 and IPv6 are two versions of the Internet Protocol. Both do the same job, giving every connection an address, but IPv6 has vastly more addresses and writes them differently.',
        'body': '''
<h2>IPv4</h2>
<p>An IPv4 address is 32 bits, written as four numbers from 0 to 255, like <a href="/8.8.8.8">8.8.8.8</a>. That allows about 4.3 billion addresses, which turned out to be far too few. The central pool run by IANA ran out in 2011, and the regional registries have since run out of fresh blocks as well.</p>
<p>The internet kept working thanks to <strong>NAT</strong>: one public address shared by every device in a home, and <a href="/guides/private-ip-ranges">carrier-grade NAT</a>, which shares one address among many customers.</p>

<h2>IPv6</h2>
<p>An IPv6 address is 128 bits, written as eight groups of four hexadecimal digits separated by colons. There are enough addresses for every device to have its own public one. Two rules shorten them:</p>
<ul>
<li>Leading zeros in a group can be dropped: <code>0db8</code> becomes <code>db8</code>.</li>
<li>One run of all-zero groups can be replaced with <code>::</code>.</li>
</ul>
<p>So <a href="/2001:4860:4860::8888">2001:4860:4860::8888</a> is short for <code>2001:4860:4860:0000:0000:0000:0000:8888</code>.</p>
<p>Homes usually receive a whole block of IPv6 addresses (a /64 or larger), and devices often use temporary addresses that change regularly for privacy.</p>

<h2>Special IPv6 addresses</h2>
<div class="table-wrap"><table class="doc-table">
<thead><tr><th>Address</th><th>Meaning</th></tr></thead>
<tbody>
<tr><td>::1</td><td>Loopback, this device</td></tr>
<tr><td>fe80::/10</td><td>Link-local, only valid on the local network segment</td></tr>
<tr><td>fc00::/7</td><td>Unique local, the IPv6 version of private addresses</td></tr>
<tr><td>2001:db8::/32</td><td>Reserved for documentation and examples</td></tr>
</tbody></table></div>

<h2>Which one are you using?</h2>
<p>Many connections are <strong>dual-stack</strong>: they have both an IPv4 and an IPv6 address, and your device picks whichever connects faster for each site. <a href="/" data-cmd="whoami">whoami</a> shows the address your browser used to reach ipterm, marked IPv4 or IPv6. Neither version is inherently faster; the difference comes from the route your traffic takes.</p>
''',
        'try': 'Look up <a href="/2001:4860:4860::8888">2001:4860:4860::8888</a> to see an IPv6 address expanded and its /64 prefix.',
        'related': ['private-ip-ranges', 'what-is-an-asn'],
    },
    {
        'slug': 'what-is-an-asn',
        'title': 'What is an ASN (autonomous system number)?',
        'crumb': 'what is an ASN',
        'cmd': 'man asn',
        'desc': 'An ASN identifies a network on the internet, such as an ISP or cloud provider. Learn how ASNs and BGP route traffic, who assigns them, and how to look one up.',
        'lede': 'The internet is a network of networks. Each one that runs its own routing, such as an internet provider, cloud platform, university or large company, is an <em>autonomous system</em>, identified by an autonomous system number (ASN) like AS15169.',
        'body': '''
<h2>How ASNs route traffic</h2>
<p>Autonomous systems exchange routes using <strong>BGP</strong> (Border Gateway Protocol). Each network announces the blocks of IP addresses, called <em>prefixes</em>, that it can deliver traffic to, and its neighbors pass those announcements along. When you load a page, your traffic crosses a chain of these networks to reach the one that announced the destination address.</p>

<h2>Who assigns them</h2>
<p>IANA hands out blocks of AS numbers to five Regional Internet Registries, which assign them to organizations:</p>
<ul>
<li><strong>ARIN</strong>: North America</li>
<li><strong>RIPE NCC</strong>: Europe, the Middle East and parts of Central Asia</li>
<li><strong>APNIC</strong>: Asia-Pacific</li>
<li><strong>LACNIC</strong>: Latin America and the Caribbean</li>
<li><strong>AFRINIC</strong>: Africa</li>
</ul>

<h2>The numbers themselves</h2>
<p>ASNs were originally 16-bit (1 to 65,535). 32-bit ASNs, up to 4,294,967,295, were added once those began to run short. Some ranges are reserved: 64512–65534 and 4200000000–4294967294 for private use (RFC 6996), and 64496–64511 and 65536–65551 for documentation (RFC 5398).</p>

<h2>Why look one up</h2>
<ul>
<li><strong>Find out who operates an address</strong>, for example before reporting abuse or spam.</li>
<li><strong>Tell residential from datacenter traffic</strong>: a visitor from a cloud provider's network is more likely to be automated.</li>
<li><strong>Troubleshoot</strong> routing and reachability problems.</li>
</ul>
<p>Every IP result in ipterm links to its network. Network pages show the holder, the registry, how many prefixes it announces and how much IPv4 address space they cover, using data from RIPEstat.</p>
''',
        'try': 'Look up <a href="/AS13335" data-cmd="asn AS13335">AS13335</a> (Cloudflare) or <a href="/AS15169" data-cmd="asn AS15169">AS15169</a> (Google).',
        'related': ['what-your-ip-reveals', 'ipv4-vs-ipv6'],
    },
    {
        'slug': 'subnet-cheat-sheet',
        'title': 'Subnet mask cheat sheet: CIDR to netmask',
        'crumb': 'subnet cheat sheet',
        'cmd': 'cidr --table',
        'desc': 'Every IPv4 prefix from /8 to /32 with its subnet mask, wildcard mask, total addresses and usable hosts, plus how CIDR notation works and common IPv6 prefix sizes.',
        'meta': 'Every IPv4 prefix from /8 to /32 with its subnet mask, wildcard mask, addresses and usable hosts, plus how CIDR notation works and common IPv6 prefixes.',
        'lede': 'CIDR notation writes a network as an address plus a prefix length: <code>192.168.1.0/24</code> means the first 24 bits identify the network and the remaining 8 identify hosts. This page converts every common prefix to its subnet mask.',
        'body': """
<h2>Reading CIDR notation</h2>
<ul>
<li><strong>Prefix length</strong> is the number of 1 bits in the subnet mask: /24 is 255.255.255.0 because the first 24 bits are 1.</li>
<li><strong>Addresses</strong> in a block are 2<sup>(32 − prefix)</sup>: a /24 has 256.</li>
<li><strong>Usable hosts</strong> subtract the network address (the first) and the broadcast address (the last). Two exceptions: a /31 has two usable addresses for point-to-point links (RFC 3021), and a /32 is a single host.</li>
<li><strong>Wildcard mask</strong> is the netmask inverted, used in router access lists and some firewall rules.</li>
</ul>

<h2>IPv4 prefixes from /8 to /32</h2>
""" + _subnet_table() + """

<h2>Common IPv6 prefix sizes</h2>
<div class="table-wrap"><table class="doc-table">
<thead><tr><th>Prefix</th><th>Typical use</th></tr></thead>
<tbody>
<tr><td><a href="/cidr/2001:db8::1/128">/128</a></td><td>A single address</td></tr>
<tr><td><a href="/cidr/2001:db8::/64">/64</a></td><td>One local network. Address autoconfiguration (SLAAC) expects exactly a /64.</td></tr>
<tr><td><a href="/cidr/2001:db8::/56">/56</a></td><td>A common home allocation: 256 networks of /64</td></tr>
<tr><td><a href="/cidr/2001:db8::/48">/48</a></td><td>A common site or business allocation: 65,536 networks of /64</td></tr>
<tr><td><a href="/cidr/2001:db8::/32">/32</a></td><td>A typical minimum allocation to an internet provider from a regional registry</td></tr>
</tbody></table></div>
""",
        'try': 'Run <a href="/cidr/10.0.0.0/22">cidr 10.0.0.0/22</a>, or any range, in the terminal for the full breakdown, including which bits are network and which are host.',
        'related': ['private-ip-ranges', 'ipv4-vs-ipv6'],
    },
]

BY_SLUG = {g['slug']: g for g in GUIDES}

HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} | ipterm</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="%ORIGIN%{path}">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="ipterm">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="%ORIGIN%{path}">
<meta property="og:image" content="%ORIGIN%/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#030805">
<script src="/prefs.js"></script>
<link rel="stylesheet" href="/app.css">
<script type="application/ld+json">{ld}</script>
</head>
<body>
<div class="doc">
  <header class="bar">
    <div class="brand"><a class="logo" href="/">ip<b>term</b></a><span class="ver">guides</span></div>
    <span class="doc-tools"><button type="button" class="mode-btn" data-theme-toggle>light</button><a class="doc-back" href="/">← back to the terminal</a></span>
  </header>
  <nav class="crumbs" aria-label="Breadcrumb">{crumbs}</nav>
  <main class="doc-body">
'''
FOOT = '''  </main>
</div>
</body>
</html>
'''


def ld_json(obj):
    # Escape "<" so the JSON can never close its script tag.
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')


def plain(s):
    return html.unescape(s.replace('<em>', '').replace('</em>', ''))


def guide_page(g):
    path = f"/guides/{g['slug']}"
    words = len(plain(g['body']).split()) + len(plain(g['lede']).split())
    minutes = max(2, round(words / 220))
    ld = {
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'Article', 'headline': g['title'], 'description': g.get('meta', g['desc']), 'datePublished': UPDATED, 'dateModified': UPDATED,
             'author': {'@type': 'Organization', 'name': 'ipterm'}, 'publisher': {'@type': 'Organization', 'name': 'ipterm'},
             'mainEntityOfPage': f'%ORIGIN%{path}', 'image': '%ORIGIN%/og.png'},
            {'@type': 'BreadcrumbList', 'itemListElement': [
                {'@type': 'ListItem', 'position': 1, 'name': 'ipterm', 'item': '%ORIGIN%/'},
                {'@type': 'ListItem', 'position': 2, 'name': 'Guides', 'item': '%ORIGIN%/guides'},
                {'@type': 'ListItem', 'position': 3, 'name': g['title'], 'item': f'%ORIGIN%{path}'}]},
        ],
    }
    crumbs = f'<a href="/">ipterm</a><span aria-hidden="true">/</span><a href="/guides">guides</a><span aria-hidden="true">/</span><span aria-current="page">{html.escape(g["crumb"])}</span>'
    related = ''.join(f'<li><a href="/guides/{s}">{html.escape(BY_SLUG[s]["title"])}</a></li>' for s in g['related'])
    out = HEAD.format(title=html.escape(g['title']), desc=html.escape(g.get('meta', g['desc']), quote=True), path=path, og_type='article', ld=ld_json(ld), crumbs=crumbs)
    out += f'''    <p class="ln echo"><span class="ps1">guest@ipterm:~$</span> {html.escape(g['cmd'])}</p>
    <h1>{html.escape(g['title'])}</h1>
    <p class="doc-meta">Updated {UPDATED_LABEL} · {minutes} min read</p>
    <p class="doc-lede">{g['lede']}</p>
{g['body'].strip()}
    <p class="doc-try"><strong>Try it</strong>{g['try']}</p>
    <h2>Related guides</h2>
    <ul>{related}</ul>
'''
    return out + FOOT


def index_page():
    ld = {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'ipterm guides', 'url': '%ORIGIN%/guides',
          'hasPart': [{'@type': 'Article', 'headline': g['title'], 'url': f"%ORIGIN%/guides/{g['slug']}"} for g in GUIDES]}
    desc = 'Plain-language guides to IP addresses: finding your router, private ranges, what your IP reveals, IPv4 vs IPv6 and ASNs.'
    crumbs = '<a href="/">ipterm</a><span aria-hidden="true">/</span><span aria-current="page">guides</span>'
    items = ''.join(f'<li><a href="/guides/{g["slug"]}">{html.escape(g["title"])}</a><p>{html.escape(g["desc"])}</p></li>' for g in GUIDES)
    out = HEAD.format(title='Guides to IP addresses and networks', desc=desc, path='/guides', og_type='website', ld=ld_json(ld), crumbs=crumbs)
    out += f'''    <p class="ln echo"><span class="ps1">guest@ipterm:~$</span> ls guides/</p>
    <h1>Guides</h1>
    <p class="doc-lede">Short, plain-language answers to common questions about IP addresses and the networks behind them.</p>
    <ul class="guide-list">{items}</ul>
'''
    return out + FOOT


if __name__ == '__main__':
    (OUT / 'guides').mkdir(exist_ok=True)
    for g in GUIDES:
        (OUT / 'guides' / f"{g['slug']}.html").write_text(guide_page(g), encoding='utf-8')
    (OUT / 'guides.html').write_text(index_page(), encoding='utf-8')
    print('built', len(GUIDES), 'guides + index')
