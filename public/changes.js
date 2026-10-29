/* ipterm's changes: real fixes and new pages, newest first, for /changes (changesRoute() in src/worker.js, which imports
   this file; it is served as /changes.js too, like ports.js). Written by hand, in the same commit as the change, and
   dated the day it goes live. No reporter names: the GitHub issue already credits whoever reported it. No dependencies.
   Each entry: [date (YYYY-MM-DD), what changed (one or two plain sentences), the pages it is about (paths on this site,
   linked on the page; optional)]. */
(function (root) {
  const LIST = [
    ['2026-10-29', 'New: public DNS resolver pages. Every address of 11 public DNS services (Google, Cloudflare, Quad9, OpenDNS, AdGuard and more) shows its service, its filtering variant, its other addresses, DoH and DoT, and what the operator documents about DNSSEC, client subnet (ECS) and logging, with the operator\'s pages as sources and the day they were checked. /public-dns lists them all, also as plain text for curl. Their titles, descriptions and summaries no longer name one place (IPinfo\'s location row stays), and an address is called anycast only where its operator says so.',
      ['/public-dns', '/9.9.9.9', '/1.1.1.3']],
    ['2026-10-29', 'Reference pages (the port pages, the tool pages but leaktest, the guides, /public-dns and a DNS resolver\'s details on its IP page) end with a line to suggest a fix: on GitHub (public, needs an account) or by email. It fills in only the page\'s address, and "resolver" for a resolver\'s details. Other IP pages point to IPinfo instead, which takes corrections to its locations.',
      ['/port', '/whois', '/guides/find-router-ip', '/public-dns']],
    ['2026-10-29', 'New: this list of changes, also as plain text for curl.'],
    ['2026-10-27', 'whois and report cards name the registry whose server failed, and say the problem is on its side: "ARIN\'s whois server (rdap.arin.net) failed to answer (HTTP 525). That\'s on their side; try again in a moment."'],
    ['2026-10-27', 'When ipterm takes too long to answer, the terminal no longer blames your connection: "No answer from ipterm within 9 seconds: a registry or data source may be slow or down." It offers retry, as it does when ipterm can\'t be reached.'],
    ['2026-10-27', 'access lists the commands to type apart from what happens by itself (reduced motion, screen reader summaries), and typing motion or screen explains itself instead of "command not found".'],
    ['2026-10-25', 'All 42 port pages are in the sitemap. Each names the service IANA registered for the port, or says "not registered with IANA" (10 of them), and links IANA\'s registry, and whatportis.com for the 38 it has a page for.',
      ['/port', '/port/22']],
    ['2026-10-25', 'Clearer titles: an IP page says "IP lookup" with its network and hostname, an ASN page "ASN, IP ranges and upstreams", and a /32 is "a single address". Descriptions fit search results, and an anycast address such as 8.8.8.8 no longer claims one city.',
      ['/8.8.8.8', '/AS13335']],
    ['2026-10-25', 'One table of special-purpose addresses, from IANA\'s registries, for the subnet calculator, the IP pages and the terminal: the calculator no longer calls 198.18.0.0/15 (benchmarking) or 3fff::/20 (documentation) public.',
      ['/cidr/198.18.0.0/15', '/cidr/3fff::/20']],
  ];
  root.IPTERM_CHANGES = {
    // { date, text, pages }, newest first
    list: () => LIST.map(([date, text, pages]) => ({ date, text, pages: pages || [] })),
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
