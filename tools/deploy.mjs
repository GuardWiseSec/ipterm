// `npm run deploy`: deploys the Worker with the git short SHA as the version's tag, so the site can say
// which code is running (the footer, `about` and /help read it back through the CF_VERSION_METADATA
// binding in wrangler.toml). Plain Node with no shell in between, so it works the same from PowerShell,
// cmd or sh.
//
//   npm run deploy                  deploy the committed code, tagged with its short SHA
//   npm run deploy -- --dry-run     anything after -- goes to `wrangler deploy` as it is
//   npm run deploy -- --dirty       deploy uncommitted changes anyway; the tag becomes <sha>-dirty
//
// "The code we deploy" should mean exactly that, so by default it refuses to deploy while anything the
// Worker is built from (src/, public/, wrangler.toml, package.json) differs from the commit.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const fail = msg => { console.error(`deploy: ${msg}`); process.exit(1); };
const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) fail(`git ${args.join(' ')} failed: ${(r.stderr || (r.error && r.error.message) || '').trim()}`);
  return r.stdout.trimEnd();
};

const args = process.argv.slice(2);
const allowDirty = args.includes('--dirty');
const pass = args.filter(a => a !== '--dirty');
if (pass.some(a => a === '--tag' || a.startsWith('--tag='))) fail('the tag is set here (the git short SHA), so leave out --tag.');

const sha = git('rev-parse', '--short=7', 'HEAD');
const changed = git('status', '--porcelain', '--untracked-files=all', '--', 'src', 'public', 'wrangler.toml', 'package.json', 'package-lock.json');
if (changed && !allowDirty) {
  fail(`these differ from commit ${sha}, so the deployed code wouldn't match it:\n${changed}\n` +
    'Commit them first, or run `npm run deploy -- --dirty` to deploy anyway (tagged ' + sha + '-dirty).');
}
const tag = changed ? `${sha}-dirty` : sha;
const remotes = git('branch', '-r', '--contains', 'HEAD');
if (!remotes) console.warn(`deploy: warning: ${sha} isn't on any remote branch yet, so the footer's link to it won't open until you push.`);

const message = git('log', '-1', '--format=%s').slice(0, 100);
const req = createRequire(import.meta.url);
const bin = join(dirname(req.resolve('wrangler/package.json')), req('wrangler/package.json').bin.wrangler);
console.log(`deploy: ${tag}${changed ? ' (with uncommitted changes)' : ''}: ${message}`);
const r = spawnSync(process.execPath, [bin, 'deploy', '--tag', tag, ...(pass.some(a => a === '--message' || a.startsWith('--message=')) ? [] : ['--message', message]), ...pass], { stdio: 'inherit' });
process.exit(r.status ?? 1);
