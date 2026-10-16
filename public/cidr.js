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

  function v4range(net) {                          // what kind of block the network address sits in
    const a = net >>> 24, b = (net >>> 16) & 255, c = (net >>> 8) & 255;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return ['private', 'RFC 1918 private range'];
    if (a === 100 && b >= 64 && b <= 127) return ['cgnat', 'carrier-grade NAT range (RFC 6598)'];
    if (a === 127) return ['loopback', 'loopback range'];
    if (a === 169 && b === 254) return ['link-local', 'link-local range'];
    if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return ['docs', 'documentation range (RFC 5737)'];
    if (a >= 224 && a <= 239) return ['multicast', 'multicast range'];
    if (a >= 240 || a === 0) return ['reserved', 'reserved range'];
    return ['public', 'public address space'];
  }

  // ---- IPv6 helpers (BigInt) ----
  const B = BigInt, ALL = (1n << 128n) - 1n;
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
  function v6range(g) {
    if (g.every(x => x === 0)) return ['unspecified', 'unspecified address'];
    if ((g[0] & 0xffc0) === 0xfe80) return ['link-local', 'link-local range (fe80::/10)'];
    if ((g[0] & 0xfe00) === 0xfc00) return ['ula', 'unique local range (fc00::/7)'];
    if ((g[0] & 0xff00) === 0xff00) return ['multicast', 'multicast range (ff00::/8)'];
    if (g[0] === 0x2001 && g[1] === 0x0db8) return ['docs', 'documentation range (2001:db8::/32)'];
    if ((g[0] & 0xe000) === 0x2000) return ['public', 'global unicast space (2000::/3)'];
    return ['reserved', 'reserved or special-purpose space'];
  }

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
      const [range, rangeNote] = v4range(net);
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
      const ip = v6big(g), mask = n === 0 ? 0n : (ALL << B(128 - n)) & ALL;
      const net = ip & mask, last = net | (~mask & ALL), total = 1n << B(128 - n);
      const ng = v6split(net), [range, rangeNote] = v6range(ng);
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

  root.IPTERM_CIDR = { calc, table, maskToPrefix, fmt };
})(typeof globalThis !== 'undefined' ? globalThis : window);
