/* ipterm subnet calculator.
   One source of truth for the page (loaded as /cidr.js, exposes window.IPTERM_CIDR) and the Worker
   (imported by src/worker.js for the /cidr/<range> pages). No dependencies. */
(function (root) {
  const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  function v6groups(s) {
    if (!/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
    const dbl = s.includes('::');
    const [h, t] = dbl ? s.split('::') : [s, ''];
    const hp = h ? h.split(':') : [], tp = dbl && t ? t.split(':') : [];
    const fill = 8 - hp.length - tp.length;
    if (dbl ? fill < 1 : hp.length !== 8) return null;
    const g = [...hp, ...Array(dbl ? fill : 0).fill('0'), ...tp];
    if (g.length !== 8 || g.some(x => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
    return g.map(x => parseInt(x, 16));
  }

  const u32 = n => n >>> 0;
  const v4int = o => u32(o[0] * 16777216 + o[1] * 65536 + o[2] * 256 + o[3]);
  const v4str = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  const v4mask = n => (n === 0 ? 0 : u32(0xFFFFFFFF << (32 - n)));
  const fmt = n => (typeof n === 'bigint' ? n : BigInt(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  function maskToPrefix(m) {                       // 255.255.252.0 -> 22, or null if the mask isn't contiguous
    if (!V4.test(m)) return null;
    const inv = u32(~v4int(m.split('.').map(Number)));
    if ((inv & (inv + 1)) !== 0) return null;
    return 32 - Math.round(Math.log2(inv + 1));
  }

  // ---- IPv6 helpers (BigInt) ----
  const B = BigInt, ALL = (1n << 128n) - 1n;
  const v6mask = n => (n === 0 ? 0n : (ALL << B(128 - n)) & ALL);
  const v6big = g => g.reduce((acc, x) => (acc << 16n) | B(x), 0n);
  const v6split = big => Array.from({ length: 8 }, (_, i) => Number((big >> B(112 - 16 * i)) & 0xffffn));
  function v6compress(g) {                         // RFC 5952: drop leading zeros, collapse the longest zero run
    let best = -1, bestLen = 0;
    for (let i = 0; i < 8;) {
      if (g[i] !== 0) { i++; continue; }
      let j = i; while (j < 8 && g[j] === 0) j++;
      if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
      i = j;
    }
    const hex = g.map(x => x.toString(16));
    if (best < 0) return hex.join(':');
    return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLen).join(':');
  }
  // ---- special-purpose addresses ----
  // One table for the subnet calculator, the IP pages (nonPublicReason() in src/worker.js) and the terminal (classify()
  // in public/app.js), so they never disagree: [block, kind, words]. From IANA's IPv4 and IPv6 Special-Purpose Address
  // Registries (iana-ipv4-special-registry, iana-ipv6-special-registry, as of 2026-10-25): the blocks marked not
  // globally reachable, plus multicast (from the IPv4 and IPv6 Address Space registries). Kind 'public' marks the
  // blocks inside those, or outside 2000::/3, that IANA marks globally reachable: the NAT64 prefix. Five anycast
  // addresses that IANA marks so too stay non-public, with words of their own: PCP's and TURN's (192.0.0.9 and
  // 192.0.0.10 in 192.0.0.0/24, 2001:1::1 and 2001:1::2) and DNS-SD SRP's (2001:1::3). IPinfo calls them bogons and
  // has no data for them (its free API, on 2026-10-25). 192.88.99.0/24 is public, with its own words: deprecated by
  // RFC 7526, but still announced (by AS6939, seen by 199 of 269 RIS peers in RIPEstat on 2026-10-25), apart from its
  // 6a44 relay address. IPinfo calls 192.88.99.1 a bogon all the same, and its page says so in IPinfo's name (ipPage()
  // in src/worker.js). The IETF block 2001::/23 is left out as a whole: most of what is assigned in it is reachable
  // (Teredo, AS112, AMT), so only its benchmarking block and those three anycast addresses are here. Beyond the table
  // IPv4 is public, and IPv6 is public in 2000::/3 (global unicast, in the IPv6 Address Space registry) and reserved
  // elsewhere.
  // tools/check_pages.mjs checks the table against IANA's.
  const SPECIAL = [
    ['0.0.0.0/8', 'reserved', '"this network" block (0.0.0.0/8)'],
    ['10.0.0.0/8', 'private', 'RFC 1918 private range (10.0.0.0/8)'],
    ['100.64.0.0/10', 'cgnat', 'carrier-grade NAT range (100.64.0.0/10)'],
    ['127.0.0.0/8', 'loopback', 'loopback range (127.0.0.0/8)'],
    ['169.254.0.0/16', 'link-local', 'link-local range (169.254.0.0/16)'],
    ['172.16.0.0/12', 'private', 'RFC 1918 private range (172.16.0.0/12)'],
    ['192.0.0.0/24', 'reserved', 'IETF protocol assignments (192.0.0.0/24)'],
    ['192.0.0.9/32', 'reserved', 'Port Control Protocol anycast address (192.0.0.9, RFC 7723)'],
    ['192.0.0.10/32', 'reserved', 'TURN anycast address (192.0.0.10, RFC 8155)'],
    ['192.0.2.0/24', 'docs', 'documentation range TEST-NET-1 (192.0.2.0/24, RFC 5737)'],
    ['192.88.99.0/24', 'public', 'former 6to4 relay anycast range (192.88.99.0/24, deprecated by RFC 7526)'],
    ['192.88.99.2/32', 'reserved', '6a44 relay anycast address (192.88.99.2)'],
    ['192.168.0.0/16', 'private', 'RFC 1918 private range (192.168.0.0/16)'],
    ['198.18.0.0/15', 'benchmark', 'benchmarking range (198.18.0.0/15, RFC 2544)'],
    ['198.51.100.0/24', 'docs', 'documentation range TEST-NET-2 (198.51.100.0/24, RFC 5737)'],
    ['203.0.113.0/24', 'docs', 'documentation range TEST-NET-3 (203.0.113.0/24, RFC 5737)'],
    ['224.0.0.0/4', 'multicast', 'multicast range (224.0.0.0/4)'],
    ['240.0.0.0/4', 'reserved', 'reserved range (240.0.0.0/4)'],
    ['255.255.255.255/32', 'reserved', 'limited broadcast address (255.255.255.255)'],
    ['::/128', 'unspecified', 'unspecified address (::)'],
    ['::1/128', 'loopback', 'loopback address (::1)'],
    ['::ffff:0:0/96', 'reserved', 'IPv4-mapped range (::ffff:0:0/96); look up the IPv4 address instead'],
    ['64:ff9b::/96', 'public', 'NAT64 translation prefix (64:ff9b::/96, RFC 6052)'],
    ['64:ff9b:1::/48', 'reserved', 'local-use NAT64 translation prefix (64:ff9b:1::/48, RFC 8215)'],
    ['100::/64', 'reserved', 'discard-only prefix (100::/64, RFC 6666)'],
    ['100:0:0:1::/64', 'reserved', 'dummy IPv6 prefix (100:0:0:1::/64, RFC 9780)'],
    ['2001:1::1/128', 'reserved', 'Port Control Protocol anycast address (2001:1::1, RFC 7723)'],
    ['2001:1::2/128', 'reserved', 'TURN anycast address (2001:1::2, RFC 8155)'],
    ['2001:1::3/128', 'reserved', 'DNS-SD Service Registration Protocol anycast address (2001:1::3, RFC 9665)'],
    ['2001:2::/48', 'benchmark', 'benchmarking range (2001:2::/48, RFC 5180)'],
    ['2001:db8::/32', 'docs', 'documentation range (2001:db8::/32, RFC 3849)'],
    ['3fff::/20', 'docs', 'documentation range (3fff::/20, RFC 9637)'],
    ['5f00::/16', 'reserved', 'SRv6 SID prefix (5f00::/16, RFC 9602)'],
    ['fc00::/7', 'ula', 'unique local range (fc00::/7)'],
    ['fe80::/10', 'link-local', 'link-local range (fe80::/10)'],
    ['ff00::/8', 'multicast', 'multicast range (ff00::/8)'],
  ];
  const TABLE = { 4: [], 6: [] };
  for (const [block, kind, note] of SPECIAL) {
    const [a, l] = block.split('/'), len = Number(l), v = V4.test(a) ? 4 : 6;
    TABLE[v].push({ block, kind, note, len, net: v === 4 ? v4int(a.split('.').map(Number)) : v6big(v6groups(a)) });
  }
  // The entry for a block (its network address and prefix length), and whether it holds all of the block: the most
  // specific one that does, or else the most specific non-public one its network address is in, since the calculator
  // goes by where a block starts (10.0.0.0/7 is private, 100.0.0.0/9 public). That one begins where the block does and
  // lies inside it. null for ordinary space.
  function entry(v, net, len) {
    const holds = v === 4 ? e => u32(net & v4mask(e.len)) === e.net : e => (net & v6mask(e.len)) === e.net;
    let all = null, start = null;
    for (const e of TABLE[v]) {
      if (!holds(e)) continue;
      if (e.len <= len && (!all || e.len > all.len)) all = e;
      if (e.kind !== 'public' && (!start || e.len > start.len)) start = e;
    }
    return all ? [all, true] : start ? [start, false] : null;
  }
  // [kind, words]. An entry's words are only for a block it holds: a wider block "starts with" it (10.0.0.0/7 starts
  // with the RFC 1918 range 10.0.0.0/8, ::/96 with the unspecified address), and a /0 is the whole address space.
  // other: [kind, words] for ordinary space.
  function rangeOf(v, net, len, other) {
    const [e, all] = entry(v, net, len) || [];
    return [e ? e.kind : other[0], len === 0 ? `whole IPv${v} address space` : !e ? other[1] : all ? e.note : 'starts with the ' + e.note];
  }
  const v4range = (net, len) => rangeOf(4, net, len, ['public', 'public address space']);
  const v6range = (net, len) => rangeOf(6, net, len, net >> 125n === 1n     // net: a BigInt
    ? ['public', 'global unicast space (2000::/3)'] : ['reserved', 'reserved IPv6 space (outside 2000::/3)']);
  // [kind, words, listed] for one address, as parseIp gives it ({ v: 4, o: [octets] } or { v: 6, g: [groups] }): listed
  // when the words are an entry's, not ordinary space's. The IP pages and the terminal call it non-public unless the
  // kind is 'public'.
  const special = p => {
    const net = p.v === 4 ? v4int(p.o) : v6big(p.g), len = p.v === 4 ? 32 : 128;
    return [...(p.v === 4 ? v4range(net, len) : v6range(net, len)), Boolean(entry(p.v, net, len))];
  };
  // A kind's word in the title of a non-public address's page, as in "private IPv4 address" (ipPage() in src/worker.js,
  // lookup() in public/app.js): RFC 1918 and unique local space are both "private", the word people search for.
  // 'non-public' for a kind without one (the unspecified address).
  const WORDS = { private: 'private', ula: 'private', loopback: 'loopback', 'link-local': 'link-local', cgnat: 'carrier-grade NAT (shared)',
    docs: 'documentation', benchmark: 'benchmarking', multicast: 'multicast', reserved: 'reserved' };
  const kindWord = kind => (Object.hasOwn(WORDS, kind) ? WORDS[kind] : 'non-public');
  // rangeIn: "in the RFC 1918 private range (10.0.0.0/8)", or "the loopback address (::1)" for an entry of one address
  // and "the whole IPv4 address space" for a /0. rangeIs: the same after "it": "is in the ...", or "starts with the ..."
  // for a block wider than its entry (calc's rangeNote; an address's words never start so).
  const THE = new Set([...TABLE[4].filter(e => e.len === 32), ...TABLE[6].filter(e => e.len === 128)].map(e => e.note)
    .concat('whole IPv4 address space', 'whole IPv6 address space'));
  const rangeIn = note => (THE.has(note) ? 'the ' : 'in the ') + note;
  const rangeIs = note => (/^starts /.test(note) ? note : 'is ' + rangeIn(note));

  function calc(input) {
    const s = String(input || '').trim().replace(/\s+/g, ' ');
    if (!s) return { error: 'Give a range, like 10.0.0.0/22, 192.168.1.10 255.255.255.0 or 2001:db8::/48.' };
    let ipPart, pfx;
    if (s.includes('/')) [ipPart, pfx] = s.split('/', 2);
    else [ipPart, pfx] = s.split(' ', 2);
    ipPart = (ipPart || '').trim(); pfx = pfx === undefined ? '' : String(pfx).trim();

    if (V4.test(ipPart)) {
      let n;
      if (pfx === '') n = 32;
      else if (/^\d{1,2}$/.test(pfx)) n = Number(pfx);
      else if (V4.test(pfx)) { n = maskToPrefix(pfx); if (n === null) return { error: `${pfx} is not a valid netmask: the 1 bits must be contiguous, like 255.255.252.0.` }; }
      else return { error: `"${pfx}" is not a prefix length (0–32) or a netmask.` };
      if (n < 0 || n > 32) return { error: 'An IPv4 prefix length must be between 0 and 32.' };
      const ip = v4int(ipPart.split('.').map(Number)), mask = v4mask(n);
      const net = u32(ip & mask), bcast = u32(net | u32(~mask)), total = 2 ** (32 - n);
      const usable = n === 32 ? 1 : n === 31 ? 2 : total - 2;   // /31: point-to-point links use both (RFC 3021)
      const [range, rangeNote] = v4range(net, n);
      const a = net >>> 24;
      const d = {
        v: 4, input: s, ip: ipPart, prefix: n,
        network: v4str(net), broadcast: v4str(bcast), netmask: v4str(mask), wildcard: v4str(u32(~mask)),
        first: v4str(n >= 31 ? net : net + 1), last: v4str(n >= 31 ? bcast : bcast - 1),
        total, usable, totalText: fmt(total), usableText: fmt(usable),
        hostIndex: ip !== net ? ip - net : null,
        legacyClass: a < 128 ? 'A' : a < 192 ? 'B' : a < 224 ? 'C' : a < 240 ? 'D (multicast)' : 'E (reserved)',
        range, rangeNote,
        bits: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].map(x => x.toString(2).padStart(8, '0')).join('.'),
        supernet: n > 0 ? `${v4str(u32(net & v4mask(n - 1)))}/${n - 1}` : null,
        halves: n < 32 ? [`${v4str(net)}/${n + 1}`, `${v4str(u32(net + total / 2))}/${n + 1}`] : null,
        slash24s: n >= 8 && n < 24 ? 2 ** (24 - n) : null,
      };
      d.cidr = `${d.network}/${n}`;
      return d;
    }

    const g = v6groups(ipPart.toLowerCase());
    if (g) {
      let n;
      if (pfx === '') n = 128;
      else if (/^\d{1,3}$/.test(pfx)) n = Number(pfx);
      else return { error: `"${pfx}" is not an IPv6 prefix length (0–128).` };
      if (n < 0 || n > 128) return { error: 'An IPv6 prefix length must be between 0 and 128.' };
      const ip = v6big(g), mask = v6mask(n);
      const net = ip & mask, last = net | (~mask & ALL), total = 1n << B(128 - n);
      const ng = v6split(net), [range, rangeNote] = v6range(net, n);
      const d = {
        v: 6, input: s, ip: ipPart.toLowerCase(), prefix: n,
        network: v6compress(ng), last: v6compress(v6split(last)),
        expanded: ng.map(x => x.toString(16).padStart(4, '0')).join(':'),
        totalText: fmt(total), totalPow: `2^${128 - n}`,
        subnets64: n <= 64 ? fmt(1n << B(64 - n)) : null,
        range, rangeNote,
        supernet: n > 0 ? `${v6compress(v6split(net & ((ALL << B(129 - n)) & ALL)))}/${n - 1}` : null,
        halves: n < 128 ? [`${v6compress(ng)}/${n + 1}`, `${v6compress(v6split(net | (1n << B(127 - n))))}/${n + 1}`] : null,
      };
      d.cidr = `${d.network}/${n}`;
      return d;
    }
    return { error: `"${ipPart}" is not a valid IPv4 or IPv6 address.` };
  }

  // Prefix table for the cheat sheet and the `cidr` command with no arguments.
  function table(from = 8, to = 32) {
    const rows = [];
    for (let n = from; n <= to; n++) {
      const total = 2 ** (32 - n);
      rows.push({ prefix: n, netmask: v4str(v4mask(n)), wildcard: v4str(u32(~v4mask(n))), total, usable: n === 32 ? 1 : n === 31 ? 2 : total - 2 });
    }
    return rows;
  }

  root.IPTERM_CIDR = { calc, table, maskToPrefix, fmt, special, kindWord, rangeIn, rangeIs, SPECIAL };
})(typeof globalThis !== 'undefined' ? globalThis : window);
