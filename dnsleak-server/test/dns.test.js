import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, answer, encode, udpLimit, TYPE, RCODE, v6bytes, validName } from '../dns.js';
import { query, decode, ecsOption } from './wire.js';

const cfg = { zone: 'dl.ipterm.net', ns: 'ns1.dl.ipterm.net', hostmaster: 'hostmaster.dl.ipterm.net', nsIpv4: '203.0.113.7', nsIpv6: null,
  ttl: 3600, negTtl: 60, serial: 1 };
const TOKEN = '0123456789abcdef0123';

// The whole path a packet takes through the server: parse, decide, encode, and read it back.
function ask(buf, c = cfg) {
  const q = parseQuery(buf);
  if (!q) return null;
  const r = answer(q, c);
  return { r, m: decode(encode(q, r, udpLimit(q))) };
}

test('SOA at the zone apex', () => {
  const { m } = ask(query('dl.ipterm.net', TYPE.SOA));
  assert.equal(m.rcode, RCODE.NOERROR);
  assert.ok(m.qr && m.aa && !m.ra);
  assert.equal(m.answer.length, 1);
  assert.deepEqual(m.answer[0].data, { mname: 'ns1.dl.ipterm.net', rname: 'hostmaster.dl.ipterm.net', serial: 1, minimum: 60 });
  assert.equal(m.answer[0].name, 'dl.ipterm.net');
});

test('NS at the apex, with the glue address', () => {
  const { m } = ask(query('dl.ipterm.net', TYPE.NS));
  assert.deepEqual(m.answer.map(a => [a.name, a.type, a.data]), [['dl.ipterm.net', TYPE.NS, 'ns1.dl.ipterm.net']]);
  assert.deepEqual(m.additional.map(a => [a.name, a.type, a.data]), [['ns1.dl.ipterm.net', TYPE.A, '203.0.113.7']]);
});

test('the name server answers A, and AAAA only when configured', () => {
  assert.equal(ask(query('ns1.dl.ipterm.net', TYPE.A)).m.answer[0].data, '203.0.113.7');
  const noV6 = ask(query('ns1.dl.ipterm.net', TYPE.AAAA)).m;
  assert.equal(noV6.rcode, RCODE.NOERROR);                // NODATA: the name exists, the type doesn't
  assert.equal(noV6.answer.length, 0);
  assert.equal(noV6.authority[0].type, TYPE.SOA);
  const v6 = ask(query('ns1.dl.ipterm.net', TYPE.AAAA), { ...cfg, nsIpv6: '2001:db8::53' }).m;
  assert.equal(v6.answer[0].data, '2001:db8:0:0:0:0:0:53');
});

test('other types at the apex are NODATA with the SOA', () => {
  const { m } = ask(query('dl.ipterm.net', TYPE.A));
  assert.equal(m.rcode, RCODE.NOERROR);
  assert.equal(m.answer.length, 0);
  assert.equal(m.authority[0].ttl, 60);
});

test('a token name is NXDOMAIN and is noted', () => {
  const { r, m } = ask(query(`${TOKEN}.dl.ipterm.net`, TYPE.A));
  assert.equal(r.token, TOKEN);
  assert.equal(m.rcode, RCODE.NXDOMAIN);
  assert.ok(m.aa);
  assert.equal(m.answer.length, 0);
  assert.equal(m.authority[0].type, TYPE.SOA);
  assert.equal(m.authority[0].ttl, 60);                    // the negative-caching time
  assert.equal(m.authority[0].name, 'dl.ipterm.net');
});

test('every query type for a token is NXDOMAIN (AAAA, HTTPS, NS from QNAME minimisation)', () => {
  for (const t of [TYPE.AAAA, 65, TYPE.NS, TYPE.ANY]) {
    const { r, m } = ask(query(`${TOKEN}.dl.ipterm.net`, t));
    assert.equal(m.rcode, RCODE.NXDOMAIN);
    assert.equal(r.token, TOKEN);
  }
});

test('mixed case (0x20) is echoed exactly, and the token still matches', () => {
  const name = '0123456789ABCDEF0123.Dl.IpTeRm.NeT';
  const { r, m } = ask(query(name, TYPE.A));
  assert.equal(m.question[0].name, name);
  assert.equal(r.token, TOKEN);
  assert.equal(m.authority[0].name.toLowerCase(), 'dl.ipterm.net');
});

test('names that are not tokens are NXDOMAIN and not noted', () => {
  for (const n of ['test.dl.ipterm.net', `${TOKEN}0.dl.ipterm.net`, `${TOKEN.slice(1)}.dl.ipterm.net`, `x.${TOKEN}.dl.ipterm.net`,
    '0123456789abcdefg123.dl.ipterm.net', 'www.dl.ipterm.net']) {
    const { r, m } = ask(query(n, TYPE.A));
    assert.equal(m.rcode, RCODE.NXDOMAIN, n);
    assert.equal(r.token, null, n);
  }
});

test('a label with a dot in it is not mistaken for a name in the zone', () => {
  // one label "evil.dl" then "ipterm", "net": that is not under dl.ipterm.net
  const raw = Buffer.concat([Buffer.from([7]), Buffer.from('evil.dl'), Buffer.from([6]), Buffer.from('ipterm'), Buffer.from([3]), Buffer.from('net'), Buffer.from([0])]);
  const { m } = ask(query('', TYPE.A, { raw }));
  assert.equal(m.rcode, RCODE.REFUSED);
});

test('names outside the zone are REFUSED, and no recursion is offered', () => {
  for (const n of ['ipterm.net', 'example.com', 'xdl.ipterm.net', '']) {
    const { m } = ask(query(n, TYPE.A));
    assert.equal(m.rcode, RCODE.REFUSED, n);
    assert.ok(!m.aa && !m.ra);
  }
});

test('CHAOS class (version.bind and the like) is REFUSED', () => {
  assert.equal(ask(query('version.bind', 16, { klass: 3 })).m.rcode, RCODE.REFUSED);
  assert.equal(ask(query('dl.ipterm.net', TYPE.SOA, { klass: 3 })).m.rcode, RCODE.REFUSED);
});

test('opcodes other than QUERY get NOTIMP', () => {
  assert.equal(ask(query('dl.ipterm.net', TYPE.SOA, { opcode: 4 })).m.rcode, RCODE.NOTIMP);   // NOTIFY
});

test('EDNS: an OPT comes back with our size and the DO bit copied', () => {
  const { m } = ask(query(`${TOKEN}.dl.ipterm.net`, TYPE.A, { edns: { udpSize: 4096, do: true } }));
  assert.deepEqual(m.edns, { udpSize: 1232, extRcode: 0, version: 0, do: true });
  const plain = ask(query(`${TOKEN}.dl.ipterm.net`, TYPE.A)).m;
  assert.equal(plain.edns, null);
});

test('EDNS version 1 gets BADVERS', () => {
  const { m } = ask(query('dl.ipterm.net', TYPE.SOA, { edns: { version: 1 } }));
  assert.equal(m.edns.extRcode, 1);                       // BADVERS = 16: 1 in the OPT, 0 in the header
  assert.equal(m.rcode, 0);
  assert.equal(m.answer.length, 0);
});

test('EDNS Client Subnet is ignored: same answer, and nothing about it is kept', () => {
  const withEcs = ask(query(`${TOKEN}.dl.ipterm.net`, TYPE.A, { edns: { options: ecsOption(198, 51, 100) } }));
  const without = ask(query(`${TOKEN}.dl.ipterm.net`, TYPE.A, { edns: {} }));
  assert.deepEqual(withEcs.r, without.r);
  assert.deepEqual(withEcs.m, without.m);
  assert.ok(!JSON.stringify(parseQuery(query(`${TOKEN}.dl.ipterm.net`, TYPE.A, { edns: { options: ecsOption(198, 51, 100) } }))).includes('198'));
});

test('malformed queries: FORMERR, or no answer at all', () => {
  assert.equal(parseQuery(Buffer.alloc(5)), null);                      // shorter than a header
  const resp = query('dl.ipterm.net', TYPE.SOA); resp[2] |= 0x80;       // a response, not a query
  assert.equal(parseQuery(resp), null);
  const pointer = query('', TYPE.A, { raw: Buffer.from([0xc0, 0x0c]) }); // compression pointer in the question
  assert.equal(ask(pointer).m.rcode, RCODE.FORMERR);
  assert.equal(ask(pointer).m.question.length, 0);
  const cut = query(`${TOKEN}.dl.ipterm.net`, TYPE.A).subarray(0, 20);   // ends inside the name
  assert.equal(ask(cut).m.rcode, RCODE.FORMERR);
  const two = query('dl.ipterm.net', TYPE.SOA); two.writeUInt16BE(2, 4); // two questions
  assert.equal(ask(two).m.rcode, RCODE.FORMERR);
  const long = query('', TYPE.A, { raw: Buffer.concat([Buffer.from([64]), Buffer.alloc(64, 97), Buffer.from([0])]) });
  assert.equal(ask(long).m.rcode, RCODE.FORMERR);                        // a label over 63 bytes
  const twoOpt = query('dl.ipterm.net', TYPE.SOA, { edns: {} });
  const doubled = Buffer.concat([twoOpt, twoOpt.subarray(twoOpt.length - 11)]); doubled.writeUInt16BE(2, 10);
  assert.equal(ask(doubled).m.rcode, RCODE.FORMERR);
});

test('the answer keeps the query id and RD flag', () => {
  const { m } = ask(query('dl.ipterm.net', TYPE.SOA, { id: 0xbeef, rd: false }));
  assert.equal(m.id, 0xbeef);
  assert.equal(m.rd, false);
  assert.equal(ask(query('dl.ipterm.net', TYPE.SOA)).m.rd, true);
});

test('answers too big for plain UDP are truncated (TC), never sent oversized', () => {
  // A long name inside the zone: its question alone is close to 512 bytes with a long SOA.
  const big = { ...cfg, hostmaster: 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(60) + '.' + 'd'.repeat(60) + '.example' };
  const name = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(40), 'dl.ipterm.net'].join('.');   // 248 bytes on the wire
  const q = parseQuery(query(name, TYPE.A));
  assert.ok(!q.bad);
  const r = answer(q, big);
  const full = encode(q, r, 65535), udp = encode(q, r, 512);
  assert.ok(full.length > 512);
  assert.ok(udp.length <= 512);
  assert.ok(decode(udp).tc);
  assert.equal(decode(udp).authority.length, 0);
});

test('helpers: IPv6 parsing and host-name checks', () => {
  assert.deepEqual(v6bytes('2001:db8::1').slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);
  assert.throws(() => v6bytes('2001:db8::1::2'));
  assert.throws(() => v6bytes('1:2:3:4:5:6:7'));
  assert.ok(validName('dl.ipterm.net'));
  for (const bad of ['dl', '-x.ipterm.net', 'dl.ipterm.net.', 'DL.ipterm.net', '*.ipterm.net', 'a b.net']) assert.ok(!validName(bad), bad);
});
