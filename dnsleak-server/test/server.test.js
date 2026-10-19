// The running server: DNS over UDP and TCP on a random local port, and the API the Worker calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { loadConfig, start } from '../server.js';
import { query, decode } from './wire.js';

const KEY = 'k'.repeat(40);
const TOKEN = 'aaaaaaaaaabbbbbbbbbb', OTHER = 'ccccccccccdddddddddd';
const env = { DNSLEAK_ZONE: 'dl.ipterm.net', DNSLEAK_NS_IPV4: '203.0.113.7', DNSLEAK_KEY: KEY,
  DNSLEAK_DNS_BIND: '127.0.0.1', DNSLEAK_DNS_PORT: '0', DNSLEAK_API_PORT: '0' };

function udpAsk(port, buf) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('no UDP answer')); }, 2000);
    s.on('message', m => { clearTimeout(t); s.close(); resolve(decode(m)); });
    s.send(buf, port, '127.0.0.1');
  });
}

function tcpAsk(port, bufs) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1');
    const answers = []; let data = Buffer.alloc(0);
    c.on('error', reject);
    c.on('data', d => {
      data = Buffer.concat([data, d]);
      while (data.length >= 2 && data.length >= 2 + data.readUInt16BE(0)) {
        answers.push(decode(data.subarray(2, 2 + data.readUInt16BE(0))));
        data = data.subarray(2 + data.readUInt16BE(0));
      }
      if (answers.length === bufs.length) { c.end(); resolve(answers); }
    });
    // Both queries in one write, the second split across the boundary, as TCP may deliver them.
    c.write(Buffer.concat(bufs.map(b => { const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); })));
  });
}

const get = (port, path, key) => fetch(`http://127.0.0.1:${port}${path}`, { headers: key ? { 'x-dnsleak-key': key } : {} })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('configuration is checked before anything starts', () => {
  assert.throws(() => loadConfig({ ...env, DNSLEAK_ZONE: 'not a zone' }), /DNSLEAK_ZONE/);
  assert.throws(() => loadConfig({ ...env, DNSLEAK_KEY: 'short' }), /DNSLEAK_KEY/);
  assert.throws(() => loadConfig({ ...env, DNSLEAK_NS_IPV4: '' }), /IPv4/);
  const c = loadConfig({ DNSLEAK_ZONE: 'DL.ipterm.net.', DNSLEAK_NS_IPV4: '203.0.113.7', DNSLEAK_KEY: KEY });
  assert.equal(c.zone, 'dl.ipterm.net');
  assert.equal(c.ns, 'ns1.dl.ipterm.net');
  assert.equal(c.dnsBind, '203.0.113.7');                  // the public address, not 0.0.0.0
  assert.equal(c.dnsPort, 53);
  assert.equal(c.apiBind, '127.0.0.1');
});

test('DNS over UDP and TCP, then the API: once, with the key', async t => {
  const s = await start(loadConfig(env));
  t.after(() => s.close());

  const soa = await udpAsk(s.dnsPort, query('dl.ipterm.net', 6));
  assert.equal(soa.rcode, 0);
  assert.equal(soa.answer[0].data.mname, 'ns1.dl.ipterm.net');

  const nx = await udpAsk(s.dnsPort, query(`${TOKEN}.dl.ipterm.net`, 1, { edns: {} }));
  assert.equal(nx.rcode, 3);
  assert.ok(nx.aa);

  const [a, b] = await tcpAsk(s.dnsPort, [query(`${OTHER}.dl.ipterm.net`, 28), query('ns1.dl.ipterm.net', 1)]);
  assert.equal(a.rcode, 3);
  assert.equal(b.answer[0].data, '203.0.113.7');

  await udpAsk(s.dnsPort, query('test.dl.ipterm.net', 1));       // not a token: answered, not noted
  assert.equal(s.store.size, 2);

  assert.deepEqual(await get(s.apiPort, '/healthz'), { status: 200, body: { ok: true } });
  assert.equal((await get(s.apiPort, `/v1/resolvers?t=${TOKEN}`)).status, 401);
  assert.equal((await get(s.apiPort, `/v1/resolvers?t=${TOKEN}`, KEY + 'x')).status, 401);
  assert.equal((await get(s.apiPort, '/v1/resolvers?t=test', KEY)).status, 400);
  assert.equal((await get(s.apiPort, '/v1/resolvers', KEY)).status, 400);
  assert.equal((await get(s.apiPort, `/v1/resolvers?t=${Array(11).fill(TOKEN).join(',')}`, KEY)).status, 400);
  assert.equal((await get(s.apiPort, '/', KEY)).status, 404);

  const first = await get(s.apiPort, `/v1/resolvers?t=${TOKEN},${OTHER.toUpperCase()},eeeeeeeeeeffffffffff`, KEY);
  assert.deepEqual(first, { status: 200, body: { resolvers: ['127.0.0.1'], seen: 2 } });
  const again = await get(s.apiPort, `/v1/resolvers?t=${TOKEN},${OTHER}`, KEY);
  assert.deepEqual(again.body, { resolvers: [], seen: 0 });     // forgotten after the first read
  assert.equal(s.store.size, 0);

  const post = await fetch(`http://127.0.0.1:${s.apiPort}/v1/resolvers?t=${TOKEN}`, { method: 'POST', headers: { 'x-dnsleak-key': KEY } });
  assert.equal(post.status, 405);
});

test('the API: calls without the key have a small allowance per network and never use up the Worker\'s', async t => {
  const s = await start(loadConfig(env), { now: () => 0 });   // the rate limits' clock stopped: nothing refills
  t.after(() => s.close());
  const ask = (path, key, init = {}) => fetch(`http://127.0.0.1:${s.apiPort}${path}`,
    { ...init, headers: { ...(key ? { 'x-dnsleak-key': key } : {}), ...init.headers } }).then(r => r.status);
  const RESOLVERS = `/v1/resolvers?t=${TOKEN}`;
  const open = [() => ask('/healthz'), () => ask(RESOLVERS), () => ask(RESOLVERS, KEY + 'x'), () => ask('/', KEY),
    () => ask(RESOLVERS, KEY, { method: 'POST' })];
  const run = async (n, f) => { const out = []; for (let i = 0; i < n; i++) out.push(await f(i)); return out; };

  // Ten of them from this network, then nothing more for it, past the Worker's whole burst of 400...
  assert.deepEqual(await run(10, i => open[i % 5]()), [200, 401, 401, 404, 405, 200, 401, 401, 404, 405]);
  assert.deepEqual(new Set(await run(500, i => open[i % 5]())), new Set([429]));
  // ...and the Worker still has all of its 400, and is limited after them.
  const worker = await run(401, () => ask(RESOLVERS, KEY));
  assert.equal(worker.filter(x => x === 200).length, 400);
  assert.equal(worker[400], 429);

  // Behind Caddy the caller is the last X-Forwarded-For entry (Caddy's own), by network, so a flood from
  // one place leaves /healthz up for a monitor elsewhere. Without a usable entry it is the connection's.
  const via = xff => ask('/healthz', null, { headers: { 'x-forwarded-for': xff } });
  assert.deepEqual(new Set(await run(10, () => via('198.51.100.7'))), new Set([200]));
  assert.equal(await via('198.51.100.250'), 429);                // the same /24
  assert.equal(await via('198.51.100.7, 203.0.113.9'), 200);     // another network
  assert.equal(await via('203.0.113.9, 198.51.100.7'), 429);     // an entry in front of Caddy's changes nothing
  assert.equal(await via('2001:db8:0:100::1'), 200);
  assert.equal(await via('not an address'), 429);                // this connection's own, spent above
});

test('garbage on the DNS ports gets no answer and does not stop the server', async t => {
  const s = await start(loadConfig(env));
  t.after(() => s.close());
  const sock = dgram.createSocket('udp4');
  await new Promise(r => sock.send(Buffer.from('hello'), s.dnsPort, '127.0.0.1', r));
  sock.close();
  const c = net.connect(s.dnsPort, '127.0.0.1');
  await new Promise(r => c.on('connect', r));
  c.write(Buffer.from([0xff, 0xff, 1, 2, 3]));                 // claims 65535 bytes, sends 3, then too much
  c.write(Buffer.alloc(5000));
  await new Promise(r => c.on('close', r));                    // the server hangs up
  const ok = await udpAsk(s.dnsPort, query('dl.ipterm.net', 6));
  assert.equal(ok.rcode, 0);
});
