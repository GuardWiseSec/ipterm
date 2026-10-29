/* ipterm's public DNS resolvers: the service and operator behind each well-known resolver address, the filtering
   variant it belongs to, the service's other addresses, its encrypted endpoints (DNS over HTTPS and DNS over TLS) and
   what the operator documents about DNSSEC, EDNS Client Subnet (ECS) and logging, with the operator's own pages as
   sources. One source of truth for the page (loaded as /resolvers.js, exposes window.IPTERM_RESOLVERS) and the Worker
   (imported by src/worker.js for the resolver block on each address's page, /public-dns and /sitemap-resolvers.xml).
   No dependencies.
   Every fact comes from the operator's own documentation (each service's sources). What an operator doesn't document is
   left out: '' or [] here, and no line on the pages. That an address is anycast (answered from many locations) is said
   only where the operator says so (anycast). The pages' titles, descriptions and summaries name no place for any of
   them: the page is about the resolver, and IPinfo's place for it says little (IPinfo Lite, which bots get, gives
   1.1.1.1 Australia). IPinfo's location row stays. "Public DNS resolvers" in docs/handbook.md says how to check them
   again. */
(function (root) {
  // The day every row below was last checked against its sources. Move it only after checking all of them again: the
  // resolver pages and /public-dns say "last checked <date>", and /sitemap-resolvers.xml gives it as their <lastmod>, so
  // search engines come back for them when it moves.
  const LAST_CHECKED = '2026-10-28';
  // Each service: id (its anchor on /public-dns), service (its name there), short (in titles: "9.9.9.9 · Quad9 DNS"),
  // brand (in "9.9.9.9 is Quad9's public DNS resolver"), operator, its variants, then what the operator documents about
  // dnssec, ecs and logging, and the pages all of it comes from (sources). A variant: [name, what it filters, IPv4
  // addresses, IPv6 addresses, DoH URL, DoT host], each '' or [] when not documented; what it filters starts with
  // 'none' where the operator says it blocks nothing. Addresses are in the operator's order, IPv6 in its short form
  // (RFC 5952), as the pages' own addresses are written.
  // either: the operator's order isn't a primary then a secondary, so a description says "also", not "secondary".
  // anycast: the page where the operator says its addresses are anycast (one of its sources); none where it doesn't.
  const LIST = [
    // Google: either address can be primary or secondary (either). It also gives the IPv6 addresses in full
    // (2001:4860:4860:0:0:0:0:8888) for devices that reject '::'. Google Public DNS64 (64:ff9b::/96) is a separate service.
    { id: 'google', service: 'Google Public DNS', short: 'Google Public DNS', brand: "Google's", either: true,
      operator: 'Google LLC', anycast: 'https://developers.google.com/speed/public-dns/faq',
      variants: [
        ['Google Public DNS', 'none: Google says it does no blocking or filtering of any kind, except for certain domains in rare cases, to protect users from security threats or where the law requires it',
          ['8.8.8.8', '8.8.4.4'], ['2001:4860:4860::8888', '2001:4860:4860::8844'], 'https://dns.google/dns-query', 'dns.google'],
      ],
      dnssec: "Validates: 'All responses from DNSSEC signed zones are validated unless clients explicitly set the CD flag'. A failed validation returns SERVFAIL. Google has fully supported DNSSEC since January 2013, and may temporarily turn validation off for a zone when a very popular domain fails it.",
      ecs: 'Sends ECS to authoritative servers it has detected as supporting it (Google detects this per name server IP address). It passes at most the first 24 bits (IPv4) or 56 bits (IPv6) of the client address.',
      logging: 'Temporary logs hold your full IP and query and are deleted within 24-48 hours (kept longer only for security and abuse work). Permanent logs are a sample with the IP replaced by city or region-level location. Google says it does not link these logs to your use of other Google services except for security and abuse, and does not use them to target ads.',
      sources: [
        'https://developers.google.com/speed/public-dns/docs/using',
        'https://developers.google.com/speed/public-dns/docs/secure-transports',
        'https://developers.google.com/speed/public-dns/docs/security',
        'https://developers.google.com/speed/public-dns/faq',
        'https://developers.google.com/speed/public-dns/docs/ecs',
        'https://developers.google.com/speed/public-dns/privacy',
      ] },
    // Cloudflare: its FAQ's DNSSEC and ECS answers speak of 1.1.1.1 and don't name the Families addresses, hence the
    // last sentence of each. Families keeps 1.1.1.1's privacy commitments. DoT host: the DoT page's one.one.one.one.
    // The 1.1.1.1 docs say it runs on Cloudflare's network in hundreds of cities; that it is anycast is said in
    // Cloudflare's report on its 2025-07-14 outage.
    { id: 'cloudflare', service: 'Cloudflare 1.1.1.1 and 1.1.1.1 for Families', short: 'Cloudflare DNS', brand: "Cloudflare's",
      operator: 'Cloudflare, Inc.', anycast: 'https://blog.cloudflare.com/cloudflare-1-1-1-1-incident-on-july-14-2025/',
      variants: [
        ['1.1.1.1', "none ('no content filtering')",
          ['1.1.1.1', '1.0.0.1'], ['2606:4700:4700::1111', '2606:4700:4700::1001'], 'https://cloudflare-dns.com/dns-query', 'one.one.one.one'],
        ['1.1.1.1 for Families: block malware', 'malware and phishing',
          ['1.1.1.2', '1.0.0.2'], ['2606:4700:4700::1112', '2606:4700:4700::1002'], 'https://security.cloudflare-dns.com/dns-query', 'security.cloudflare-dns.com'],
        ['1.1.1.1 for Families: block malware and adult content', 'malware, phishing and adult content',
          ['1.1.1.3', '1.0.0.3'], ['2606:4700:4700::1113', '2606:4700:4700::1003'], 'https://family.cloudflare-dns.com/dns-query', 'family.cloudflare-dns.com'],
      ],
      dnssec: "'1.1.1.1 is a DNSSEC-validating resolver.' It sends the DO flag on every query and validates signed answers before returning them. Cloudflare's FAQ says this of 1.1.1.1 and doesn't name the Families addresses.",
      ecs: "Not sent: 'It does not send the EDNS Client Subnet (ECS) header.' The only exception is Akamai's debug domain whoami.ds.akahelp.net. Cloudflare's FAQ says this of 1.1.1.1 and doesn't name the Families addresses.",
      logging: 'The source IP is never written to non-volatile storage, except in randomly sampled packets (at most 0.05% of traffic) kept for troubleshooting and DoS mitigation. IPs are truncated (last octet for IPv4, last 80 bits for IPv6) and deleted within 25 hours, and resolver logs are deleted within 25 hours, except limited sampled log data (without the truncated IPs) used to build aggregate statistics; Cloudflare may store those aggregates indefinitely. Personal data is not sold, shared or used to target ads; anonymised log data is shared only with APNIC for research.',
      sources: [
        'https://developers.cloudflare.com/1.1.1.1/ip-addresses/',
        'https://developers.cloudflare.com/1.1.1.1/setup/',
        'https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/',
        'https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-tls/',
        'https://developers.cloudflare.com/1.1.1.1/faq/',
        'https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/',
        'https://blog.cloudflare.com/cloudflare-1-1-1-1-incident-on-july-14-2025/',
      ] },
    // Quad9: quad9.net's service page lists 9.9.9.9, .10 and .11; docs.quad9.net/services adds 9.9.9.12. An older FAQ
    // answer says 'two out of three' services validate DNSSEC, the service page all of them: the line says both.
    { id: 'quad9', service: 'Quad9', short: 'Quad9 DNS', brand: "Quad9's",
      operator: 'Quad9 Foundation (Swiss public-benefit not-for-profit foundation, c/o SWITCH, Zurich)', anycast: 'https://quad9.net/support/faq/',
      variants: [
        ['9.9.9.9 (Recommended / Secure)', 'malware (threat blocking)',
          ['9.9.9.9', '149.112.112.112'], ['2620:fe::fe', '2620:fe::9'], 'https://dns.quad9.net/dns-query', 'dns.quad9.net'],
        ['9.9.9.10 (Unsecured / No Threat Blocking)', 'none',
          ['9.9.9.10', '149.112.112.10'], ['2620:fe::10', '2620:fe::fe:10'], 'https://dns10.quad9.net/dns-query', 'dns10.quad9.net'],
        ['9.9.9.11 (Secured with ECS)', 'malware (threat blocking); sends ECS',
          ['9.9.9.11', '149.112.112.11'], ['2620:fe::11', '2620:fe::fe:11'], 'https://dns11.quad9.net/dns-query', 'dns11.quad9.net'],
        ['9.9.9.12 (No Threat Blocking + ECS)', 'none; sends ECS',
          ['9.9.9.12', '149.112.112.12'], ['2620:fe::12', '2620:fe::fe:12'], 'https://dns12.quad9.net/dns-query', 'dns12.quad9.net'],
      ],
      dnssec: "The service page says 'DNSSEC validation is enabled on all resolver addresses' and labels 9.9.9.9, 9.9.9.11 and 9.9.9.10 as validating. docs.quad9.net says a failed validation returns SERVFAIL. An older FAQ answer still says 'two out of three' services validate.",
      ecs: "The default service (9.9.9.9) does not send ECS: 'we do not transmit that data in our default service'. ECS is sent only by the ECS services, 9.9.9.11 and 9.9.9.12. Quad9 calls ECS data 'a grey area of personally identifiable information'. No prefix length is documented.",
      logging: "'Quad9 does not collect or record user IP addresses.' The IP is held only in volatile memory for the milliseconds needed to answer and count the query. Counters may record the Quad9 address queried, the client's prefix (no finer than /24 IPv4 or /56 IPv6) and ASN, and geographic region, and may be kept in permanent archives; none is tied to an individual.",
      sources: [
        'https://quad9.net/service/service-addresses-and-features/',
        'https://docs.quad9.net/services/',
        'https://quad9.net/support/faq/',
        'https://docs.quad9.net/FAQs/',
        'https://quad9.net/privacy/policy/',
      ] },
    // OpenDNS: the standard addresses' DoH URL is from Cisco's document 224705 (updated 2025-10-17, the newest Cisco
    // page to give one); the IPv6 addresses and the FamilyShield and Sandbox DoH URLs are from Cisco's Umbrella blog on
    // DoH (updated 2023-02-27), which gives no filtering for Sandbox. Cisco says DoT is live on all Umbrella resolvers
    // (TCP 853, found through DDR) but names no DoT host, so there is none here.
    { id: 'opendns', service: 'OpenDNS (Cisco Umbrella), including FamilyShield', short: 'OpenDNS', brand: "Cisco's OpenDNS",
      operator: 'Cisco (OpenDNS, now part of Cisco Umbrella)', anycast: 'https://umbrella.cisco.com/blog/enhancing-support-dns-encryption-with-dns-over-https',
      variants: [
        ['OpenDNS Public Service / Umbrella', "OpenDNS describes the no-account Public Service as 'basic DNS-layer protection and built-in filtering configurations'; custom filtering needs a free OpenDNS Home account",
          ['208.67.222.222', '208.67.220.220'], ['2620:119:35::35', '2620:119:53::53'], 'https://doh.umbrella.com/dns-query', ''],
        ['FamilyShield', "adult content ('Preconfigured to block adult content'); OpenDNS's benefit matrix also ticks 'Built-in protection for malicious phishing'",
          ['208.67.222.123', '208.67.220.123'], ['2620:119:35::123', '2620:119:53::123'], 'https://familyshield.opendns.com/dns-query', ''],
        ['Sandbox', '',
          ['208.67.222.2', '208.67.220.2'], ['2620:0:ccc::2', '2620:0:ccd::2'], 'https://sandbox.opendns.com/dns-query', ''],
      ],
      dnssec: "Cisco's Extended DNS Errors page (updated 2025-09-25) shows Umbrella resolvers answering SERVFAIL with Extended DNS Error 6, 'DNSSEC Bogus', when validation fails. Cisco lists 208.67.222.222 and 208.67.220.220 as the Umbrella resolver addresses.",
      ecs: '',
      logging: '',
      sources: [
        'https://www.opendns.com/setupguide/',
        'https://www.opendns.com/home-internet-security/',
        'https://umbrella.cisco.com/blog/enhancing-support-dns-encryption-with-dns-over-https',
        'https://docs.umbrella.com/deployment-umbrella/docs/point-your-dns-to-cisco',
        'https://www.cisco.com/c/en/us/support/docs/security/umbrella/224705-configure-dns-over-https-doh-with.html',
        'https://www.cisco.com/c/en/us/support/docs/security/umbrella/225803-understand-opendns-familyshield.html',
        'https://www.cisco.com/c/en/us/support/docs/security/umbrella/225059-understand-umbrella-support-for.html',
      ] },
    // AdGuard: its pages word Default differently ('ads and trackers', 'ads, tracking, and phishing'); this is the
    // FAQ's and the KB overview's. The Non-filtering secondary is 94.140.14.141, in the same /24 as its primary.
    { id: 'adguard', service: 'AdGuard DNS (public servers)', short: 'AdGuard DNS', brand: "AdGuard's",
      operator: 'ADGUARD SOFTWARE LIMITED (Limassol, Cyprus)', anycast: 'https://adguard-dns.io/kb/general/dns-providers/',
      variants: [
        ['Default', 'ads, trackers, malware and phishing',
          ['94.140.14.14', '94.140.15.15'], ['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'], 'https://dns.adguard-dns.com/dns-query', 'dns.adguard-dns.com'],
        ['Family protection', 'everything Default blocks, plus adult websites; enforces Safe Search and Safe Mode where possible',
          ['94.140.14.15', '94.140.15.16'], ['2a10:50c0::bad1:ff', '2a10:50c0::bad2:ff'], 'https://family.adguard-dns.com/dns-query', 'family.adguard-dns.com'],
        ['Non-filtering', 'none',
          ['94.140.14.140', '94.140.14.141'], ['2a10:50c0::1:ff', '2a10:50c0::2:ff'], 'https://unfiltered.adguard-dns.com/dns-query', 'unfiltered.adguard-dns.com'],
      ],
      dnssec: "AdGuard's FAQ says 'AdGuard DNS supports DNSSEC technology which allows you to verify the authenticity of the stored DNS records'. It does not say the servers validate, or name the variants.",
      ecs: '',
      logging: "'We do not process any of your Personal Data when you connect to and use public AdGuard DNS.' AdGuard keeps an anonymous database of domains requested in the last 24 hours, with nothing linking them to a user, plus general usage statistics.",
      sources: [
        'https://adguard-dns.io/en/public-dns.html',
        'https://adguard-dns.io/kb/general/dns-providers/',
        'https://adguard-dns.io/en/welcome.html',
        'https://adguard-dns.io/kb/public-dns/overview/',
        'https://adguard-dns.io/en/privacy.html',
      ] },
    // CleanBrowsing: the Adult Filter's secondary is 185.228.169.11 (not .10), as published. Its DNSSEC pages say
    // it validates, but tests on 2026-10-28 disagreed between addresses, so there is no DNSSEC line until rechecked.
    { id: 'cleanbrowsing', service: 'CleanBrowsing free filters', short: 'CleanBrowsing DNS', brand: "CleanBrowsing's",
      operator: 'CleanBrowsing, Inc. (Weatherford, Texas, USA)', anycast: 'https://cleanbrowsing.org/how-it-works',
      variants: [
        ['Security Filter', 'phishing, spam, malware and malicious domains; adult content is not blocked',
          ['185.228.168.9', '185.228.169.9'], ['2a0d:2a00:1::2', '2a0d:2a00:2::2'], 'https://doh.cleanbrowsing.org/doh/security-filter/', 'security-filter-dns.cleanbrowsing.org'],
        ['Adult Filter', 'adult, pornographic and explicit sites, plus malicious and phishing domains; Google and Bing SafeSearch forced. Proxy and VPN domains and mixed-content sites such as Reddit are not blocked',
          ['185.228.168.10', '185.228.169.11'], ['2a0d:2a00:1::1', '2a0d:2a00:2::1'], 'https://doh.cleanbrowsing.org/doh/adult-filter/', 'adult-filter-dns.cleanbrowsing.org'],
        ['Family Filter', 'adult, pornographic and explicit sites, proxy and VPN domains used to bypass filters, mixed-content sites such as Reddit, plus malicious and phishing domains; Google, Bing and YouTube SafeSearch forced',
          ['185.228.168.168', '185.228.169.168'], ['2a0d:2a00:1::', '2a0d:2a00:2::'], 'https://doh.cleanbrowsing.org/doh/family-filter/', 'family-filter-dns.cleanbrowsing.org'],
      ],
      dnssec: '',
      ecs: '',
      logging: 'The free filters (including DoH, DoT and DNSCrypt) do not log or store personally identifiable information such as your IP address. CleanBrowsing processes anonymised, aggregate DNS query data, may keep it indefinitely, and shares it with its sister brands NOC, DNSArchive and Trunc.',
      sources: [
        'https://cleanbrowsing.org/filters/',
        'https://cleanbrowsing.org/privacy/',
        'https://cleanbrowsing.org/how-it-works',
        'https://cleanbrowsing.org/learn/what-is-dnssec',
      ] },
    // Control D: its own ('Native') filters. The docs also list presets that only apply third-party blocklists it
    // doesn't maintain (OISD, Hagezi, 1Hosts, StevenBlack, AdGuard), left out here. The docs give 2606:1a40::0 and
    // 2606:1a40:1::0 (written short here). The DNSSEC line is from its blog, the ECS line from its Android privacy policy.
    { id: 'controld', service: 'Control D Free DNS', short: 'Control D DNS', brand: "Control D's",
      operator: 'CONTROLD, Inc. (Toronto, Canada; sister company of Windscribe)', anycast: 'https://docs.controld.com/docs/free-dns',
      variants: [
        ['Unfiltered (p0)', 'none',
          ['76.76.2.0', '76.76.10.0'], ['2606:1a40::', '2606:1a40:1::'], 'https://freedns.controld.com/p0', 'p0.freedns.controld.com'],
        ['Malware (p1)', "malware ('Blocks known dangerous sites')",
          ['76.76.2.1', '76.76.10.1'], ['2606:1a40::1', '2606:1a40:1::1'], 'https://freedns.controld.com/p1', 'p1.freedns.controld.com'],
        ['Ads & Tracking (p2)', 'malware, ads and trackers',
          ['76.76.2.2', '76.76.10.2'], ['2606:1a40::2', '2606:1a40:1::2'], 'https://freedns.controld.com/p2', 'p2.freedns.controld.com'],
        ['Social (p3)', "social media ('Block major social media apps/sites')",
          ['76.76.2.3', '76.76.10.3'], ['2606:1a40::3', '2606:1a40:1::3'], 'https://freedns.controld.com/p3', 'p3.freedns.controld.com'],
        ['Family Friendly', 'malware, ads, trackers, adult content and drug sites',
          ['76.76.2.4', '76.76.10.4'], ['2606:1a40::4', '2606:1a40:1::4'], 'https://freedns.controld.com/family', 'family.freedns.controld.com'],
        ["Uncensored (shown as 'Advanced' on controld.com)", 'none; unblocks domains censored in various countries',
          ['76.76.2.5', '76.76.10.5'], ['2606:1a40::5', '2606:1a40:1::5'], 'https://freedns.controld.com/uncensored', 'uncensored.freedns.controld.com'],
      ],
      dnssec: "Control D's blog (27 Apr 2025) says it 'fully supports DNSSEC validation on its resolver network' and checks signatures before returning answers. The free-DNS docs page itself does not mention DNSSEC.",
      ecs: "Control D's privacy policy (Android app) says it uses 'a custom implementation of EDNS Client Subnet which does not expose the source IP address to authoritative DNS servers'. The free-DNS docs say nothing on ECS.",
      logging: "The free resolvers do not store logs: 'no individual browsing history, timestamps, or query logs' (docs). The privacy policy says free resolvers do not store IP addresses, timestamps or the DNS queries themselves.",
      sources: [
        'https://docs.controld.com/docs/free-dns',
        'https://controld.com/free-dns',
        'https://controld.com/privacy/android',
        'https://controld.com/blog/dns-security-protocols/',
        'https://docs.controld.com/docs/ecs-custom-subnet',
        'https://docs.controld.com/docs/disable-dnssec-option',
      ] },
    // Yandex: the order is dns.yandex.com's; its support page calls 77.88.8.1, .2 and .3 primary (either). Its IPv6
    // addresses are written 2a02:6b8::feed:0ff and so on there, the same addresses. DoH is documented only as port 443
    // with the DoT names and no URL path, so there is no DoH URL. Blocked sites get a warning page, not NXDOMAIN.
    { id: 'yandex', service: 'Yandex DNS', short: 'Yandex DNS', brand: "Yandex's", either: true,
      operator: 'Yandex',
      variants: [
        ['Basic', "none (the terms call it 'unfiltered' mode: no websites are blocked)",
          ['77.88.8.8', '77.88.8.1'], ['2a02:6b8::feed:ff', '2a02:6b8:0:1::feed:ff'], '', 'common.dot.dns.yandex.net'],
        ['Safe', 'malware and fraud: infected sites, fraudulent sites, and botnet command traffic',
          ['77.88.8.88', '77.88.8.2'], ['2a02:6b8::feed:bad', '2a02:6b8:0:1::feed:bad'], '', 'safe.dot.dns.yandex.net'],
        ['Family', 'everything Safe blocks, plus pornographic and erotic sites and adult ads; adult content is also removed from Yandex search results',
          ['77.88.8.7', '77.88.8.3'], ['2a02:6b8::feed:a11', '2a02:6b8:0:1::feed:a11'], '', 'family.dot.dns.yandex.net'],
      ],
      dnssec: '',
      ecs: '',
      logging: "Under the service terms, Yandex may collect 'automatically and anonymously (without reference to the User)' the device type and model, operating system, the list of domain names visited, and usage statistics. This data is handled under the Yandex Privacy Policy and may be stored and processed by Yandex affiliates.",
      sources: [
        'https://dns.yandex.com/',
        'https://yandex.com/support/dns/en/ya-dns-modes',
        'https://yandex.com/legal/dns_termsofuse/',
      ] },
    // 114DNS (operator: Nanjing Xinfeng Network Technology Co., Ltd.): the site is in Chinese and documents IPv4 only;
    // the variant names are its own in English ("Healthy browsing" for the one the site says schools or parents can
    // choose). Blocked names resolve to a fixed address. Its FAQ says it runs on BGP Global AnyCast.
    { id: '114dns', service: '114DNS', short: '114DNS', brand: "114DNS's",
      operator: 'Nanjing Xinfeng Network Technology Co., Ltd.', anycast: 'http://www.114dns.com/faq.html',
      variants: [
        ['Clean (no hijacking)', 'none; the FAQ says these addresses do not block phishing, virus or trojan sites',
          ['114.114.114.114', '114.114.115.115'], [], '', ''],
        ['Safe', 'malware: phishing, virus and trojan sites',
          ['114.114.114.119', '114.114.115.119'], [], '', ''],
        ['Healthy browsing', "pornographic sites and sites unsuitable for children; 114DNS's site (in Chinese) calls it healthy browsing and says schools or parents can choose it",
          ['114.114.114.110', '114.114.115.110'], [], '', ''],
      ],
      dnssec: '',
      ecs: '',
      logging: '',
      sources: [
        'http://www.114dns.com/',
        'http://www.114dns.com/faq.html',
      ] },
    // AliDNS: DoH also answers at https://<any of its addresses>/dns-query. Since 2024-09-30 the free tier may cap
    // queries per source address under load. No DNSSEC, filtering or logging policy is documented for it (the site
    // presents it as protection against DNS hijacking).
    { id: 'alidns', service: 'AliDNS (Alibaba Cloud Public DNS)', short: 'AliDNS', brand: "Alibaba Cloud's AliDNS",
      operator: 'Alibaba Cloud',
      variants: [
        ['AliDNS', '',
          ['223.5.5.5', '223.6.6.6'], ['2400:3200::1', '2400:3200:baba::1'], 'https://dns.alidns.com/dns-query', 'dns.alidns.com'],
      ],
      dnssec: '',
      ecs: "The homepage says it supports ECS. The DoH JSON API takes an edns_client_subnet parameter, meant for DNS proxies passing on their users' subnet, and recommends a /24 mask. How the resolver handles ECS toward authoritative servers by default is not documented.",
      logging: '',
      sources: [
        'https://www.alidns.com/',
        'https://alidns.com/articles/6018321800a44d0e45e90d71',
        'https://help.aliyun.com/zh/dns/public-dns-free-version-access-speed-limit-notification-dns',
      ] },
    // DNS.SB: other DoH addresses are listed (doh.sb, dns.sb, per-city servers); doh.dns.sb is the first.
    { id: 'dnssb', service: 'DNS.SB', short: 'DNS.SB', brand: "xTom's DNS.SB",
      operator: 'xTom GmbH (Germany)', anycast: 'https://dns.sb/faq/',
      variants: [
        ['DNS.SB', "none: 'we do not implement any content filtering or blocking' (another FAQ line adds 'except for legal requirements')",
          ['185.222.222.222', '45.11.45.11'], ['2a09::', '2a11::'], 'https://doh.dns.sb/dns-query', 'dot.sb'],
      ],
      dnssec: "'Yes, DNS.SB is a DNSSEC-validating resolver.' The DoH and DoT pages say 'DNSSEC enabled'.",
      ecs: "Not sent: DNS.SB 'does not send any client IP information to upstream servers', and the privacy page says no portion of your IP is sent upstream.",
      logging: "'We do not store any logs of DNS queries.' IP addresses are not recorded with queries, and the servers run with logging disabled ('no logs, forever').",
      sources: [
        'https://dns.sb/',
        'https://dns.sb/faq/',
        'https://dns.sb/doh/',
        'https://dns.sb/dot/',
        'https://dns.sb/privacy/',
      ] },
  ];
  const SERVICES = LIST.map(s => ({ ...s, either: !!s.either, anycast: s.anycast || '',
    variants: s.variants.map(([name, filtering, ipv4, ipv6, doh, dot]) => ({ name, filtering, ipv4, ipv6, doh, dot })) }));
  // An address as one key however it is written: IPv4 as it is, IPv6 as its eight groups without leading zeros (so
  // 2606:1a40::0, 2606:1a40:0:0:0:0:0:0 and 2606:1a40:: are one address), or null.
  function key(s) {
    const t = String(s == null ? '' : s).trim().toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    if (!/^[0-9a-f:]{2,39}$/.test(t) || t.split('::').length > 2) return null;
    const [h, rest] = t.includes('::') ? t.split('::') : [t, null];
    const hp = h ? h.split(':') : [], tp = rest ? rest.split(':') : [], fill = 8 - hp.length - tp.length;
    if (rest === null ? hp.length !== 8 : fill < 1) return null;
    const g = [...hp, ...Array(rest === null ? 0 : fill).fill('0'), ...tp];
    return g.every(x => /^[0-9a-f]{1,4}$/.test(x)) ? g.map(x => parseInt(x, 16).toString(16)).join(':') : null;
  }
  const BY = new Map();
  for (const service of SERVICES) {
    for (const variant of service.variants) for (const ip of [...variant.ipv4, ...variant.ipv6]) BY.set(key(ip), { ip, v: ip.includes(':') ? 6 : 4, service, variant });
  }
  const andList = a => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  // A variant's name inside a sentence: "Recommended / Secure" for "9.9.9.9 (Recommended / Secure)", nothing for a name
  // that is only an address ("1.1.1.1"), and no parentheses inside the ones it goes in ("Unfiltered, p0").
  const label = name => {
    const m = /^[\d.]+ \((.+)\)$/.exec(name);
    return m ? m[1] : /^[\d.]+$/.test(name) ? '' : name.replace(/ \(([^()]+)\)/g, ', $1');
  };
  // Whether any of a service's variants filters something the operator documents (not Google's, AliDNS's or DNS.SB's)
  const filters = s => s.variants.some(x => x.filtering && !/^none\b/.test(x.filtering));
  root.IPTERM_RESOLVERS = {
    checked: LAST_CHECKED,
    // The services in the order /public-dns lists them: { id, service, short, brand, either, operator, anycast,
    // variants: [{ name, filtering, ipv4, ipv6, doh, dot }], dnssec, ecs, logging, sources }
    list: () => SERVICES,
    // The resolver an address is one of, however it is written: { ip (as listed), v (4 or 6), service, variant }, or null
    get: ip => BY.get(key(ip)) || null,
    label, filters,
    // "9.9.9.9 · Quad9 DNS: addresses, DoH, DoT and filtering | ipterm": the page's title (ipPage() in src/worker.js) and
    // the terminal's (ipTitle() in public/app.js). "filtering" only for a service with a variant that filters.
    title: r => `${r.ip} · ${r.service.short}: ` +
      andList(['addresses', r.variant.doh && 'DoH', r.variant.dot && 'DoT', filters(r.service) && 'filtering'].filter(Boolean)) + ' | ipterm',
    // "9.9.9.9 is Quad9's public DNS resolver (Recommended / Secure).", then the other addresses people set beside it:
    // "Secondary 149.112.112.112, IPv6 2620:fe::fe." The start of the page's summary and description (ipPage()).
    lead: r => {
      const s = r.service, l = s.variants.length > 1 ? label(r.variant.name) : '';
      return `${r.ip} is ${s.brand} public DNS resolver${r.v === 6 ? ' over IPv6' : ''}${l ? ` (${l})` : ''}.`;
    },
    others: r => {
      const x = r.variant, same = r.v === 4 ? x.ipv4 : x.ipv6, other = r.v === 4 ? x.ipv6 : x.ipv4, i = same.indexOf(r.ip);
      const mate = same.length > 1 ? `${r.service.either ? 'Also' : i ? 'Primary' : 'Secondary'} ${same[i ? 0 : 1]}` : '';
      const parts = [mate, other.length ? `IPv${r.v === 4 ? 6 : 4} ${other[0]}` : ''].filter(Boolean);
      return parts.length ? parts.join(', ') + '.' : '';
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
