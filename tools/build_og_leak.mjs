// Builds the share images for shared leak test results: public/og-leak-a.png, -b, -c, -d and -f
// (1200x630, the terminal's phosphor theme and fonts). /leaktest/r/<code> pages use the one for their grade.
// The images are static: one per grade, with nothing about anyone's result beyond the letter.
//
//   node tools/build_og_leak.mjs
//
// Renders with headless Chrome (or Edge, or Chromium), so there's nothing to install. Set CHROME to the
// browser's path if it isn't found. Commit the PNGs along with any change here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(join(root, 'public', 'leakgrade.js')).href);
const { GRADES } = globalThis.IPTERM_LEAK;

// The phosphor theme's colors (public/app.css :root). The letter takes the status colors: OK for A and B,
// caution for C, LEAK for D and F.
const C = { bg: '#030805', screen: '#06110a', fg: '#86eb9b', hi: '#dcffe3', dim: '#5f9e6c', rule: '#173a20', accent: '#5dff88', warn: '#ffd166', err: '#ff9c5b' };
const LETTER = { A: C.accent, B: C.accent, C: C.warn, D: C.err, F: C.err };
// One short line under the grade. The rubric's own words are longer than an image can hold.
const SHORT = { A: 'no leaks found', B: 'only the time zone leaked', C: 'DNS leaked past the VPN', D: 'WebRTC or IPv6 leaked an address', F: 'several leaks past the VPN' };

const font = f => `data:font/woff2;base64,${readFileSync(join(root, 'public', 'fonts', f)).toString('base64')}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(g) {
  const col = LETTER[g], article = /^[AF]$/.test(g) ? 'an' : 'a';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Plex;font-weight:400;src:url(${font('ibm-plex-mono-latin-400-normal.woff2')}) format("woff2")}
@font-face{font-family:Plex;font-weight:500;src:url(${font('ibm-plex-mono-latin-500-normal.woff2')}) format("woff2")}
@font-face{font-family:VT;src:url(${font('vt323-latin-400-normal.woff2')}) format("woff2")}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden;background:${C.bg}}
body{position:relative;font:400 26px/1.4 Plex,monospace;color:${C.fg}}
.scr{position:absolute;inset:28px;border:1px solid ${C.rule};border-radius:10px;background:${C.screen};box-shadow:inset 0 0 90px rgb(0 0 0 / .6);overflow:hidden}
.scr::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(to bottom,rgb(0 0 0 / .22) 0 1px,transparent 1px 3px);pointer-events:none}
.bar{position:absolute;left:44px;right:44px;top:26px;display:flex;justify-content:space-between;align-items:baseline}
.logo{font:400 64px/1 VT,monospace;color:${C.hi};text-shadow:0 0 14px rgb(93 255 136 / .45)}
.logo b{font-weight:400;color:${C.accent}}
.tag{border:1.5px solid currentColor;border-radius:4px;padding:2px 12px;font-size:19px;letter-spacing:.1em;text-transform:uppercase;color:${C.dim}}
.grade{position:absolute;left:44px;top:120px;width:340px;height:370px;border:2px solid ${col};border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center}
.grade .k{font-size:22px;letter-spacing:.24em;color:${C.dim};margin-bottom:-18px}
.grade .g{font:400 330px/.9 VT,monospace;color:${col};text-shadow:0 0 22px ${col}88,0 0 4px ${col}}
.txt{position:absolute;left:430px;right:44px;top:132px}
.ps1{color:${C.accent}}
.cmd{color:${C.hi}}
.big{margin-top:30px;font:500 46px/1.2 Plex,monospace;color:${C.hi};text-shadow:0 0 10px rgb(93 255 136 / .3)}
.sub{margin-top:6px;font-size:28px;color:${C.fg}}
.why{margin-top:22px;font-size:25px;color:${col}}
.checks{margin-top:26px;display:flex;gap:12px;flex-wrap:wrap}
.foot{position:absolute;left:430px;right:44px;bottom:50px;font-size:24px;color:${C.dim}}
.foot b{font-weight:400;color:${C.accent}}
.cur{display:inline-block;width:14px;height:28px;background:${C.accent};vertical-align:-5px;margin-left:6px}
</style></head><body><div class="scr">
<div class="bar"><div class="logo">ip<b>term</b></div><span class="tag">vpn &amp; dns leak test</span></div>
<div class="grade"><div class="k">LEAKS</div><div class="g">${g}</div></div>
<div class="txt">
<div><span class="ps1">guest@ipterm:~$</span> <span class="cmd">leaktest</span></div>
<div class="big">this browser got ${article} ${g}</div>
<div class="sub">on ipterm's leak test</div>
<div class="why">${esc(SHORT[g])}</div>
<div class="checks"><span class="tag">dns</span><span class="tag">webrtc</span><span class="tag">ipv6</span><span class="tag">time zone</span></div>
</div>
<div class="foot"><b>run yours</b> · no IP or location in this link<span class="cur"></span></div>
</div></body></html>`;
}

function findChrome() {
  const env = process.env.CHROME;
  if (env) return env;
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const paths = {
    win32: pf.flatMap(p => [join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  }[process.platform] || [];
  const found = paths.find(existsSync);
  if (found) return found;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) { console.error('No Chrome, Edge or Chromium found. Set CHROME to its path and run this again.'); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), 'ipterm-og-'));
try {
  for (const [g] of GRADES) {
    const html = join(tmp, `leak-${g}.html`), png = join(root, 'public', `og-leak-${g.toLowerCase()}.png`);
    writeFileSync(html, page(g));
    // A throwaway profile, so an open Chrome window is left alone; virtual time lets the fonts load first.
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run',
      `--user-data-dir=${join(tmp, 'profile')}`, '--window-size=1200,630', '--virtual-time-budget=4000', `--screenshot=${png}`, pathToFileURL(html).href],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
    const head = existsSync(png) ? readFileSync(png).subarray(16, 24) : null;
    const size = head ? [head.readUInt32BE(0), head.readUInt32BE(4)] : null;
    if (r.status !== 0 || !size || size[0] !== 1200 || size[1] !== 630) {
      console.error(`og-leak-${g.toLowerCase()}.png failed (exit ${r.status}${size ? `, ${size.join('x')}` : ''}): ${String(r.stderr || '').slice(0, 400)}`);
      process.exit(1);
    }
    console.log(`public/og-leak-${g.toLowerCase()}.png  ${size.join('x')}  ${Math.round(readFileSync(png).length / 1024)} KB`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
