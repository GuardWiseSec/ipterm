/* ipterm leak test: the grade and the share codes.
   One source of truth for the page (loaded as /leakgrade.js, exposes window.IPTERM_LEAK) and the Worker
   (imported by src/worker.js for the rubric on the /leaktest page and the /leaktest/r/<code> result pages).
   No dependencies.

   The grade counts only what leaks past a VPN: DNS, WebRTC, the other IP version (IPv6 or IPv4) and the
   time zone, each only when a VPN is detected. Not using a VPN never lowers it.

   A share code carries the grade, whether a VPN was detected, and for each graded check whether it
   passed, leaked or wasn't tested. Nothing else: no IP address, provider, location or resolver, so every
   browser with the same result gets the same code. The page makes the code; the server only reads it.
   Version 1 is "1", the grade letter, then 10 bits (vpn, dns, webrtc, ipv6, tz: 2 bits each) as two
   characters of Crockford's base32: 1bjp is a B on a VPN, with only the time zone leaking. 113 codes are
   valid in all. A later version can add checks under a new first character. */
(function (root) {
  const NOT_TESTED = 0, PASS = 1, LEAK = 2;                 // each graded check
  const VPN_UNKNOWN = 0, VPN_NONE = 1, VPN_ON = 2;          // whether a VPN was detected
  // The graded checks, in code order: [key, label].
  const CHECKS = [['dns', 'DNS'], ['webrtc', 'WebRTC'], ['ipv6', 'IPv6 / IPv4'], ['tz', 'time zone']];

  // The rubric, as `man leaktest`, the /leaktest page and docs/handbook.md show it.
  const GRADES = [
    ['A', 'no leaks'],
    ['B', 'only the time zone leaks: it gives away your region, not your address'],
    ['C', 'DNS leaks (sites you visit are looked up outside the VPN), but neither WebRTC nor IPv6 does'],
    ['D', 'WebRTC or IPv6 shows an address outside the VPN (one of the two), and DNS doesn\'t leak'],
    ['F', 'WebRTC or IPv6 leaks and DNS does too, or WebRTC and IPv6 both leak'],
  ];
  const RULES = [
    'Only four checks count: DNS, WebRTC, IPv6 (your other IP version) and the time zone, and only when a VPN is detected: a known VPN, proxy or Tor address, a hosting network, Cloudflare WARP, or iCloud Private Relay (a relay, counted the same way).',
    'No VPN detected: nothing can leak past one, so the grade is A. What sites see without one (your provider and rough location) gets its own line and is never graded.',
    "Can't tell whether you use a VPN: no grade if a line would be a leak with one, A if none would.",
    "Checks that couldn't run don't count. INFO lines (connection security, browser language, a local address) never count.",
  ];

  // f: { vpn, dns, webrtc, ipv6, tz }. Returns the letter, or null when there is no grade (something
  // would be a leak, but no VPN was detected to leak past).
  function grade(f) {
    const leak = k => f[k] === LEAK;
    if (f.vpn !== VPN_ON && CHECKS.some(([k]) => leak(k))) return null;
    const ip = (leak('webrtc') ? 1 : 0) + (leak('ipv6') ? 1 : 0);
    if (ip === 2 || (ip && leak('dns'))) return 'F';
    if (ip) return 'D';
    if (leak('dns')) return 'C';
    if (leak('tz')) return 'B';
    return 'A';
  }

  const B32 = '0123456789abcdefghjkmnpqrstvwxyz';           // Crockford's: no i, l, o or u
  const okVal = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  function encode(f) {
    if (!f || !okVal(f.vpn, 2) || !CHECKS.every(([k]) => okVal(f[k], 2))) return null;
    const g = grade(f);
    if (!g) return null;
    const bits = [f.vpn, ...CHECKS.map(([k]) => f[k])].reduce((n, v) => n * 4 + v, 0);
    return '1' + g.toLowerCase() + B32[bits >> 5] + B32[bits & 31];
  }
  // The result a code stands for, or null if it isn't a valid one (the grade must match the checks).
  function decode(code) {
    const m = /^1([abcdf])([0-9a-hjkmnp-tv-z])([0-9a-hjkmnp-tv-z])$/.exec(String(code || '').trim().toLowerCase());
    if (!m) return null;
    let bits = B32.indexOf(m[2]) * 32 + B32.indexOf(m[3]);
    const vals = [];
    for (let i = 0; i < 5; i++) { vals.unshift(bits & 3); bits >>= 2; }
    if (vals.includes(3)) return null;
    const f = { vpn: vals[0] };
    CHECKS.forEach(([k], i) => { f[k] = vals[i + 1]; });
    const g = grade(f);
    return g && g.toLowerCase() === m[1] ? { code: m[0], grade: g, ...f } : null;
  }

  // Words for a decoded result, shared by the result page and the terminal.
  const article = g => (/^[AF]$/.test(g) ? 'an ' : 'a ') + g;
  const checkWord = v => (v === LEAK ? 'leaked' : v === PASS ? 'no leak' : 'not tested');
  const vpnWord = v => (v === VPN_ON ? 'a VPN was on' : v === VPN_NONE ? 'no VPN detected' : "couldn't tell whether a VPN was on");

  root.IPTERM_LEAK = { NOT_TESTED, PASS, LEAK, VPN_UNKNOWN, VPN_NONE, VPN_ON, CHECKS, GRADES, RULES, grade, encode, decode, article, checkWord, vpnWord };
})(typeof globalThis !== 'undefined' ? globalThis : window);
