// Authoritative DNS for the leak-test zone (dl.ipterm.net): just enough of the wire format (RFC 1035,
// plus the EDNS header from RFC 6891) to answer SOA and NS for the zone, A/AAAA for its name server,
// and NXDOMAIN for every other name, while noting which resolver asked for each token name.
//
// Token names get NXDOMAIN rather than an address: the browser's fetch then fails within milliseconds
// (net::ERR_NAME_NOT_RESOLVED) and never tries to connect anywhere. With an address, even TEST-NET
// 192.0.2.1, Chrome waits on the connection until the page gives up, and home routers with DNS
// rebinding protection drop such answers anyway. See README.md.
//
// EDNS options are skipped unread, so EDNS Client Subnet data (part of the visitor's own address,
// which some resolvers attach) is never looked at, let alone kept.

export const TOKEN_RE = /^[0-9a-f]{20}$/;   // the random label the page makes: 80 bits as lowercase hex
export const TYPE = { A: 1, NS: 2, SOA: 6, AAAA: 28, OPT: 41, ANY: 255 };
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5, BADVERS: 16 };
const CLASS_IN = 1, CLASS_ANY = 255;
const EDNS_SIZE = 1232;                      // the payload size we advertise (DNS flag day 2020)

// Reads a query. null: not worth an answer (shorter than a header, or a response). Otherwise an
// object; .bad means it couldn't be read, and the answer is FORMERR without a question.
export function parseQuery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null;                       // a response: never answer those
  const q = { id: buf.readUInt16BE(0), opcode: (flags >> 11) & 0xf, rd: !!(flags & 0x0100), cd: !!(flags & 0x0010),
    qdcount: buf.readUInt16BE(4), labels: null, qtype: 0, qclass: 0, qraw: null, edns: null, bad: false };
  if (q.qdcount !== 1) { q.bad = true; return q; }
  try {
    let off = 12, wire = 1;
    const labels = [];
    for (;;) {
      const len = buf[off];
      if (len === undefined) throw new Error('short');
      if (len === 0) { off++; break; }
      if (len > 63) throw new Error('label');            // compression pointers have no place in a question
      if (off + 1 + len > buf.length) throw new Error('short');
      if ((wire += len + 1) > 255) throw new Error('long');
      // Resolvers randomize the case of names (0x20), so names are compared in lowercase, ASCII only.
      labels.push(buf.toString('latin1', off + 1, off + 1 + len).replace(/[A-Z]/g, c => c.toLowerCase()));
      off += 1 + len;
    }
    if (off + 4 > buf.length) throw new Error('short');
    q.qraw = buf.subarray(12, off);                       // echoed byte for byte, case and all
    q.labels = labels;
    q.qtype = buf.readUInt16BE(off);
    q.qclass = buf.readUInt16BE(off + 2);
    off += 4;
    const others = buf.readUInt16BE(6) + buf.readUInt16BE(8), extra = buf.readUInt16BE(10);
    for (let i = 0; i < others; i++) off = readRR(buf, off).end;
    for (let i = 0; i < extra; i++) {
      const rr = readRR(buf, off);
      if (rr.type === TYPE.OPT) {
        if (q.edns || rr.nameLen !== 1) throw new Error('opt');   // one OPT at most, owned by the root
        q.edns = { udpSize: rr.klass, version: (rr.ttl >>> 16) & 0xff, do: !!(rr.ttl & 0x8000) };
      }
      off = rr.end;
    }
  } catch {
    q.bad = true; q.edns = null;
  }
  return q;
}

// One resource record's header, skipping its owner name and data.
function readRR(buf, off) {
  const start = off;
  for (;;) {
    const len = buf[off];
    if (len === undefined) throw new Error('short');
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { off += 2; break; }
    if (len > 63) throw new Error('label');
    off += 1 + len;
  }
  if (off + 10 > buf.length) throw new Error('short');
  const end = off + 10 + buf.readUInt16BE(off + 8);
  if (end > buf.length) throw new Error('short');
  return { type: buf.readUInt16BE(off), klass: buf.readUInt16BE(off + 2), ttl: buf.readUInt32BE(off + 4), nameLen: off - start, end };
}

const labelsOf = name => (name ? name.toLowerCase().split('.') : []);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const endsWith = (a, suffix) => a.length >= suffix.length && suffix.every((x, i) => a[a.length - suffix.length + i] === x);

// What to answer, as records; encode() turns it into bytes. .token is the token name to note, if any.
export function answer(q, cfg) {
  const r = { rcode: RCODE.NOERROR, aa: false, answer: [], authority: [], additional: [], token: null };
  if (q.bad) return { ...r, rcode: RCODE.FORMERR };
  if (q.edns && q.edns.version > 0) return { ...r, rcode: RCODE.BADVERS };
  if (q.opcode !== 0) return { ...r, rcode: RCODE.NOTIMP };
  if (q.qclass !== CLASS_IN && q.qclass !== CLASS_ANY) return { ...r, rcode: RCODE.REFUSED };
  const zone = labelsOf(cfg.zone), name = q.labels;
  if (!endsWith(name, zone)) return { ...r, rcode: RCODE.REFUSED };   // not ours: no recursion here
  r.aa = true;
  const soa = { name: cfg.zone, type: TYPE.SOA, ttl: cfg.ttl,
    data: { mname: cfg.ns, rname: cfg.hostmaster, serial: cfg.serial, refresh: 3600, retry: 600, expire: 1209600, minimum: cfg.negTtl } };
  const negative = { ...soa, ttl: cfg.negTtl };          // RFC 2308: the SOA's TTL, capped at its minimum
  const nsInZone = endsWith(labelsOf(cfg.ns), zone);
  const addrs = [cfg.nsIpv4 && { name: cfg.ns, type: TYPE.A, ttl: cfg.ttl, data: cfg.nsIpv4 },
    cfg.nsIpv6 && { name: cfg.ns, type: TYPE.AAAA, ttl: cfg.ttl, data: cfg.nsIpv6 }].filter(Boolean);
  const t = q.qtype;
  if (name.length === zone.length) {                     // the zone itself
    if (t === TYPE.SOA || t === TYPE.ANY) r.answer.push(soa);
    else if (t === TYPE.NS) {
      r.answer.push({ name: cfg.zone, type: TYPE.NS, ttl: cfg.ttl, data: cfg.ns });
      if (nsInZone) r.additional.push(...addrs);
    } else r.authority.push(negative);                   // no such type here (NODATA)
    return r;
  }
  if (nsInZone && same(name, labelsOf(cfg.ns))) {        // the name server's own addresses
    const hits = addrs.filter(a => a.type === t || t === TYPE.ANY);
    if (hits.length) r.answer.push(...hits); else r.authority.push(negative);
    return r;
  }
  if (name.length === zone.length + 1 && TOKEN_RE.test(name[0])) r.token = name[0];
  r.rcode = RCODE.NXDOMAIN;
  r.authority.push(negative);
  return r;
}

// The answer as bytes. If it doesn't fit maxSize (512 for plain UDP, the client's EDNS size up to 1232,
// 65535 over TCP), the records are dropped and TC is set, so the client asks again over TCP.
export function encode(q, r, maxSize = 512) {
  const full = build(q, r, false);
  return full.length <= maxSize ? full : build(q, r, true);
}

// The largest UDP answer this query allows.
export const udpLimit = q => (q.edns ? Math.max(512, Math.min(q.edns.udpSize, EDNS_SIZE)) : 512);

function build(q, r, truncated) {
  const w = new Writer();
  const records = truncated ? [[], [], []] : [r.answer, r.authority, r.additional];
  const withQ = !q.bad && !!q.qraw;
  w.u16(q.id);
  w.u16(0x8000 | (q.opcode << 11) | (r.aa ? 0x0400 : 0) | (truncated ? 0x0200 : 0) | (q.rd ? 0x0100 : 0) | (q.cd ? 0x0010 : 0) | (r.rcode & 0xf));
  w.u16(withQ ? 1 : 0); w.u16(records[0].length); w.u16(records[1].length); w.u16(records[2].length + (q.edns ? 1 : 0));
  if (withQ) { w.bytes(q.qraw); w.u16(q.qtype); w.u16(q.qclass); }
  const ctx = withQ ? q.labels : null;
  for (const rr of records.flat()) writeRR(w, rr, ctx);
  if (q.edns) {                                          // OPT: our size, the high bits of the rcode, the DO bit copied (RFC 3225)
    w.u8(0); w.u16(TYPE.OPT); w.u16(EDNS_SIZE); w.u32((((r.rcode >> 4) & 0xff) << 24 | (q.edns.do ? 0x8000 : 0)) >>> 0); w.u16(0);
  }
  return w.done();
}

function writeRR(w, rr, qlabels) {
  writeName(w, rr.name, qlabels);
  w.u16(rr.type); w.u16(CLASS_IN); w.u32(rr.ttl);
  const at = w.reserve16();
  if (rr.type === TYPE.A) w.bytes(Buffer.from(v4bytes(rr.data)));
  else if (rr.type === TYPE.AAAA) w.bytes(Buffer.from(v6bytes(rr.data)));
  else if (rr.type === TYPE.NS) writeName(w, rr.data, qlabels);
  else if (rr.type === TYPE.SOA) {
    const s = rr.data;
    writeName(w, s.mname, qlabels); writeName(w, s.rname, qlabels);
    for (const n of [s.serial, s.refresh, s.retry, s.expire, s.minimum]) w.u32(n);
  }
  w.patch16(at, w.length - at - 2);
}

// Names are written as labels, ending in a pointer to the question when they share its suffix
// (dl.ipterm.net inside <token>.dl.ipterm.net), which keeps answers short.
function writeName(w, name, qlabels) {
  const labels = labelsOf(name);
  for (let i = 0; i < labels.length; i++) {
    const rest = labels.slice(i);
    if (qlabels && endsWith(qlabels, rest)) {
      const skip = qlabels.slice(0, qlabels.length - rest.length).reduce((n, l) => n + l.length + 1, 0);
      w.u16(0xc000 | (12 + skip));
      return;
    }
    w.u8(labels[i].length); w.bytes(Buffer.from(labels[i], 'latin1'));
  }
  w.u8(0);
}

class Writer {
  constructor() { this.buf = Buffer.alloc(4096); this.length = 0; }
  u8(n) { this.buf.writeUInt8(n, this.length); this.length += 1; }
  u16(n) { this.buf.writeUInt16BE(n, this.length); this.length += 2; }
  u32(n) { this.buf.writeUInt32BE(n, this.length); this.length += 4; }
  bytes(b) { b.copy(this.buf, this.length); this.length += b.length; }
  reserve16() { const at = this.length; this.u16(0); return at; }
  patch16(at, n) { this.buf.writeUInt16BE(n, at); }
  done() { return Buffer.from(this.buf.subarray(0, this.length)); }
}

/* ---------- addresses and names (also used to check the configuration) ---------- */

export function v4bytes(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  const b = m ? m.slice(1).map(Number) : null;
  if (!b || b.some(x => x > 255)) throw new Error(`not an IPv4 address: ${s}`);
  return b;
}

export function v6bytes(s) {
  s = String(s).toLowerCase();
  if (!/^[0-9a-f:]+$/.test(s) || s.split('::').length > 2) throw new Error(`not an IPv6 address: ${s}`);
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const fill = 8 - h.length - t.length;
  if (tail === null ? h.length !== 8 : fill < 1) throw new Error(`not an IPv6 address: ${s}`);
  const groups = [...h, ...Array(tail === null ? 0 : fill).fill('0'), ...t];
  if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) throw new Error(`not an IPv6 address: ${s}`);
  return groups.flatMap(g => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; });
}

// A host name we can serve: lowercase letters, digits and hyphens, at least two labels.
export const validName = s => typeof s === 'string' && s.length <= 253 &&
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(s);
