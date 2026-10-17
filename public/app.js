(() => {
  const $ = s => document.querySelector(s);
  const out = $('#out'), screen = $('#screen'), form = $('#line'), input = $('#cmd'), modeEl = $('#mode');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // fast: the server already sent this result (your IP on the homepage), so draw it at once, in the
  // same frame that removes the server's copy, instead of typing it out.
  // hold: during that swap, keep the screen where the server's copy had it instead of following the output.
  let fast = false, hold = false;
  const sleep = ms => (fast ? Promise.resolve() : new Promise(r => setTimeout(r, reduced ? 0 : ms)));
  let live = false, busy = false;

  /* ---------- command history ----------
     The commands you run (typed or clicked, never their results) are kept in this browser's local storage
     under ipterm-history, the newest 200, so Up, Down, history, Tab and Ctrl+R still know them after a
     reload. A page's own first command (the homepage's whoami, a shared link's lookup) isn't saved, since
     nobody typed it. `history clear` forgets them; `history off` stops saving (remembered as
     ipterm-history-off) until `history on`. Up and Down keep working for this tab either way. */
  const HIST_KEY = 'ipterm-history', HIST_OFF = 'ipterm-history-off', HIST_MAX = 200;
  const stored = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const store = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };
  const histOff = () => stored(HIST_OFF) === '1';
  function savedHistory() {
    if (histOff()) return [];
    try {
      const a = JSON.parse(stored(HIST_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim() && x.length <= 500).slice(-HIST_MAX) : [];
    } catch { return []; }
  }
  // Read again before each write, so two open tabs add to one list instead of overwriting each other's.
  function remember(cmd) {
    if (histOff() || cmd.length > 500) return;
    const a = savedHistory();
    if (a[a.length - 1] !== cmd) a.push(cmd);
    store(HIST_KEY, JSON.stringify(a.slice(-HIST_MAX)));
  }
  const hist = savedHistory(); let hIdx = hist.length;
  const addHist = cmd => { if (hist[hist.length - 1] !== cmd) hist.push(cmd); hIdx = hist.length; };

  /* ---------- output helpers ---------- */
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const scroll = () => { if (!hold) screen.scrollTop = screen.scrollHeight; };
  // On small screens a whole result doesn't fit; bring a key line (your IP) into view instead of the prompt.
  const reveal = node => {
    if (!node) return;
    const s = screen.getBoundingClientRect(), r = node.getBoundingClientRect();
    if (r.top < s.top || r.bottom > s.bottom) screen.scrollTop += r.top - s.top - 16;
  };
  const line = (text, cls = '') => {
    const d = el('div', 'ln ' + cls, text); out.appendChild(d); scroll();
    if (/\b(err|warn)\b/.test(cls)) announce(text);   // problems are always spoken
    return d;
  };
  // Screen readers hear one summary per result (and every problem), not each line as it types out.
  const srStatus = document.getElementById('sr-status');
  function announce(text) {
    if (!srStatus || !text) return;
    srStatus.textContent = '';
    setTimeout(() => { srStatus.textContent = text; }, 60);
  }
  async function lines(arr, cls = '') { for (const t of arr) { line(t, cls); await sleep(24); } }
  function echo(cmd) { const d = el('div', 'ln echo'); d.append(el('span', 'ps1', 'guest@ipterm:~$ '), document.createTextNode(cmd)); out.appendChild(d); scroll(); }
  async function kv(rows) {
    const dl = el('dl', 'kv'); out.appendChild(dl);
    for (const r of rows) {
      if (r === 'sep') { dl.appendChild(el('div', 'sep')); continue; }
      const [k, v, kind] = r;
      const dt = el('dt', kind === 'big' ? 'bigl' : kind === 'plain' ? 'plainl' : ''), dd = el('dd', kind === 'big' ? 'big' : kind === 'plain' ? 'plain' : '');
      if (k instanceof Node) dt.appendChild(k); else dt.textContent = k;
      if (v instanceof Node) dd.appendChild(v); else dd.textContent = v;
      dl.append(dt, dd); scroll(); await sleep(16);
    }
  }

  /* ---------- dot-matrix map ----------
     Land comes from window.IPTERM_GEO (land.js): delta-encoded rings in 1/20 degree units,
     plus per-country [lat, lon, radius km] for country-level results. Each map rasterizes the
     land into a tiny mask canvas (one pixel per dot), then draws one dot per cell. */
  const GEO = window.IPTERM_GEO || null;
  const ASPECT = 2.2, CITY_KM = 50, ZOOM_MS = 1400, PULSE_MS = 20000;
  // Some rings cross the antimeridian by jumping from 180 to -180 (Eurasia at 65°N and 69°N, Wrangel
  // Island at 71°N). Filled as they are, the jumps flip even-odd parity across the whole band, so each
  // ring is unwrapped into one continuous outline that may run past ±180 (paint() draws the path at
  // -360, 0 and +360), then moved by 360 if its middle ended up outside ±180. A ring that goes all the
  // way around (Antarctica) is closed along its pole. LAND_X is the path's longitude extent.
  let LAND_PATH = null, LAND_X = null;
  function landPath() {
    if (LAND_PATH || !GEO) return LAND_PATH;
    LAND_PATH = new Path2D(); LAND_X = [Infinity, -Infinity];
    for (const f of GEO.land) {
      const pts = [];
      let x = 0, y = 0, shift = 0, lo = Infinity, hi = -Infinity;
      for (let i = 0; i < f.length; i += 2) {
        if (i && Math.abs(f[i]) > 3600) shift -= Math.sign(f[i]) * 360;
        x += f[i]; y += f[i + 1];
        const px = x / 20 + shift;
        pts.push([px, y / 20]); lo = Math.min(lo, px); hi = Math.max(hi, px);
      }
      if (Math.abs(f[0] - x) > 3600) shift -= Math.sign(f[0] - x) * 360;   // the closing edge
      if (shift) { const pole = y < 0 ? -90 : 90; pts.push([pts[pts.length - 1][0], pole], [f[0] / 20, pole]); }
      const k = lo + hi > 360 ? -360 : lo + hi < -360 ? 360 : 0;
      pts.forEach(([px, py], i) => { if (i) LAND_PATH.lineTo(px + k, py); else LAND_PATH.moveTo(px + k, py); });
      LAND_PATH.closePath();
      LAND_X[0] = Math.min(LAND_X[0], lo + k); LAND_X[1] = Math.max(LAND_X[1], hi + k);
    }
    return LAND_PATH;
  }
  let BORDER_PATH = null;
  function borderPath() {
    if (BORDER_PATH || !GEO || !GEO.borders) return BORDER_PATH;
    BORDER_PATH = new Path2D();
    for (const f of GEO.borders) {
      let x = 0, y = 0;
      for (let i = 0; i < f.length; i += 2) {
        x += f[i]; y += f[i + 1];
        if (i) BORDER_PATH.lineTo(x / 20, y / 20); else BORDER_PATH.moveTo(x / 20, y / 20);
      }
    }
    return BORDER_PATH;
  }
  const mask = document.createElement('canvas');
  const mctx = mask.getContext('2d', { willReadFrequently: true });
  const bmask = document.createElement('canvas');
  const bctx = bmask.getContext('2d', { willReadFrequently: true });
  const BORDER_SPAN = 110;   // borders appear once the view is narrower than this many degrees of latitude
  const maps = new Set(); let newest = null, rafId = 0;
  const token = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  function locate(d) {
    if (!d) return null;
    if (d.lat != null && d.lon != null) return { lat: d.lat, lon: d.lon, km: CITY_KM, level: 'city' };
    const c = GEO && d.countryCode && GEO.countries[String(d.countryCode).toUpperCase()];
    return c ? { lat: c[0], lon: c[1], km: c[2], level: 'country' } : null;
  }
  const worldView = () => ({ lat: 12, lon: 0, span: 360 / ASPECT, k: 1 });
  function regionView(loc) {
    // City results zoom in until the approximate area spans several dots; countries keep more context.
    const span = loc.level === 'city' ? Math.max(5, (loc.km / 111.32) * 12) : Math.max(14, (loc.km / 111.32) * 2 * 2.4);
    return { lat: loc.lat, lon: loc.lon, span, k: Math.max(0.25, Math.cos(loc.lat * Math.PI / 180)) };
  }
  function viewAt(m, now) {
    const target = m.mode === 'world' ? worldView() : m.region;
    if (!m.anim) return target;
    const t = Math.max(0, Math.min(1, (now - m.anim.t0) / ZOOM_MS));
    if (t >= 1) {                                       // landed: the label locks on, once per result
      m.anim = null;
      if (m.labelT0 == null) m.labelT0 = now;
      return target;
    }
    const a = m.anim.from, e = ease(t);
    return { lat: a.lat + (target.lat - a.lat) * e, lon: a.lon + (target.lon - a.lon) * e,
      span: a.span * Math.pow(target.span / a.span, e), k: a.k + (target.k - a.k) * e };
  }
  function ringGeom(m) {
    const { w, h, lon0, lonSpan, latTop, span } = m.geom, L = m.loc;
    let lon = L.lon; const c = lon0 + lonSpan / 2;
    while (lon - c > 180) lon -= 360; while (c - lon > 180) lon += 360;
    const ry = L.km / 111.32 / span * h;
    const rx = L.km / (111.32 * Math.max(0.2, Math.cos(L.lat * Math.PI / 180))) / lonSpan * w;
    return { x: (lon - lon0) / lonSpan * w, y: (latTop - L.lat) / span * h, rx, ry };
  }

  function paint(m, now, col) {
    const cv = m.cv, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(w * dpr), H = Math.round(h * dpr);
    for (const c of [cv, m.layer]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }

    const v = m.view = viewAt(m, now);
    const cols = Math.round(w / (w < 520 ? 5 : 6)), rows = Math.max(4, Math.round(h / (w < 520 ? 5 : 6)));
    const lonSpan = v.span * (w / h) / v.k, lon0 = v.lon - lonSpan / 2;
    let latTop = Math.min(86, v.lat + v.span / 2);
    if (latTop - v.span < -86) latTop = Math.min(86, v.span - 86);
    m.geom = { w, h, lon0, lonSpan, latTop, span: v.span };

    mask.width = cols; mask.height = rows;
    mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, cols, rows);
    const sx = cols / lonSpan, sy = rows / v.span, path = landPath();
    for (const off of [-360, 0, 360]) {
      if (lon0 + lonSpan < off + LAND_X[0] || lon0 > off + LAND_X[1]) continue;
      mctx.setTransform(sx, 0, 0, -sy, (off - lon0) * sx, latTop * sy);
      mctx.fill(path, 'evenodd');
    }
    const a = mctx.getImageData(0, 0, cols, rows).data;

    // Country borders become dark seams: land dots on a border shrink. They fade in as the
    // view zooms past BORDER_SPAN, since at world scale they would only add noise.
    const bf = Math.max(0, Math.min(1, (BORDER_SPAN - v.span) / 40));
    let b = null;
    if (bf > 0 && borderPath()) {
      bmask.width = cols; bmask.height = rows;
      bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, cols, rows);
      bctx.lineWidth = 0.9 / Math.sqrt(sx * sy); bctx.lineJoin = 'round';
      for (const off of [-360, 0, 360]) {
        if (lon0 + lonSpan < off - 180 || lon0 > off + 180) continue;
        bctx.setTransform(sx, 0, 0, -sy, (off - lon0) * sx, latTop * sy);
        bctx.stroke(borderPath());
      }
      b = bctx.getImageData(0, 0, cols, rows).data;
    }

    // Dots inside the approximate area light up, brightest at the reported point and fading
    // toward the edge. The area never shrinks below the nearest dot, so a small city radius
    // still lights at least one dot when zoomed out.
    const cw = w / cols, ch = h / rows, cell = Math.min(cw, ch), rL = cell * 0.3, rO = cell * 0.11;
    const r = ringGeom(m), ex = Math.max(r.rx, cell * .75), ey = Math.max(r.ry, cell * .75);
    const ocean = new Path2D(), land = new Path2D(), seam = new Path2D(), lit = [], rS = rL * (1 - .5 * bf);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const idx = (j * cols + i) * 4 + 3;
      const x = (i + .5) * cw, y = (j + .5) * ch, isLand = a[idx] > 77, onBorder = isLand && b && b[idx] > 90;
      const dn = Math.hypot((x - r.x) / ex, (y - r.y) / ey);
      if (dn <= 1) {
        const k = Math.pow(1 - dn, 0.6);
        const rr = (isLand ? rL : rO + (rL - rO) * k) * (1 + .25 * k) * (onBorder ? 1 - .5 * bf : 1);
        lit.push({ x, y, dn, land: isLand, k, r: rr });
      } else {
        const p = onBorder ? seam : isLand ? land : ocean, rr = onBorder ? rS : isLand ? rL : rO;
        p.moveTo(x + rr, y); p.arc(x, y, rr, 0, 7);
      }
    }
    m.lit = lit;
    const g = m.layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    g.fillStyle = col.rule; g.fill(ocean);
    g.fillStyle = col.dim; g.fill(land);
    g.fillStyle = bf > .5 ? col.rule : col.dim; g.fill(seam);
    // Lit dots: a dim base, then the bright color layered on in six intensity steps.
    const steps = Array.from({ length: 6 }, () => new Path2D()), base = new Path2D();
    for (const d of lit) {
      base.moveTo(d.x + d.r, d.y); base.arc(d.x, d.y, d.r, 0, 7);
      const s = steps[Math.min(5, Math.floor(d.k * (d.land ? 1 : .7) * 6))];
      s.moveTo(d.x + d.r, d.y); s.arc(d.x, d.y, d.r, 0, 7);
    }
    g.fillStyle = col.dim; g.fill(base);
    g.fillStyle = col.lit;
    steps.forEach((s, n) => { g.globalAlpha = (n + 1) / 6; g.fill(s); });
    g.globalAlpha = 1;
    return true;
  }

  function compose(m, now, col) {
    const ctx = m.cv.getContext('2d'), { w, h } = m.geom, dpr = m.cv.width / w, r = ringGeom(m);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, m.cv.width, m.cv.height);
    ctx.drawImage(m.layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1; ctx.strokeStyle = col.rule; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(0, r.y); ctx.lineTo(w, r.y); ctx.moveTo(r.x, 0); ctx.lineTo(r.x, h); ctx.stroke();
    ctx.setLineDash([]);
    // Pulse: a band of brightness that ripples outward through the lit dots.
    if (m === newest && !reduced && !m.anim && now < m.pulseUntil && m.lit) {
      const p = (now % 2400) / 2400, c = p * 1.3, fade = 1 - p * .5;
      ctx.fillStyle = col.accent;
      for (const d of m.lit) {
        const b = 1 - Math.abs(d.dn - c) / .22;
        if (b <= 0) continue;
        ctx.globalAlpha = b * .85 * fade;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 1.15, 0, 7); ctx.fill();
      }
    }
    // Marker: a small point with a dark halo so it stays distinct from the lit dots.
    ctx.globalAlpha = 1;
    ctx.fillStyle = col.screen; ctx.beginPath(); ctx.arc(r.x, r.y, 4, 0, 7); ctx.fill();
    ctx.fillStyle = col.accent; ctx.shadowColor = col.accent; ctx.shadowBlur = col.glow;
    ctx.beginPath(); ctx.arc(r.x, r.y, 2.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0;

    drawLabel(ctx, m, r, now, col, w, h);
  }

  /* Label "lock-on": once the map lands, a leader line draws out from the marker, the tag box
     flickers open, and the place name decrypts left to right out of scrambled glyphs behind a
     block cursor, which blinks a few times and goes away. Reduced motion shows it static. */
  const GLYPHS = '!<>-_/\\[]{}=+*^?#$%&01ABCDEF';
  const LBL = { lead: 180, open: 150, openDur: 260, text: 330, textDur: 620, blink: 1300 };
  const LABEL_TOTAL = LBL.text + LBL.textDur + 150 + LBL.blink;
  const noise = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
  const clamp01 = x => Math.max(0, Math.min(1, x));

  function drawLabel(ctx, m, r, now, col, w, h) {
    if (!m.label || m.labelT0 == null) return;          // hidden while the map is zooming
    const t = reduced ? 1e9 : now - m.labelT0;
    if (t < 0) return;
    ctx.save();
    ctx.font = `500 10px ${col.font}`;
    try { ctx.letterSpacing = '1px'; } catch {}
    const chars = [...m.label], n = chars.length;
    const pad = 5, bh = 16, tw = ctx.measureText(m.label).width, bw = tw + pad * 2, cw = tw / n;
    let lx = r.x + 12, ly = r.y - 12 - bh;
    if (lx + bw > w - 4) lx = r.x - 12 - bw;
    if (ly < 4) ly = r.y + 12;
    lx = Math.max(4, Math.min(w - bw - 4, lx)); ly = Math.max(4, Math.min(h - bh - 4, ly));

    // Leader line from the marker to the nearest corner of the tag.
    const right = lx >= r.x, cx = right ? lx : lx + bw, cy = ly >= r.y ? ly : ly + bh;
    const dx = cx - r.x, dy = cy - r.y, len = Math.hypot(dx, dy) || 1;
    const sx = r.x + dx / len * 5, sy = r.y + dy / len * 5, pl = clamp01(t / LBL.lead);
    ctx.strokeStyle = col.dim; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + (cx - sx) * pl, sy + (cy - sy) * pl); ctx.stroke();

    // Box opens away from the marker, flickering like a CRT warming up.
    const po = ease(clamp01((t - LBL.open) / LBL.openDur));
    if (po <= 0) { ctx.restore(); return; }
    const curW = Math.max(1, bw * po), ox = right ? lx : lx + bw - curW;
    const pf = clamp01((t - LBL.open) / LBL.openDur);   // fade in with a single soft dip: no rapid flashing
    const flicker = pf < 1 ? Math.min(1, .4 + .6 * pf) * (1 - .3 * Math.sin(Math.PI * pf) ** 2) : 1;
    ctx.globalAlpha = .9 * flicker; ctx.fillStyle = col.screen; ctx.fillRect(ox, ly, curW, bh);
    ctx.globalAlpha = flicker; ctx.strokeStyle = col.dim; ctx.strokeRect(ox + .5, ly + .5, curW - 1, bh - 1);
    ctx.beginPath(); ctx.rect(ox, ly, curW, bh); ctx.clip();

    // Text decrypts left to right; each character cycles glyphs until its lock time.
    ctx.textBaseline = 'middle';
    let locked = 0;
    for (let i = 0; i < n; i++) {
      const ch = chars[i], x = lx + pad + i * cw, lockAt = LBL.text + (i / n) * LBL.textDur + noise(i, 1) * 80;
      if (t >= lockAt || ch === ' ') {
        if (locked === i) locked = i + 1;
        ctx.globalAlpha = 1; ctx.fillStyle = col.hi; ctx.fillText(ch, x, ly + bh / 2 + .5);
      } else if (t >= LBL.text - 120) {
        ctx.globalAlpha = .75; ctx.fillStyle = col.accent;
        ctx.fillText(GLYPHS[Math.floor(noise(i, Math.floor(t / 70)) * GLYPHS.length)], x, ly + bh / 2 + .5);
      }
    }
    // Block cursor: rides the lock position, then blinks at the end and disappears.
    const done = LBL.text + LBL.textDur + 150;
    const showCursor = t < done ? t >= LBL.text - 120 : t < done + LBL.blink && Math.floor((t - done) / 220) % 2 === 0;
    if (showCursor) {
      ctx.globalAlpha = 1; ctx.fillStyle = col.accent;
      ctx.fillRect(lx + pad + Math.min(locked, n) * cw, ly + 3, Math.max(2, cw - 1.5), bh - 6);
    }
    ctx.restore();
  }

  function mapTick(now) {
    rafId = 0; let again = false;
    const col = { rule: token('--rule'), dim: token('--dim'), hi: token('--hi'), lit: token('--lit') || token('--hi'), accent: token('--accent'), screen: token('--screen'),
      font: token('--f-mono') || 'monospace', glow: parseFloat(token('--canvas-glow')) || 0 };
    for (const m of maps) {
      if (!m.cv.isConnected) { m.ro.disconnect(); maps.delete(m); if (newest === m) newest = null; continue; }
      const pulsing = m === newest && !reduced && now < m.pulseUntil;
      const labelling = m.labelT0 != null && !reduced && now - m.labelT0 < LABEL_TOTAL;
      if (m.dirty || m.anim) { if (!paint(m, now, col)) continue; m.dirty = false; compose(m, now, col); }
      else if (pulsing || labelling) compose(m, now, col);
      if (m.anim || pulsing || labelling || (m.labelT0 != null && now < m.labelT0)) again = true;
    }
    if (again && !document.hidden) rafId = requestAnimationFrame(mapTick);
  }
  const kick = () => { if (!rafId) rafId = requestAnimationFrame(mapTick); };
  const redrawMaps = () => { maps.forEach(m => { m.dirty = true; }); kick(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

  function geoBlock(d) {
    const loc = locate(d);
    if (!loc || !landPath()) return null;
    const where = loc.level === 'city' ? [d.city, d.region, d.country || d.countryCode].filter(Boolean).join(', ') : (d.country || d.countryCode);
    const fig = el('figure', 'geo'), cv = el('canvas'), cap = el('figcaption', 'geo-cap');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', `Dot map marking the approximate location: ${where || 'unknown place'}`);
    const km = loc.km >= 1000 ? loc.km.toLocaleString('en-US') : loc.km;
    const note = el('span', '', loc.level === 'city' ? `approximate area · ±${km} km` : `country-level only · ${where} · ±${km} km`);
    const btn = el('button', 'geo-btn'); btn.type = 'button';
    cap.append(note, btn); fig.append(cv, cap);

    const now = performance.now();
    const m = { cv, loc, layer: document.createElement('canvas'), region: regionView(loc), mode: 'region',
      anim: null, dirty: true, view: null, geom: null, pulseUntil: now + PULSE_MS };
    const tag = (loc.level === 'city' ? [d.city, d.region || d.country || d.countryCode] : [d.country || d.countryCode])
      .filter(Boolean).join(', ').toUpperCase();
    m.label = tag.length > 30 ? tag.slice(0, 29) + '…' : tag;
    m.labelT0 = now + 250;
    if (m.region.span >= worldView().span * 0.85) { m.mode = 'world'; btn.hidden = true; }
    else if (!reduced) { m.anim = { t0: now + 300, from: worldView() }; m.labelT0 = null; }
    const label = () => { btn.textContent = m.mode === 'world' ? '[ zoom in ]' : '[ world view ]'; };
    const toggle = () => {
      if (btn.hidden) return;
      m.anim = reduced ? null : { t0: performance.now(), from: m.view || worldView() };
      m.mode = m.mode === 'world' ? 'region' : 'world';
      m.dirty = true; m.pulseUntil = performance.now() + PULSE_MS; label(); kick();
    };
    label();
    btn.addEventListener('click', toggle);
    cv.addEventListener('click', toggle);
    m.ro = new ResizeObserver(() => { m.dirty = true; kick(); });
    m.ro.observe(cv);
    newest = m; maps.add(m);
    return fig;
  }

  /* ---------- IP parsing ---------- */
  const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  function v6groups(s) {
    if (!/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
    const dbl = s.includes('::');
    const [h, t] = dbl ? s.split('::') : [s, ''];
    const hp = h ? h.split(':') : [], tp = dbl && t ? t.split(':') : [];
    const fill = 8 - hp.length - tp.length;
    if (dbl ? fill < 1 : hp.length !== 8) return null;
    const g = [...hp, ...Array(dbl ? fill : 0).fill('0'), ...tp];
    if (g.length !== 8 || g.some(x => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
    return g.map(x => parseInt(x, 16));
  }
  function parseIp(s) {
    s = (s || '').trim();
    if (V4.test(s)) return { v: 4, o: s.split('.').map(Number) };
    const g = v6groups(s); return g ? { v: 6, g } : null;
  }
  function classify(p) {
    if (p.v === 4) {
      const [a, b, c] = p.o;
      if (a === 0) return ['reserved', '"this network" block, 0.0.0.0/8'];
      if (a === 10) return ['private', 'RFC 1918 private range, 10.0.0.0/8'];
      if (a === 100 && b >= 64 && b <= 127) return ['cgnat', 'carrier-grade NAT, RFC 6598 (100.64.0.0/10)'];
      if (a === 127) return ['loopback', 'loopback, 127.0.0.0/8. This is your own machine.'];
      if (a === 169 && b === 254) return ['link-local', 'link-local, 169.254.0.0/16. Usually means DHCP failed.'];
      if (a === 172 && b >= 16 && b <= 31) return ['private', 'RFC 1918 private range, 172.16.0.0/12'];
      if (a === 192 && b === 0 && c === 2) return ['docs', 'TEST-NET-1 documentation range, RFC 5737'];
      if (a === 192 && b === 168) return ['private', 'RFC 1918 private range, 192.168.0.0/16. Typical home router.'];
      if (a === 198 && (b === 18 || b === 19)) return ['benchmark', 'benchmarking range, RFC 2544 (198.18.0.0/15)'];
      if (a === 198 && b === 51 && c === 100) return ['docs', 'TEST-NET-2 documentation range, RFC 5737'];
      if (a === 203 && b === 0 && c === 113) return ['docs', 'TEST-NET-3 documentation range, RFC 5737'];
      if (a >= 224 && a <= 239) return ['multicast', 'multicast, 224.0.0.0/4'];
      if (a >= 240) return ['reserved', p.o.every(x => x === 255) ? 'limited broadcast address' : 'reserved, 240.0.0.0/4'];
      return ['public', null];
    }
    const g = p.g;
    if (g.every(x => x === 0)) return ['unspecified', 'unspecified address, ::'];
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return ['loopback', 'loopback, ::1'];
    if ((g[0] & 0xffc0) === 0xfe80) return ['link-local', 'link-local, fe80::/10'];
    if ((g[0] & 0xfe00) === 0xfc00) return ['ula', 'unique local address, fc00::/7 (IPv6 private range)'];
    if ((g[0] & 0xff00) === 0xff00) return ['multicast', 'multicast, ff00::/8'];
    if (g[0] === 0x2001 && g[1] === 0x0db8) return ['docs', 'documentation range, RFC 3849 (2001:db8::/32)'];
    return ['public', null];
  }
  function computed(p) {
    if (p.v === 4) {
      const n = p.o[0] * 16777216 + p.o[1] * 65536 + p.o[2] * 256 + p.o[3];
      return [
        ['decimal', String(n)],
        ['hex', '0x' + n.toString(16).padStart(8, '0')],
        ['binary', p.o.map(x => x.toString(2).padStart(8, '0')).join('.')],
        ['rdns zone', [...p.o].reverse().join('.') + '.in-addr.arpa'],
      ];
    }
    const full = p.g.map(x => x.toString(16).padStart(4, '0'));
    return [
      ['expanded', full.join(':')],
      ['/64 prefix', full.slice(0, 4).join(':') + '::/64'],
      ['rdns zone', full.join('').split('').reverse().join('.') + '.ip6.arpa'],
    ];
  }

  /* ---------- data ---------- */
  const DEMO = {
    self: { ip: '203.0.113.42', hostname: 'pool-203-0-113-42.example.net', asn: 'AS64500', org: 'Example Broadband (sample)',
      city: 'Portland', region: 'Oregon', countryCode: 'US', country: 'United States', lat: 45.5152, lon: -122.6784,
      timezone: 'America/Los_Angeles', colo: 'PDX', source: 'demo' },
    '8.8.8.8': { hostname: 'dns.google', asn: 'AS15169', org: 'Google LLC', city: 'Mountain View', region: 'California',
      countryCode: 'US', country: 'United States', lat: 37.4056, lon: -122.0775, timezone: 'America/Los_Angeles',
      note: 'anycast: you reach the nearest Google site, wherever it is' },
    '8.8.4.4': { hostname: 'dns.google', asn: 'AS15169', org: 'Google LLC', countryCode: 'US', country: 'United States', note: 'anycast DNS resolver' },
    '1.1.1.1': { hostname: 'one.one.one.one', asn: 'AS13335', org: 'Cloudflare, Inc.', note: "anycast: announced from Cloudflare's data centers worldwide" },
    '1.0.0.1': { hostname: 'one.one.one.one', asn: 'AS13335', org: 'Cloudflare, Inc.', note: 'anycast DNS resolver' },
    '9.9.9.9': { hostname: 'dns9.quad9.net', asn: 'AS19281', org: 'Quad9', city: 'Berkeley', region: 'California',
      countryCode: 'US', country: 'United States', lat: 37.8716, lon: -122.2727, timezone: 'America/Los_Angeles', note: 'anycast DNS resolver' },
    '2001:4860:4860::8888': { hostname: 'dns.google', asn: 'AS15169', org: 'Google LLC', countryCode: 'US', country: 'United States', note: 'anycast DNS resolver' },
  };
  // Sample networks for the preview: a handful of real prefixes, no totals.
  const DEMO_ASN = {
    AS15169: { asn: 'AS15169', number: 15169, found: true, sample: true, holder: 'GOOGLE - Google LLC', handle: 'GOOGLE', name: 'Google LLC',
      registry: 'ARIN', announced: true, v4: { prefixes: ['142.250.0.0/15', '172.217.0.0/16', '8.8.4.0/24', '8.8.8.0/24'] }, v6: { prefixes: ['2001:4860::/32'] } },
    AS13335: { asn: 'AS13335', number: 13335, found: true, sample: true, holder: 'CLOUDFLARENET - Cloudflare, Inc.', handle: 'CLOUDFLARENET', name: 'Cloudflare, Inc.',
      registry: 'ARIN', announced: true, v4: { prefixes: ['104.16.0.0/13', '172.64.0.0/13', '1.0.0.0/24', '1.1.1.0/24'] }, v6: { prefixes: ['2606:4700::/32'] } },
  };
  const SRC = { edge: 'cloudflare edge', 'ipinfo-lite': 'ipinfo lite', 'ipinfo-core': 'ipinfo core', ipinfo: 'ipinfo', demo: 'sample data' };
  const fmt = n => Number(n).toLocaleString('en-US');

  async function getJson(path, extra) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch(path, { signal: ctrl.signal, headers: { accept: 'application/json', ...extra } });
      if (!(r.headers.get('content-type') || '').includes('json')) return { error: 'no-api' };
      const d = await r.json();
      if (r.ok || (d && d.found === false)) return d;
      return { error: (d && d.error) || 'HTTP ' + r.status };
    } catch { return { error: 'network error. Check your connection and try again.' }; }
    finally { clearTimeout(t); }
  }
  // Addresses this page has seen as yours: the one you connect from (whoami, leaktest, port), your other IP version
  // (otherFamily) and the public ones WebRTC reveals. The Worker only knows the one each request comes from, so a
  // lookup of any of them asks for no registry date (block=0), and so do their links and address bar (ipPath), so a
  // new tab or a reload does too.
  const ownIps = new Set();
  const own = ip => { const c = canonIp(ip); if (c) ownIps.add(c); return ip; };
  const api = ip => getJson('/api/lookup' + (ip ? '?ip=' + encodeURIComponent(ip) + (ownIps.has(canonIp(ip)) ? '&block=0' : '') : ''));
  const ipPath = ip => '/' + ip + (ownIps.has(canonIp(ip)) ? '?block=0' : '');
  const apiDns = (name, type) => getJson('/api/dns?name=' + encodeURIComponent(name) + (type ? '&type=' + encodeURIComponent(type) : ''));
  const apiWhois = q => getJson('/api/whois?q=' + encodeURIComponent(q));
  const apiMail = (name, sel) => getJson('/api/mail?domain=' + encodeURIComponent(name) + (sel ? '&dkim=' + encodeURIComponent(sel) : ''));
  const apiGrade = name => getJson('/api/grade?domain=' + encodeURIComponent(name));
  const apiAsn = n => getJson('/api/asn?asn=' + n);
  const apiRoute = q => getJson('/api/route?q=' + encodeURIComponent(q));

  /* ---------- links and URLs ----------
     Every result has its own address (/8.8.8.8, /AS13335). When live, lookups update the
     address bar so it can be shared, and back/forward replay the matching command. */
  const TITLE_HOME = document.title;
  let navPush = true;
  function setUrl(path, title) {
    document.title = title;
    if (!live || !navPush) return;
    // The same page is the same path and, on a mail page, the same ?dkim= (the only query that tells two pages
    // apart: the ?block=0 on your own addresses' pages doesn't), so a tag on the address the visitor came in on
    // (?fbclid=, ?utm_source=) doesn't add a second entry.
    try {
      const u = new URL(path, location.origin), mail = u.pathname.startsWith('/mail/');
      const sel = search => (mail && new URLSearchParams(search).get('dkim')) || '';
      if (u.pathname === location.pathname && sel(u.search) === sel(location.search)) return;
      history.pushState({ path }, '', path);
    } catch {}
  }
  function cmdFor(pathname, search = '') {
    let p; try { p = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, ''); } catch { return null; }
    if (!p) return 'whoami';
    const lr = /^leaktest\/r\/([0-9a-z]{1,8})$/i.exec(p);    // a shared result: shown again, never a test run
    if (lr) return 'leaktest --result ' + lr[1].toLowerCase();
    const tool = { whois: 'whois', dns: 'dig', mail: 'mail', grade: 'grade', cidr: 'cidr', leaktest: 'leaktest', port: 'port', api: 'api' }[p.toLowerCase()];
    if (tool) return tool;
    const gr = /^grade\/([^/]+)$/i.exec(p);
    if (gr) return 'grade ' + gr[1];
    const pt = /^port\/(\d{1,5})$/i.exec(p);           // the page explains the port; Back never re-runs a check
    if (pt) return 'port ' + Number(pt[1]) + ' --info';
    const cd = /^cidr\/(.+)$/i.exec(p);
    if (cd) return 'cidr ' + cd[1];
    const dn = /^dns\/([^/]+)(?:\/([a-z]+))?$/i.exec(p);
    if (dn) return 'dig ' + dn[1] + (dn[2] ? ' ' + dn[2].toUpperCase() : '');
    const ml = /^mail\/([^/]+)$/i.exec(p);
    if (ml) { const sel = new URLSearchParams(search).get('dkim'); return 'mail ' + ml[1] + (sel ? ' --dkim ' + sel.replace(/\s+/g, '') : ''); }
    const w = /^whois\/(.+)$/i.exec(p);
    if (w) return 'whois ' + w[1];
    if (/^as\d+$/i.test(p)) return 'asn ' + p.toUpperCase();
    return parseIp(p) ? 'lookup ' + p : null;
  }
  function cmdLink(text, cmd, href) {
    const a = el('a', 'cmd', text);
    a.href = href;
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault(); exec(cmd); focusInput();
    });
    return a;
  }
  // A command that has no page of its own (copy, share, ping...) is a button that looks like the links.
  function cmdButton(text, cmd) {
    const b = el('button', 'cmd', text); b.type = 'button';
    b.addEventListener('click', () => { exec(cmd); focusInput(); });
    return b;
  }
  // The page a command's result lives at (the reverse of cmdFor), or null if it has none. Paths are
  // the canonical ones each command puts in the address bar, so a new tab or a copied link shows the
  // same result as a click; input that isn't valid gets no page (and so becomes a button).
  function hrefFor(cmd) {
    const parts = cmd.trim().split(/\s+/), [c, a, b] = parts;
    const name = v => (parseIp(v) ? v : domainOf(v));          // pasted URLs become their host name
    switch (c) {
      case 'whoami': return '/';
      case 'leaktest': {                                       // leaktest --result <code>: a shared result's page
        if (!a) return '/leaktest';
        const r = /^--?result$/i.test(a) && LEAKLIB && LEAKLIB.decode(b);
        return r ? '/leaktest/r/' + r.code : null;
      }
      case 'api': return '/api';
      case 'whois': return '/whois' + (a ? '/' + name(a) : '');
      case 'dig': return '/dns' + (a ? '/' + name(a) + (b ? '/' + b.toUpperCase() : '') : '');
      case 'mail': {
        const m = mailArgs(parts.slice(1));
        return '/mail' + (m.dom ? '/' + name(m.dom) + (m.sel ? '?dkim=' + encodeURIComponent(m.sel.toLowerCase()) : '') : '');
      }
      case 'grade': return !a ? '/grade' : looksLikeDomain(a) && !parseIp(domainOf(a)) && !recordName(a) ? '/grade/' + domainOf(a).toLowerCase() : null;
      case 'cidr': {                                           // also "cidr 192.168.1.10 255.255.255.0"
        const rest = parts.slice(1).join(' ');
        if (!rest) return '/cidr';
        const d = CIDRLIB && CIDRLIB.calc(rest);
        return d && !d.error ? '/cidr/' + d.cidr : null;
      }
      case 'asn': {
        const m = /^(?:as)?(\d{1,10})$/i.exec(a || ''), n = m ? Number(m[1]) : 0;
        return n >= 1 && n <= 4294967295 ? '/AS' + n : null;
      }
      case 'route': {                                          // a prefix's routing is on its /cidr page; an address has none of its own
        if (!a || !looksLikeCidr(a)) return null;
        const d = CIDRLIB && CIDRLIB.calc(a);
        return d && !d.error && d.range === 'public' ? '/cidr/' + d.cidr : null;
      }
      case 'port': {                                           // the page explains the port; the link's click runs the check
        if (!a) return '/port';
        const n = PORTSLIB && PORTSLIB.parse(a);
        return n ? '/port/' + n : null;
      }
      case 'lookup':
        if (!a) return null;
        if (parseIp(a)) return ipPath(a);
        if (/^as\d+$/i.test(a)) return hrefFor('asn ' + a);
        if (looksLikeCidr(a)) return hrefFor('cidr ' + a);
        return looksLikeDomain(a) ? '/dns/' + domainOf(a) : null;
      default: return null;
    }
  }

  /* ---------- next: suggested follow-ups ----------
     Each result names up to four commands that make sense after it, picked from its own data, so no
     result is a dead end. They print as one line after the command finishes (after any sponsored
     line, which stays separate and labeled). Links only run when clicked, so they cost nothing. */
  let nextItems = null;
  // Each item: [label, command, hint], or [label, null, hint, href] for a plain link (a guide).
  const next = (...items) => { nextItems = items.filter(Boolean).slice(0, 4); };
  function flushNext() {
    const items = nextItems; nextItems = null;
    if (!items || !items.length) return;
    const d = el('div', 'ln sys next'); d.append('next: ');
    items.forEach(([label, cmd, hint, href], i) => {
      if (i) d.append('  ·  ');
      let n;
      if (!cmd) { n = el('a', 'cmd', label); n.href = href; }
      else { const h = hrefFor(cmd); n = h ? cmdLink(label, cmd, h) : cmdButton(label, cmd); }
      if (hint) n.title = hint;
      d.append(n);
    });
    out.appendChild(d); scroll();
  }
  // A data source hiccup or the rate limit (not a typo): offer to run the same command again.
  const RETRYABLE = /didn't respond|didn't finish|Too many (lookups|port checks)|network error|HTTP \d/;
  function failedUpstream(mark) {
    for (let n = mark ? mark.nextSibling : out.firstChild; n; n = n.nextSibling)
      if (n.classList && n.classList.contains('err') && RETRYABLE.test(n.textContent)) return true;
    return false;
  }
  // A plain address becomes a mailto: link; anything else (extra fields, odd characters) stays text.
  const MAIL_RE = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
  function mailLink(addr) {
    if (typeof addr !== 'string' || addr.length > 254 || !MAIL_RE.test(addr)) return document.createTextNode(String(addr));
    const a = el('a', '', addr); a.href = 'mailto:' + addr; return a;
  }
  const ipTitle = (ip, d) => [ip, d.hostname, d.org ? d.org + (d.asn ? ` (${d.asn})` : '') : d.asn].filter(Boolean).join(' · ') + ' | ipterm';

  function localTime(tz) {
    try {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      return f.format(new Date()) + '  ' + tz;
    } catch { return tz; }
  }

  // A connection uses IPv4 or IPv6, so the server only sees one. To show the other, ask ipify's
  // single-stack endpoints (open source, no logging, CORS-enabled): api.ipify.org answers only over
  // IPv4 and api6.ipify.org only over IPv6. Only the other version is asked for; failure means "none".
  async function otherFamily(v) {
    const url = v === 4 ? 'https://api6.ipify.org?format=json' : 'https://api.ipify.org?format=json';
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      const j = r.ok ? await r.json() : null;
      const q = j && typeof j.ip === 'string' ? parseIp(j.ip.trim()) : null;
      return q && q.v !== v ? own(q.v === 4 ? q.o.join('.') : j.ip.trim().toLowerCase()) : null;
    } catch { return null; } finally { clearTimeout(t); }
  }

  // IPinfo Core's flags in plain words: what kind of connection the address belongs to.
  function connection(d) {
    const f = (d && d.flags) || {}, out = [];
    if (f.hosting || (d && d.asType === 'hosting')) out.push('hosting or data center');
    if (f.mobile) out.push('mobile network');
    if (f.satellite) out.push('satellite');
    if (f.anycast) out.push('anycast (served from many locations)');
    if (!out.length && d && d.asType === 'isp') out.push('home or business internet provider');
    return out.join(' · ');
  }

  // VPN / proxy verdict for a lookup. Only Core and proxycheck.io check for it, and a clean result is
  // not proof: VPN providers keep adding fresh addresses that no list knows yet. Matches worker.js.
  // "yes" needs Core's flag or a specific proxycheck.io finding (VPN, proxy, Tor or a named service).
  // proxycheck.io's own "anonymous" is a catch-all, also set on addresses that are none of those
  // (Google Public DNS, 8.8.8.8), and "compromised" means seen performing attacks: alone, each gets
  // a hedged line, and leaktest doesn't count them as a VPN.
  const pcKnown = pc => !!(pc && pc.anonymous && (pc.vpn || pc.proxy || pc.tor || pc.operator));
  const pcFlag = pc => (pc.compromised ? 'flagged by proxycheck.io as compromised (seen performing attacks)' : 'flagged as anonymizing by proxycheck.io') +
    ', but not as a known VPN, proxy or Tor service';
  const vpnKind = pc => (pcKnown(pc) ? (pc.tor ? 'Tor' : pc.vpn ? 'VPN' : pc.proxy ? 'proxy' : 'VPN, proxy or Tor') : 'VPN, proxy or Tor');
  function vpnText(d) {
    const core = d && d.source === 'ipinfo-core' && d.flags ? d.flags : null, pc = (d && d.privacy) || null;
    if (!core && !pc) return 'not checked (detailed data unavailable for this lookup)';
    if ((core && core.anonymous) || pcKnown(pc)) return `yes: a known ${vpnKind(pc)} address` + (pc && pc.operator ? ` (${pc.operator})` : '');
    if (pc && pc.anonymous) return pcFlag(pc);
    const hosting = (core && core.hosting) || d.asType === 'hosting' || (pc && pc.hosting);
    return 'not on known VPN or proxy lists' + (hosting
      ? ', but it is a hosting network, which VPN servers usually use'
      : ' (not a guarantee: new VPN servers are often unlisted)');
  }

  // A lookup's block, when the registry record of the address's network is recent (the Worker's blockData):
  // location databases lag behind new and reassigned blocks, so sites may place the address differently.
  // Worded like blockText in worker.js, naming the same registries (REGISTRY there: the RIRs and the NIRs).
  const REGISTRIES = ['IDNIC', 'JPNIC', 'KRNIC', 'TWNIC', 'NIC.br', 'ARIN', 'RIPE NCC', 'APNIC', 'LACNIC', 'AFRINIC'];
  function blockLine(b) {
    const ago = b.days === 0 ? 'today' : b.days === 1 ? '1 day ago' : `${b.days} days ago`;
    return `${b.network || 'this block'} registered${REGISTRIES.includes(b.registry) ? ' with ' + b.registry : ''} on ${b.registered} (${ago}): ` +
      'IP location databases often take months to catch up with new or reassigned blocks, so sites may disagree about where this address is';
  }

  async function render(p, ipText, d, isSelf) {
    const [cls, why] = classify(p);
    const head = el('div', 'head');
    head.append(el('span', 'hip', isSelf ? 'whoami' : ipText), el('span', 'tag', 'IPv' + p.v), el('span', 'tag ' + (cls === 'public' ? 'pub' : 'priv'), cls));
    if (d && d.source) head.append(el('span', 'tag', SRC[d.source] || d.source));
    const res = isSelf ? { cmd: 'whoami', value: ipText, what: 'your IP address', path: '/', self: true, hide: [own(ipText)], terms: placeTerms(d), drop: SELF_DROP }
      : { cmd: 'lookup ' + ipText, value: ipText, what: 'the address ' + ipText, path: '/' + ipText };
    head.append(shareBar(res));
    out.appendChild(head);
    const fig = geoBlock(d);
    if (fig) { out.appendChild(fig); kick(); scroll(); }

    const rows = [];
    if (isSelf) rows.push(['your ip', ipText, 'big'], ['', 'This is your public IP address: the number websites and apps see when you connect. Its location is roughly where your internet provider is, not your home.', 'plain']);
    if (isSelf && live) {                      // the other IP version fills in when it arrives
      const want = p.v === 4 ? 6 : 4, slot = el('span', 'ttl', 'checking…');
      rows.push(['IPv' + want, slot]);
      otherFamily(p.v).then(other => {
        slot.textContent = '';
        if (other) res.hide.push(other);           // copy md leaves it out too
        if (other) { slot.className = ''; slot.append(cmdLink(other, 'lookup ' + other, ipPath(other))); announce(`Your IPv${want} address is ${other}.`); }
        else slot.append(`none detected (your connection looks IPv${p.v} only)`);
      });
    }
    // (the preview has DNS samples for example.com only, so other names stay plain text there)
    const domLink = v => (looksLikeDomain(v) && (live || DEMO_DNS[domainOf(v).toLowerCase()]) ? cmdLink(v, 'dig ' + v, '/dns/' + v) : v);
    if (d) {
      if (d.hostname) rows.push(['hostname', domLink(d.hostname)]);
      else if (d.ptrTimedOut) {                 // the homepage gives reverse DNS only a moment
        const f = document.createDocumentFragment();
        f.append('reverse DNS was slow to answer: ', cmdLink(`dig ${ipText}`, `dig ${ipText}`, `/dns/${ipText}`));
        rows.push(['hostname', f]);
      }
      if (d.asn || d.org) {
        const f = document.createDocumentFragment(), id = String(d.asn || '').toUpperCase();
        if (/^AS\d+$/.test(id)) f.append(cmdLink(id, 'asn ' + id, '/' + id)); else if (d.asn) f.append(document.createTextNode(d.asn));
        if (d.org) f.append(document.createTextNode((d.asn ? '  ' : '') + d.org));
        rows.push(['network', f]);
        if (classify(p)[0] === 'public') rows.push(['registry', cmdLink(`whois ${ipText}`, `whois ${ipText}`, `/whois/${ipText}`)]);
      }
      if (d.asDomain) rows.push(['domain', domLink(d.asDomain)]);
      const ctry = d.country ? d.country + (d.countryCode ? ' [' + d.countryCode + ']' : '') : d.countryCode;
      const place = [d.city, d.region, ctry].filter(Boolean).join(', ');
      if (place) rows.push(['location', place]);
      if (d.continent && !d.city) rows.push(['continent', d.continent]);
      if (d.postal) rows.push(['postal', d.postal]);
      if (d.lat != null && d.lon != null) {
        const f = document.createDocumentFragment();
        f.append(document.createTextNode(d.lat.toFixed(4) + ', ' + d.lon.toFixed(4) + '   '));
        const a = el('a', '', 'map ↗');
        // Google Maps view of the area, without a pin: IP locations are approximate, and a pin would
        // look like an exact address.
        a.href = `https://www.google.com/maps/@${Number(d.lat).toFixed(4)},${Number(d.lon).toFixed(4)},11z`;
        a.target = '_blank'; a.rel = 'noopener';
        a.setAttribute('aria-label', 'Open the approximate area in Google Maps (new tab)');
        f.append(a); rows.push(['coords', f]);
      }
      if (d.timezone) rows.push(['local time', localTime(d.timezone)]);
      if (d.block && d.block.recent) rows.push(['block', blockLine(d.block)]);
      const conn = connection(d);
      if (conn) rows.push(['connection', conn]);
      if (isSelf && live) {                    // your own address is checked by leaktest, not here
        const f = document.createDocumentFragment();
        f.append('run ', cmdLink('leaktest', 'leaktest', '/leaktest'), ' to check yours (and what else your browser gives away)');
        rows.push(['vpn / proxy', f]);
      } else if (!isSelf && cls === 'public' && d.source && d.source !== 'demo') rows.push(['vpn / proxy', vpnText(d)]);
      if (d.colo) rows.push(['edge', d.colo + '  (the Cloudflare data center that answered you)']);
      if (d.note) rows.push(['note', d.note]);
    }
    if (why) rows.push(['range', why]);
    rows.push('sep');
    rows.push(...computed(p));
    await kv(rows);
    const where = d ? [d.city, d.region, d.country || d.countryCode].filter(Boolean).join(', ') : '';
    announce(isSelf
      ? `Your IP address is ${ipText}` + (where ? `, near ${where}` : '') + (d && d.org ? `, network ${d.org}` : '') + '.'
      : `${ipText}: ` + (d ? [d.org, d.asn, where].filter(Boolean).join(', ') || 'no details' : (why || cls)) + '.');
  }

  /* ---------- sponsored line ----------
     One labeled line after some results, filled from sponsors.json (edit it and redeploy).
     Plain text and a link: no ad scripts, no tracking, nothing about the visitor is sent anywhere.
     Sponsors are picked (by weight) among those whose `on` list matches the result type: whoami,
     check (the leaktest verdict when no VPN is on), ip or asn. Only results that have a matching
     sponsor count: the line shows after the 1st of them, then every `every`. The check verdict
     always gets its line. */
  let SPONSORS = [], SPONSOR_EVERY = 3, sinceShown = -1;   // -1: none shown yet
  async function loadSponsors() {
    if (document.querySelector('[data-copy]')) return;  // a self-hosted copy (SELF_HOSTED in wrangler.toml) shows none
    for (const path of ['/sponsors.json', 'sponsors.json']) {
      try {
        const r = await fetch(path, { headers: { accept: 'application/json' } });
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) continue;
        const cfg = await r.json();
        if (!cfg || cfg.enabled === false || !Array.isArray(cfg.sponsors)) return;
        SPONSOR_EVERY = Math.max(1, Math.min(20, Number(cfg.every) || 3));
        SPONSORS = cfg.sponsors
          .filter(x => x && typeof x.text === 'string' && x.text.trim())
          .map(x => ({
            text: x.text.trim().slice(0, 160),
            url: typeof x.url === 'string' && /^https:\/\//i.test(x.url) ? x.url : null,   // only secure web links
            on: Array.isArray(x.on) ? x.on.map(String) : null,
            weight: Math.max(0, Number(x.weight) || 1),
            label: typeof x.label === 'string' && x.label.trim() ? x.label.trim().slice(0, 20) : 'sponsored',
          }));
        return;
      } catch {}
    }
  }
  const SPONSORS_READY = loadSponsors();

  async function sponsor(kind) {
    await Promise.race([SPONSORS_READY, new Promise(r => setTimeout(r, 1500))]);
    const pool = SPONSORS.filter(x => !x.on || x.on.includes(kind));
    const total = pool.reduce((a, x) => a + x.weight, 0);
    if (!pool.length || total <= 0) return;             // nothing to show here, so it doesn't use up a turn
    if (kind !== 'check' && sinceShown >= 0 && ++sinceShown < SPONSOR_EVERY) return;
    sinceShown = 0;
    let roll = Math.random() * total, pick = pool[0];
    for (const x of pool) { roll -= x.weight; if (roll < 0) { pick = x; break; } }
    const row = el('div', 'ln sponsor');
    row.append(el('span', 'tag', pick.label));
    if (pick.url) {
      const a = el('a', '', pick.text + ' ↗');
      a.href = pick.url; a.target = '_blank'; a.rel = 'sponsored noopener';
      row.append(a);
    } else row.append(el('span', '', pick.text));
    out.appendChild(row); scroll();
  }

  /* ---------- commands ---------- */
  function setLive(on) {
    live = on;
    modeEl.textContent = on ? 'live' : 'preview';
    modeEl.className = 'pill ' + (on ? 'live' : 'demo');
  }

  /* ---------- privacy check (leaktest) ----------
     Everything runs on demand, in the visitor's browser, and nothing is stored:
       - /api/check: the IP websites see, plus IPinfo's view of it (VPN/proxy/Tor, hosting, mobile)
         and whether it's on the Tor Project's exit list (the Worker keeps a copy)
       - DNS: which resolvers look up a few random names under ipterm's test zone (/api/dnsleak)
       - WebRTC: which public IPs the browser reveals to a STUN server (Cloudflare's public one)
       - ipify: the address on the other IP version, and whether it uses a different network
       - the device's time zone compared with the IP's location
       - /cdn-cgi/trace, which Cloudflare's edge answers itself: Cloudflare WARP, and the TLS and HTTP
         versions and key exchange (INFO badges)
       - the browser's language region compared with the IP's country (INFO only: expats differ)
     The grade (leakgrade.js) counts DNS, WebRTC, IPv6 and the time zone, each only when a VPN is
     detected, so not using one never lowers it. The last run stays in this tab's memory (never in
     storage) so the next one can print a before → after compare. */
  const LEAKTEST_TITLE = 'VPN and DNS leak test: DNS, WebRTC and IPv6 leaks | ipterm';
  const LEAKTEST_TITLE_NO_DNS = 'VPN leak test: WebRTC, IPv6 and time zone check | ipterm';   // before the DNS test is set up
  const ZONE_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
  const LEAKLIB = window.IPTERM_LEAK || null;
  const [NOT_TESTED, PASS, LEAKED] = [0, 1, 2];        // a graded check's flag, as in leakgrade.js
  const GRADED = ['dns', 'webrtc', 'ipv6', 'tz'];
  let lastLeak = null;                                  // the previous run in this tab, for the compare
  let vpnSeen = false;                                  // a run in this tab found a VPN: no VPN offer after that
  let leakCode = null;                                  // the latest run's share code ('' = nothing to share)

  // DNS leak test: look up a few random, single-use names under the test zone (/api/check says which).
  // Each fetch fails within milliseconds, since the zone's server answers NXDOMAIN, but by then the
  // lookup has reached that server through whichever resolvers this device uses. Then ask which.
  async function dnsLookups(zone) {
    if (typeof zone !== 'string' || !ZONE_RE.test(zone)) return null;
    const token = () => [...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, '0')).join('');
    const tokens = Array.from({ length: 6 }, token);
    await Promise.all(tokens.map(t => {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 3000);
      return fetch(`https://${t}.${zone}/`, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .catch(() => {}).finally(() => clearTimeout(timer));
    }));
    // Resolvers that asked in parallel may still be on their way. (Not sleep(): that one is for animation,
    // and skips the wait under reduced motion.)
    await new Promise(r => setTimeout(r, 600));
    return getJson('/api/dnsleak?t=' + tokens.join(','), { 'x-ipterm': 'dnsleak' });
  }
  const canonIp = s => { const q = parseIp(String(s || '').trim()); return q ? (q.v === 4 ? q.o.join('.') : q.g.map(x => x.toString(16)).join(':')) : null; };
  const isPrivate = s => { const q = parseIp(s); return !!q && classify(q)[0] !== 'public'; };

  function webrtcIps(timeout = 2000) {           // VPNs often block STUN entirely, so don't wait long
    return new Promise(resolve => {
      const ips = new Set(), local = new Set(); let pc, finished = false;
      const done = supported => {
        if (finished) return; finished = true;
        try { pc && pc.close(); } catch {}
        resolve({ supported, ips: [...ips], local: [...local] });
      };
      if (typeof RTCPeerConnection !== 'function') return done(false);
      try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }); } catch { return done(false); }
      const t = setTimeout(() => done(true), timeout);
      pc.onicecandidate = e => {
        if (!e.candidate) { clearTimeout(t); return done(true); }
        const m = /\s(\S+)\s\d+\styp\s(host|srflx|prflx|relay)\b/.exec(e.candidate.candidate || '');
        if (!m) return;
        const addr = m[1].toLowerCase();
        if (m[2] === 'host') { if (/\.local$/.test(addr)) local.add('mdns'); else if (parseIp(addr)) local.add(addr); }
        else if (parseIp(addr) && !isPrivate(addr)) ips.add(addr);
      };
      try {
        pc.createDataChannel('ipterm');
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { clearTimeout(t); done(true); });
      } catch { clearTimeout(t); done(true); }
    });
  }

  function tzOffset(tz) {                      // minutes east of UTC right now, or null
    try {
      const d = new Date(), f = z => new Date(d.toLocaleString('en-US', { timeZone: z, hour12: false }));
      return Math.round((f(tz) - f('UTC')) / 60000);
    } catch { return null; }
  }

  // What Cloudflare's edge says about this connection (/cdn-cgi/trace, the same answer ping times): the
  // TLS and HTTP versions, the key exchange, and warp=on when the request came through Cloudflare WARP.
  // null when there's no edge in front (wrangler dev) or it doesn't answer quickly. Nothing is kept.
  async function cfTrace() {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch('/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      const t = r.ok ? await r.text() : '';
      if (!/^colo=\w+$/m.test(t)) return null;
      const o = Object.create(null);
      for (const m of t.matchAll(/^([a-z_]{1,20})=(.{0,80})$/gm)) o[m[1]] = m[2].trim();
      return o;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  // The country the browser's preferred language names (en-US → US), or none (plain "en").
  function langRegion() {
    let langs = [];
    try { langs = [...(navigator.languages || []), navigator.language].filter(x => typeof x === 'string' && x); } catch {}
    for (const tag of langs) {
      try { const r = new Intl.Locale(tag).region; if (/^[A-Z]{2}$/.test(r || '')) return { tag, region: r }; } catch {}
    }
    return langs.length ? { tag: langs[0], region: null } : null;
  }
  const regionName = cc => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; } catch { return cc; } };
  const LEAK_STATUS = { ok: 'ok', warn: 'leak', info: 'info' };
  const stTag = st => el('span', 'tag st-' + st, LEAK_STATUS[st]);
  const frag = (...parts) => { const x = document.createDocumentFragment(); parts.forEach(q => x.append(q)); return x; };

  async function leaktest(args = []) {
    if (/^--?result$/i.test(args[0] || '')) return leakResult(args[1]);
    setUrl('/leaktest', LEAKTEST_TITLE);
    if (!live) return line('The privacy check tests your real connection, so it only runs on the deployed site.', 'warn');
    const ql = line('running privacy check… (nothing is stored)', 'sys'); const t0 = performance.now();
    const [d, rtc, trace] = await Promise.all([getJson('/api/check'), webrtcIps(), cfTrace()]);
    if (d.error) { ql.textContent = d.error; ql.className = 'ln err'; announce(d.error); return; }
    const p = parseIp(d.ip);
    if (!p) { ql.textContent = 'The server returned an address this page cannot read.'; ql.className = 'ln err'; return; }
    if (!d.dnsleak) document.title = LEAKTEST_TITLE_NO_DNS;
    [d.ip, ...rtc.ips].forEach(own);             // yours, like the other IP version: their lookups skip the registry
    const dnsPending = dnsLookups(d.dnsleak);    // runs alongside the other IP version's lookup
    const other = await otherFamily(p.v);
    const otherInfo = other ? await api(other) : null;   // with block=0 (otherFamily marked it yours)
    const dns = await dnsPending;
    ql.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;

    const net = d.network || {}, f = net.flags || {}, pc = net.privacy || null;
    // Named services: Cloudflare's edge says when a request comes through WARP, and Tor exits are on the
    // Tor Project's list (Cloudflare also gives them the country code T1).
    const warp = !!(trace && /^(on|plus)$/i.test(trace.warp || ''));
    const torListed = !!net.tor || d.countryCode === 'T1';
    const tor = torListed || !!(pcKnown(pc) && pc.tor);
    const vpnKnown = net.source === 'ipinfo-core' || !!pc || warp || torListed;
    const anon = !!(f.anonymous || pcKnown(pc) || warp || torListed);
    // proxycheck.io's catch-all flag alone (see vpnText) doesn't say a VPN is on, so it doesn't count
    // as one here. On a hosting network the hosting check below still counts it; anywhere else the
    // check is unsure, and treats it like an address it couldn't classify.
    const flagged = !anon && !!(pc && pc.anonymous);
    const vpn = !!(anon || f.hosting || net.asType === 'hosting' || (pc && pc.hosting));
    // If we can't tell whether a VPN is on, a mismatch might be a leak: flag it, with a caveat (and no
    // grade, since it would depend on the answer). An unlisted IP isn't proof there's no VPN (new VPN
    // servers are often unlisted), so those lines keep the caveat too, just without the LEAK label.
    // A home or mobile provider's network is different: commercial VPN servers run in data centers,
    // so an unflagged address there means no VPN, and the lines below can say so plainly.
    const homeNet = !vpn && !flagged && vpnKnown && !!(net.asType === 'isp' || f.mobile || (pc && (pc.netType === 'residential' || pc.netType === 'wireless')));
    // Mismatches below still carry the caveat there: a VPN to your own home or office, or one using
    // home addresses, would look like a home connection too.
    const unsure = !vpnKnown || (flagged && !vpn);
    const strict = vpn || unsure, ifVpn = !vpn ? ' (a leak if you use a VPN)' : '';
    const vpnState = vpn ? 'vpn' : unsure ? 'unsure' : 'none';
    const tunnel = warp ? 'Cloudflare WARP' : tor ? 'Tor' : 'your VPN';
    const tunnelNet = warp ? "Cloudflare WARP's network" : tor ? 'the Tor network' : "your VPN's network";
    // Each line: { key, st, label, v, fix, sum, data, flag }. sum is the short form the compare prints.
    // A graded line's flag: LEAK lines leak. On a VPN only an OK line passes (an INFO line there couldn't
    // tell); without one every line that ran passes, since nothing can leak past a VPN that isn't there.
    const results = [], skipped = [];
    const add = (key, st, label, v, o = {}) => {
      const ran = o.ran !== false;
      if (GRADED.includes(key) && o.ran === false && o.skip) skipped.push(label);
      results.push({ key, st, label, v, ...o, flag: !GRADED.includes(key) || !ran ? NOT_TESTED : st === 'warn' ? LEAKED : vpn && st !== 'ok' ? NOT_TESTED : PASS });
    };
    const ipLink = ip => cmdLink(ip, 'lookup ' + ip, ipPath(ip));
    const ipList = ips => ips.flatMap((ip, i) => (i ? [', ', ipLink(ip)] : [ipLink(ip)]));

    // 1. what every site sees: stated, never graded
    const place = [d.city, /^[A-Z]{2}$/.test(d.countryCode || '') && d.countryCode !== 'T1' ? d.countryCode : null].filter(Boolean).join(', ');
    const seen = [d.org, place && 'near ' + place].filter(Boolean).join(', ');
    add('see', 'info', 'sites see', frag(ipLink(d.ip), seen ? ` (${seen})` : '', vpn
      ? `: ${warp ? "Cloudflare WARP's" : tor ? "a Tor exit's" : "your VPN's"} address, not your provider's. Not graded`
      : unsure ? ": unless you use a VPN, that's your provider and rough location. Not graded"
      : ': your provider and rough location, which every site you visit sees without a VPN. Not graded'), { sum: [d.ip, d.org].filter(Boolean).join(' ') });

    // 2. VPN / proxy detection
    if (warp) add('vpn', 'ok', 'VPN detection', "you're on Cloudflare WARP (Cloudflare's edge says so): sites see a Cloudflare address, not your provider", { sum: 'Cloudflare WARP' });
    else if (torListed) add('vpn', 'ok', 'VPN detection', "your IP is a Tor exit (on the Tor Project's list): sites see the Tor network, not your provider", { sum: 'Tor' });
    else if (!vpnKnown) add('vpn', 'info', 'VPN detection', "unavailable for this check, so the lines below can't tell whether you use a VPN", { sum: 'unavailable' });
    else if (anon) add('vpn', 'ok', 'VPN detection', `your IP is a known ${vpnKind(pc)} address${pc && pc.operator ? ' (' + pc.operator + ')' : ''}: sites see that, not your provider`,
      { sum: vpnKind(pc) + (pc && pc.operator ? ' (' + pc.operator + ')' : '') });
    else if (vpn) add('vpn', 'ok', 'VPN detection', 'your IP belongs to a hosting network, as VPN servers usually do' + (flagged ? ` (${pcFlag(pc)})` : ''), { sum: 'hosting network' });
    else if (flagged) add('vpn', 'info', 'VPN detection', `your IP is ${pcFlag(pc)}, so this check can't tell whether you use a VPN. Without one, sites see your provider${d.org ? ' (' + d.org + ')' : ''} and rough location`, { sum: 'unclear' });
    else if (homeNet) add('vpn', 'info', 'VPN detection', `no VPN service: your IP belongs to ${d.org || 'your internet provider'}, a home or mobile internet provider, so sites see your provider and rough location`, { sum: 'no VPN' });
    else add('vpn', 'info', 'VPN detection', `not on known VPN lists. Without a VPN, sites see your provider${d.org ? ' (' + d.org + ')' : ''} and rough location. If you are using one, it's a newer or unlisted server, and sites may not spot it either`, { sum: 'not on VPN lists' });

    // 3. DNS: which resolvers looked up the test names, grouped by network. A LEAK only on a VPN, when one
    // of them is outside the VPN's network (your provider's or anyone else's); otherwise they're named, as INFO.
    // Through Tor the exit relay picks the resolver, so there only your own provider's counts.
    const dnsRan = !!(dns && !dns.error && dns.seen > 0 && Array.isArray(dns.resolvers) && dns.resolvers.length);
    const up = s => String(s || '').toUpperCase(), low = s => String(s || '').trim().toLowerCase();
    let dnsAsns = [];
    if (dnsRan) {
      // On a VPN, your provider's network is known only if the other IP version leaked (step 5 below).
      const ispAsn = vpn ? (otherInfo && !otherInfo.error && up(otherInfo.asn) !== up(d.asn) ? up(otherInfo.asn) : '') : up(d.asn);
      const mine = new Set([canonIp(d.ip), canonIp(other)].filter(Boolean));
      const groups = new Map();
      for (const r of dns.resolvers) {
        if (!r || !parseIp(String(r.ip || ''))) continue;
        const asn = /^AS\d+$/i.test(r.asn || '') ? up(r.asn) : '', key = r.private ? 'private' : asn || 'ip:' + r.ip;
        if (!groups.has(key)) {
          const vpnNet = vpn && asn && (asn === up(d.asn) || (r.org && low(r.org) === low(d.org)));
          groups.set(key, { kind: r.private ? 'private' : !asn ? 'unknown' : vpnNet ? 'vpn' : asn === ispAsn ? 'isp' : 'other',
            org: r.org, asn, service: r.service, ips: [] });
        }
        groups.get(key).ips.push(r.ip);
      }
      const label = g => (g.kind === 'private' ? 'a resolver inside your own network (private address)'
        : g.kind === 'vpn' ? `${tunnelNet}${g.org ? ' (' + g.org + ')' : ''}`
        : g.ips.every(ip => mine.has(canonIp(ip))) ? 'your own address (a resolver you run yourself)'
        : g.kind === 'isp' ? `your ISP: ${g.org || g.asn}`
        : g.service || g.org || g.asn || 'a network ipterm could not identify');
      const named = list => list.flatMap((g, i) => [i ? '; ' : '', label(g), ' at ',
        ...g.ips.slice(0, 2).flatMap((ip, j) => (j ? [', ', ipLink(ip)] : [ipLink(ip)])), g.ips.length > 2 ? ` +${g.ips.length - 2} more` : '']);
      const all = [...groups.values()], outside = all.filter(g => g.kind === 'isp' || (g.kind === 'other' && !tor));
      dnsAsns = all.map(g => g.asn).filter(Boolean);
      const o = { sum: all.map(label).join('; '), data: { leakAsns: outside.map(g => g.asn).filter(Boolean) }, ran: !unsure };
      if (vpn && outside.length) add('dns', 'warn', 'DNS', frag('sites you visit are looked up by ', ...named(outside), `, outside ${tunnelNet}${!warp && !tor && d.org ? ' (' + d.org + ')' : ''}`), { ...o,
        fix: "turn on DNS leak protection in your VPN app, so lookups go through the tunnel to the VPN's own DNS servers. Also check your browser's secure DNS setting (Chrome and Edge: Settings › Privacy and security › Security › Use secure DNS; Firefox: Settings › Privacy & Security › DNS over HTTPS): when it names a provider, lookups go there instead of to your VPN" });
      else if (vpn && (tor || all.every(g => g.kind === 'vpn'))) add('dns', 'ok', 'DNS', frag('sites you visit are looked up by ', ...named(all),
        tor ? ", which the Tor exit chose, so your internet provider can't see them" : ", so your internet provider can't see them"), o);
      else add('dns', 'info', 'DNS', frag('sites you visit are looked up by ', ...named(all), all.length === 1 && all[0].kind === 'isp' ? ', which can see the name of every site you visit' : ''), o);
    } else skipped.push('DNS');

    // 4. WebRTC
    const known = new Set([canonIp(d.ip), canonIp(other)].filter(Boolean));
    const extra = rtc.ips.filter(ip => !known.has(canonIp(ip)));
    const localIps = rtc.local.filter(x => x !== 'mdns');
    const rtcData = { extra: extra.map(canonIp) };
    if (!rtc.supported) add('webrtc', 'ok', 'WebRTC', 'turned off in this browser, so it cannot leak', { sum: 'turned off', data: rtcData });
    else if (extra.length && strict) add('webrtc', 'warn', 'WebRTC', frag('reveals ', ...ipList(extra), vpn ? `, an address outside ${tunnel}` : ', a second public address' + ifVpn), { sum: 'shows ' + extra.join(', '), data: rtcData,
      fix: 'turn on WebRTC leak protection in your VPN app, or block WebRTC in your browser (Firefox: set media.peerconnection.enabled to false in about:config)' });
    else if (extra.length) add('webrtc', 'info', 'WebRTC', frag('also shows ', ...ipList(extra), ' (a second public address; common on some networks)' + ifVpn), { sum: 'also shows ' + extra.join(', '), data: rtcData });
    else if (rtc.ips.length) add('webrtc', 'ok', 'WebRTC', 'only shows the IP above, so nothing extra leaks', { sum: 'nothing extra', data: rtcData });
    else add('webrtc', 'ok', 'WebRTC', 'no public address exposed', { sum: 'nothing exposed', data: rtcData });
    // A local address says nothing about where you are, so it's INFO and never graded.
    if (localIps.length) add('local', 'info', 'local address', `WebRTC also shows your local network address ${localIps.slice(0, 2).join(', ')}. Current versions of Chrome, Edge, Firefox and Safari hide it, so updating your browser usually does too`,
      { sum: localIps.slice(0, 2).join(', ') });

    // 5. the other IP version
    const otherV = p.v === 4 ? 'IPv6' : 'IPv4';
    if (!other) add('ipv6', 'ok', otherV, `none detected (your connection looks IPv${p.v} only)`, { sum: 'none', data: {} });
    else {
      const oAsn = otherInfo && !otherInfo.error ? otherInfo.asn : null, oOrg = otherInfo && !otherInfo.error ? otherInfo.org : null;
      const sameNet = oAsn && d.asn && up(oAsn) === up(d.asn);
      const o = { data: { asn: up(oAsn) } };
      if (!oAsn) add('ipv6', 'info', otherV, frag(ipLink(other), "  couldn't check which network this belongs to; look it up to compare with your " + 'IPv' + p.v), { sum: other, ran: false, skip: true, data: {} });
      else if (sameNet) add('ipv6', 'ok', otherV, frag(ipLink(other), `  same network${oOrg ? ' (' + oOrg + ')' : ''}`), { ...o, sum: 'same network' + (oOrg ? ' (' + oOrg + ')' : '') });
      else add('ipv6', strict ? 'warn' : 'info', otherV, frag(ipLink(other), vpn
        ? `  goes through ${oOrg || oAsn}, not ${tunnel}`
        : `  through ${oOrg || oAsn}, a different network than your ${'IPv' + p.v}` + ifVpn), { ...o, sum: 'through ' + (oOrg || oAsn),
        fix: `turn on your VPN app's ${otherV} leak protection (sometimes called "block ${otherV}"), or turn off ${otherV} on this device` });
    }

    // 6. time zone. A device that reports UTC (Tor Browser, Firefox's resistFingerprinting) gives nothing away.
    const devTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();
    if (devTz && d.timezone) {
      const off = tzOffset(devTz), same = devTz === d.timezone || (off != null && off === tzOffset(d.timezone));
      if (same) add('tz', 'ok', 'time zone', `your device (${devTz}) matches your IP's location`, { sum: 'matches (' + devTz + ')' });
      else if (/^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu)$/i.test(devTz)) add('tz', 'ok', 'time zone', "your device reports UTC, which doesn't give away your region", { sum: 'reports UTC' });
      else add('tz', strict ? 'warn' : 'info', 'time zone', `your device says ${devTz}, your IP says ${d.timezone}` + (vpn ? ': sites can tell your real region from your clock' : ifVpn), { sum: `${devTz} vs ${d.timezone}`,
        fix: "set your device's time zone to match the VPN location, or use a browser that reports UTC (Tor Browser, or Firefox with privacy.resistFingerprinting turned on)" });
    } else skipped.push('time zone');

    // 7. browser language vs the IP's country: INFO only, since expats and travelers differ for good reasons
    const lr = langRegion(), cc = /^[A-Z]{2}$/.test(d.countryCode || '') && d.countryCode !== 'T1' ? d.countryCode : null;
    if (lr && cc) {
      if (!lr.region) add('lang', 'info', 'language', `your browser asks for pages in ${lr.tag}, which names no country, so there's nothing to compare`, { sum: lr.tag });
      else if (lr.region === cc) add('lang', 'info', 'language', `your browser asks for pages in ${lr.tag}, the same country as your IP (${regionName(cc)})`, { sum: `${lr.tag}, same country` });
      else add('lang', 'info', 'language', `your browser asks for pages in ${lr.tag} (${regionName(lr.region)}), another country than your IP's (${regionName(cc)}). Sites can compare the two` +
        (vpn ? ', which can hint at where you are' : '') + ". Expats and travelers differ all the time, so this never counts as a leak", { sum: `${lr.tag} vs ${cc}` });
    }

    // 8. how this browser connects: INFO badges from Cloudflare's edge, never a plus on the grade
    if (trace && (trace.tls || trace.http || trace.kex)) {
      const badge = (text, good) => el('span', 'tag' + (good ? ' pub' : ''), text);
      const tls = trace.tls && trace.tls !== 'off' ? trace.tls.replace(/^TLSv/i, 'TLS ') : null;
      const http = trace.http ? trace.http.toUpperCase() : null, pq = /MLKEM|Kyber/i.test(trace.kex || '');
      const tags = [tls && badge(tls, tls === 'TLS 1.3'), http && badge(http, http === 'HTTP/3'), trace.kex && badge(pq ? 'post-quantum' : 'not post-quantum', pq)].filter(Boolean);
      add('conn', 'info', 'connection', frag(...tags.flatMap((t, i) => (i ? [' ', t] : [t])),
        `  ${trace.kex ? 'key exchange ' + trace.kex + '. ' : ''}How this browser connects to ipterm; not part of the grade`),
        { sum: [tls, http, trace.kex].filter(Boolean).join(', ') });
    }

    // The grade, and the share code (made here, in the browser: only the grade and the flags)
    const flags = { vpn: vpn ? 2 : unsure ? 0 : 1 };
    for (const k of GRADED) { const r = results.find(x => x.key === k); flags[k] = r ? r.flag : NOT_TESTED; }
    const grade = LEAKLIB ? LEAKLIB.grade(flags) : null;
    leakCode = (LEAKLIB && LEAKLIB.encode(flags)) || '';
    const leakLines = results.filter(r => r.st === 'warn'), n = leakLines.length;
    const tally = grade == null ? `not graded: ipterm couldn't tell whether you use a VPN, and the line${n > 1 ? 's' : ''} marked LEAK only count${n > 1 ? '' : 's'} if you do`
      : vpnState === 'none' ? 'no VPN detected, so nothing can leak past one: not using a VPN never lowers the grade. What sites see is on its own line'
      : !vpn ? "ipterm couldn't tell whether you use a VPN, but nothing would leak either way"
      : n ? `${n} leak${n > 1 ? 's' : ''} past ${tunnel}: ${leakLines.map(r => r.label).join(', ')}` : `no leaks past ${tunnel}`;

    const verdict = n ? `${n} possible leak${n > 1 ? 's' : ''} found. The lines marked LEAK show what gives you away` + (unsure ? ' if you use a VPN.' : '.')
      : vpn ? `No leaks found: sites see ${tunnel}, not you.`
      : homeNet ? "Nothing leaks beyond your IP address, but that address shows your provider and rough location. A VPN would hide them."
      : "Nothing leaks beyond your IP address. Without a VPN, that address still shows your provider and rough location; a VPN would hide it.";

    const head = el('div', 'head');
    // The tag names the tunnel as `tunnel` does (a Tor exit known only to proxycheck.io too).
    head.append(el('span', 'hip', 'leaktest'), el('span', 'tag pub', 'privacy check'),
      el('span', 'tag', warp ? 'warp on' : tor ? 'tor' : vpn ? 'vpn on' : homeNet ? 'no vpn' : flagged ? 'vpn unclear' : vpnKnown ? 'no vpn detected' : 'vpn unknown'),
      el('span', 'tag', grade ? 'grade ' + grade : 'not graded'));
    // Share: your grade's link, whose code holds only the grade and each check's flag (leakgrade.js), or the check
    // itself when the run has no grade. The Markdown keeps the findings but nothing that is you: no address or
    // resolver (hide), and no provider, network, resolver operator, place, time zone or language region (terms):
    // this run's, and the previous run's too, since the compare below prints in the same block. (lastLeak is
    // still the previous run here.) Each run keeps only its own, raw as the lines print them. A language tag
    // counts only when it names a country (en-US): a bare one (no, it, so) places no one, and as a whole word
    // it would hide ordinary words ("no vpn").
    const mine = [d.ip, other, ...rtc.ips, ...rtc.local, ...(dns && Array.isArray(dns.resolvers) ? dns.resolvers.map(r => r && r.ip) : [])].filter(Boolean);
    const myTerms = [...placeTerms(d), net.org, net.asn, pc && pc.operator, ...placeTerms(otherInfo),
      ...(dns && Array.isArray(dns.resolvers) ? dns.resolvers.flatMap(r => (r ? [r.org, r.asn, r.service, r.countryCode] : [])) : []),
      devTz, ...(lr && lr.region ? [lr.tag, lr.region, regionName(lr.region)] : []), cc && regionName(cc), trace && trace.colo, trace && trace.loc];
    head.append(shareBar({ cmd: 'leaktest', value: verdict, what: 'the verdict', path: leakCode ? '/leaktest/r/' + leakCode : '/leaktest',
      self: !leakCode, text: leakCode ? `my ipterm leak test grade: ${grade}` : null,
      note: leakCode ? '   (it holds only the grade and which checks passed or leaked: no IP address, provider, location or DNS resolver; opening it never runs the test)' : null,
      hide: lastLeak ? [...mine, ...lastLeak.hide] : mine, terms: lastLeak ? [...myTerms, ...lastLeak.terms] : myTerms, drop: LEAK_DROP }));
    out.appendChild(head);
    await kv([['leaks', grade || '–', 'big'],
      ['', frag(tally + (skipped.length ? `; not tested: ${skipped.join(', ')}` : '') + '. ', cmdButton('how the grade works', 'man leaktest')), 'plain'],
      ...results.flatMap(({ st, label, v, fix }) => {
        const x = document.createDocumentFragment(); x.append(stTag(st), ' ', v);
        return st === 'warn' && fix ? [[label, x], ['', 'fix: ' + fix, 'plain']] : [[label, x]];
      })]);
    line(verdict, n ? 'warn' : 'sys');
    announce(`Leak test: ${grade ? 'grade ' + grade : 'not graded'}. ${verdict}`);
    // Before the DNS test server is set up, or when it can't say anything this time, the check says so.
    if (!dnsRan) {
      const why = !d.dnsleak ? '' : dns && !dns.error ? ": none of the test lookups reached ipterm's DNS server (a blocker or proxy may have stopped them)"
        : ": ipterm's DNS test server didn't answer this time";
      line(`Not tested: DNS leaks (which DNS servers answer for you)${why}. Your VPN app usually has a setting for this.`, 'sys');
    }

    // Compare with the previous run in this tab, then keep this one (in memory only) for the next.
    const run = { at: Date.now(), hide: mine, terms: myTerms, vpnState, tunnel, grade, lines: new Map(results.map(r => [r.key, r])),
      ips: known, asns: new Set([d.asn, otherInfo && !otherInfo.error ? otherInfo.asn : null].filter(Boolean).map(up)), dnsAsns: new Set(dnsAsns) };
    if (lastLeak) await compareLeaks(lastLeak, run);
    lastLeak = run;
    // The VPN offer follows a no-VPN verdict only, and not even that once this tab has seen a VPN on: someone
    // who turned theirs off to compare already has one. (Memory only, like the compare: a reload forgets it.)
    const offer = !vpn && !vpnSeen;
    vpnSeen = vpnSeen || vpn;

    if (offer) await sponsor('check');
    next(['leaktest', 'leaktest', n ? 'run it again after a fix, to compare' : 'turn your VPN on or off, then run it again to compare'],
      ['share', 'share', leakCode ? 'copy a link to your grade (no IP address or location in it)' : 'copy a link to this check, so others can run it'],
      ['man leaktest', 'man leaktest', 'what each check means and how the grade works'], ['whoami', 'whoami', 'your IP, network and location']);
  }

  // Before → after, line by line. Unchanged lines collapse into one row, except a leak that's still there.
  // Each side's summary (your addresses, networks, time zones) and the verdict are marked .yours, so copy md
  // prints only each run's status: "sites see  [INFO]  →  [OK]".
  async function compareLeaks(b, a) {
    const state = r => (r.vpnState === 'vpn' ? (r.tunnel === 'your VPN' ? 'a VPN' : r.tunnel) : r.vpnState === 'none' ? 'no VPN' : 'VPN unclear');
    const mins = Math.round((a.at - b.at) / 60000);
    line(`compared with your last run (${mins < 1 ? 'under a minute' : mins === 1 ? '1 minute' : mins + ' minutes'} ago): ${state(b) === state(a) ? state(a) + ' both times' : state(b) + ' → ' + state(a)}`, 'sys');
    const rows = [['leaks', `${b.grade || '–'} → ${a.grade || '–'}`]], same = [];
    for (const k of ['see', 'vpn', 'dns', 'webrtc', 'local', 'ipv6', 'tz', 'lang', 'conn']) {
      const x = b.lines.get(k), y = a.lines.get(k);
      if (!x && !y) continue;
      const label = (y || x).label;
      if (x && y && x.st === y.st && x.sum === y.sum && x.st !== 'warn') { same.push(label); continue; }
      const side = r => (r ? [stTag(r.st), el('span', 'yours', r.sum ? ' ' + r.sum : '')] : ['not tested']);
      const verdict = leakVerdict(k, x, y, b, a);
      rows.push([label, frag(...side(x), '  →  ', ...side(y), el('span', 'yours', verdict ? '  · ' + verdict : ''))]);
    }
    if (same.length) rows.push(['unchanged', same.join(', ')]);
    await kv(rows);
  }

  // What a change means. With the VPN on in one run and off in the other, the run without it shows what
  // a leak on the VPN gives away, so "a leak if you use a VPN" becomes a confirmed verdict either way.
  function leakVerdict(key, x, y, b, a) {
    if (!GRADED.includes(key) || !x || !y) return '';
    const bv = b.vpnState === 'vpn', av = a.vpnState === 'vpn';
    if (bv === av) return x.st === 'warn' ? (y.st === 'warn' ? 'still leaks' : 'fixed') : y.st === 'warn' ? 'new leak' : '';
    const [tun, real, realRun] = av ? [y, x, b] : [x, y, a];
    if (realRun.vpnState !== 'none') return '';    // the run without a VPN couldn't tell: nothing to confirm against
    if (tun.st === 'ok') return av ? 'not a leak with the VPN on' : 'no leak while the VPN was on';
    if (tun.st !== 'warn') return '';
    const t = tun.data || {};
    const match = key === 'webrtc' ? (t.extra || []).some(ip => realRun.ips.has(ip))
      : key === 'ipv6' ? !!t.asn && realRun.asns.has(t.asn)
      : key === 'dns' ? (t.leakAsns || []).some(n => realRun.asns.has(n) || realRun.dnsAsns.has(n))
      : real.st === 'ok';                           // time zone: your clock matched your IP without the VPN
    const why = { webrtc: "it's the address you have without the VPN", ipv6: "it's your network without the VPN",
      dns: 'the same resolvers as without the VPN', tz: 'your clock matches where your IP is without the VPN' }[key];
    return 'confirmed leak' + (match ? ': ' + why : av ? ': it gets past the VPN' : ' while the VPN was on');
  }

  // A shared result (/leaktest/r/<code>): the grade and lines someone else's browser got, from the code
  // alone. It never runs the test: that takes a click on "run yours".
  async function leakResult(code) {
    const L = LEAKLIB, r = L && L.decode(code);
    if (!r) {
      line(`${code ? `"${String(code).slice(0, 20)}" isn't` : 'That is not'} a leak test result. Result links come from share after leaktest, like /leaktest/r/1bjp.`, 'err');
      return next(['leaktest', 'leaktest', 'run the leak test on this browser'], ['man leaktest', 'man leaktest', 'how the grade works']);
    }
    const says = `this browser got ${L.article(r.grade)} on ipterm's leak test`;
    setUrl('/leaktest/r/' + r.code, `This browser got ${L.article(r.grade)} on ipterm's leak test | ipterm`);
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'leaktest'), el('span', 'tag pub', 'shared result'), el('span', 'tag', 'grade ' + r.grade));
    // The code holds no one's addresses, so nothing needs hiding: the link is this page, copy takes the grade.
    head.append(shareBar({ cmd: 'leaktest --result ' + r.code, value: r.grade, what: 'the grade', path: '/leaktest/r/' + r.code,
      text: `an ipterm leak test grade: ${r.grade}`,
      note: '   (it holds only the grade and which checks passed or leaked: no IP address, provider, location or DNS resolver; opening it never runs the test)' }));
    out.appendChild(head);
    const st = v => (v === L.LEAK ? 'warn' : v === L.PASS ? 'ok' : 'info');
    await kv([['leaks', r.grade, 'big'], ['', says + '.', 'plain'],
      ['VPN', frag(stTag(r.vpn === L.VPN_ON ? 'ok' : 'info'), ' ', L.vpnWord(r.vpn) + (r.vpn === L.VPN_NONE ? ', so nothing could leak past one' : ''))],
      ...L.CHECKS.map(([k, label]) => [label, frag(stTag(st(r[k])), ' ', L.checkWord(r[k]))])]);
    line("This is someone else's result. ipterm hasn't tested your browser, and won't until you ask. The link holds only the grade and these lines: no IP address, provider, location or DNS resolver.", 'sys');
    const d = el('div', 'ln run-yours');
    d.append(cmdLink('run yours', 'leaktest', '/leaktest'), '  tests this browser in a few seconds; nothing is stored');
    out.appendChild(d); scroll();
    announce(`Shared result: ${says}. Use run yours to test your own browser.`);
    next(['man leaktest', 'man leaktest', 'what each check means and how the grade works'], ['whoami', 'whoami', 'your IP address and network']);
  }

  const whoamiNext = d => next(['copy', 'copy', 'copy your IP address'], live && ['leaktest', 'leaktest', 'check what else your browser gives away'],
    /^AS\d+$/i.test(d.asn || '') && (live || DEMO_ASN[d.asn.toUpperCase()]) && [`asn ${d.asn}`, `asn ${d.asn}`, "your provider's network"],
    parseIp(d.ip) && classify(parseIp(d.ip))[0] === 'public' && [`whois ${d.ip}`, `whois ${d.ip}`, 'who your address is registered to']);

  async function whoami() {
    const q = line('querying…', 'sys');
    if (live) {
      const t0 = performance.now(); const d = await api('');
      if (d.error) { q.textContent = d.error; q.className = 'ln err'; announce(q.textContent); return; }
      const p = parseIp(d.ip);
      if (!p) { q.textContent = 'The server returned an address this page cannot read.'; q.className = 'ln err'; announce(q.textContent); return; }
      q.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
      setUrl('/', TITLE_HOME);
      await render(p, d.ip, d, true);
      whoamiNext(d);
      return sponsor('whoami');
    }
    q.textContent = 'ok · sample data';
    await render(parseIp(DEMO.self.ip), DEMO.self.ip, { ...DEMO.self }, true);
    whoamiNext(DEMO.self);
    return sponsor('whoami');
  }

  // pre: data the server already embedded in the page ({ data } or { error }), so no second request.
  async function lookup(raw, pre) {
    raw = String(raw || '').trim();
    if (/^as\d+$/i.test(raw)) return asn(raw, pre);
    const p = parseIp(raw);
    if (!p && looksLikeCidr(raw)) return cidr(raw);
    if (!p && looksLikeDomain(raw)) return dns(raw);
    if (!p) return line(`"${raw}" is not a valid IP address, ASN or domain. Examples: lookup 8.8.8.8, asn AS13335, lookup example.com`, 'err');
    const ipText = p.v === 4 ? p.o.join('.') : raw.toLowerCase();
    const [cls] = classify(p);
    if (cls !== 'public') {
      setUrl('/' + ipText, `${ipText} · non-public IPv${p.v} address | ipterm`);
      await render(p, ipText, null, false);
      line('This address is not routable on the public internet, so it has no owner or location to look up.', 'sys');
      const local = cls === 'private' || cls === 'ula';
      if (local) line(`If it's your router, open http://${p.v === 6 ? '[' + ipText + ']' : ipText} in a browser on the same network to reach its settings.`, 'sys');
      next(['whoami', 'whoami', 'your public IP address, the one websites see'],
        p.v === 4 && (local || cls === 'cgnat') && [`cidr ${ipText}/24`, `cidr ${ipText}/24`, 'the /24 network around this address'],
        local && ['router guide', null, "how to find your router's IP address", '/guides/find-router-ip']);
      return;
    }
    let d = null;
    if (pre) {
      if (pre.error) line(pre.error, 'err'); else d = pre.data;
    } else if (live) {
      const q = line('querying…', 'sys'); const t0 = performance.now();
      d = await api(ipText);
      if (d.error) { q.textContent = d.error; q.className = 'ln err'; announce(q.textContent); d = null; }
      else q.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    } else {
      d = DEMO[ipText] ? { ...DEMO[ipText], source: 'demo' } : null;
      if (!d) line('Preview mode has sample data for 8.8.8.8, 1.1.1.1 and 9.9.9.9 only. Owner and location for other addresses appear once the Worker is deployed. Computed details below.', 'warn');
    }
    if (d) setUrl(ipPath(ipText), ipTitle(ipText, d));
    await render(p, ipText, d, false);
    if (d) await sponsor('ip');
    if (!d && live) return;                      // the lookup failed: retry is offered instead
    const block = `${ipText}/${p.v === 4 ? 24 : 64}`;
    next(d && [`whois ${ipText}`, `whois ${ipText}`, 'registry record: owner and abuse contact'],
      d && /^AS\d+$/i.test(d.asn || '') && [`asn ${d.asn.toUpperCase()}`, `asn ${d.asn.toUpperCase()}`, 'the network this address belongs to'],
      live ? [`route ${ipText}`, `route ${ipText}`, 'the route it is in: who announces it, RPKI, AS paths']
        : [`cidr ${block}`, `cidr ${block}`, `the /${p.v === 4 ? 24 : 64} block around this address`],
      d && live && ['share', 'share', 'copy a link to this result']);
  }

  async function asn(raw, pre) {
    const m = /^(?:as)?(\d{1,10})$/i.exec(String(raw || '').trim());
    const n = m ? Number(m[1]) : 0;
    if (!m || n < 1 || n > 4294967295) return line(`"${raw}" is not a valid AS number. Example: asn AS13335`, 'err');
    const id = 'AS' + n;
    let d = null;
    if (pre) {
      if (pre.error) return line(pre.error, 'err');
      d = pre.data;
    } else if (live) {
      const q = line('querying…', 'sys'); const t0 = performance.now();
      d = await apiAsn(n);
      if (d.error) { q.textContent = d.error; q.className = 'ln err'; announce(q.textContent); return; }
      q.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    } else {
      d = DEMO_ASN[id];
      if (!d) return line('Preview mode has sample data for AS15169 and AS13335 only. Other networks appear once the Worker is deployed.', 'warn');
    }
    if (!d || !d.found) return line(`${id} has no registered holder or announced prefixes.`, 'warn');
    setUrl('/' + id, `${id} · ${d.name || d.holder || 'network'} | ipterm`);
    await renderAsn(d);
    await sponsor('asn');
    const top = (d.v4 && d.v4.prefixes && d.v4.prefixes[0]) || (d.v6 && d.v6.prefixes && d.v6.prefixes[0]);
    next([`whois ${id}`, `whois ${id}`, 'registry record: holder and abuse contact'],
      top && [`cidr ${top}`, `cidr ${top}`, 'its largest address block, and how it is routed'], live && ['share', 'share', 'copy a link to this network']);
  }

  // Sample registry records for the preview (deployed sites query the registries live).
  const DEMO_WHOIS = {
    '8.8.8.8': { query: '8.8.8.8', kind: 'ip', found: true, sample: true, registry: 'ARIN', name: 'GOGL', org: 'Google LLC',
      cidrs: ['8.8.8.0/24'], range: { start: '8.8.8.0', end: '8.8.8.255' }, type: 'DIRECT ALLOCATION',
      abuse: { email: 'network-abuse@google.com' } },
    'AS13335': { query: 'AS13335', kind: 'asn', found: true, sample: true, registry: 'ARIN', name: 'CLOUDFLARENET', org: 'Cloudflare, Inc.',
      abuse: { email: 'abuse@cloudflare.com' } },
    'example.com': { query: 'example.com', kind: 'domain', domain: 'example.com', found: true, sample: true, registry: 'Verisign',
      registrar: { name: 'RESERVED-Internet Assigned Numbers Authority', ianaId: '376' },
      registered: '1995-08-14T04:00:00Z', expires: '2027-08-13T04:00:00Z', updated: '2026-08-14T07:01:39Z',
      status: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited'],
      nameservers: ['a.iana-servers.net', 'b.iana-servers.net'], dnssec: true, registrantHidden: true, abuse: null },
  };

  /* ---------- subnet calculator ---------- */
  // The math lives in cidr.js, shared with the Worker so pages and the terminal always agree.
  const CIDRLIB = window.IPTERM_CIDR;
  const looksLikeCidr = s => { const t = String(s || '').trim(); return /\//.test(t) && !!parseIp(t.split('/')[0].trim()); };

  async function cidr(raw, pre) {
    if (!CIDRLIB) return line('The subnet calculator did not load. Reload the page and try again.', 'err');
    const input = String(raw || '').trim();
    if (pre && pre.error) return line(pre.error, 'err');
    if (!input && !pre) return toolIntro('cidr');
    const d = pre && pre.data ? pre.data : CIDRLIB.calc(input);
    if (d.error) return line(d.error, 'err');
    setUrl('/cidr/' + d.cidr, (d.v === 4 ? `${d.cidr} subnet: ${d.netmask}, ${d.usableText} usable hosts` : `${d.cidr} IPv6 subnet`) + ' | ipterm');
    await renderCidr(d);
    // A public range also gets its routing: from the page when the server sent it, else one request (RIPEstat, cached).
    let r = null;
    if (d.range === 'public' && pre && pre.route) r = pre.route;
    else if (d.range === 'public' && live && !pre) {
      const q = line('routing: asking RIPEstat…', 'sys'); const t0 = performance.now();
      r = await apiRoute(d.cidr);
      q.textContent = r.error ? r.error : `routing: ok · ${Math.round(performance.now() - t0)} ms`;
      if (r.error) q.className = 'ln warn';
    }
    if (r && r.error && pre) line(r.error, 'warn');
    if (r && !r.error) {
      await renderRoute(r);
      const o = r.origins[0];
      if (o) document.title = routeTitle(d.cidr, r);
      return next(o && [`asn ${o.asn}`, `asn ${o.asn}`, 'the network that announces it'],
        [`whois ${d.network}`, `whois ${d.network}`, 'who this block is registered to'],
        d.supernet && [`cidr ${d.supernet}`, `cidr ${d.supernet}`, 'the block twice this size'], live && ['share', 'share', 'copy a link to this prefix']);
    }
    next(d.supernet && [`cidr ${d.supernet}`, `cidr ${d.supernet}`, 'the block twice this size'],
      d.halves && d.halves[0] && [`cidr ${d.halves[0]}`, `cidr ${d.halves[0]}`, 'the first half of this block'],
      d.range === 'public' ? [`whois ${d.network}`, `whois ${d.network}`, 'who this block is registered to']
        : d.v === 4 && ['cheat sheet', null, 'subnet mask cheat sheet: /8 to /32', '/guides/subnet-cheat-sheet']);
  }

  /* ---------- routing (route) ----------
     How a public prefix or address is routed: the route that carries it, the network that originates it,
     RPKI, how many RIS peers see it, its main upstreams and a few AS paths. The Worker asks RIPEstat (never
     IPinfo) and caches the answer for six hours; the wording (summary, rpkiNote) comes with the data. */
  async function route(raw) {
    const q = String(raw || '').trim();
    if (!q || /^-/.test(q)) {                    // route -n is the Linux habit for the local table
      line("route shows how a prefix or address is routed on the internet (BGP): the network that announces it, RPKI, visibility and AS paths, from RIPEstat. Browsers can't read your own device's routing table.", 'sys');
      line('usage: route <prefix or ip>   e.g. route 1.1.1.0/24', 'sys');
      return next(['route 1.1.1.0/24', 'route 1.1.1.0/24', "Cloudflare's resolver prefix"], ['route 8.8.8.8', 'route 8.8.8.8', 'the route Google Public DNS is in'], ['man route', 'man route', 'the manual']);
    }
    if (!live) return line('route asks RIPEstat through the deployed Worker, so it works once the site is deployed.', 'warn');
    const ql = line('querying RIPEstat…', 'sys'); const t0 = performance.now();
    const d = await apiRoute(q);
    if (d.error) { ql.textContent = d.error; ql.className = 'ln err'; announce(d.error); return; }
    ql.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    const page = d.kind === 'ip' ? d.prefix : d.query, o = d.origins[0];
    if (page) setUrl('/cidr/' + page, o ? routeTitle(page, d.kind === 'ip' ? { ...d, status: 'announced' } : d) : `${page} routing | ipterm`);
    // Its own [share] [copy] [md]: the link is the page the address bar now shows (an unrouted address has
    // none, so /route/<ip>, which sends browsers to its /cidr page). copy takes the route itself.
    await renderRoute(d, { cmd: 'route ' + d.query, value: d.prefix || d.query,
      what: d.prefix ? 'the route' : d.kind === 'ip' ? 'the address' : 'the prefix', path: page ? '/cidr/' + page : '/route/' + d.query });
    next(o && [`asn ${o.asn}`, `asn ${o.asn}`, 'the network that announces it'],
      d.prefix && [`cidr ${d.prefix}`, `cidr ${d.prefix}`, 'subnet math for the route, on its own page'],
      d.prefix && [`whois ${d.prefix.split('/')[0]}`, `whois ${d.prefix.split('/')[0]}`, 'who the block is registered to'],
      ['share', 'share', 'copy a link to this route']);
  }

  // bar: route's own share bar. cidr() draws the routing under its own result without one, so the cidr result
  // stays the current one and its [md] takes in both.
  async function renderRoute(d, bar) {
    const head = el('div', 'head'), o = d.origins[0];
    head.append(el('span', 'hip', 'route ' + d.query), el('span', 'tag ' + (d.prefix ? 'pub' : 'priv'), { announced: 'announced', covered: 'routed', split: 'split', unrouted: 'not routed' }[d.status] || d.status));
    if (o && o.rpki) head.append(el('span', 'tag', o.rpki === 'not-found' ? 'no roa' : 'rpki ' + o.rpki.replace('-', ' ')));
    head.append(el('span', 'tag', 'ripestat'));
    if (bar) head.append(shareBar(bar));
    out.appendChild(head);
    const asLink = a => cmdLink(a, 'asn ' + a, '/' + a);
    const pfxLink = p => cmdLink(p, 'cidr ' + p, '/cidr/' + p);
    const rows = [];
    if (d.prefix) rows.push(['route', d.status === 'covered' ? joinFrag([pfxLink(d.prefix), d.kind === 'ip' ? '  (the route this address is in)' : '  (covers this prefix)']) : pfxLink(d.prefix), 'big']);
    else rows.push(['route', d.status === 'split' ? 'not announced as a whole' : 'not announced: no RIS peer sees a route that covers it', 'big']);
    if (d.summary) rows.push(['', d.summary, 'plain']);
    d.origins.forEach((x, i) => rows.push([i ? '' : 'origin', joinFrag([asLink(x.asn), x.name ? '  ' + x.name : ''])]));
    d.origins.filter(x => x.rpkiNote).forEach((x, i) => rows.push([i ? '' : 'RPKI', (d.origins.length > 1 ? x.asn + ': ' : '') + x.rpkiNote]));
    if (d.visibility) rows.push(['visibility', `seen by ${d.visibility.seeing} of ${d.visibility.total} RIS peers`]);
    if (d.firstSeen) rows.push(['first seen', d.firstSeen]);
    if (d.registry) rows.push(['registry', d.registry]);
    if (d.upstreams.length) rows.push(['upstreams', joinFrag(d.upstreams.flatMap((u, i) => [i ? '  ' : '', asLink(u.asn)]).concat(`  (just before the origin in ${d.routes} sampled routes)`))]);
    d.paths.forEach((p, i) => rows.push([i ? '' : 'AS paths', joinFrag(p.path.flatMap((a, j) => [j ? ' ' : '', asLink('AS' + a)]).concat(p.collector ? `  (${p.collector})` : ''))]));
    if (d.inside.length) rows.push(['more specific', joinFrag(d.inside.flatMap((p, i) => [i ? '  ' : '', pfxLink(p)]).concat(d.insideMore ? '  and more' : ''))]);
    if (d.prefix) rows.push(['collectors', d.collectors.join(' · ')]);
    await kv(rows);
    announce(d.summary || `route ${d.query}`);
  }
  // The /cidr page's title for a routed prefix (cidrPage() in worker.js words it the same way).
  function routeTitle(cidr, r) {
    const o = r.origins[0], name = o.asn + (o.name ? ' ' + o.name : '');
    const rpki = o.rpki ? (o.rpki === 'valid' ? ', RPKI valid' : o.rpki === 'not-found' ? ', no ROA' : ', RPKI invalid') : '';
    return (r.status === 'announced' ? `${cidr}: announced by ${name}${rpki}` : `${cidr}: routed in ${r.prefix} by ${name}`) + ' | ipterm';
  }
  // Text and nodes in one fragment.
  const joinFrag = parts => { const f = document.createDocumentFragment(); parts.forEach(p => { if (p !== '' && p != null) f.append(p); }); return f; };

  async function cidrTable() {
    await kv(CIDRLIB.table(16, 32).map(r => [`/${r.prefix}`, `${r.netmask.padEnd(16)} ${CIDRLIB.fmt(r.usable)} usable`]));
    if (live) {
      const d = el('div', 'ln sys'); const a = el('a', 'cmd', 'full cheat sheet: /8 to /32 ↗'); a.href = '/guides/subnet-cheat-sheet';
      d.append(a); out.appendChild(d); scroll();
    }
  }

  /* ---------- port check ----------
     "Is this port open on my IP?" The Worker connects to the address you are visiting from (never any
     other) on the one port you name, and says whether it was accepted, turned away or got no answer. It
     only runs when you ask: the /port/<n> pages explain the port and offer a button. What each port is
     for comes from ports.js, shared with the Worker; how a result reads comes from the Worker. */
  const PORTSLIB = window.IPTERM_PORTS || null;
  const portTitle = (n, s) => (s ? `Port ${n} (${s.name})` : `Port ${n}`) +
    (PORTSLIB && PORTSLIB.untestable(n) ? ": what it's for and why ipterm can't check it" : ": check if it's open on your IP") + ' | ipterm';
  const PORT_STATE = { open: ['st-ok', 'open'], closed: ['st-warn', 'closed'], 'no-answer': ['st-warn', 'no answer'], untestable: ['st-info', 'not tested'] };

  async function portIntro() {
    setUrl('/port', 'Port checker: is a port open on my IP? | ipterm');
    line("port checks whether a TCP port is open on your own IP address: ipterm connects to the address you are visiting from, on the one port you name, and reports open, closed or no answer. It never tests anyone else's address.", 'sys');
    line('usage: port <number>   e.g. port 25565    port <number> --info explains a port without checking it', 'sys');
    const d = el('div', 'ln sys'); d.append('try: ');
    [25565, 32400, 22, 3389].forEach((n, i) => { if (i) d.append('  ·  '); d.append(cmdLink(`port ${n}`, `port ${n}`, `/port/${n}`)); });
    out.appendChild(d);
    if (PORTSLIB) {                            // what each common port is for (a click explains it; nothing is checked)
      const c = el('div', 'ln sys'); c.append('common ports: ');
      PORTSLIB.list().forEach((n, i) => { if (i) c.append('  ·  '); c.append(cmdLink(`${n} ${PORTSLIB.get(n).name}`, `port ${n} --info`, `/port/${n}`)); });
      out.appendChild(c);
    }
    scroll();
    announce('Port checker. Type port and a number to check whether that port is open on your own IP address.');
  }

  async function portAbout(n) {
    const s = PORTSLIB && PORTSLIB.get(n);
    setUrl('/port/' + n, portTitle(n, s));
    const head = el('div', 'head');
    head.append(el('span', 'hip', `port ${n}`), el('span', 'tag', s ? s.proto : 'tcp'), el('span', 'tag', 'about'));
    head.append(shareBar({ cmd: `port ${n} --info`, value: String(n), what: 'the port number', path: '/port/' + n }));
    out.appendChild(head);
    const rows = s ? [['service', s.name], ['used for', s.use], ['protocol', PORTSLIB.protoText(s.proto)], ['if closed', s.tips]]
      : [['protocol', 'TCP'], ['', `Port ${n} isn't one of the common ports ipterm describes, but it can still be checked.`, 'plain']];
    if (s && s.risk) rows.push(['caution', s.risk]);
    const blocked = PORTSLIB && PORTSLIB.untestable(n);   // port 25: say so, and offer no check
    const f = document.createDocumentFragment();
    f.append(cmdButton(`check port ${n} now`, `port ${n}`), '  on the address you are visiting from (one connection; nothing is stored)');
    rows.push(['check', blocked ? `ipterm can't check this port: ${blocked}` : f]);
    await kv(rows);
    const then = blocked ? `ipterm can't check this port: ${blocked}` : 'Use the check button to test it on your address.';
    announce(s ? `Port ${n}, ${s.name}: ${s.use} ${then}` : `Port ${n}. ${then}`);
    next(['port', 'port', 'common ports and how the check works'], ['man port', 'man port', 'the manual']);
  }

  async function portCheck(n) {
    setUrl('/port/' + n, portTitle(n, PORTSLIB && PORTSLIB.get(n)));
    if (!live) return line('The port check tests your real connection, so it only runs on the deployed site.', 'warn');
    const q = line(`connecting to your address on TCP port ${n}… (up to 5 seconds; nothing is stored)`, 'sys'); const t0 = performance.now();
    // X-Ipterm: browsers without Sec-Fetch-Site send no Origin here either, and the Worker needs to know
    // the request comes from this page (a cross-site page can't add the header).
    const d = await getJson('/api/port?n=' + n, { 'x-ipterm': 'port' });
    if (d.error) { q.textContent = d.error; q.className = 'ln err'; announce(d.error); return; }
    q.textContent = `done · ${Math.round(performance.now() - t0)} ms`;
    const [cls, label] = PORT_STATE[d.state] || PORT_STATE.untestable, svc = d.service;
    const head = el('div', 'head');
    head.append(el('span', 'hip', `port ${n}`), el('span', 'tag', 'tcp'), el('span', 'tag ' + cls, label));
    if (d.version) head.append(el('span', 'tag', 'IPv' + d.version));
    // The notes may name your provider (one known for carrier-grade NAT): its Markdown hides that too.
    head.append(shareBar({ cmd: `port ${n}`, value: String(n), what: 'the port number', path: '/port/' + n, self: true, hide: [own(d.ip)],
      terms: PORTSLIB ? PORTSLIB.cgnatNames() : [], drop: SELF_DROP }));
    out.appendChild(head);
    const rows = [['port', `${n}/tcp` + (svc ? '  ' + svc.name : '')]];
    if (d.ip) rows.push(['your address', `${d.ip}  (IPv${d.version}: the address you connected from, the only one ipterm tests)`]);
    if (d.version === 6) {                     // the address a router's port forward applies to, which this couldn't test
      const slot = el('span', 'ttl', 'checking…');
      rows.push(['IPv4', slot]);
      otherFamily(6).then(v4 => { slot.className = ''; slot.textContent = v4 ? `${v4}  not tested: you reached ipterm over IPv6 (curl -4 tests it)` : 'none detected: your connection looks IPv6 only'; });
    }
    rows.push(['result', d.summary || label]);
    if (svc && svc.use) rows.push(['used for', svc.use]);
    (d.notes || []).forEach((t, i) => rows.push([i ? '' : 'notes', t]));
    await kv(rows);
    announce(d.summary || label);
    const about = svc && [`port ${n} --info`, `port ${n} --info`, `what port ${n} is used for`];
    if (d.state === 'open') next(about, ['port', 'port', 'check another port'], ['share', 'share', "copy a link to this port's page"], ['whoami', 'whoami', 'your IP address and network']);
    else next(d.state !== 'untestable' && ['check again', `port ${n}`, 'run the check again after a change'], about, ['port', 'port', 'common ports'], ['whoami', 'whoami', 'your IP address and network']);
  }

  function portCmd(args) {
    if (!args.length) return portIntro();
    if (!PORTSLIB) return line('The port list did not load. Reload the page and try again.', 'err');
    const [a, b] = args, n = PORTSLIB.parse(a);
    // Only ever your own address, one port at a time: say so instead of guessing at what was meant.
    if (parseIp(a) || looksLikeDomain(a)) return line(`port only checks your own address, so it takes just a port number: port ${PORTSLIB.parse(b) || 22}`, 'warn');
    if (n == null) return line(/^\d+\s*[-,:]/.test(a) ? 'One port at a time: port <number>, e.g. port 22' : `"${a}" is not a port number. Ports run from 1 to 65535: port 22`, 'err');
    if (b && /^(--?info|info|about)$/i.test(b)) return portAbout(n);
    return portCheck(n);
  }

  /* ---------- tool intros (/whois, /dns, /cidr, or the command on its own) ---------- */
  const TOOL_INTRO = {
    whois: { url: '/whois', title: 'Whois lookup: who owns a domain, IP address or network | ipterm',
      text: 'whois shows who a domain, IP address or network is registered to: registrar, dates, name servers, owner and abuse contact.',
      usage: 'usage: whois <ip, ASN or domain>',
      ex: [['whois example.com', '/whois/example.com'], ['whois github.com', '/whois/github.com'], ['whois 8.8.8.8', '/whois/8.8.8.8'], ['whois AS13335', '/whois/AS13335']] },
    dns: { url: '/dns', title: 'DNS lookup: A, AAAA, MX, NS, TXT and CAA records | ipterm',
      text: "dig looks up a domain's DNS records: addresses, mail servers, name servers, TXT and CAA. Give it an IP address for reverse DNS.",
      usage: 'usage: dig <domain> [type]   types: A AAAA CNAME MX NS TXT CAA SOA SRV PTR DS DNSKEY HTTPS',
      ex: [['dig example.com', '/dns/example.com'], ['dig gmail.com MX', '/dns/gmail.com/MX'], ['dig github.com TXT', '/dns/github.com/TXT'], ['dig 8.8.8.8', '/dns/8.8.8.8']] },
    mail: { url: '/mail', title: 'Email security check: SPF, DMARC, DKIM and MX records | ipterm',
      text: "mail checks a domain's email security: mail servers, SPF, DMARC, DKIM, MTA-STS, TLS-RPT and BIMI, graded A to F with a fix for each problem.",
      usage: 'usage: mail <domain> [--dkim <selector>]',
      ex: [['mail gmail.com', '/mail/gmail.com'], ['mail outlook.com', '/mail/outlook.com'], ['mail github.com', '/mail/github.com'], ['mail example.com', '/mail/example.com']] },
    grade: { url: '/grade', title: 'Domain report card: DNSSEC, security headers, email and expiry, graded A to F | ipterm',
      text: "grade gives a domain a report card, graded A to F: DNSSEC, IPv6, CAA and HTTPS records, the email security grade, the registration's expiry and transfer lock, and the website's HTTPS redirect and security headers, with a fix for each problem and a badge for your README.",
      usage: 'usage: grade <domain>',
      ex: [['grade github.com', '/grade/github.com'], ['grade cloudflare.com', '/grade/cloudflare.com'], ['grade example.com', '/grade/example.com'], ['grade wikipedia.org', '/grade/wikipedia.org']] },
    cidr: { url: '/cidr', title: 'Subnet calculator: CIDR, netmask and usable host range | ipterm',
      text: 'cidr works out a subnet: network and broadcast addresses, netmask, wildcard, usable host range and host count. IPv6 works too. For a public range it also shows how it is routed (route).',
      usage: 'usage: cidr <range>   also accepts an address and netmask: cidr 192.168.1.10 255.255.255.0',
      ex: [['cidr 192.168.1.0/24', '/cidr/192.168.1.0/24'], ['cidr 10.0.0.0/22', '/cidr/10.0.0.0/22'], ['cidr 172.16.0.0/12', '/cidr/172.16.0.0/12'], ['cidr 1.1.1.0/24', '/cidr/1.1.1.0/24']] },
  };
  async function toolIntro(tool) {
    const t = TOOL_INTRO[tool];
    setUrl(t.url, t.title);
    line(t.text, 'sys');
    line(t.usage, 'sys');
    const d = el('div', 'ln sys'); d.append('try: ');
    t.ex.forEach(([c, href], i) => { if (i) d.append('  ·  '); d.append(cmdLink(c, c, href)); });
    out.appendChild(d); scroll();
    if (tool === 'cidr' && CIDRLIB) await cidrTable();
    announce(t.text + ' ' + t.usage);
  }

  // A 404, or a search /go couldn't read (init.message, and maybe two suggestions: a number is an ASN or a port).
  function notFound(init) {
    line(init.message || `ipterm: ${init.path}: no such page (404)`, 'err');
    const list = [].concat(init.suggest || []).filter(s => s && s.href);
    if (list.length) {
      const d = el('div', 'ln sys'); d.append('did you mean: ');
      list.forEach((s, i) => {
        if (i) d.append(' or ');
        if (s.cmd) d.append(cmdLink(s.cmd, s.cmd, s.href));
        else { const a = el('a', 'cmd', s.label || s.href); a.href = s.href; d.append(a); }
      });
      d.append(' ?'); out.appendChild(d);
    }
    const d = el('div', 'ln sys'); d.append('type help for commands, or run ');
    d.append(cmdLink('whoami', 'whoami', '/')); d.append(' to see your own IP address.');
    out.appendChild(d); scroll();
  }

  function bitsFragment(bits, n) {               // network bits in the accent color, host bits dim
    const f = document.createDocumentFragment(); let count = 0, cls = null, buf = '', cut = false;
    const flush = () => { if (buf) { f.append(cls ? el('span', cls, buf) : document.createTextNode(buf)); buf = ''; } };
    for (const ch of bits) {
      const c = ch === '.' ? null : (count < n ? 'bits-net' : 'bits-host');
      if (c !== cls) { flush(); cls = c; }
      if (!cut && count === n && n > 0 && n < 32) { flush(); f.append(el('span', 'bits-cut', '|')); cut = true; }   // divider, not just color
      buf += ch; if (ch !== '.') count++;
    }
    flush();
    f.append(el('span', 'ttl', `   ${n} network · ${32 - n} host bits`));
    return f;
  }

  async function renderCidr(d) {
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'cidr ' + d.cidr), el('span', 'tag', 'IPv' + d.v), el('span', 'tag ' + (d.range === 'public' ? 'pub' : 'priv'), d.range), el('span', 'tag', 'calculated'));
    head.append(shareBar({ cmd: 'cidr ' + d.cidr, value: d.cidr, what: 'the range', path: '/cidr/' + d.cidr }));
    out.appendChild(head);
    const link = c => cmdLink(c, 'cidr ' + c, '/cidr/' + c);
    const both = list => { const f = document.createDocumentFragment(); list.forEach((c, i) => { if (i) f.append('  ·  '); f.append(link(c)); }); return f; };
    const rows = [['network', d.cidr, 'big']];
    if (d.v === 4) {
      rows.push(['netmask', d.netmask], ['wildcard', d.wildcard]);
      if (d.prefix <= 30) rows.push(['broadcast', d.broadcast]);
      rows.push(['usable hosts', `${d.first} – ${d.last}`], ['host count', `${d.usableText} usable · ${d.totalText} addresses` + (d.prefix === 31 ? '  (point-to-point, RFC 3021)' : '')]);
      if (d.hostIndex) rows.push(['your address', `${d.ip} is address #${CIDRLIB.fmt(d.hostIndex)} in this network`]);
      rows.push(['bits', bitsFragment(d.bits, d.prefix)]);
      if (d.halves) rows.push(['splits into', both(d.halves)]);
      if (d.slash24s && d.slash24s > 2) rows.push(['contains', `${CIDRLIB.fmt(d.slash24s)} × /24 networks`]);
      if (d.supernet) rows.push(['part of', link(d.supernet)]);
      rows.push(['range', d.rangeNote], ['legacy class', `${d.legacyClass} (classful addressing is historical)`]);
    } else {
      rows.push(['first address', d.network], ['last address', d.last], ['addresses', `${d.totalPow} = ${d.totalText}`]);
      if (d.subnets64) rows.push(['/64 subnets', d.subnets64]);
      rows.push(['expanded', d.expanded]);
      if (d.halves) rows.push(['splits into', both(d.halves)]);
      if (d.supernet) rows.push(['part of', link(d.supernet)]);
      rows.push(['range', d.rangeNote]);
    }
    if (d.range === 'public') rows.push(['registry', cmdLink(`whois ${d.network}`, `whois ${d.network}`, `/whois/${d.network}`)]);
    await kv(rows);
    announce(d.v === 4
      ? `${d.cidr}: netmask ${d.netmask}, ${d.usableText} usable hosts from ${d.first} to ${d.last}.`
      : `${d.cidr}: ${d.totalPow} addresses` + (d.subnets64 ? `, ${d.subnets64} /64 subnets.` : '.'));
  }

  /* ---------- DNS ---------- */
  const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA', 'SOA', 'SRV', 'PTR', 'DS', 'DNSKEY', 'HTTPS'];
  function domainOf(raw) {                     // accept pasted URLs: https://example.com/page -> example.com
    raw = String(raw || '').trim();
    if (/^https?:\/\//i.test(raw)) { try { return new URL(raw).hostname; } catch { return raw; } }
    return raw.replace(/[/?#].*$/, '').replace(/\.$/, '');
  }
  function looksLikeDomain(raw) {
    const d = domainOf(raw);
    return d.length <= 253 && !/[\s:@\\]/.test(d) && /^[^.]+(\.[^.]+)+$/.test(d) && /[^\d.]/.test(d.split('.').pop());
  }
  // A label starting with "_" (_dmarc.gmail.com) names a DNS record, not a domain: dig takes it, grade doesn't.
  function recordName(raw) { return /(^|\.)_/.test(domainOf(raw)); }
  // Sample records for the preview, using documentation addresses (deployed sites query DNS live).
  const DEMO_DNS = {
    'example.com': { name: 'example.com', sample: true, status: 'NOERROR', dnssec: true, cname: [],
      types: ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA'],
      records: { A: [{ ttl: 300, value: '192.0.2.10' }], AAAA: [{ ttl: 300, value: '2001:db8::10' }],
        MX: [{ ttl: 3600, priority: 10, value: 'mail.example.com' }], NS: [{ ttl: 86400, value: 'a.iana-servers.net' }, { ttl: 86400, value: 'b.iana-servers.net' }],
        TXT: [{ ttl: 3600, value: 'v=spf1 -all' }] } },
  };

  async function dns(raw, type, pre) {
    const q = domainOf(raw).toLowerCase();
    const t = type ? String(type).toUpperCase() : null;
    if (t && !DNS_TYPES.includes(t)) return line(`Unsupported record type "${type}". Try one of: ${DNS_TYPES.join(', ')}`, 'err');
    const p = parseIp(q);
    if (p && classify(p)[0] !== 'public') return line(`${q} is a non-public address, so it has no public reverse DNS.`, 'sys');
    if (!p && !looksLikeDomain(q)) return line(`"${raw}" is not a valid domain name. Example: dig example.com`, 'err');
    let d = null;
    if (pre) {
      if (pre.error) return line(pre.error, 'err');
      d = pre.data;
    } else if (live) {
      const ql = line('resolving…', 'sys'); const t0 = performance.now();
      d = await apiDns(q, t);
      if (d.error) { ql.textContent = d.error; ql.className = 'ln err'; announce(d.error); return; }
      ql.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    } else {
      const s = DEMO_DNS[q];
      if (!s || (t && !s.records[t])) return line('Preview mode has sample DNS records for example.com only (A, AAAA, MX, NS, TXT). Live DNS lookups work once the Worker is deployed.', 'warn');
      d = t ? { ...s, types: [t] } : s;
    }
    const single = d.types && d.types.length === 1 ? d.types[0] : null;
    setUrl('/dns/' + d.name + (single && !p ? '/' + single : ''), `${d.name} ${single ? single + ' record' : 'DNS records'} | ipterm`);
    await renderDns(d, single);
  }

  // An MX record pointing at "." is a null MX (RFC 7505): the domain accepts no mail. Matches worker.js.
  const nullMx = r => r.value === '.' || r.value === '';
  async function renderDns(d, single) {
    const head = el('div', 'head');
    head.append(el('span', 'hip', (single ? `dig ${d.name} ${single}` : d.name)), el('span', 'tag pub', 'dns'));
    head.append(el('span', 'tag', d.dnssec ? 'dnssec ✓' : 'unsigned'));
    head.append(el('span', 'tag', d.sample ? 'sample data' : '1.1.1.1'));
    const one = single && !parseIp(d.name) ? single : '';   // a reverse lookup's page is /dns/<ip>
    head.append(shareBar({ cmd: `dig ${d.name}${one ? ' ' + one : ''}`, value: d.name, what: 'the name', path: `/dns/${d.name}${one ? '/' + one : ''}` }));
    out.appendChild(head);
    if (d.status === 'NXDOMAIN') {
      line(`${d.name} does not exist (NXDOMAIN).`, 'warn');
      return next([`whois ${d.name}`, `whois ${d.name}`, 'is the name registered? (a domain can be registered without DNS records)']);
    }
    if (d.status && d.status !== 'NOERROR') { line(`The resolver answered ${d.status} for ${d.name}.`, 'warn'); return; }
    const R = d.records || {};
    const frag = () => document.createDocumentFragment();
    const ipLink = v => (parseIp(v) ? cmdLink(v, 'lookup ' + v, '/' + v) : document.createTextNode(v));
    const nameLink = v => (looksLikeDomain(v) ? cmdLink(v, 'lookup ' + v, '/dns/' + v) : document.createTextNode(v));
    const ttl = r => (single && r.ttl != null ? el('span', 'ttl', `  ttl ${r.ttl}s`) : null);
    const rows = [];
    if (d.cname && d.cname.length) { const f = frag(); d.cname.forEach((c, i) => { if (i) f.append(' → '); f.append(nameLink(c)); }); rows.push(['alias of', f]); }
    const order = single ? [single] : d.types;
    for (const t of order) {
      const list = R[t];
      if (!list || !list.length) { if (single || ['A', 'MX', 'NS'].includes(t)) rows.push([t, 'none']); continue; }
      list.forEach((r, i) => {
        const f = frag();
        if (t === 'A' || t === 'AAAA') f.append(ipLink(r.value));
        else if (t === 'MX') { f.append(`${r.priority}  `); f.append(nullMx(r) ? '. (accepts no mail: null MX)' : nameLink(r.value)); }
        else if (t === 'NS' || t === 'CNAME' || t === 'PTR') f.append(nameLink(r.value));
        else if (t === 'SOA' && r.admin) f.append(`${r.value}  ${r.admin}  serial ${r.serial}`);
        else if (t === 'SRV' && r.port != null) { f.append(`${r.priority} ${r.weight} ${r.port}  `); f.append(nameLink(r.value)); }
        else f.append(r.value);
        const tl = ttl(r); if (tl) f.append(tl);
        rows.push([i === 0 ? t : '', f]);
      });
    }
    if (d.hosting && d.hosting.org) {
      const f = frag();
      f.append(cmdLink(d.hosting.org, 'lookup ' + d.hosting.ip, '/' + d.hosting.ip));
      if (/^AS\d{1,10}$/i.test(d.hosting.asn || '')) { f.append('  '); f.append(cmdLink(d.hosting.asn, 'asn ' + d.hosting.asn, '/' + d.hosting.asn)); }
      if (d.hosting.country) f.append('  · ' + d.hosting.country);
      rows.push(['hosted by', f]);
    }
    if (!parseIp(d.name)) rows.push(['DNSSEC', d.dnssec ? 'validated: answers are cryptographically signed' : 'not validated (the domain is not signed)']);
    if (!parseIp(d.name) && !single) rows.push(['registration', cmdLink(`whois ${d.name}`, `whois ${d.name}`, `/whois/${d.name}`)]);
    // A domain with mail servers or an SPF record gets a way to the mail check (it reads live DNS, so not in the preview).
    const hasMail = live && !d.sample && !parseIp(d.name) && ((R.MX || []).length > 0 || (R.TXT || []).some(r => /^v=spf1(\s|$)/i.test(r.value)));
    if (hasMail) rows.push(['mail check', cmdLink(`mail ${d.name}`, `mail ${d.name}`, `/mail/${d.name}`)]);
    await kv(rows);
    if (d.sample) line('Sample data with documentation addresses. The live version queries DNS directly.', 'sys');
    const A = (R.A || []).map(r => r.value), MX = (R.MX || []).filter(r => !nullMx(r)).map(r => r.value), PTR = (R.PTR || []).map(r => r.value);
    const share = live && !d.sample && ['share', 'share', 'copy a link to these records'];
    const mailNext = hasMail && [`mail ${d.name}`, `mail ${d.name}`, 'email security: SPF, DMARC and DKIM, graded A to F'];
    if (parseIp(d.name)) next([`lookup ${d.name}`, `lookup ${d.name}`, 'owner and approximate location'], [`whois ${d.name}`, `whois ${d.name}`, 'registry record'],
      PTR[0] && looksLikeDomain(PTR[0]) && [`dig ${PTR[0]}`, `dig ${PTR[0]}`, 'look the name up the other way']);
    else if (single) next([`dig ${d.name}`, `dig ${d.name}`, 'all the common record types'], mailNext || gradeNext(d.name), [`whois ${d.name}`, `whois ${d.name}`, 'registrar, dates and status'], share);
    else next([`whois ${d.name}`, `whois ${d.name}`, 'registrar, registration and expiry dates'], mailNext, gradeNext(d.name),
      !mailNext && d.hosting && d.hosting.ip && [`lookup ${d.hosting.ip}`, `lookup ${d.hosting.ip}`, 'who runs the server, and where'], share);
    announce(parseIp(d.name) ? `${d.name}: reverse DNS ${PTR[0] || 'none'}.`
      : single ? `${d.name} ${single}: ${(R[single] || []).length} record(s).`
      : `${d.name}: ` + (A.length ? `resolves to ${A.slice(0, 2).join(', ')}` : 'no IPv4 address') + (MX.length ? `, mail by ${MX[0]}` : R.MX && R.MX.length ? ', accepts no mail' : '') +
        (d.hosting && d.hosting.org ? `, hosted by ${d.hosting.org}` : '') + '.');
  }

  // The report card, offered after dig, whois and mail (it reads live DNS and the site, so not in the preview).
  // Never for a record name (_dmarc.gmail.com): it has no site or mail of its own, so the Worker refuses it.
  const gradeNext = name => live && !recordName(name) && [`grade ${name}`, `grade ${name}`, 'report card: DNSSEC, email, expiry and security headers, graded A to F'];

  /* ---------- mail check ----------
     mail <domain> [--dkim <selector>]: the Worker reads the records (MX, SPF, DMARC, DKIM, MTA-STS,
     TLS-RPT, BIMI) and grades them; this draws its OK / WARN / FAIL / INFO lines, like leaktest's. */
  function mailArgs(args) {                     // --dkim <selector> or --dkim=<selector>, before or after the domain
    let dom = null, sel = null, err = null;
    for (let i = 0; i < args.length; i++) {
      const m = /^--?dkim(?:=(.*))?$/i.exec(args[i]);
      if (m) { sel = m[1] != null ? m[1] : args[++i] || ''; if (!sel) err = 'usage: mail <domain> --dkim <selector>   example: mail outlook.com --dkim selector1'; }
      else if (!dom) dom = args[i];
    }
    return { dom, sel, err };
  }

  async function mail(args, pre) {
    const { dom, sel, err } = mailArgs(args);
    if (err) return line(err, 'warn');
    const q = domainOf(dom || '').toLowerCase();
    if (parseIp(q)) return line('The mail check needs a domain name, not an IP address. Example: mail gmail.com', 'err');
    if (!looksLikeDomain(q)) return line(`"${dom}" is not a valid domain name. Example: mail gmail.com`, 'err');
    let d = null;
    if (pre) {
      if (pre.error) return line(pre.error, 'err');
      d = pre.data;
    } else if (live) {
      const ql = line('checking mail records…', 'sys'); const t0 = performance.now();
      d = await apiMail(q, sel);
      if (d.error) { ql.textContent = d.error; ql.className = 'ln err'; announce(d.error); return; }
      ql.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    } else return line('The mail check reads live DNS, so it works once the Worker is deployed.', 'warn');
    const path = '/mail/' + d.domain + (d.selector ? '?dkim=' + encodeURIComponent(d.selector) : '');
    if (d.status !== 'NOERROR') {
      setUrl(path, `${d.domain} mail check | ipterm`);
      line(d.status === 'NXDOMAIN' ? `${d.domain} does not exist (NXDOMAIN), so it has no mail records.`
        : `The mail check for ${d.domain} could not run: the resolver answered ${d.status}.`, 'warn');
      return next([`whois ${d.domain}`, `whois ${d.domain}`, 'is the name registered?']);
    }
    setUrl(path, `${d.domain} SPF, DMARC and DKIM check: grade ${d.grade} | ipterm`);
    await renderMail(d);
    next(gradeNext(d.domain), [`dig ${d.domain} TXT`, `dig ${d.domain} TXT`, 'every TXT record, SPF included'],
      ['man mail', 'man mail', 'what each check means and how the grade works'], ['share', 'share', 'copy a link to this check']);
  }

  const MAIL_TAG = { ok: 'st-ok', warn: 'st-caution', fail: 'st-fail', info: 'st-info' };
  async function renderMail(d) {
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'mail ' + d.domain), el('span', 'tag pub', 'email'), el('span', 'tag', 'grade ' + d.grade), el('span', 'tag', '1.1.1.1'));
    head.append(shareBar({ cmd: 'mail ' + d.domain + (d.selector ? ' --dkim ' + d.selector : ''), value: d.domain, what: 'the domain',
      path: '/mail/' + d.domain + (d.selector ? '?dkim=' + encodeURIComponent(d.selector) : '') }));
    out.appendChild(head);
    const frag = (...parts) => { const f = document.createDocumentFragment(); parts.forEach(p => f.append(p)); return f; };
    const c = d.counts || {};
    const tally = c.fail || c.warn ? [c.fail && `${c.fail} FAIL`, c.warn && `${c.warn} WARN`].filter(Boolean).join(', ') : 'no problems found';
    const rows = [['grade', d.grade, 'big'], ['', tally + (c.info ? `, plus ${c.info} INFO line${c.info > 1 ? "s that don't" : " that doesn't"} count` : ''), 'plain']];
    let prev = null;
    for (const x of d.checks || []) {             // one line per finding, with a fix under each problem
      rows.push([x.check === prev ? '' : x.check, frag(el('span', 'tag ' + (MAIL_TAG[x.status] || 'st-info'), x.status), ' ', x.text)]);
      if (x.fix) rows.push(['', 'fix: ' + x.fix, 'plain']);
      prev = x.check;
    }
    rows.push('sep');
    const nameLink = v => (looksLikeDomain(v) ? cmdLink(v, 'lookup ' + v, '/dns/' + v) : document.createTextNode(v));
    const mx = (d.mx && d.mx.records) || [];
    if (!mx.length) rows.push(['MX records', 'none']);
    mx.forEach((r, i) => rows.push([i ? '' : 'MX records', frag(`${r.priority != null ? r.priority : ''}  `, nullMx({ value: r.host }) ? '. (accepts no mail: null MX)' : nameLink(r.host))]));
    const spf = d.spf || {};
    if (spf.record) [spf.record, ...(spf.others || [])].forEach((v, i) => rows.push([i ? '' : 'SPF record', v]));
    if (spf.includes && spf.includes.length) {
      const shown = spf.includes.slice(0, 12).map(x => cmdLink(x, `dig ${x} TXT`, `/dns/${x}/TXT`));
      rows.push(['SPF includes', frag(joined(shown), spf.includes.length > 12 ? `  and ${spf.includes.length - 12} more` : '')]);
    }
    if (d.dmarc) rows.push(['DMARC record', frag(d.dmarc.record, d.dmarc.inherited ? el('span', 'ttl', `  at _dmarc.${d.dmarc.from}`) : '')]);
    if (d.dkim) {                                 // which had a key, and which the resolver couldn't read (as dkimNote in worker.js)
      const un = d.dkim.unanswered || [];
      const note = [d.dkim.keys.length ? `found: ${d.dkim.keys.map(k => k.selector).join(', ')}` : un.length < d.dkim.selectors.length ? 'none found' : null,
        un.length ? `couldn't read: ${un.join(', ')}` : null].filter(Boolean).join('; ');
      rows.push(['DKIM selectors', frag(d.dkim.selectors.join(', '), el('span', 'ttl', '  ' + note))]);
    }
    const m = d.mtaSts, p = m && m.policy;
    if (m) rows.push(['MTA-STS record', m.record]);
    if (p) rows.push(['MTA-STS policy', p.error ? `${p.url} ${p.error}` : `mode ${p.mode || '?'} · mx ${p.mx.join(' ') || 'none'} · max_age ${p.maxAge != null ? p.maxAge : '?'}`]);
    if (d.tlsRpt) rows.push(['TLS-RPT record', d.tlsRpt.record]);
    if (d.bimi) rows.push(['BIMI record', d.bimi.record]);
    await kv(rows);
    const worst = (d.checks || []).find(x => x.status === 'fail') || (d.checks || []).find(x => x.status === 'warn');
    announce(`mail ${d.domain}: grade ${d.grade}, ${tally}.` + (worst ? ` First problem: ${worst.check}, ${worst.text}.` : ''));
  }

  /* ---------- domain report card ----------
     grade <domain>: the Worker reads DNS (DNSSEC, AAAA, CAA, HTTPS), the mail check, the registration (RDAP) and
     the site's own headers (one HEAD to https:// and one to http://), and grades them A to F; this draws its
     OK / WARN / FAIL / INFO lines like the mail check's, then the Markdown for a README badge. */
  async function grade(args, pre) {
    const dom = args[0];
    const q = domainOf(dom || '').toLowerCase();
    if (parseIp(q)) return line('grade needs a domain name, not an IP address. Example: grade github.com', 'err');
    if (!looksLikeDomain(q)) return line(`"${dom}" is not a valid domain name. Example: grade github.com`, 'err');
    let d = null;
    if (pre) {
      if (pre.error) return line(pre.error, 'err');
      d = pre.data;
    } else if (live) {
      const ql = line('checking DNS, email, the registration and the website…', 'sys'); const t0 = performance.now();
      d = await apiGrade(q);
      if (d.error) { ql.textContent = d.error; ql.className = 'ln err'; announce(d.error); return; }
      ql.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    } else return line('The report card reads live DNS and asks the site itself, so it works once the Worker is deployed.', 'warn');
    const path = '/grade/' + d.domain;
    if (!d.grade) {
      setUrl(path, `${d.domain} report card | ipterm`);
      line(d.status === 'NXDOMAIN' ? `${d.domain} does not exist (NXDOMAIN), so there is nothing to grade.`
        : `The report card for ${d.domain} could not run: the resolver answered ${d.status}.`, 'warn');
      return next([`whois ${d.domain}`, `whois ${d.domain}`, 'is the name registered?']);
    }
    setUrl(path, `${d.domain} security report card: grade ${d.grade} | ipterm`);
    await renderGrade(d);
    next([`mail ${d.domain}`, `mail ${d.domain}`, 'every email finding, with its fix'], [`dig ${d.domain}`, `dig ${d.domain}`, 'its DNS records'],
      [`whois ${d.domain}`, `whois ${d.domain}`, 'registrar, dates and status'], ['copy badge', 'copy badge', 'copy a README badge for this grade, as Markdown']);
  }

  // The README badge as Markdown: shields.io's (it fetches /badge/<domain>.json, so readers never contact ipterm) and
  // ipterm's own SVG. The same as badgeLinks() in worker.js.
  function badgeMd(name) {
    const o = live ? location.origin : 'https://your-domain', page = `${o}/grade/${name}`;
    return { shields: `[![domain security grade](https://img.shields.io/endpoint?url=${encodeURIComponent(`${o}/badge/${name}.json`)})](${page})`,
      svg: `[![domain security grade](${o}/badge/${name}.svg)](${page})` };
  }
  async function renderGrade(d) {
    const badge = badgeMd(d.domain);
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'grade ' + d.domain), el('span', 'tag pub', 'report card'), el('span', 'tag', 'grade ' + d.grade));
    head.append(shareBar({ cmd: 'grade ' + d.domain, value: d.domain, what: 'the domain', path: '/grade/' + d.domain, badge: badge.shields }));
    out.appendChild(head);
    const frag = (...parts) => { const f = document.createDocumentFragment(); parts.forEach(p => f.append(p)); return f; };
    const c = d.counts || {}, skipped = [...new Set(d.notChecked || [])];
    const tally = c.fail || c.warn ? [c.fail && `${c.fail} FAIL`, c.warn && `${c.warn} WARN`].filter(Boolean).join(', ') : 'no problems found';
    const rows = [['grade', d.grade, 'big'], ['', tally + (c.info ? `, plus ${c.info} INFO line${c.info > 1 ? "s that don't" : " that doesn't"} count` : '') +
      (skipped.length ? `. Not checked: ${skipped.join(', ')}` : ''), 'plain']];
    let prev = null, sec = null;
    for (const x of d.checks || []) {             // one line per finding, the mail check's main ones under its line, a fix under each problem
      if (sec && x.section !== sec) rows.push('sep');
      sec = x.section;
      rows.push([x.check === prev ? '' : x.check, frag(el('span', 'tag ' + (MAIL_TAG[x.status] || 'st-info'), x.status), ' ', x.text)]);
      (x.details || []).forEach(t => rows.push(['', '  ' + t, 'plain']));
      if (x.fix) rows.push(['', 'fix: ' + x.fix, 'plain']);
      prev = x.check;
    }
    rows.push('sep');
    const dn = d.dns || {}, r = d.registration, w = d.web && d.web.https;
    // Addresses stay plain text: a link to /<ip> would let crawlers that run scripts spend IPinfo lookups.
    if (dn.addresses && dn.addresses.length) rows.push(['addresses', dn.addresses.slice(0, 4).join('  ') + (dn.addresses.length > 4 ? `  and ${dn.addresses.length - 4} more` : '')]);
    if (dn.caa) dn.caa.records.forEach((v, i) => rows.push([i ? '' : dn.caa.from !== d.domain ? `CAA (${dn.caa.from})` : 'CAA records', v]));
    if (r && r.registrar) rows.push(['registrar', r.registrar]);
    if (w && w.headers) rows.push(['page checked', w.final]);
    await kv(rows);
    // The badge: Markdown to paste into a README, with a copy button each (copy badge copies the first).
    const snip = (label, md) => {
      const b = el('button', 'share-btn', 'copy'); b.type = 'button'; b.setAttribute('aria-label', 'Copy the badge Markdown');
      b.addEventListener('click', () => toClipboard(md).then(ok => (ok ? flash(b, 'copied the badge Markdown') : line('The clipboard is blocked here, so select the Markdown below and copy it by hand.', 'warn'))));
      const t = el('div', 'ln sys badge-snip'); t.append(label + '  ', b);
      out.append(t, el('div', 'ln snippet badge-snip', md));
    };
    snip("README badge (shields.io draws it, so your readers' browsers never contact ipterm):", badge.shields);
    snip("or the same badge served by ipterm itself (each reader's browser fetches it from here):", badge.svg);
    scroll();
    const worst = (d.checks || []).find(x => x.status === 'fail') || (d.checks || []).find(x => x.status === 'warn');
    announce(`grade ${d.domain}: ${d.grade}, ${tally}.` + (worst ? ` First problem: ${worst.check}, ${worst.text}.` : ''));
  }

  async function whois(raw, pre) {
    raw = String(raw || '').trim();
    const asnM = /^(?:as)(\d{1,10})$/i.exec(raw), p = asnM ? null : parseIp(raw);
    const dom = !asnM && !p && looksLikeDomain(raw) ? domainOf(raw).toLowerCase() : null;
    if (!asnM && !p && !dom) return line(`"${raw}" is not a valid IP address, AS number or domain. Examples: whois 8.8.8.8, whois AS13335, whois example.com`, 'err');
    const q = asnM ? 'AS' + Number(asnM[1]) : dom || (p.v === 4 ? p.o.join('.') : raw.toLowerCase());
    if (p && classify(p)[0] !== 'public') {
      setUrl('/whois/' + q, `whois ${q} | ipterm`);
      line(`${q} is a non-public address (${classify(p)[1] || classify(p)[0]}), so no internet registry holds a record for it.`, 'sys');
      next([`lookup ${q}`, `lookup ${q}`, 'what this range is for'], ['whoami', 'whoami', 'your public IP address']);
      return announce(`${q} is not a public address, so there is no registry record.`);
    }
    let d = null;
    if (pre) {
      if (pre.error) return line(pre.error, 'err');
      d = pre.data;
    } else if (live) {
      const qline = line('querying the registry…', 'sys'); const t0 = performance.now();
      d = await apiWhois(q);
      if (d.error) { qline.textContent = d.error; qline.className = 'ln err'; announce(d.error); return; }
      qline.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
    } else {
      d = DEMO_WHOIS[q];
      if (!d) return line('Preview mode has sample registry records for 8.8.8.8, AS13335 and example.com only. Live records appear once the Worker is deployed.', 'warn');
    }
    if (!d.found) {
      line(d.message || `No registry record was found for ${q}.`, 'warn');
      if (d.kind === 'domain' && d.reason === 'no-rdap') line('DNS still works for it.', 'sys');
      if (d.kind === 'domain') next([`dig ${q}`, `dig ${q}`, 'its DNS records']);
      return;
    }
    const share = live && !d.sample && ['share', 'share', 'copy a link to this record'];
    if (d.kind === 'domain') {
      setUrl('/whois/' + d.domain, `whois ${d.domain}` + (d.registrar && d.registrar.name ? ` · ${d.registrar.name}` : '') + ' | ipterm');
      await renderDomainWhois(d);
      return next([`dig ${d.domain}`, `dig ${d.domain}`, 'its DNS records and who hosts it'],
        live && !d.sample && [`mail ${d.domain}`, `mail ${d.domain}`, 'email security: SPF, DMARC and DKIM, graded A to F'],
        !d.sample ? gradeNext(d.domain) : [`dig ${d.domain} MX`, `dig ${d.domain} MX`, 'its mail servers'], share);
    }
    setUrl('/whois/' + q, `whois ${q}` + (d.org ? ` · ${d.org}` : '') + ' | ipterm');
    await renderWhois(d);
    const block = (d.cidrs || [])[0];
    if (d.kind === 'asn') next([`asn ${d.query}`, `asn ${d.query}`, 'announced prefixes and address space'], share);
    else next([`lookup ${d.query}`, `lookup ${d.query}`, 'network and approximate location'], block && [`cidr ${block}`, `cidr ${block}`, 'the registered address block'], share);
  }

  function relDays(iso) {                       // "in 41 days", "3 years ago"
    const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
    const days = Math.round((t - Date.now()) / 86400000), a = Math.abs(days);
    const span = a >= 730 ? `${Math.floor(a / 365.25)} years` : a >= 60 ? `${Math.floor(a / 30.44)} months` : `${a} day${a === 1 ? '' : 's'}`;
    return days >= 0 ? `in ${span}` : `${span} ago`;
  }

  async function renderDomainWhois(d) {
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'whois ' + d.domain), el('span', 'tag pub', 'domain'));
    if (d.registry) head.append(el('span', 'tag', d.registry));
    head.append(el('span', 'tag', d.sample ? 'sample data' : 'rdap'));
    head.append(shareBar({ cmd: 'whois ' + d.domain, value: d.domain, what: 'the domain', path: '/whois/' + d.domain }));
    out.appendChild(head);
    if (d.query && d.query !== d.domain && d.query !== 'www.' + d.domain) line(`${d.query} is part of ${d.domain}, so this is that domain's registration.`, 'sys');
    const date = v => (v ? String(v).slice(0, 10) : null);
    const dim = t => el('span', 'ttl', '  ' + t);
    const withNote = (main, note) => { const f = document.createDocumentFragment(); f.append(main); if (note) f.append(dim(note)); return f; };
    const rows = [['domain', withNote(d.domain, d.unicodeName ? `(${d.unicodeName})` : ''), 'big']];
    if (d.registrar && d.registrar.name) rows.push(['registrar', withNote(d.registrar.name, d.registrar.ianaId ? `IANA ID ${d.registrar.ianaId}` : '')]);
    if (d.registered) rows.push(['registered', withNote(date(d.registered), relDays(d.registered))]);
    if (d.expires) {
      const left = Math.round((Date.parse(d.expires) - Date.now()) / 86400000);
      rows.push(['expires', withNote(date(d.expires), left < 0 ? `expired ${relDays(d.expires)}` : left <= 30 ? `${relDays(d.expires)}, renewal due soon` : relDays(d.expires))]);
    }
    if (d.updated) rows.push(['last changed', date(d.updated)]);
    if (d.status && d.status.length) {
      const locked = d.status.some(x => /transfer prohibited|^locked$/.test(x));   // RFC 9083's "locked" is a registry lock
      rows.push(['status', withNote(d.status.join(' · '), locked ? '(locked against transfers)' : '')]);
    }
    if (d.nameservers && d.nameservers.length) {
      d.nameservers.forEach((n, i) => rows.push([i === 0 ? 'name servers' : '', cmdLink(n, 'lookup ' + n, '/dns/' + n)]));
    }
    if (d.dnssec != null) rows.push(['DNSSEC', d.dnssec ? 'signed (the registry holds a DS record)' : 'not signed']);
    rows.push(['registrant', d.registrant ? d.registrant + (d.registrantCountry ? `  (${d.registrantCountry})` : '') : 'not published (redacted for privacy)']);
    rows.push('sep');
    if (d.abuse && d.abuse.email) {
      const a = mailLink(d.abuse.email);
      rows.push(['abuse email', a]);
    } else rows.push(['abuse contact', "not listed; use the registrar's website"]);
    if (d.abuse && d.abuse.phone) rows.push(['abuse phone', d.abuse.phone]);
    rows.push(['DNS records', cmdLink(`dig ${d.domain}`, `dig ${d.domain}`, '/dns/' + d.domain)]);
    await kv(rows);
    if (d.abuse && d.abuse.email) line("Report phishing, spam or malware on this domain to the registrar's abuse contact, with the full URL and when you saw it.", 'sys');
    if (d.sample) line('Sample data. The live version queries the domain registry and the registrar (RDAP).', 'sys');
    announce(`whois ${d.domain}: ` + (d.registrar && d.registrar.name ? `registrar ${d.registrar.name}` : 'registrar unknown') +
      (d.registered ? `, registered ${date(d.registered)}` : '') + (d.expires ? `, expires ${date(d.expires)}` : '') +
      (d.nameservers && d.nameservers.length ? `, name servers ${d.nameservers.slice(0, 2).join(' and ')}` : '') + '.');
  }

  async function renderWhois(d) {
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'whois ' + d.query), el('span', 'tag pub', 'registry'));
    if (d.registry) head.append(el('span', 'tag', d.registry));
    head.append(el('span', 'tag', d.sample ? 'sample data' : 'rdap'));
    head.append(shareBar({ cmd: 'whois ' + d.query, value: d.query, what: d.kind === 'asn' ? 'the AS number' : 'the address', path: '/whois/' + d.query }));
    out.appendChild(head);
    const date = v => (v ? String(v).slice(0, 10) : null);
    const rows = [];
    if (d.org) rows.push(['owner', d.org, 'big']);
    if (d.name) rows.push(['network name', d.name]);
    if (d.handle && !/ - /.test(d.handle)) rows.push(['handle', d.handle]);   // RIPE uses the range itself as the handle
    const block = (d.cidrs || []).join(', ');
    if (block) rows.push(['address block', block]);
    if (d.range) rows.push(['range', `${d.range.start} – ${d.range.end}`]);
    if (d.asnRange && d.asnRange.start !== d.asnRange.end) rows.push(['ASN range', `AS${d.asnRange.start} – AS${d.asnRange.end}`]);
    if (d.type) rows.push(['type', d.type]);
    if (d.country) rows.push(['country', d.country]);
    if (d.registered) rows.push(['registered', date(d.registered)]);
    if (d.updated) rows.push(['last changed', date(d.updated)]);
    if (d.description) rows.push(['description', d.description]);
    rows.push('sep');
    if (d.abuse && d.abuse.email) {
      const a = mailLink(d.abuse.email);
      rows.push(['abuse email', a]);
    } else if (d.abuse && d.abuse.handle) rows.push(['abuse contact', `${d.abuse.handle} (email not published in RDAP; see the registry)`]);
    else rows.push(['abuse contact', 'none listed in the registry record']);
    if (d.abuse && d.abuse.phone) rows.push(['abuse phone', d.abuse.phone]);
    rows.push(['details', cmdLink(d.kind === 'asn' ? `asn ${d.query}` : `lookup ${d.query}`, d.kind === 'asn' ? `asn ${d.query}` : `lookup ${d.query}`, '/' + d.query)]);
    await kv(rows);
    if (d.abuse && d.abuse.email) line('When reporting abuse, include the IP address, the exact date and time with time zone, and relevant log lines.', 'sys');
    if (d.sample) line('Sample data. The live version queries the regional registry (RDAP) for the full record.', 'sys');
    announce(`whois ${d.query}: registered to ${d.org || 'an unnamed holder'}` + (d.registry ? ` through ${d.registry}` : '') +
      (block ? `, block ${block}` : '') + (d.abuse && d.abuse.email ? `. Abuse contact ${d.abuse.email}.` : '.'));
  }

  async function renderAsn(d) {
    const head = el('div', 'head');
    head.append(el('span', 'hip', d.asn), el('span', 'tag pub', 'asn'));
    if (d.registry) head.append(el('span', 'tag', d.registry));
    head.append(el('span', 'tag', d.sample ? 'sample data' : 'ripestat'));
    head.append(shareBar({ cmd: 'asn ' + d.asn, value: d.asn, what: 'the AS number', path: '/' + d.asn }));
    out.appendChild(head);

    const v4 = d.v4 || { prefixes: [] }, v6 = d.v6 || { prefixes: [] };
    const n4 = v4.count != null ? v4.count : v4.prefixes.length, n6 = v6.count != null ? v6.count : v6.prefixes.length;
    const rows = [['network', d.name || d.holder || d.asn, 'big']];
    if (d.handle) rows.push(['handle', d.handle]);
    if (d.registry) rows.push(['registry', d.registry]);
    rows.push(['announced', d.announced ? 'yes, visible in global routing' : 'no prefixes announced right now']);
    rows.push(['IPv4 prefixes', fmt(n4)]);
    if (v4.addresses != null) {
      const bits = v4.addresses > 0 ? 32 - Math.floor(Math.log2(v4.addresses)) : null;
      rows.push(['IPv4 space', fmt(v4.addresses) + ' addresses' + (bits && v4.addresses >= 256 ? `  (about a /${bits})` : '')]);
    }
    rows.push(['IPv6 prefixes', fmt(n6)]);
    // The main upstreams: the networks RIPEstat sees just before this one in AS paths (worker.js upstreams()).
    const up = d.upstreams;
    if (up && up.tooMany) rows.push(['upstreams', 'not listed: a transit network with thousands of neighbours (customers and peers)']);
    else if (up && up.list) {
      up.list.forEach((u, i) => rows.push([i ? '' : 'upstreams', joinFrag([cmdLink(u.asn, 'asn ' + u.asn, '/' + u.asn), u.name ? '  ' + u.name : ''])]));
      if (!up.list.length) rows.push(['upstreams', 'none seen']);
      else if (up.total > up.list.length) rows.push(['', `${up.list.length} of ${fmt(up.total)} seen, by how many RIS peers see each`]);
    }
    rows.push(['registry', cmdLink(`whois ${d.asn}`, `whois ${d.asn}`, `/whois/${d.asn}`)]);

    const show4 = v4.prefixes.slice(0, 12), show6 = v6.prefixes.slice(0, 6);
    const list = arr => {
      const f = document.createDocumentFragment();
      arr.forEach((px, i) => { if (i) f.append(document.createTextNode('  ')); f.append(cmdLink(px, 'cidr ' + px, '/cidr/' + px)); });
      return f;
    };
    if (show4.length || show6.length) {
      rows.push('sep');
      if (show4.length) rows.push(['largest v4', list(show4)]);
      if (show6.length) rows.push(['largest v6', list(show6)]);
    }
    await kv(rows);
    announce(`${d.asn} ${d.name || d.holder || ''}: ${fmt(n4)} IPv4 prefixes` + (v4.addresses != null ? `, ${fmt(v4.addresses)} addresses` : '') + `, ${fmt(n6)} IPv6 prefixes.`);
    const more = (n4 - show4.length) + (n6 - show6.length);
    if (more > 0) line(`${fmt(more)} more prefixes not shown. Click a prefix to see its address range.`, 'sys');
    else if (show4.length + show6.length) line('Click a prefix to see its address range.', 'sys');
    if (d.sample) line('Sample data. The live version lists the largest announced prefixes and counts the full address space.', 'sys');
  }

  /* ---------- help, man pages and typo suggestions ---------- */
  // [what to type, what it does, what clicking it runs (an example for commands that take one)]
  const HELP = [
    ['whoami', 'show your own IP, network and location', 'whoami'],
    ['leaktest', 'VPN and DNS leak test, graded A to F: DNS, WebRTC, IPv6 and time-zone leaks, VPN detection', 'leaktest'],
    ['lookup <ip>', 'look up any IPv4 or IPv6 address', 'lookup 8.8.8.8'],
    ['lookup <domain>', 'DNS records, mail and name servers, hosting, DNSSEC', 'lookup example.com'],
    ['dig <name> [type]', 'one record type: A AAAA MX NS TXT CAA SOA CNAME SRV ... (dig <ip> = reverse)', 'dig gmail.com MX'],
    ['mail <domain>', 'email security: MX, SPF, DMARC, DKIM, MTA-STS, TLS-RPT and BIMI, graded A to F', 'mail gmail.com'],
    ['grade <domain>', 'report card, graded A to F: DNSSEC, CAA, email, expiry, HTTPS and security headers, with a README badge', 'grade github.com'],
    ['cidr <range>', 'subnet calculator: cidr 10.0.0.0/22, IP + netmask, or IPv6', 'cidr 10.0.0.0/22'],
    ['whois <ip|ASN|domain>', 'registry record: owner, registrar, dates, name servers, abuse contact', 'whois example.com'],
    ['asn <number>', 'network details, address blocks and upstreams, e.g. asn AS13335', 'asn AS13335'],
    ['route <prefix|ip>', 'how it is routed: origin network, RPKI, visibility, AS paths', 'route 1.1.1.0/24'],
    ['port <number>', 'is a TCP port open on your IP? (tests your own address only)', 'port'],
    ['<ip> or <ASN>', 'same as lookup', null],
    ['ping [count]', 'round trip from your browser to the nearest Cloudflare data center', 'ping'],
    ['man <command>', 'details and examples for one command, e.g. man dig', 'man dig'],
    ['share', 'share a link to the current result (phones: the share sheet; after leaktest: your grade)', 'share'],
    ['copy [md|link|badge]', "copy the current result's address, domain, range or ASN; md: as Markdown; badge: after grade", 'copy'],
    ['privacy', 'what ipterm does and does not collect', 'privacy'],
    ['theme <name>', 'phosphor, amber, ice, contrast or paper', 'theme'],
    ['crt on|off', 'turn glow and scanlines on or off', 'crt'],
    ['access', 'accessibility and display options', 'access'],
    ['reset', 'forget display settings and return to the defaults', null],
    ['api', 'use ipterm from curl or scripts', 'api'],
    ['history', 'your recent commands, saved in this browser (history clear, history off)', 'history'],
    ['keys', 'keyboard shortcuts: Tab completes, Ctrl+R searches history, !! repeats', 'keys'],
    ['about', 'where the data comes from', 'about'],
    ['clear', 'clear the screen (Ctrl+L)', null],
  ];
  // Other names each command answers to (run() goes by these too).
  const ALIASES = { myip: 'whoami', me: 'whoami', leaks: 'leaktest', leak: 'leaktest', privacycheck: 'leaktest', vpntest: 'leaktest',
    vpncheck: 'leaktest', dnsleak: 'leaktest', dnsleaktest: 'leaktest', rdap: 'whois', subnet: 'cidr', ipcalc: 'cidr', dns: 'dig', nslookup: 'dig', host: 'dig', geo: 'lookup',
    spf: 'mail', dmarc: 'mail', dkim: 'mail', email: 'mail', mailcheck: 'mail', report: 'grade', reportcard: 'grade', scorecard: 'grade', badge: 'grade',
    as: 'asn', bgp: 'route', rpki: 'route', iplookup: 'lookup', link: 'share', cls: 'clear', fx: 'crt', curl: 'api', '?': 'help', a11y: 'access', accessibility: 'access',
    portcheck: 'port', shortcuts: 'keys', bindkey: 'keys', tracert: 'traceroute', mtr: 'traceroute', tracepath: 'traceroute', trace: 'traceroute', dir: 'ls', logout: 'exit', quit: 'exit' };
  // man <command>: [synopsis, description, examples, see also, curl paths]
  const MAN = {
    whoami: ['whoami', "your public IP address, the network (ISP) it belongs to and its approximate location: what every website you visit sees. The location is usually your provider's nearest hub, not your home.",
      ['whoami'], ['leaktest', 'lookup', 'copy'], ['', '/me', '/json', '/text', '/city', '/line']],
    // The sixth entry: the grading rubric, from leakgrade.js (also on the /leaktest page and in docs/handbook.md).
    leaktest: ['leaktest   or   leaktest --result <code>', "VPN and DNS leak test, graded A to F: is your IP a known VPN (Cloudflare WARP and Tor by name), which DNS servers look up sites for you, and does WebRTC, IPv6 or your time zone give away more than your IP? For DNS, your browser looks up a few random names under ipterm's own DNS server (which answers \"no such name\"), and the check shows which resolvers asked: on a VPN, any outside the VPN's network is a DNS leak. Runs in your browser in a few seconds; nothing is stored. --result <code> shows a shared result without testing anything.",
      ['leaktest'], ['whoami', 'share'], ['/leaktest/r/1bjp', '/leaktest/r/1bjp?format=text'], [
        ...(LEAKLIB ? LEAKLIB.GRADES.map(([g, t], i) => [i ? '' : 'GRADE', `${g}: ${t}`]) : []),
        ...(LEAKLIB ? LEAKLIB.RULES.map((t, i) => [i ? '' : 'COUNTS', t]) : []),
        ['SITES SEE', "your IP, and with it your provider and rough location (or your VPN's), on its own line: never graded."],
        ['INFO', "never part of the grade: how your browser connects (TLS 1.3, HTTP/3 and post-quantum key exchange, from Cloudflare's edge), your browser language's country next to your IP's (expats and travelers differ for good reasons), and a local network address."],
        ['COMPARE', "run leaktest again after turning your VPN on or off, or after a fix, and it prints each line before → after: a line that would be \"a leak if you use a VPN\" becomes a confirmed leak, or not. The last run is kept in this tab's memory only, never stored. copy md gives only each line's status before → after (OK, LEAK or INFO): what either run found, and the verdict, stay on screen."],
        ['SHARE', "share after leaktest copies a link like /leaktest/r/1bjp. It holds only the grade, whether a VPN was on and which checks passed, leaked or weren't tested: no IP address, provider, location or resolver, so every browser with the same result gets the same link. It's made in your browser, and opening one never runs the test."]]],
    lookup: ['lookup <ip | domain | ASN>', 'owner, network and approximate location of any IPv4 or IPv6 address. When the registry record of its block is at most 180 days old, a block line says so: location databases often take months to catch up with new or reassigned blocks, so sites may disagree about where it is. Your own address never gets one: lookup never sends it to a registry. A domain shows its DNS records and an AS number its network. Typing the address on its own does the same.',
      ['lookup 8.8.8.8', 'lookup 2606:4700:4700::1111', 'lookup github.com'], ['whois', 'asn', 'dig'], ['/8.8.8.8', '/8.8.8.8/org', '/8.8.8.8/text']],
    dig: ['dig <domain> [type]   or   dig <ip>', "DNS records from Cloudflare's resolver (1.1.1.1). With a type, just that type with its TTLs: A AAAA CNAME MX NS TXT CAA SOA SRV PTR DS DNSKEY HTTPS. With an IP address, its reverse DNS name.",
      ['dig example.com', 'dig gmail.com MX', 'dig github.com TXT', 'dig 8.8.8.8'], ['lookup', 'whois', 'mail'], ['/dns/example.com', '/dns/gmail.com/MX', '/dns/example.com?format=text']],
    // The sixth entry: extra rows. The grading rubric is the same as MAIL_GRADES in worker.js and docs/handbook.md.
    mail: ['mail <domain> [--dkim <selector>]', "checks a domain's email security: its mail servers and the provider behind them, SPF (following includes to count its DNS lookups against the limit of 10), the DMARC policy and where reports go, DKIM keys, MTA-STS (the record, plus the policy file fetched from https://mta-sts.<domain>), TLS-RPT and BIMI. Each finding is OK, WARN, FAIL or INFO, with a fix under every problem. Records come from Cloudflare's resolver (1.1.1.1) and are cached for five minutes.",
      ['mail gmail.com', 'mail github.com', 'mail example.com', 'mail outlook.com --dkim selector1'], ['dig', 'whois'], ['/mail/gmail.com', '/mail/gmail.com?format=text', '/mail/outlook.com?dkim=selector1'],
      [['GRADE', 'A: no FAIL and no WARN'], ['', 'B: no FAIL, one or two WARN'], ['', 'C: one FAIL, or three or more WARN'], ['', 'D: two FAIL'],
        ['', 'F: three or more FAIL, no working SPF and no DMARC, or SPF that lets any server pass (+all)'], ['', 'INFO lines never count.'],
        ['FAIL', 'no SPF or DMARC record; two of either; SPF over 10 lookups, with +all, or with errors; an MTA-STS record whose policy is missing, invalid or leaves out an MX host'],
        ['WARN', 'DMARC p=none, pct below 100, sp=none or no report address; SPF ?all, no all, or ptr; DKIM keys under 2048 bits; no TLS-RPT beside MTA-STS; a BIMI logo without DMARC enforcement'],
        ['DKIM', "selectors can't be listed, so only google, selector1, selector2, default, k1 and s1 are tried, and no key there is INFO (so is a selector the resolver couldn't read). Name yours with --dkim: it is the s= value in a message's DKIM-Signature header."],
        ['NULL MX', 'a domain that accepts no mail (MX 0 .) should have v=spf1 -all and DMARC p=reject; the other checks don\'t apply']]],
    // The sixth entry: the grading rubric, the same as GRADE_GRADES in worker.js, the /grade page and docs/handbook.md.
    grade: ['grade <domain>', "a domain's report card, graded A to F: DNSSEC, an AAAA record (IPv6), CAA and an HTTPS record from Cloudflare's resolver; the mail check's grade and its main findings; the registration's expiry and transfer lock, from the registry over RDAP; and the website, from one HEAD request to https://<domain>/ (HSTS, CSP, X-Content-Type-Options, frame protection, Referrer-Policy; a GET, its body dropped unread, if the site refuses HEAD) and one to http://<domain>/ (the redirect to HTTPS). Redirects are followed only within the domain. A 403, a bot challenge or a timeout is \"couldn't check\", never a FAIL. Each line is OK, WARN, FAIL or INFO, with a fix under every problem. Cached for five minutes.",
      ['grade github.com', 'grade cloudflare.com', 'grade example.com'], ['mail', 'dig', 'whois', 'copy'], ['/grade/github.com', '/grade/github.com?format=text', '/badge/github.com.json'],
      [['GRADE', 'A: no FAIL and no WARN'], ['', 'B: no FAIL, one to three WARN'], ['', 'C: one FAIL, or four or more WARN'], ['', 'D: two FAIL'],
        ['', 'F: three or more FAIL, an expired registration, or broken DNSSEC (validating resolvers refuse the domain)'], ['', "INFO lines, and parts that couldn't be checked, never count."],
        ['FAIL', 'broken DNSSEC; a mail grade of C or worse; an expired or lapsing registration; https:// redirecting to plain http://'],
        ['WARN', 'no DNSSEC; no AAAA record; no CAA record, or none that names a CA for the domain itself; a mail grade of B; expiry within 30 days; no transfer lock; http:// that doesn\'t redirect to HTTPS; HSTS missing or under 180 days; no CSP, or one that lets any inline script or any host run; no nosniff; no frame protection; Referrer-Policy unsafe-url or no-referrer-when-downgrade'],
        ['INFO', "no HTTPS record; no Referrer-Policy (browsers default to strict-origin-when-cross-origin); anything that couldn't be checked"],
        ['BADGE', "copy badge copies Markdown for a README badge that shields.io draws from /badge/<domain>.json, so your readers' browsers never contact ipterm. /badge/<domain>.svg is the same badge served by ipterm itself, which each reader's browser fetches from here (unless a proxy like GitHub's sits in between). Both are cached for an hour."],
        ['CERTS', "certificates aren't checked: ipterm's server never sees them."]]],
    whois: ['whois <ip | ASN | domain>', 'the registry record. For addresses and networks: owner, address block and abuse contact. For domains: registrar, registration and expiry dates, status and name servers. Straight from the registries over RDAP.',
      ['whois example.com', 'whois 8.8.8.8', 'whois AS13335'], ['lookup', 'asn', 'dig'], ['/whois/example.com', '/whois/8.8.8.8', '/whois/example.com?format=text']],
    asn: ['asn <number>', "an autonomous system: a network such as an internet provider, a cloud or a large company. Shows its holder and registry, how many IPv4 and IPv6 prefixes it announces, largest first, and its main upstreams: the networks RIPEstat sees just before it in AS paths, usually its transit providers. The largest transit networks, with thousands of neighbours, get no upstream list.",
      ['asn AS13335', 'asn 15169'], ['whois', 'route', 'cidr'], ['/AS13335', '/AS13335/text']],
    cidr: ['cidr <range>   or   cidr <ip> <netmask>', "subnet calculator: network and broadcast addresses, netmask, wildcard, usable host range and count, and how the block splits and combines. IPv6 too. Calculated in your browser; for a public range it also asks how the range is routed (see route).",
      ['cidr 192.168.1.0/24', 'cidr 10.0.0.0/22', 'cidr 192.168.1.10 255.255.255.0', 'cidr 1.1.1.0/24'], ['route', 'whois', 'asn'], ['/cidr/10.0.0.0/22', '/cidr/10.0.0.0/22?format=text']],
    route: ['route <prefix>   or   route <ip>', "how a public prefix or address is routed on the internet (BGP), from RIPEstat's route collectors: the route that carries it (the prefix itself, or the less specific one it is part of), the network that announces it, whether RPKI allows that (a ROA names the network and the longest prefix it may announce), how many RIS peers see it, the networks just before the origin in AS paths, and a few sample paths from RRC00 (Amsterdam), RRC01 (London) and RRC11 (New York). An address shows the route it is in. Cached for six hours. Browsers can't read your own device's routing table, so route with nothing after it only explains itself.",
      ['route 1.1.1.0/24', 'route 8.8.8.8', 'route 8.8.0.0/16', 'route 2001:4860::/32'], ['asn', 'cidr', 'whois'], ['/route/1.1.1.0/24', '/route/8.8.8.8?format=text']],
    port: ['port <number>   or   port <number> --info', "checks whether a TCP port is open on your own public IP address: ipterm's server connects to the address you are visiting from, on the one port you name, and reports open (something accepted), closed (turned away at once: nothing is listening, or a firewall rejected it) or no answer (dropped, usually by a router that isn't forwarding the port). It never tests any other address, sends nothing over the connection and stores nothing; 10 checks a minute. Port 25 can't be checked: Cloudflare, which runs ipterm, blocks it. Over IPv6 it tests your IPv6 address, where port forwards don't apply: curl -4 tests IPv4. --info explains a port without checking it.",
      ['port 25565', 'port 22', 'port 32400 --info'], ['whoami', 'ping'], ['-4 /port/22', '-4 /port/22?format=text']],
    ping: ['ping [count]', "times HTTPS round trips from your browser to the Cloudflare data center serving ipterm (4 by default, up to 10). Browsers can't send ICMP, so other hosts can't be pinged from a web page.",
      ['ping', 'ping 10'], ['whoami', 'traceroute']],
    traceroute: ['traceroute', "not possible from a browser: tracing a route needs raw ICMP or UDP packets. ping times the connection to ipterm's edge instead.", ['ping'], ['ping', 'asn']],
    share: ['share', "shares a link to the current result: the share sheet on phones, the clipboard elsewhere. Every lookup has its own page, so the link opens the same result. After whoami or a port check it shares the page itself (/ or /port/<n>), which shows each visitor their own result (check yours), never your address. After leaktest it shares your grade's link, /leaktest/r/<code>, which holds only the grade and which checks passed or leaked (no IP address, provider, location or resolver), or /leaktest when the run has no grade. Every result's header line has the same [share] button, and [copy] and [md] beside it; [md] leaves your address, provider and location out of your own results (see copy).",
      ['share'], ['copy', 'leaktest']],
    copy: ['copy [md | link | badge]', "copies the current result's main value: the IP address, the domain, the range or the AS number. After grade, copy badge copies the Markdown for a README badge. copy md copies the whole result as a Markdown code block that starts with the command and ends with its link, for GitHub issues, Discord or Stack Overflow. For whoami, leaktest and port results, which are about you, it leaves out your address and everything that names or places you: your provider and the other networks (AS numbers too), your city, region and country, your time zones and the data center. Lines that hold only those are left out, and elsewhere they read [hidden]. After a second leaktest, the before → after lines show only each run's OK, LEAK or INFO. Other lookups (lookup 8.8.8.8, whois, dig) are copied whole. copy link copies the link. The sponsored line is never copied.",
      ['copy', 'copy md', 'copy link', 'copy badge'], ['share', 'grade']],
    history: ['history [clear | off | on]', "lists the commands you ran, numbered (click one to run it again). They are saved in this browser's local storage, the newest 200 and never their results, so they are still there after a reload; nothing is sent anywhere. history clear deletes them, history off stops saving them (and deletes them) until history on. Up and Down recall them at the prompt either way, Ctrl+R searches them, Tab completes from them, !! runs the last one again and !<n> runs number n.",
      ['history', 'history clear', 'history off', 'history on'], ['keys', 'privacy']],
    keys: ['keys', "the keyboard shortcuts. Tab completes a command, a record type after dig <name>, a theme, or an address, domain, range or AS number from your history; when several match, Tab fills in what they share and then steps through them. On an empty prompt Tab moves focus on, as on any page. Ctrl+R searches your history as you type (Ctrl+R again for an older match, Enter runs it, Esc gives your line back). !! is the previous command and !<n> number n in history, also inside a line. Up and Down step through history; Ctrl+L clears the screen.",
      ['keys', 'history'], ['history']],
    theme: ['theme [phosphor | amber | ice | contrast | paper]', 'changes the colors; with no name, moves to the next theme. Remembered on this device only.', ['theme amber', 'theme paper', 'theme contrast'], ['crt', 'access']],
    crt: ['crt [on | off]', 'turns the CRT glow, scanlines and vignette on or off; with neither, switches. Remembered on this device only.', ['crt off', 'crt on'], ['theme', 'access']],
    api: ['api', "how to use ipterm from curl and scripts. Pages answer browsers with HTML and command-line tools with JSON (plain text for your IP). /me draws a card of your own address with a world map (?w=<columns> to fit, ?color=0 for no colors, ?redact to hide the IP). One value at a time as plain text: /asn, /org, /cc, /city, /tz, /colo and /hostname for your own address, /<ip>/asn, org, cc, country, continent or hostname for any other. /line puts your IP, network, country and data center on one line for a shell prompt. /expect/<ASN or country code> answers HTTP 200 when your address matches and 412 when it doesn't, so curl -fs …/expect/AS13335 || <stop something> works as a VPN kill switch. Add ?format=text to any lookup for aligned lines instead of JSON, or /text after an IP or AS number (/8.8.8.8/text, nothing for the shell to expand); ?color=1 adds colors. curl …/help prints the whole reference. In a browser, /go?q=<anything> opens the page for an IP address, domain, AS number, range, email address (its mail check) or port <n>, or for a command such as dig gmail.com MX; browsers offer ipterm as a search engine through it, and api shows a search form for wikis that uses it.",
      ['api'], ['whoami', 'lookup'], ['/help', '/me', '/asn', '/line', '-fs /expect/AS13335', '/8.8.8.8/country', '/8.8.8.8?format=text']],
    man: ['man <command>', 'shows the manual for a command: what it does, examples to click and related commands. help <command> and <command> --help do the same.', ['man dig', 'man whois'], ['help']],
    help: ['help [command]', 'lists every command; click one to run it. With a command name, shows its manual.', ['help', 'help dig'], ['man']],
  };
  // The guides, for `ls guides`, the guide pages' own `man <topic>` prompts, and the GUIDE line of a manual.
  const GUIDES = [['find-router-ip', "How to find your router's IP address", 'router-ip'], ['private-ip-ranges', 'Private IP address ranges explained', 'private-ip'],
    ['what-your-ip-reveals', 'What your IP address reveals', 'ip-privacy'], ['ipv4-vs-ipv6', 'IPv4 vs IPv6', 'ipv6'],
    ['what-is-an-asn', 'What is an ASN?', null], ['subnet-cheat-sheet', 'Subnet mask cheat sheet', null]];
  const MAN_GUIDE = { whoami: 'what-your-ip-reveals', leaktest: 'what-your-ip-reveals', asn: 'what-is-an-asn', route: 'what-is-an-asn', cidr: 'subnet-cheat-sheet' };
  const guideLink = slug => { const g = GUIDES.find(x => x[0] === slug), a = el('a', 'cmd', g ? g[1] : slug); a.href = '/guides/' + slug; return a; };
  // Ties go to the earlier entry, so plain commands come before their aliases ("iplookup" -> lookup, not nslookup),
  // unless the caller names one to prefer ("mal gmail.com" -> mail, not man).
  const KNOWN = ['help', 'man', 'whoami', 'myip', 'leaktest', 'dnsleak', 'whois', 'cidr', 'subnet', 'dig', 'mail', 'grade', 'lookup', 'nslookup', 'asn', 'route', 'port', 'ping', 'traceroute', 'dmarc',
    'share', 'copy', 'privacy', 'clear', 'history', 'keys', 'theme', 'crt', 'reset', 'access', 'api', 'about', 'ifconfig', 'ipconfig'];
  // Edit distance, with two swapped neighbors ("cdir") counting as one edit.
  function osa(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }
  function closest(word, prefer) {
    if (!word || word.length > 20) return null;
    let best = null, bestD = Infinity;
    for (const k of KNOWN) { const x = osa(word, k); if (x < bestD || (x === bestD && k === prefer)) { bestD = x; best = k; } }
    return bestD <= (word.length <= 4 ? 1 : 2) ? best : null;     // short words need a closer match
  }
  const runnable = (label, cmd) => { const h = hrefFor(cmd); return h ? cmdLink(label, cmd, h) : cmdButton(label, cmd); };
  const joined = nodes => { const f = document.createDocumentFragment(); nodes.forEach((n, i) => { if (i) f.append('  ·  '); f.append(n); }); return f; };

  async function help() {
    await kv(HELP.map(([k, v, cmd]) => {
      if (!cmd) return [k, v];
      const n = runnable(k, cmd); n.title = 'run: ' + cmd;
      return [n, v];
    }));
    line('Click a command to run it (the ones with <…> run an example). man <command> shows details, e.g. man dig.', 'sys');
    announce('Command list. Each command runs when you activate it. Type man and a command name for details.');
  }

  async function man(topic) {
    const t = String(topic || '').toLowerCase(), name = ALIASES[t] || t;
    const m = MAN[name], h = HELP.find(r => r[0].split(' ')[0] === name);
    const topicGuide = GUIDES.find(g => g[2] === t);
    if (!m && !h && topicGuide) {                 // the guide pages head themselves with `man router-ip` and so on
      const d = el('div', 'ln sys'); d.append(`${t} is a guide: `, guideLink(topicGuide[0]));
      out.appendChild(d); scroll();
      return announce(`${t} is a guide: ${topicGuide[1]}.`);
    }
    if (!m && !h) {
      line(`No manual entry for ${topic}.`, 'err');
      const g = closest(t);
      return next(g && (MAN[g] || HELP.some(r => r[0].split(' ')[0] === g)) && [`man ${g}`, `man ${g}`], ['help', 'help', 'all commands']);
    }
    const head = el('div', 'head');
    head.append(el('span', 'hip', 'man ' + name), el('span', 'tag', 'manual'));
    out.appendChild(head);
    const also = Object.keys(ALIASES).filter(a => ALIASES[a] === name && a !== '?');
    const rows = [['NAME', `${name} - ${m ? m[1] : h[1]}`], ['SYNOPSIS', m ? m[0] : h[0]]];
    if (m) rows.push(['EXAMPLES', joined(m[2].map(c => runnable(c, c)))]);
    if (m && m[5]) rows.push(...m[5]);
    if (also.length) rows.push(['ALSO', also.join(', ')]);
    if (m && m[4]) m[4].forEach((p, i) => { const [f, q] = p.startsWith('-') ? p.split(' ') : ['', p]; rows.push([i ? '' : 'CURL', curlLine(q, f)]); });
    if (m && m[3].length) rows.push(['SEE ALSO', joined(m[3].map(c => cmdButton(c, 'man ' + c)))]);
    if (MAN_GUIDE[name]) rows.push(['GUIDE', guideLink(MAN_GUIDE[name])]);
    await kv(rows);
    announce(`Manual for ${name}: ${m ? m[1] : h[1]}`);
  }

  /* ---------- ping and traceroute ----------
     Browsers can't send ICMP, so ping times HTTPS requests to /cdn-cgi/trace: Cloudflare's edge answers
     that itself (it never reaches the Worker, so it costs nothing and nothing is logged by ipterm) and
     names the data center. The connection is already open, so the time is a real round trip. */
  async function ping(args = []) {
    // The count is a bare number or follows -c / -n / --count (Linux and Windows habits); the host is the
    // first other argument that isn't a flag or a flag's value.
    let count = 4, host = null;
    args.forEach((x, i) => {
      const prev = args[i - 1] || '';
      if (/^\d+$/.test(x) && (/^(-[cn]|--count)$/i.test(prev) || !/^-/.test(prev))) count = Math.max(1, Math.min(10, Number(x)));
      else if (!host && !/^-/.test(x) && !/^-/.test(prev)) host = x;
    });
    if (host) line(`Browsers can't send ICMP, so ${host} can't be pinged from a web page. Timing your connection to ipterm's edge instead.`, 'sys');
    if (!live) return line('ping times your connection to the deployed site, so it only works there.', 'warn');
    line(`PING ${location.host}: ${count} HTTPS round trip${count > 1 ? 's' : ''} to the nearest Cloudflare data center`, 'sys');
    const times = []; let colo = '';
    for (let i = 1; i <= count; i++) {
      if (i > 1) await new Promise(r => setTimeout(r, 500));
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 5000), t0 = performance.now();
      try {
        const r = await fetch('/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
        const m = /^colo=(\w+)$/m.exec(await r.text()), ms = performance.now() - t0;
        // An answer that isn't a trace means Cloudflare's edge isn't in front (e.g. `wrangler dev`).
        if ((!r.ok || !m) && i === 1) return line("ping needs Cloudflare's edge, which answers /cdn-cgi/trace, and it isn't there (for example under wrangler dev). It works on the deployed site.", 'warn');
        if (!r.ok || !m) throw new Error('no trace');
        colo = m[1]; times.push(ms);
        line(`reply from ${colo}: seq=${i} time=${ms.toFixed(1)} ms`);
      } catch { line(`seq=${i}: no reply`, 'warn'); } finally { clearTimeout(timer); }
    }
    line(`--- ${count} sent, ${times.length} received, ${Math.round((count - times.length) / count * 100)}% lost`, 'sys');
    if (times.length) {
      const s = [...times].sort((a, b) => a - b), avg = times.reduce((a, b) => a + b, 0) / times.length;
      line(`round trip min/avg/max = ${s[0].toFixed(1)}/${avg.toFixed(1)}/${s[s.length - 1].toFixed(1)} ms · data center ${colo}`, 'sys');
      announce(`ping: ${times.length} of ${count} replies, average ${Math.round(avg)} milliseconds to ${colo}.`);
    } else announce('ping: no replies.');
    next(count < 10 && ['ping 10', 'ping 10', 'a longer run'], ['whoami', 'whoami', 'your IP address and network']);
  }
  function traceroute(arg) {
    line("traceroute can't run in a browser: tracing a route needs raw ICMP or UDP packets, which web pages can't send.", 'sys');
    const t = arg && (parseIp(arg) || /^as\d+$/i.test(arg) || looksLikeDomain(arg)) ? arg : null;
    next(['ping', 'ping', 'time your connection to the nearest Cloudflare data center'], t && [`lookup ${t}`, `lookup ${t}`, 'who runs it, and where']);
  }

  const THEMES = ['phosphor', 'amber', 'ice', 'contrast', 'paper'];
  function setTheme(name) {
    document.documentElement.dataset.crt = name;
    try { localStorage.setItem('ipterm-theme', name); } catch {}
    if (window.IPTERM_PREFS) IPTERM_PREFS.sync();
    redrawMaps();
  }
  // the light/dark switch in the header (wired in prefs.js) changes the theme outside the terminal
  document.addEventListener('ipterm:theme', e => { redrawMaps(); announce(e.detail === 'light' ? 'Light theme on.' : 'Dark theme on.'); });
  function currentTheme() { return document.documentElement.dataset.crt || (matchMedia('(prefers-contrast: more)').matches ? 'contrast' : 'phosphor'); }
  function theme(name) {
    if (!name) {
      const cur = currentTheme(), next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      setTheme(next); announce('Theme set to ' + next); return line(`theme: ${next}   (options: ${THEMES.join(', ')})`, 'sys');
    }
    name = name.toLowerCase();
    if (!THEMES.includes(name)) return line(`unknown theme "${name}". Options: ${THEMES.join(', ')}`, 'err');
    setTheme(name); announce('Theme set to ' + name); line('theme: ' + name, 'sys');
  }

  const toClipboard = t => { try { return navigator.clipboard.writeText(t).then(() => true, () => false); } catch { return Promise.resolve(false); } };
  function clip(textValue, okMsg, failMsg) {
    return toClipboard(textValue).then(ok => { line(ok ? okMsg : failMsg, ok ? 'sys' : 'warn'); });
  }
  function crt(arg) {
    const d = document.documentElement, off = arg ? /^(off|0|no|false)$/i.test(arg) : d.dataset.fx !== 'off';
    if (arg && !off && !/^(on|1|yes|true)$/i.test(arg)) return line('usage: crt on   or   crt off', 'warn');
    if (off) d.dataset.fx = 'off'; else delete d.dataset.fx;
    try { localStorage.setItem('ipterm-fx', off ? 'off' : 'on'); } catch {}
    redrawMaps();
    const msg = off ? 'CRT effects off: no glow, scanlines or vignette.' : 'CRT effects on.';
    announce(msg); line(msg, 'sys');
  }

  // Forget saved display settings: back to the default theme with CRT effects on, which also
  // re-enables the automatic high-contrast theme for systems that ask for more contrast.
  function reset() {
    const d = document.documentElement;
    delete d.dataset.crt; delete d.dataset.fx;
    try { localStorage.removeItem('ipterm-theme'); localStorage.removeItem('ipterm-fx'); } catch {}
    if (window.IPTERM_PREFS) { IPTERM_PREFS.forgetDark(); IPTERM_PREFS.sync(); }
    redrawMaps();
    const auto = matchMedia('(prefers-contrast: more)').matches;
    const msg = 'Display settings reset to the defaults' + (auto ? ' (high contrast, because your system asks for more contrast).' : '.');
    announce(msg); line(msg, 'sys');
  }

  async function access() {
    await kv([
      ['theme contrast', 'near-white text on black, no glow. Turns on by itself if your system asks for more contrast'],
      ['theme paper', 'dark text on a light background'],
      ['crt off', 'keep your theme, drop the glow, scanlines and vignette'],
      ['motion', 'animations are skipped when your system is set to reduce motion'],
      ['screen readers', 'each result is announced as a one-line summary'],
      ['keys', 'keyboard shortcuts. Tab completes at the prompt; on an empty prompt it moves focus out of the terminal'],
      ['reset', 'forget these settings and go back to the defaults'],
    ]);
    line('Settings are remembered on this device only.', 'sys');
    announce('Accessibility options listed: theme contrast, theme paper, crt off.');
  }

  /* ---------- share, copy and copy md ----------
     Each result's header line ends in [share] [copy] [md], tied to that result, so an older result's
     buttons still act on it; share, copy and copy md at the prompt act on the newest result (`current`).
     share opens the phone's share sheet where there is one and copies the link everywhere else. copy takes
     the result's main value (the address, domain, range or AS number). copy md takes a fenced Markdown
     block for GitHub issues, Discord or Stack Overflow: the command, the result's lines, then its
     permalink. Nothing copied carries the sponsored line or the next: line. A result about your own
     connection never shares your address: after whoami or a port check its link is the page itself, which
     shows each visitor their own ("check yours"); after leaktest it is the grade's /leaktest/r/<code> (only
     the grade and per-check flags, see leakgrade.js), or /leaktest when the run has no grade. Its Markdown
     leaves out your addresses and everything that names or places you: your provider and the networks
     involved (with their AS numbers), the place, the time zones and the data center. Rows that hold only
     those go; in sentences they read [hidden] (leaktest's: also its resolvers and the previous run's, and
     its compare prints only each line's status). */
  let current = null;              // { cmd, value, what, path, self, hide: [your addresses], terms: [names and places], drop: [row labels], bar, text, note }
  // Rows of your own result that are your address in another form (or would point at it), or that only
  // name your provider or place you: its network, domain and connection type, the location, local time
  // and data center.
  const SELF_DROP = ['hostname', 'IPv4', 'IPv6', 'postal', 'coords', 'decimal', 'hex', 'binary', 'rdns zone', 'expanded', '/64 prefix',
    'network', 'domain', 'location', 'continent', 'local time', 'block', 'connection', 'edge'];
  // leaktest's: the browser language's country (the other lines are checks, and keep their status).
  const LEAK_DROP = ['language'];
  // What names or places you in a lookup of your own address (whoami's data, /api/check's, the other IP
  // version's), for the Markdown to hide wherever it stands: see termRe.
  const placeTerms = d => (d && !d.error ? [d.org, d.asn, d.asDomain, d.hostname, d.city, d.region, d.postal, d.country, d.countryCode, d.continent, d.timezone, d.colo] : []);
  const LEFT_OUT = ' (your address, provider and location left out)';
  function shareBar(r) {
    current = r;
    const bar = r.bar = el('span', 'share');
    const btn = (label, name, act) => {
      const b = el('button', 'share-btn', label); b.type = 'button';
      b.setAttribute('aria-label', name); b.title = name;
      b.addEventListener('click', () => act(b));
      return b;
    };
    bar.append(btn('share', r.self ? 'Share a link to this page (it shows each visitor their own result, never yours)' : 'Share a link to this result', b => shareResult(r, b)),
      btn('copy', 'Copy ' + r.what, b => copyValue(r, b)),
      btn('md', 'Copy this result as Markdown' + (hidesYours(r) ? LEFT_OUT : ''), b => copyMd(r, b)));
    return bar;
  }
  // Whether the Markdown leaves you out: your own result, or one with addresses or names to hide (a graded
  // leaktest shares its grade's link, not the page itself, but its Markdown still hides them).
  function hidesYours(r) { return !!(r.self || (r.hide || []).some(Boolean) || (r.terms || []).some(Boolean)); }
  // A button answers in place: its label says "copied" for a moment, and screen readers hear what was copied.
  function flash(b, spoken) {
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = 'copied'; announce(spoken);
    clearTimeout(b.flashTimer); b.flashTimer = setTimeout(() => { b.textContent = b.dataset.label; }, 1600);
  }
  async function shareResult(r, b) {
    if (!live) return line('Sharing works once the site is deployed. Every lookup gets its own link, like https://your-domain/8.8.8.8', 'sys');
    if (!hasMouse() && navigator.share) {          // phones and tablets: the system share sheet
      try { return await navigator.share({ title: 'ipterm', text: r.text || (r.self ? 'check yours' : r.cmd), url: location.origin + r.path }); }
      catch (e) { if (e && e.name === 'AbortError') return; }   // turned down: nothing to do. Failed: copy instead
    }
    return copyLink(r, b);
  }
  async function copyLink(r, b) {
    const url = (live ? location.origin : 'https://your-domain') + r.path;
    const note = r.note || (r.self ? '   (check yours: it shows each visitor their own result, never yours)' : '');
    const ok = await toClipboard(url);
    if (ok && b) return flash(b, 'copied link: ' + url);
    line(ok ? 'copied link: ' + url + note : 'link: ' + url + '   (the clipboard is blocked here, so copy it by hand)', ok ? 'sys' : 'warn');
  }
  async function copyValue(r, b) {
    const shown = r.value.length > 60 || /\s/.test(r.value) ? r.what : r.value;
    const ok = await toClipboard(r.value);
    if (ok && b) return flash(b, 'copied ' + shown);
    line(ok ? 'copied ' + shown : `The clipboard is blocked here. Select ${r.what} above and copy it by hand.`, ok ? 'sys' : 'warn');
  }
  async function copyMd(r, b) {
    const head = r.bar.isConnected ? r.bar.closest('.head') : null;
    if (!head) return line('That result is no longer on the screen. Run it again to copy it.', 'warn');
    const ok = await toClipboard(markdown(r, head)), what = 'copied the result as Markdown' + (hidesYours(r) ? LEFT_OUT : '');
    if (ok && b) return flash(b, what);
    line(ok ? what : 'The clipboard is blocked here, so select the result and copy it by hand.', ok ? 'sys' : 'warn');
  }
  // The result as text, from its header line up to the next command: the header's tags, the table and
  // the notes under it, without the map, buttons, the sponsored line or the next: line.
  // Progress lines, not results: "ok · 12 ms", and cidr's "routing: ok · 12 ms" (or "routing: asking RIPEstat…"
  // while it waits; an error there stays, as a note).
  const NOT_RESULT = /^(routing: )?(ok|done) · (\d+ ms|sample data)$|^routing: asking RIPEstat|^queued: |^Click a prefix/;
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An address to hide, wherever it stands on its own: also before a sentence's "." or ":" ("address 192.168.1.5.",
  // "203.0.113.7: unless…") and an IPv4 before ":port", but never inside a longer address (1.2.3.45, 1.2.3.4.5,
  // 4.3.2.1.in-addr.arpa, 2001:db8::1:5).
  const hideRe = ip => new RegExp(`(?<![\\w.:])${reEsc(ip)}` + (ip.includes(':') ? '(?!\\w|[.:][\\w:])' : '(?!\\w|\\.\\w)'), 'gi');
  // A name or place to hide, as a whole word in any case ("Comcast", "comcast"), never inside a longer word
  // (DE in DEN). A code (a country or data center: two or three capitals) only in capitals: in lower case it
  // is an ordinary word (IN, IT, US, MAN, PER). UTC, and Cloudflare's T1 for Tor, say nothing about you.
  const CODE_RE = /^[A-Z][A-Z0-9]{1,2}$/;
  const termRe = t => new RegExp(`(?<![\\p{L}\\p{N}_])${reEsc(t)}(?![\\p{L}\\p{N}_])`, CODE_RE.test(t) ? 'gu' : 'giu');
  const mdTerms = list => [...new Set((list || []).map(t => (typeof t === 'string' ? t.trim() : '')))]
    .filter(t => t.length > 1 && t !== 'T1' && !/^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu)$/i.test(t))
    .sort((a, b) => b.length - a.length);         // the longest first: Europe/Berlin before Berlin
  function markdown(r, head) {
    // Addresses first, so a number among the names (a postal code: 1234) can't match inside one (2001:db8:1234::7)
    // and leave the rest showing. Then the names, with their own addresses hidden the same way, so a resolver named
    // "Cloudflare (1.1.1.1)" still goes whole. Hidden parts next to each other read as one ("near [hidden]", not
    // "near [hidden], [hidden]"), which doesn't say how many there were.
    const mask = (s, res) => res.reduce((a, re) => a.replace(re, '[hidden]'), s);
    const ips = (r.hide || []).filter(x => x && parseIp(x)).map(hideRe);
    const hide = [...ips, ...mdTerms((r.terms || []).map(t => (typeof t === 'string' ? mask(t, ips) : t))).map(termRe)];
    const clean = t => {
      const s = mask(t.replace(/\s*↗/g, '').replace(/\s*\n\s*/g, ' ').trimEnd(), hide);
      return hide.length ? s.replace(/\[hidden\](?:,? \[hidden\])+/g, '[hidden]') : s;
    };
    const textOf = node => {                     // status tags read [OK], [LEAK]...; buttons, outside links and
      const c = node.cloneNode(true);            // what only your own run says (.yours: the compare's summaries) go
      c.querySelectorAll('button, a[target="_blank"], .yours').forEach(x => x.remove());
      c.querySelectorAll('.tag').forEach(t => t.replaceWith(`[${t.textContent.toUpperCase()}]`));
      return c.textContent.trim();
    };
    const body = [];
    for (let n = head; n && (n === head || !n.classList.contains('echo')); n = n.nextElementSibling) {
      if (n === head) {
        const hip = n.querySelector('.hip').textContent, tags = [...n.querySelectorAll('.tag')].map(t => t.textContent);
        body.push((r.cmd.includes(hip) ? tags : [hip, ...tags]).join(' · '));
      } else if (n.tagName === 'DL') {
        const rows = []; let drop = false;
        for (const k of n.children) {
          if (k.classList.contains('sep')) { rows.push(null); continue; }
          if (k.tagName === 'DT') {
            const label = k.textContent.trim();
            if (label) drop = !!(r.drop && r.drop.includes(label));
            if (!drop) rows.push([label, '']);
          } else if (k.tagName === 'DD' && !drop && rows.length && rows[rows.length - 1]) rows[rows.length - 1][1] = textOf(k);
        }
        const w = Math.max(0, ...rows.filter(Boolean).map(x => x[0].length));
        body.push('', ...rows.map(x => (x ? x[0].padEnd(w) + '  ' + x[1] : '')), '');
      } else if (n.classList.contains('head')) {   // a section's own header, like the routing under a cidr result
        body.push('', [...n.querySelectorAll('.hip, .tag')].map(t => t.textContent).join(' · '));
      } else if (n.classList.contains('ln') && !['sponsor', 'next', 'run-yours', 'badge-snip'].some(c => n.classList.contains(c))) {
        const t = textOf(n);
        if (t && !NOT_RESULT.test(t)) body.push(t);
      }
    }
    const text = body.map(clean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // A fence longer than any run of backticks in the result, so a TXT record can't end the block early.
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map(x => x.length + 1)));
    return `${fence}\n$ ${clean(r.cmd)}\n${text}\n${fence}\n${live ? location.origin : 'https://your-domain'}${r.path}\n`;
  }

  function historyCmd(arg) {
    const a = String(arg || '').toLowerCase(), say = m => { announce(m); return line(m, 'sys'); };
    if (a === 'clear' || a === '-c') { store(HIST_KEY, null); hist.length = 0; hIdx = 0; return say('History cleared: no commands are saved in this browser now.'); }
    if (a === 'off') {
      store(HIST_OFF, '1'); store(HIST_KEY, null);
      return say("History off: commands are no longer saved in this browser, and the saved ones are deleted. Up and Down still recall this tab's commands. history on saves them again.");
    }
    if (a === 'on') { store(HIST_OFF, null); return say(`History on: your commands are saved in this browser again (the newest ${HIST_MAX}, never their results).`); }
    if (a) return line('usage: history   history clear   history off   history on', 'warn');
    const list = hist.slice(0, -1);                // everything before this `history`
    if (!list.length) return line('No history yet.', 'sys');
    list.forEach((h, i) => { const d = el('div', 'ln'); d.append(String(i + 1).padStart(4) + '  ', runnable(h, h)); out.appendChild(d); });
    scroll();
    line(histOff() ? "Saving is off, so these are only this tab's commands. history on saves them again."
      : `Saved in this browser only: the newest ${HIST_MAX} commands, never their results. history clear deletes them; history off stops saving.`, 'sys');
    announce(`${list.length} command${list.length > 1 ? 's' : ''} in your history.`);
  }
  function copy(arg) {
    const a = String(arg || '').toLowerCase();
    if (a && !/^(--?)?(md|markdown|link|url|badge)$/.test(a)) return line('usage: copy   copy md   copy link   copy badge', 'warn');
    if (/badge/.test(a)) return copyBadge();
    if (!current) return line('Nothing to copy: run whoami or a lookup first.', 'warn');
    return /md|markdown/.test(a) ? copyMd(current) : a ? copyLink(current) : copyValue(current);
  }
  // copy badge: the shields.io badge's Markdown for the current report card (grade <domain>).
  async function copyBadge() {
    if (!current || !current.badge) return line('copy badge copies a README badge after a report card: run grade <domain> first, e.g. grade github.com', 'warn');
    const ok = await toClipboard(current.badge);
    line(ok ? 'copied the badge Markdown: paste it into your README' : 'The clipboard is blocked here, so select the Markdown above and copy it by hand.', ok ? 'sys' : 'warn');
  }
  function share() {
    // With no result on screen (a tool's page, the API reference) the page's own link is shared. After leaktest it
    // is your grade's link (see leaktest()), or the check itself when the run has no grade.
    if (current && current.cmd === 'leaktest' && !leakCode) line("This run has no grade to share (ipterm couldn't tell whether you use a VPN), so here's the test itself:", 'sys');
    return shareResult(current || { cmd: document.title.replace(/\s*\|\s*ipterm$/, ''), path: location.pathname });
  }

  async function privacy() {
    await lines(['No accounts, no cookies, no analytics. Your IP is shown back to you and used for about a minute to stop abuse.',
      'Addresses you look up are sent to IPinfo (and proxycheck.io, to check for VPNs) and to their regional internet registry, for the date their network was registered (never your own address: only whois sends that to one); networks and routes go to RIPEstat, domain names go to Cloudflare\'s DNS resolver, a mail check also fetches the domain\'s own MTA-STS policy file, and a report card (grade) asks the domain\'s own website for its headers (from ipterm\'s server, never from your browser). Your own IP is only sent to them if you run leaktest (to IPinfo and proxycheck.io, with your other IP version), which also asks a STUN server run by Cloudflare which address your browser reveals, and looks up a few random names under ipterm\'s own DNS server, which sees the address of your DNS resolver and forgets it within two minutes. Its share link holds only the grade and which checks passed, never your IP or location. port <number> makes the ipterm server connect to your own address on that one port, and nothing about it is kept. To show your other address (IPv4 or IPv6), your browser asks ipify, which says it logs nothing. Sponsored lines are plain labeled links.',
      'The commands you type are saved in your own browser (the newest 200, never their results) and never leave it: history clear deletes them, history off stops saving.'], 'sys');
    if (!live) return line('The full privacy policy is at /privacy on the deployed site.', 'sys');
    const d = el('div', 'ln sys'); const a = el('a', 'cmd', 'read the full privacy policy ↗'); a.href = '/privacy';
    d.append(a); out.appendChild(d); scroll();
  }

  // The search form people paste into a wiki: a plain GET to /go. The same as goForm() in worker.js.
  const goForm = action => `<form action="${action}" method="get" role="search">\n` +
    '  <input type="search" name="q" aria-label="IP address, domain, ASN, range or port" placeholder="8.8.8.8, example.com, AS13335 or 10.0.0.0/22" required>\n' +
    '  <button type="submit">Look up on ipterm</button>\n</form>';
  // A curl line to show; URLs with ? are quoted, since zsh would treat the ? as a wildcard.
  const curlLine = (p, flag = '') => { const u = (live ? location.origin : 'https://your-domain') + p, f = flag ? flag + ' ' : ''; return p.includes('?') ? `curl ${f}'${u}'` : `curl ${f}${u}`; };
  async function apiHelp() {
    setUrl('/api', 'ipterm API: IP address lookups from curl and scripts | ipterm');
    await kv([
      [curlLine(''), 'your IP as plain text'],
      [curlLine('/me'), 'a card with a world map: your IP, network, place and time zone (?w=40, ?color=0, ?redact)'],
      [curlLine('/json'), 'your IP details as JSON'],
      [curlLine('/text'), 'the same as aligned lines'],
      [curlLine('/asn'), 'one value for your own address: /asn /org /cc /city /tz /colo /hostname'],
      [curlLine('/line'), 'IP, network, country and data center on one line, for shell prompts and tmux'],
      [curlLine('/expect/AS13335', '-fs'), 'HTTP 200 if you are on that network (or /expect/CH for a country), 412 if not: a VPN kill switch'],
      [curlLine('/8.8.8.8'), 'any IP as JSON'],
      [curlLine('/8.8.8.8/country'), 'one value for any IP: asn, org, cc, country, continent or hostname'],
      [curlLine('/AS13335'), 'any network as JSON'],
      [curlLine('/whois/8.8.8.8'), 'registry record as JSON'],
      [curlLine('/whois/example.com'), 'domain registration as JSON'],
      [curlLine('/cidr/10.0.0.0/22'), 'subnet calculation as JSON'],
      [curlLine('/route/1.1.1.0/24'), 'routing as JSON: origin network, RPKI, visibility, AS paths (a prefix or an address)'],
      [curlLine('/dns/example.com'), 'DNS records as JSON (add /MX for one type)'],
      [curlLine('/mail/gmail.com'), 'email security check (SPF, DMARC, DKIM, MTA-STS) and its grade as JSON'],
      [curlLine('/grade/github.com'), 'domain report card as JSON, graded A to F; /badge/github.com.json is its shields.io badge'],
      [curlLine('/port/22', '-4'), 'is TCP port 22 open on your own IP? (JSON; -4 tests IPv4)'],
      [curlLine('/leaktest/r/1bjp'), 'a leak test result someone shared, as JSON: the grade, whether a VPN was on, each check'],
      [curlLine('/8.8.8.8/text'), 'any IP (or /AS13335/text, any network) as aligned text lines; ?format=text for any other lookup'],
      [curlLine('/8.8.8.8/text?color=1'), 'the same with colors for a terminal (off unless asked for, so pipes into grep or jq stay clean)'],
      [curlLine('/help'), 'this reference as plain text'],
    ]);
    line('Open the same links in a browser to get a shareable page. One-value answers are a single line; a missing value is an empty line with HTTP 404.', 'sys');
    const d = el('div', 'ln sys'), doc = (href, text) => { const a = el('a', 'cmd', text); a.href = href; return a; };
    d.append('machine-readable: ', doc('/openapi.json', 'OpenAPI'), '  ·  ', doc('/llms.txt', 'llms.txt'));
    // Address-bar search (/go, which public/opensearch.xml offers to browsers) and a form for wikis that uses it.
    const go = el('div', 'ln sys');
    go.append('search from the address bar: ', doc('/go?q=8.8.8.8', '/go?q=<IP, domain, ASN, range, email or port n>'),
      ' opens the matching page, and browsers offer ipterm as a search engine.');
    const form = el('div', 'ln sys'), html = goForm((live ? location.origin : 'https://your-domain') + '/go');
    const btn = el('button', 'share-btn', 'copy'); btn.type = 'button'; btn.setAttribute('aria-label', 'Copy the search form as HTML');
    btn.addEventListener('click', () => toClipboard(html).then(ok => (ok ? flash(btn, 'copied the search form') : line('The clipboard is blocked here, so select the form below and copy it by hand.', 'warn'))));
    form.append('a search box for a wiki or intranet page (plain HTML, no script)  ', btn);
    const credit = el('div', 'ln sys'), ipinfo = el('a', '', 'IPinfo ↗');
    ipinfo.href = 'https://ipinfo.io'; ipinfo.target = '_blank'; ipinfo.rel = 'noopener';
    credit.append('IP address data powered by ', ipinfo);
    out.append(d, go, form, el('div', 'ln snippet', html), credit); scroll();
    if (!live) line('These routes work once the Worker is deployed.', 'sys');
    announce('API reference: curl commands for your IP, one value at a time, any IP, network, DNS name, registry record or subnet.');
    next(['whoami', 'whoami', 'your own IP, as /json returns it'], ['lookup 8.8.8.8', 'lookup 8.8.8.8', 'what /8.8.8.8 returns, drawn in the terminal']);
  }

  // The end of `about`: whether this is a copy, and the deployed build, from the footer the server filled in
  // (data-copy, data-build, data-source: footBuild() in worker.js).
  function about() {
    const copy = document.querySelector('[data-copy]'), b = document.querySelector('[data-build]');
    if (copy) line(`${location.host} runs a copy of ipterm's open-source code, set up by someone else: it is not ipterm.net.`, 'sys');
    if (!b) return;
    const d = el('div', 'ln sys'), sha = b.dataset.build, src = b.dataset.source;
    if (sha) d.append('the code we deploy: ' + sha + (src ? '  ' : ''));
    if (src) { const a = el('a', 'cmd', sha ? 'read it ↗' : 'source code ↗'); a.href = src; a.target = '_blank'; a.rel = 'noopener'; d.append(a); }
    out.appendChild(d); scroll();
  }

  const RESULTS = new Set(['whoami', 'ifconfig', 'ipconfig', 'ip', 'leaktest', 'whois', 'cidr', 'route', 'dig', 'mail', 'grade', 'lookup', 'asn', 'port']);
  // save: false for what the page runs by itself (a tool page's command, Back and Forward), which isn't saved.
  async function run(raw, save = true) {
    let cmd = raw.trim(); echo(raw);
    if (!cmd) return;
    if (/!(!|-?\d)/.test(cmd)) {                    // !! and !<n>, as in bash: show what runs, then run it
      const x = expandHistory(cmd);
      if (x.missing) return line(`${x.missing}: event not found`, 'err');
      cmd = x.cmd; line(cmd, 'sys');
    }
    addHist(cmd);
    if (save) remember(cmd);
    const [c0, ...args] = cmd.split(/\s+/);
    const lc = c0.toLowerCase(), c = ALIASES[lc] || lc;
    if (args.length === 1 && /^(--help|-h)$/.test(args[0]) && (MAN[c] || HELP.some(r => r[0].split(' ')[0] === c))) return man(c);
    const localNote = () => line("Browsers can't read your device's own network addresses. This is the public address websites see:", 'sys');
    // A new lookup replaces the current result, even if it fails, so copy never copies an older one.
    if (RESULTS.has(c)) current = null;
    switch (c) {
      case 'help': case 'man': return args[0] ? man(args[0]) : help();
      case 'whoami': return whoami();
      case 'ifconfig': case 'ipconfig': localNote(); return whoami();
      case 'ip':                                  // `ip a` from Linux; `ip 8.8.8.8` is a lookup
        if (args[0] && (parseIp(args[0]) || /^as\d+$/i.test(args[0]) || looksLikeDomain(args[0]))) return lookup(args[0]);
        localNote(); return whoami();
      case 'leaktest': return leaktest(args);
      case 'whois': return args[0] ? whois(args[0]) : toolIntro('whois');
      case 'cidr':                                // `cidr --table` heads the subnet cheat sheet guide
        if (/^--?table$/i.test(args[0] || '') && CIDRLIB) return cidrTable();
        return cidr(args.join(' '));
      case 'dig': return args[0] ? dns(args[0], args[1]) : toolIntro('dns');
      case 'mail':
        if (!args.length) { await toolIntro('mail'); return next(['man mail', 'man mail', 'the checks, and how the grade works']); }
        // `dkim example.com selector1` names the selector without --dkim
        return mail(lc === 'dkim' && args[1] && !/^-/.test(args[1]) ? [args[0], '--dkim', args[1]] : args);
      case 'grade':
        if (!args.length) { await toolIntro('grade'); return next(['man grade', 'man grade', 'the checks, how the grade works, and the badge']); }
        return grade(args);
      case 'lookup': return args[0] ? lookup(args[0]) : line('usage: lookup <ip, domain or ASN>   example: lookup 8.8.8.8', 'warn');
      case 'asn': return args[0] ? asn(args[0]) : line('usage: asn <number>   example: asn AS13335', 'warn');
      case 'route': return route(args.join(' '));
      case 'port': return portCmd(args);
      case 'ping': return ping(args);
      case 'traceroute': return traceroute(args[0]);
      case 'share': return share();
      case 'privacy': return privacy();
      case 'clear': out.textContent = ''; current = null; return;
      case 'keys': return keys();
      case 'history': return historyCmd(args[0]);
      case 'theme': return theme(args[0]);
      case 'crt': return crt(args[0]);
      case 'reset': return reset();
      case 'access': return access();
      case 'copy': return copy(args[0]);
      case 'api': return apiHelp();
      // what people type out of habit in other terminals (and the prompts shown on the site's own pages)
      case 'ls':
        if (/^guides\/?$/i.test(args[0] || '')) {
          GUIDES.forEach(([slug]) => { const d = el('div', 'ln'); d.append(guideLink(slug)); out.appendChild(d); });
          return scroll();
        }
        line('No files here, just commands:', 'sys'); return help();
      case 'cat':
        if (/^privacy(\.txt)?$/i.test(args[0] || '')) return privacy();
        return line('cat: no files here, just commands. Type help to see them.', 'sys');
      case 'cd': return line('cd: there is only one directory here. Type help to see what you can do.', 'sys');
      case 'pwd': return line('/home/guest', 'sys');
      case 'sudo': return line('guest is not in the sudoers file. (Nothing is reported: ipterm logs nothing about visitors.)', 'sys');
      case 'exit': return line('There is no session to end: no account, no cookies and nothing kept on the server, so you can just close the tab.', 'sys');
      case 'date': return line(new Date().toUTCString(), 'sys');
      case 'echo': return line(args.join(' '));
      case 'uname': return line('ipterm 0.2 (Cloudflare Workers)', 'sys');
      case 'about':
        return lines([
          'ipterm shows who operates an IP address or network and roughly where it sits.',
          "Your own address comes from Cloudflare's edge data. Other addresses come from IPinfo. Networks come from RIPEstat. Registry records (whois) come from the regional internet registries, and for domains from the domain's registry and registrar, via RDAP. DNS answers come from Cloudflare's public resolver (1.1.1.1), and so do mail checks, apart from the MTA-STS policy file, which comes from the domain's own server. A report card (grade) also reads the headers of the domain's own website.",
          "IP location is approximate. It usually points at the ISP's routing hub, not a street address.",
          'The map shows that uncertainty as lit dots. Click a map to switch between world view and zoomed in.',
          'Map data: Natural Earth (public domain).',
          'No cookies and no tracking. Sponsored lines are labeled and are plain links. Type privacy for details.',
        ], 'sys').then(about);
      default: {
        current = null;                            // an address, range or domain on its own is a lookup too
        if (parseIp(c0) || /^as\d+$/i.test(c0)) return lookup(c0);
        if (looksLikeCidr(cmd)) return cidr(cmd);
        if (looksLikeDomain(c0)) return dns(c0);
        const guess = closest(lc, args[0] && looksLikeDomain(args[0]) ? 'mail' : null);   // man gmail.com would find nothing
        if (!guess) return line(`command not found: ${c0}. Type help for the list.`, 'err');
        line(`command not found: ${c0}`).className = 'ln err';     // spoken once, with the suggestion, below
        const fix = [guess, ...args].join(' '), d = el('div', 'ln sys');
        d.append('did you mean ', runnable(fix, fix), '?');
        out.appendChild(d); scroll();
        announce(`command not found: ${c0}. Did you mean ${fix}? Type help for the list.`);
      }
    }
  }

  // Type-ahead, as in a real terminal: a command entered while another runs waits its turn (a few at
  // most). If the one running is a slow one, a note says so; quick ones just finish first.
  let running = 'whoami', startedAt = 0;
  const queued = [];
  const runQueued = () => { if (queued.length) { const [v, save] = queued.shift(); setTimeout(() => exec(v, save), 0); } };
  async function exec(v, save = true) {
    if (busy) {
      if (!String(v).trim() || queued.length >= 5) return;
      queued.push([v, save]);
      if (performance.now() - startedAt > 400) {
        const msg = `queued: ${String(v).trim()} (runs after ${running})`;
        line(msg, 'sys'); announce(msg);
      }
      return;
    }
    busy = true; running = String(v).trim(); startedAt = performance.now(); nextItems = null;
    const mark = out.lastChild;
    try { await run(v, save); } finally {
      busy = false;
      if (!nextItems && failedUpstream(mark)) next(['retry', running, 'run the same command again']);
      flushNext(); scroll();
      // On phones a result rarely fits on screen: start at its top (the command) rather than its last line.
      const first = mark ? mark.nextSibling : out.firstChild;
      if (!hasMouse() && first && first.isConnected) reveal(first);
      runQueued();
    }
  }

  /* ---------- Tab completion, Ctrl+R and !! ----------
     Tab completes the word being typed: a command, a record type after dig <name>, a theme, or an address,
     domain, range or AS number from your history. When several match, the first Tab fills in what they
     share and each further Tab steps to the next one (the hint beside the prompt lists them). Tab on an
     empty prompt, and Shift+Tab always, move focus as usual, so keyboard users can still leave the
     terminal. Ctrl+R searches the history as you type, newest first: Ctrl+R again finds an older match,
     Enter runs it, an arrow key or Tab keeps it for editing, Esc gives your line back. !! is the previous
     command and !<n> the nth in `history`, as in bash. */
  const COMMANDS = [...new Set([...HELP.map(r => r[0].split(' ')[0]).filter(w => /^[a-z]/.test(w)), 'traceroute'])];
  const VALUE_ARGS = new Set(['lookup', 'whois', 'dig', 'mail', 'grade', 'asn', 'cidr', 'route', 'ip', 'traceroute']);
  const WORD_ARGS = { theme: () => THEMES, crt: () => ['on', 'off'], history: () => ['clear', 'off', 'on'], copy: () => ['md', 'link', 'badge'],
    man: () => COMMANDS, help: () => COMMANDS, port: () => (PORTSLIB ? PORTSLIB.list().map(String) : []) };
  const hint = el('span', 'hint'); hint.hidden = true; hint.setAttribute('aria-hidden', 'true'); form.appendChild(hint);
  const showHint = t => { hint.textContent = t; hint.hidden = false; };
  // Addresses, domains, ranges and AS numbers from your history, newest first.
  function histValues() {
    const seen = new Set();
    for (let i = hist.length - 1; i >= 0; i--) {
      for (const w of hist[i].split(/\s+/)) if (parseIp(w) || /^as\d{1,10}$/i.test(w) || looksLikeCidr(w) || (looksLikeDomain(w) && !/[/:]/.test(w))) seen.add(w);
    }
    return [...seen];
  }
  let tabCycle = null;                             // { lead, list, i } while Tab steps through several matches
  function complete() {
    const v = input.value;
    if (tabCycle && v === tabCycle.lead + tabCycle.list[tabCycle.i]) {
      tabCycle.i = (tabCycle.i + 1) % tabCycle.list.length;
      input.value = tabCycle.lead + tabCycle.list[tabCycle.i];
      return showHint(`${tabCycle.i + 1}/${tabCycle.list.length}  ` + tabCycle.list.join('  '));
    }
    tabCycle = null;
    const lead = v.replace(/\S*$/, ''), word = v.slice(lead.length), before = lead.trim() ? lead.trim().split(/\s+/) : [];
    const c = before.length ? ALIASES[before[0].toLowerCase()] || before[0].toLowerCase() : '';
    const pool = !before.length ? [...COMMANDS, ...histValues()]
      : before.length === 2 && c === 'dig' && !parseIp(before[1]) ? DNS_TYPES
      : before.length === 1 && WORD_ARGS[c] ? WORD_ARGS[c]()
      : before.length === 1 && VALUE_ARGS.has(c) ? histValues() : [];
    const w = word.toLowerCase(), list = [...new Set(pool)].filter(x => x.toLowerCase().startsWith(w));
    if (!list.length) return announce('No completions.');
    if (list.length === 1) { input.value = lead + list[0] + ' '; return; }
    const shared = list.reduce((a, b) => { let n = 0; while (n < a.length && n < b.length && a[n].toLowerCase() === b[n].toLowerCase()) n++; return a.slice(0, n); });
    showHint(list.join('  '));
    announce(`${list.length} matches: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ' and more' : ''}.`);
    if (shared.length > word.length) { input.value = lead + shared; return; }
    tabCycle = { lead, list, i: 0 };
    input.value = lead + list[0];
  }

  let search = null;                               // { orig: the line before Ctrl+R, at: index of the match in hist }
  const ps1 = form.querySelector('.ps1'), PS1 = ps1.textContent, PLACEHOLDER = input.placeholder;
  function searchStart() {                         // what's already typed is the first search
    search = { orig: input.value, at: -1 };
    ps1.textContent = '(reverse-i-search)';
    input.placeholder = 'search your history'; input.setAttribute('aria-label', 'Search your command history');
    announce('History search. Type to search, Control R for an older match, Enter to run it, Escape to cancel.');
    searchFind(false);
  }
  function searchFind(older) {
    const q = input.value.toLowerCase(), cur = search.at >= 0 ? hist[search.at] : null;
    let i = older && search.at >= 0 ? search.at : hist.length;
    while (--i >= 0) if (hist[i].toLowerCase().includes(q) && !(older && hist[i] === cur)) break;
    if (i >= 0 || !older) search.at = i;           // Ctrl+R past the oldest match keeps the one shown
    const hit = search.at >= 0 ? hist[search.at] : null;
    showHint(hit ? '→ ' + hit : q ? 'no match' : 'type to search');
    if (hit && q) announce(hit);
  }
  function searchEnd(value) {                      // the prompt keeps value: the match, or the line from before
    search = null;
    ps1.textContent = PS1; input.placeholder = PLACEHOLDER; input.setAttribute('aria-label', 'Command');
    hint.hidden = true; input.value = value;
  }
  function searchKey(e, k, ctrl) {                 // true when the key was the search's
    const hit = search.at >= 0 ? hist[search.at] : null;
    if (ctrl && k.toLowerCase() === 'r') { e.preventDefault(); searchFind(true); return true; }
    if (k === 'Escape' || (ctrl && k.toLowerCase() === 'g')) { e.preventDefault(); searchEnd(search.orig); return true; }
    if (k === 'Enter') {
      e.preventDefault(); searchEnd(hit != null ? hit : input.value);
      if (hit != null) form.requestSubmit();
      return true;
    }
    if (k === 'Tab' && (e.shiftKey || hit == null)) { searchEnd(input.value); return false; }   // Tab as usual
    if (['Tab', 'ArrowUp', 'ArrowDown'].includes(k)) { e.preventDefault(); searchEnd(hit != null ? hit : input.value); return true; }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) { searchEnd(hit != null ? hit : input.value); return true; }
    return true;                                   // typing changes the search; the input event looks again
  }

  // !! is the previous command, !<n> number n in `history` and !-<n> the nth from the end.
  function expandHistory(cmd) {
    let missing = null;
    const x = cmd.replace(/!(!|-?\d+)/g, (m, ref) => {
      const i = ref === '!' ? hist.length - 1 : ref[0] === '-' ? hist.length + Number(ref) : Number(ref) - 1;
      if (i >= 0 && i < hist.length) return hist[i];
      if (!missing) missing = m;
      return m;
    });
    return { cmd: x, missing };
  }

  async function keys() {
    await kv([
      ['Enter', 'run the command'],
      ['Up / Down', 'step through your history'],
      ['Tab', 'complete a command, a record type after dig <name>, or an address or domain from your history. Several matches: Tab again steps through them. On an empty prompt, Tab moves on'],
      ['Ctrl+R', 'search your history as you type: Ctrl+R again for an older match, Enter to run it, an arrow key to edit it, Esc to cancel'],
      ['!!', 'the previous command again, also inside a line; !3 runs number 3 in history'],
      ['Ctrl+L', 'clear the screen'],
    ]);
    announce('Keyboard shortcuts: Tab completes, Control R searches history, two exclamation marks repeat the last command.');
  }

  /* ---------- wiring ---------- */
  // Focus the command line only for mouse/trackpad users: on phones and tablets focusing it pops up
  // the keyboard. After a command is submitted on a touch screen, close the keyboard so the result shows.
  const hasMouse = () => matchMedia('(pointer: fine)').matches;
  const focusInput = () => { if (hasMouse()) input.focus({ preventScroll: true }); };
  form.addEventListener('submit', e => {
    e.preventDefault(); const v = input.value; input.value = '';
    if (!hasMouse()) input.blur();
    exec(v);
  });
  input.addEventListener('keydown', e => {
    const k = e.key || '', ctrl = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;   // (autofill sends no key)
    if (search && searchKey(e, k, ctrl)) return;
    if (k !== 'Tab') { tabCycle = null; hint.hidden = true; }
    if (k === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (!input.value.trim()) return;             // an empty prompt: Tab moves focus on, as on any page
      e.preventDefault(); return complete();
    }
    if (ctrl && k.toLowerCase() === 'r') { e.preventDefault(); return searchStart(); }
    if (k === 'ArrowUp' && hist.length) { e.preventDefault(); hIdx = Math.max(0, hIdx - 1); input.value = hist[hIdx]; }
    else if (k === 'ArrowDown' && hist.length) { e.preventDefault(); hIdx = Math.min(hist.length, hIdx + 1); input.value = hist[hIdx] || ''; }
    else if (ctrl && k.toLowerCase() === 'l') { e.preventDefault(); out.textContent = ''; current = null; }
  });
  input.addEventListener('input', () => { if (search) searchFind(false); else { tabCycle = null; hint.hidden = true; } });
  input.addEventListener('blur', () => { if (search) searchEnd(search.orig); });
  document.querySelectorAll('button[data-cmd]').forEach(b => b.addEventListener('click', () => { exec(b.dataset.cmd); focusInput(); }));
  // Links in the section below the terminal are real links for crawlers and new tabs; a plain click
  // runs the lookup right in the terminal instead of reloading the page.
  document.querySelectorAll('a[data-cmd]').forEach(a => a.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    exec(a.dataset.cmd);
    focusInput();
  }));
  screen.addEventListener('mouseup', () => { if (!String(getSelection())) focusInput(); });
  window.addEventListener('popstate', () => {
    const c = cmdFor(location.pathname, location.search);
    if (!c || !live) return;
    navPush = false;
    exec(c, false).finally(() => { navPush = true; });
  });

  const clock = $('#clock');
  const tick = () => { clock.textContent = new Date().toISOString().slice(11, 19) + ' UTC'; };
  tick(); setInterval(tick, 1000);

  try { const t = localStorage.getItem('ipterm-theme'); if (THEMES.includes(t)) setTheme(t); } catch {}
  try { if (localStorage.getItem('ipterm-fx') === 'off') document.documentElement.dataset.fx = 'off'; } catch {}
  try { matchMedia('(prefers-contrast: more)').addEventListener('change', redrawMaps); } catch {}

  function readInitial() {
    const s = document.getElementById('ipterm-initial');
    if (!s) return null;
    try { return JSON.parse(s.textContent); } catch { return null; }
  }

  // Whatever the first page runs counts as running, so input meanwhile waits its turn (see exec).
  async function boot() {
    busy = true; startedAt = performance.now();
    try { await start(); } finally { busy = false; fast = hold = false; runQueued(); }
  }

  async function start() {
    const init = readInitial();
    // The homepage carries your address (kind "self"), so there is nothing to ask the API for.
    const selfP = init && init.kind === 'self' && init.data ? parseIp(init.data.ip) : null;
    // Server summary for no-JS visitors and crawlers. The terminal redraws its heading line and table,
    // so only those go; the summary sentence and links stay for crawlers that run scripts. A 404 and
    // the homepage's whoami are drawn in full by the terminal, so their server copies go entirely.
    const stat = document.getElementById('static');
    // The /api page's plain-text reference goes too: the terminal prints it with links (`api`).
    if (stat && (selfP || (init && (init.kind === 'notfound' || init.kind === 'leakshare')))) stat.remove();
    else if (stat) stat.querySelectorAll('.head, dl, .api-ref, .badge-ref').forEach(n => n.remove());   // the report card prints its own badge Markdown
    fast = hold = !!selfP;                                // swap the server's copy for the terminal's in one frame
    await lines(['ipterm 0.2 · IP address lookup', 'type help for commands, or enter any IP address, domain or ASN'], 'sys');

    if (init && init.kind === 'notfound') { setLive(true); notFound(init); return focusInput(); }
    // Someone else's leak test result (/leaktest/r/<code>): drawn from the code, with a "run yours" link.
    // It never runs the test on load: that would test this visitor's browser without asking.
    if (init && init.kind === 'leakshare') {
      setLive(true);
      const cmd = running = 'leaktest --result ' + init.code;
      echo(cmd); addHist(cmd);
      navPush = false;
      try { await leakResult(init.code); } finally { navPush = true; }
      flushNext();
      return focusInput();
    }
    if (init && init.kind === 'tool' && (TOOL_INTRO[init.tool] || ['leaktest', 'port', 'api'].includes(init.tool))) {
      setLive(true);
      const cmd = running = { whois: 'whois', dns: 'dig', mail: 'mail', grade: 'grade', cidr: 'cidr', leaktest: 'leaktest', port: 'port', api: 'api' }[init.tool];
      const mark = out.lastChild;
      navPush = false;
      try { await run(cmd, false); } finally { navPush = true; }
      if (!nextItems && failedUpstream(mark)) next(['retry', cmd, 'run the same command again']);
      flushNext();
      return focusInput();
    }
    // A port's page explains it and offers a button: it never checks on load (crawlers, prefetches, Back).
    if (init && init.kind === 'port') {
      setLive(true);
      const n = PORTSLIB ? PORTSLIB.parse(init.query) : null;
      const cmd = running = n && !init.error ? `port ${n} --info` : `port ${init.query}`;
      echo(cmd); addHist(cmd);
      navPush = false;
      try { if (n && !init.error) await portAbout(n); else line(init.error || 'Not a port number. Ports run from 1 to 65535: port 22', 'err'); }
      finally { navPush = true; }
      flushNext();
      return focusInput();
    }
    if (init && ['ip', 'asn', 'whois', 'dns', 'mail', 'grade', 'cidr'].includes(init.kind) && init.query) {
      setLive(true);
      const mailCmd = ['mail', init.query, ...(init.dkim ? ['--dkim', init.dkim] : [])];
      const cmd = init.kind === 'cidr' ? 'cidr ' + init.query : init.kind === 'dns' ? 'dig ' + init.query + (init.qtype && init.qtype !== 'PTR' ? ' ' + init.qtype : '')
        : init.kind === 'mail' ? mailCmd.join(' ') : (init.kind === 'asn' ? 'asn ' : init.kind === 'whois' ? 'whois ' : init.kind === 'grade' ? 'grade ' : 'lookup ') + init.query;
      // Opened from one of your own addresses' links (ipPath): it stays yours, so Back and Forward ask without the date too.
      if (init.kind === 'ip' && new URLSearchParams(location.search).get('block') === '0') own(init.query);
      running = cmd;
      echo(cmd); addHist(cmd);
      const mark = out.lastChild;
      navPush = false;
      try {
        await (init.kind === 'asn' ? asn(init.query, init) : init.kind === 'whois' ? whois(init.query, init) : init.kind === 'dns' ? dns(init.query, init.qtype, init)
          : init.kind === 'mail' ? mail(mailCmd.slice(1), init) : init.kind === 'grade' ? grade([init.query], init)
          : init.kind === 'cidr' ? cidr(init.query, init) : lookup(init.query, init));
      }
      finally { navPush = true; }
      if (!nextItems && failedUpstream(mark)) next(['retry', cmd, 'run the same command again']);
      flushNext();
      return focusInput();
    }

    echo('whoami'); addHist('whoami');
    if (selfP) {
      setLive(true);
      const d = init.data;
      await render(selfP, d.ip, d, true);
      fast = false;
      whoamiNext(d);
      await sponsor('whoami');
      flushNext();
      hold = false;
      reveal(out.querySelector('dt.bigl'));               // only scrolls if your IP is out of view
      return focusInput();
    }
    fast = hold = false;
    const q = line('querying…', 'sys');
    const t0 = performance.now();
    const d = await api('');
    const p = d && !d.error ? parseIp(d.ip) : null;
    if (p) {
      setLive(true);
      q.textContent = `ok · ${Math.round(performance.now() - t0)} ms`;
      await render(p, d.ip, d, true);
      whoamiNext(d);
      await sponsor('whoami');
    } else if (d && d.error && d.error !== 'no-api' && !/^network/.test(d.error)) {
      setLive(true);                                     // the server is there but refused (e.g. rate limit)
      q.textContent = d.error; q.className = 'ln err'; announce(q.textContent);
      next(['retry', 'whoami', 'ask again']);
    } else {
      setLive(false);
      q.textContent = 'No lookup API at /api/lookup, so this preview runs on sample data. Deploy the Worker to go live.';
      q.className = 'ln warn'; announce(q.textContent);
      await render(parseIp(DEMO.self.ip), DEMO.self.ip, { ...DEMO.self }, true);
      whoamiNext(DEMO.self);
      await sponsor('whoami');
    }
    flushNext();
    reveal(out.querySelector('dt.bigl'));
    focusInput();
  }
  boot();
})();
