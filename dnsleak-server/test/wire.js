// Test helpers: build a DNS query and read an answer, independently of dns.js.

export function query(name, type = 1, { id = 0x1234, klass = 1, rd = true, opcode = 0, edns = null, raw = null } = {}) {
  const parts = [];
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE((opcode << 11) | (rd ? 0x0100 : 0), 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(edns ? 1 : 0, 10);
  parts.push(head);
  if (raw) parts.push(raw);
  else {
    for (const l of name.split('.').filter(Boolean)) parts.push(Buffer.from([l.length]), Buffer.from(l, 'latin1'));
    parts.push(Buffer.from([0]));
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0); tail.writeUInt16BE(klass, 2);
  parts.push(tail);
  if (edns) {
    const opts = edns.options || Buffer.alloc(0);
    const opt = Buffer.alloc(11);
    opt.writeUInt8(0, 0); opt.writeUInt16BE(41, 1); opt.writeUInt16BE(edns.udpSize || 1232, 3);
    opt.writeUInt32BE((((edns.version || 0) & 0xff) << 16 | (edns.do ? 0x8000 : 0)) >>> 0, 5);
    opt.writeUInt16BE(opts.length, 9);
    parts.push(opt, opts);
  }
  return Buffer.concat(parts);
}

// An EDNS Client Subnet option (RFC 7871) for an IPv4 /24.
export function ecsOption(a, b, c) {
  const o = Buffer.alloc(11);
  o.writeUInt16BE(8, 0); o.writeUInt16BE(7, 2); o.writeUInt16BE(1, 4); o.writeUInt8(24, 6); o.writeUInt8(0, 7);
  o.writeUInt8(a, 8); o.writeUInt8(b, 9); o.writeUInt8(c, 10);
  return o;
}

function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, hops = 0;
  for (;;) {
    const len = buf[off];
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true;
      if (++hops > 20) throw new Error('loop');
      continue;
    }
    if (len === 0) { if (!jumped) end = off + 1; break; }
    labels.push(buf.toString('latin1', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}

export function decode(buf) {
  const flags = buf.readUInt16BE(2);
  const m = {
    id: buf.readUInt16BE(0), qr: !!(flags & 0x8000), opcode: (flags >> 11) & 0xf, aa: !!(flags & 0x0400), tc: !!(flags & 0x0200),
    rd: !!(flags & 0x0100), ra: !!(flags & 0x0080), rcode: flags & 0xf, question: [], answer: [], authority: [], additional: [], edns: null,
  };
  const counts = [4, 6, 8, 10].map(o => buf.readUInt16BE(o));
  let off = 12;
  for (let i = 0; i < counts[0]; i++) {
    const n = readName(buf, off);
    m.question.push({ name: n.name, type: buf.readUInt16BE(n.end), klass: buf.readUInt16BE(n.end + 2) });
    off = n.end + 4;
  }
  for (const [section, count] of [['answer', counts[1]], ['authority', counts[2]], ['additional', counts[3]]]) {
    for (let i = 0; i < count; i++) {
      const n = readName(buf, off);
      const type = buf.readUInt16BE(n.end), klass = buf.readUInt16BE(n.end + 2), ttl = buf.readUInt32BE(n.end + 4), len = buf.readUInt16BE(n.end + 8);
      const at = n.end + 10;
      let data = buf.subarray(at, at + len);
      if (type === 1) data = [...data].join('.');
      else if (type === 28) data = [...Array(8)].map((_, j) => data.readUInt16BE(j * 2).toString(16)).join(':');
      else if (type === 2) data = readName(buf, at).name;
      else if (type === 6) {
        const a = readName(buf, at), b = readName(buf, a.end);
        data = { mname: a.name, rname: b.name, serial: buf.readUInt32BE(b.end), minimum: buf.readUInt32BE(b.end + 16) };
      }
      if (type === 41) m.edns = { udpSize: klass, extRcode: ttl >>> 24, version: (ttl >>> 16) & 0xff, do: !!(ttl & 0x8000) };
      else m[section].push({ name: n.name, type, ttl, data });
      off = at + len;
    }
  }
  if (off !== buf.length) throw new Error(`trailing bytes: read ${off} of ${buf.length}`);
  return m;
}
