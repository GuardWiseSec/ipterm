// ipterm DNS leak test responder. One process, two jobs:
//   1. Authoritative DNS for the leak-test zone (dl.ipterm.net), UDP and TCP port 53. A visitor's browser
//      looks up <token>.<zone>, their resolver asks this server, and the server notes the resolver's
//      address against the token, in memory only, for less than two minutes.
//   2. A small HTTP API on 127.0.0.1 (Caddy puts HTTPS in front of it) that gives the ipterm Worker the
//      resolver addresses for its tokens, once, and then forgets them. It needs the shared key.
// Nothing about queries or addresses is ever logged or written to disk. Configuration comes from the
// environment (/etc/dnsleak/dnsleak.env under systemd); see README.md.
import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseQuery, answer, encode, udpLimit, v4bytes, v6bytes, validName, TOKEN_RE } from './dns.js';
import { TokenStore, Buckets } from './store.js';

const MAX_TOKENS_PER_ASK = 10;
const TCP_MAX_CONNECTIONS = 200;

const nameVar = (v, fallback) => String(v || fallback).trim().toLowerCase().replace(/\.$/, '');
function portVar(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`not a port number: ${v}`);
  return n;
}

export function loadConfig(env) {
  const zone = nameVar(env.DNSLEAK_ZONE, '');
  if (!validName(zone)) throw new Error('DNSLEAK_ZONE must be a domain name, like dl.ipterm.net');
  const ns = nameVar(env.DNSLEAK_NS, 'ns1.' + zone), hostmaster = nameVar(env.DNSLEAK_HOSTMASTER, 'hostmaster.' + zone);
  if (!validName(ns)) throw new Error('DNSLEAK_NS must be a host name, like ns1.dl.ipterm.net');
  if (!validName(hostmaster)) throw new Error('DNSLEAK_HOSTMASTER must be a domain name');
  const nsIpv4 = String(env.DNSLEAK_NS_IPV4 || '').trim();
  v4bytes(nsIpv4);                                       // throws if it isn't one
  const nsIpv6 = String(env.DNSLEAK_NS_IPV6 || '').trim().toLowerCase() || null;
  if (nsIpv6) v6bytes(nsIpv6);
  const key = String(env.DNSLEAK_KEY || '');
  if (key.length < 32) throw new Error('DNSLEAK_KEY must be at least 32 characters (setup.sh makes one)');
  return {
    zone, ns, hostmaster, nsIpv4, nsIpv6, key,
    ttl: 3600, negTtl: 60, serial: 1,
    dnsBind: String(env.DNSLEAK_DNS_BIND || nsIpv4).trim(),
    dnsBind6: String(env.DNSLEAK_DNS_BIND6 || nsIpv6 || '').trim() || null,
    dnsPort: portVar(env.DNSLEAK_DNS_PORT, 53),
    apiBind: String(env.DNSLEAK_API_BIND || '127.0.0.1').trim(),
    apiPort: portVar(env.DNSLEAK_API_PORT, 8053),
  };
}

// The address that asked, as a plain string (an IPv4 address that arrived on an IPv6 socket loses its
// ::ffff: prefix), and the network it's rate limited by: IPv4 /24, IPv6 /56.
const plainIp = ip => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : String(ip).split('%')[0].toLowerCase());
function prefixKey(ip) {
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.');
  try { return v6bytes(ip).slice(0, 7).join(','); } catch { return ip; }
}

// Who called the API, for its open rate limit. It listens on loopback behind Caddy, which sets
// X-Forwarded-For to the address that connected to it (without trusted_proxies it ignores whatever the
// caller sent there; the last entry is Caddy's either way). A caller not on loopback is its own address.
function caller(req) {
  const peer = plainIp(req.socket.remoteAddress || '');
  if (!/^(127\.|::1$)/.test(peer)) return peer;
  const fwd = plainIp(String(req.headers['x-forwarded-for'] || '').split(',').pop().trim());
  return net.isIP(fwd) ? fwd : peer;
}

const sha = s => createHash('sha256').update(String(s)).digest();

// `now` is the rate limits' clock (tests stop it).
export async function start(cfg, { store = new TokenStore(), now } = {}) {
  const rrl = new Buckets({ rate: 50, burst: 100, now });      // answers a second per asking network, so this can't be used to flood anyone
  const keyed = new Buckets({ rate: 200, burst: 400, now });   // calls with the key: only the Worker has it, so one bucket for them all
  const open = new Buckets({ rate: 5, burst: 10, now });       // everything else, per calling network: it never touches the Worker's
  const keyHash = sha(cfg.key);

  function handle(msg, from, overTcp) {
    let q;
    try { q = parseQuery(msg); } catch { q = null; }
    if (!q) return null;
    const r = answer(q, cfg);
    if (r.token) store.record(r.token, from);
    return encode(q, r, overTcp ? 65535 : udpLimit(q));
  }

  const udp = [], tcp = [];
  let dnsPort = cfg.dnsPort;
  for (const [family, addr] of [['udp4', cfg.dnsBind], ['udp6', cfg.dnsBind6]]) {
    if (!addr) continue;
    const sock = dgram.createSocket({ type: family });
    sock.on('message', (msg, rinfo) => {
      const from = plainIp(rinfo.address);
      if (!rrl.take(prefixKey(from))) return;          // over the limit: no answer
      const out = handle(msg, from, false);
      // With a callback, a failed send (a forged, unreachable source) is just dropped, not a socket error.
      if (out) sock.send(out, rinfo.port, rinfo.address, () => {});
    });
    await listen(sock, s => s.bind(dnsPort, addr));
    dnsPort = sock.address().port;                       // with port 0 (tests), TCP and IPv6 follow UDP's pick
    udp.push(sock);
  }

  let connections = 0;
  for (const addr of [cfg.dnsBind, cfg.dnsBind6]) {
    if (!addr) continue;
    const server = net.createServer(conn => {
      if (connections >= TCP_MAX_CONNECTIONS) return conn.destroy();
      connections++;
      conn.on('close', () => { connections--; });
      conn.on('error', () => {});
      conn.setTimeout(10_000, () => conn.destroy());
      const from = plainIp(conn.remoteAddress || '');
      let buf = Buffer.alloc(0);
      conn.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length > 4098) return conn.destroy();    // queries are small; this isn't one
        while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
          const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
          buf = buf.subarray(2 + msg.length);
          const out = rrl.take(prefixKey(from)) ? handle(msg, from, true) : null;
          if (!out) return conn.destroy();
          const len = Buffer.alloc(2);
          len.writeUInt16BE(out.length);
          conn.write(Buffer.concat([len, out]));
        }
      });
    });
    await listen(server, s => s.listen(dnsPort, addr));
    tcp.push(server);
  }

  const api = http.createServer((req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
      res.end(JSON.stringify(body) + '\n');
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { url = null; }
    // The key first, so that calls without it (anyone can reach /healthz) can't spend the Worker's allowance.
    const got = req.headers['x-dnsleak-key'];
    const worker = req.method === 'GET' && url?.pathname === '/v1/resolvers'
      && typeof got === 'string' && timingSafeEqual(sha(got), keyHash);
    if (!(worker ? keyed.take('worker') : open.take(prefixKey(caller(req))))) {
      return send(429, { error: 'Too many requests.' }, { 'retry-after': '1' });
    }
    if (req.method !== 'GET') return send(405, { error: 'Use GET.' }, { allow: 'GET' });
    if (!url) return send(400, { error: 'Bad request.' });
    if (url.pathname === '/healthz') return send(200, { ok: true });   // says nothing, so it needs no key
    if (url.pathname !== '/v1/resolvers') return send(404, { error: 'Not found.' });
    if (!worker) return send(401, { error: 'Wrong or missing key.' });
    const tokens = String(url.searchParams.get('t') || '').toLowerCase().split(',').filter(Boolean);
    if (!tokens.length || tokens.length > MAX_TOKENS_PER_ASK || !tokens.every(t => TOKEN_RE.test(t))) {
      return send(400, { error: `Give 1 to ${MAX_TOKENS_PER_ASK} tokens (20 hex characters each) as t=<token>,<token>.` });
    }
    send(200, store.take(tokens));
  });
  api.headersTimeout = 5000; api.requestTimeout = 5000; api.keepAliveTimeout = 5000;
  await listen(api, s => s.listen(cfg.apiPort, cfg.apiBind));

  const timer = setInterval(() => { store.sweep(); rrl.sweep(); keyed.sweep(); open.sweep(); }, 5000);
  timer.unref();

  return {
    dnsPort, apiPort: api.address().port, store,
    async close() {
      clearInterval(timer);
      for (const s of udp) s.close();
      await Promise.all([...tcp, api].map(s => new Promise(r => { s.close(() => r()); if (s.closeAllConnections) s.closeAllConnections(); })));
    },
  };
}

// Binds a socket or server and waits until it is listening (or fails, e.g. port 53 already in use).
function listen(s, go) {
  return new Promise((resolve, reject) => {
    const fail = e => reject(e);
    s.once('error', fail);
    s.once('listening', () => {
      s.off('error', fail);
      s.on('error', e => { console.error(`dnsleak: socket error (${e.code || e.message}); exiting so systemd restarts it`); process.exit(1); });
      resolve();
    });
    go(s);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { console.error('dnsleak: ' + e.message); process.exit(2); }
  start(cfg).then(s => {
    console.log(`dnsleak: authoritative for ${cfg.zone} on ${[cfg.dnsBind, cfg.dnsBind6].filter(Boolean).join(' and ')} port ${s.dnsPort} (UDP and TCP); API on ${cfg.apiBind}:${s.apiPort}. No queries or addresses are logged.`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }, e => { console.error(`dnsleak: could not start (${e.code || e.message})`); process.exit(1); });
}
