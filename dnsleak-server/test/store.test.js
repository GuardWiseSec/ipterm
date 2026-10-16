import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenStore, Buckets } from '../store.js';

const clock = (t = 0) => { const c = () => t; c.add = ms => { t += ms; }; return c; };

test('records the resolvers that asked, once each, and hands them over once', () => {
  const now = clock(), s = new TokenStore({ now });
  s.record('a', '8.8.8.8'); s.record('a', '8.8.4.4'); s.record('a', '8.8.8.8'); s.record('b', '1.1.1.1');
  assert.deepEqual(s.take(['a', 'b', 'c']), { resolvers: ['8.8.8.8', '8.8.4.4', '1.1.1.1'], seen: 2 });
  assert.deepEqual(s.take(['a', 'b']), { resolvers: [], seen: 0 });   // forgotten after the first read
  assert.equal(s.size, 0);
});

test('a token asked for twice in one read counts once', () => {
  const s = new TokenStore({ now: clock() });
  s.record('a', '9.9.9.9');
  assert.deepEqual(s.take(['a', 'a']), { resolvers: ['9.9.9.9'], seen: 1 });
});

test('entries expire after the TTL, whether read or swept', () => {
  const now = clock(), s = new TokenStore({ now, ttlMs: 110_000 });
  s.record('old', '8.8.8.8');
  now.add(60_000);
  s.record('new', '1.1.1.1');
  now.add(49_999);
  assert.equal(s.size, 2);
  s.sweep();
  assert.equal(s.size, 2);                                // 'old' is 109.999 s old: still there
  now.add(1);
  s.sweep();
  assert.equal(s.size, 1);                                // 'old' reached 110 s: gone
  assert.deepEqual(s.take(['old']), { resolvers: [], seen: 0 });
  now.add(60_000);
  assert.deepEqual(s.take(['new']), { resolvers: [], seen: 0 });   // expired, though never swept
});

test('a query after expiry starts the token afresh, without the old addresses', () => {
  const now = clock(), s = new TokenStore({ now, ttlMs: 1000 });
  s.record('a', '8.8.8.8');
  now.add(1000);
  s.record('a', '1.1.1.1');
  assert.deepEqual(s.take(['a']), { resolvers: ['1.1.1.1'], seen: 1 });
});

test('memory is capped: past maxTokens the oldest tokens go first', () => {
  const now = clock(), s = new TokenStore({ now, maxTokens: 3 });
  for (const k of ['a', 'b', 'c', 'd']) { s.record(k, '8.8.8.8'); now.add(1); }
  assert.equal(s.size, 3);
  assert.equal(s.take(['a']).seen, 0);
  assert.equal(s.take(['b', 'c', 'd']).seen, 3);
});

test('each token keeps at most maxIps addresses', () => {
  const s = new TokenStore({ now: clock(), maxIps: 2 });
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) s.record('a', ip);
  assert.deepEqual(s.take(['a']).resolvers, ['1.1.1.1', '2.2.2.2']);
});

test('the sweep stops at the first live entry (insertion order is creation order)', () => {
  const now = clock(), s = new TokenStore({ now, ttlMs: 100 });
  s.record('a', '1.1.1.1'); now.add(50); s.record('b', '1.1.1.1'); now.add(60);
  s.sweep();
  assert.deepEqual([...s.map.keys()], ['b']);
});

test('buckets: a burst, then the steady rate', () => {
  const now = clock(), b = new Buckets({ rate: 10, burst: 3, now });
  assert.deepEqual([b.take('x'), b.take('x'), b.take('x'), b.take('x')], [true, true, true, false]);
  assert.ok(b.take('y'));                                  // other keys are separate
  now.add(100);                                            // 10 a second: one more after 100 ms
  assert.deepEqual([b.take('x'), b.take('x')], [true, false]);
});

test('buckets: refilled ones are swept, and the table is capped', () => {
  const now = clock(), b = new Buckets({ rate: 10, burst: 2, max: 3, now });
  b.take('a'); b.take('b');
  now.add(1000);
  b.sweep();
  assert.equal(b.size, 0);
  for (const k of ['a', 'b', 'c', 'd']) b.take(k);
  assert.ok(b.size <= 3);
});
