// `npm test`: runs every check that needs no server, one at a time, each in its own Node process, and prints a line
// for each and a total. It exits 1 if any of them fails or crashes, and prints what failed: its output, less the lines
// that passed. GitHub runs it on every push to master and every pull request (.github/workflows/test.yml). Plain Node
// with no shell in between and nothing to install, so it works the same from PowerShell, cmd or sh, on Windows or
// Linux. Node 22.15 or later: most of the checks load the Worker through module.registerHooks.
//
//   npm test                     (or: node tools/test.mjs)
//
// The checks: tools/check_bots.mjs, check_vpnlists.mjs, check_https.mjs, check_pages.mjs, check_timeouts.mjs (about 9
// seconds: its deadlines are real), check_relay.mjs (about 7, for the same reason), check_corrections.mjs,
// check_resolvers.mjs, the first part of check_block.mjs (the logic, with no server: it gets http://127.0.0.1:1, where
// nothing can answer, since fetch never connects to port 1, so its part against a running copy says SKIP) and
// dnsleak-server's own tests (node --test, run in dnsleak-server/). Never side by side: dnsleak-server's tests open
// ports, and check_timeouts.mjs and check_relay.mjs time real waits.
//
// The checks against a running copy stay manual, with `npx wrangler dev` running (or against the live site):
// tools/check_previews.sh, tools/check_go.sh, tools/check_seo.sh and the second part of tools/check_block.mjs. See
// "Local development" in docs/handbook.md.
import Module from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = msg => { console.error(`test: ${msg}`); process.exit(1); };
if (typeof Module.registerHooks !== 'function') {
  fail(`Node ${process.versions.node} is too old: the checks need Node 22.15 or later (they load the Worker through module.registerHooks).`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const check = (file, ...args) => ({ name: file, args: [file, ...args] });
const SUITES = [
  ...['bots', 'vpnlists', 'https', 'pages', 'timeouts', 'relay', 'corrections', 'resolvers'].map(c => check(`tools/check_${c}.mjs`)),
  check('tools/check_block.mjs', 'http://127.0.0.1:1'),   // port 1, a "bad port" fetch never connects to: the part with no server only
  // --test-force-exit: a server test whose server failed to start leaves a socket open, and would otherwise hang here
  // until LIMIT (on Windows, TCP can be refused the port UDP was given, reserved or another program's: listen EACCES)
  { name: 'dnsleak-server', args: ['--test', '--test-reporter=tap', '--test-force-exit'], cwd: 'dnsleak-server' },
];
const LIMIT = 5 * 60000;                                 // a check that hangs is stopped after 5 minutes

// A check's own total ("N passed, M failed", its last line) or node --test's (TAP's "# pass N" and "# fail M")
function tally(out) {
  const m = [...out.matchAll(/^(\d+) passed, (\d+) failed$/gm)].pop() || /^# pass (\d+)\n# fail (\d+)$/m.exec(out);
  return m && { pass: Number(m[1]), fail: Number(m[2]) };
}
// What a check that failed printed, less what passed: its headings, FAIL lines and any error (node --test's "not ok"
// tests and their details)
const failures = out => out.replace(/^(?:# Subtest: .*\n)? *ok \d+ - .*\n +---\n[\s\S]*?\n +\.\.\.\n/gm, '')
  .split('\n').filter(l => !l.startsWith('PASS  ') && l.trim()).map(l => '      ' + l).join('\n');
const secs = ms => `${(ms / 1000).toFixed(1)} s`;

const width = Math.max(...SUITES.map(s => s.name.length));
const started = Date.now();
let bad = 0, pass = 0, failed = 0;
for (const s of SUITES) {
  const t = Date.now();
  const r = spawnSync(process.execPath, s.args, { cwd: join(root, s.cwd || '.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: LIMIT, maxBuffer: 64 << 20 });
  const out = (r.stdout || '') + (r.stderr || ''), n = tally(out);
  const why = r.error && r.error.code === 'ETIMEDOUT' ? `stopped after ${LIMIT / 60000} minutes` : r.error ? r.error.message
    : r.signal ? `killed (${r.signal})` : r.status !== 0 ? `exit ${r.status}` : n && !n.pass ? 'nothing checked' : '';
  const good = !why && n && n.fail === 0;
  if (n) { pass += n.pass; failed += n.fail; }
  if (!good) bad++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${s.name.padEnd(width)}  ${n ? `${n.pass} passed, ${n.fail} failed` : 'no total'}` +
    `  (${secs(Date.now() - t)}${why ? ', ' + why : ''})`);
  if (!good) console.log(failures(out));
}
console.log(`${SUITES.length - bad} of ${SUITES.length} suites passed (${pass} checks passed, ${failed} failed) in ${secs(Date.now() - started)}`);
process.exitCode = bad ? 1 : 0;
