// Applies saved display settings before the page paints, so a visitor who chose high contrast,
// paper or "crt off" never sees a flash of the default glowing theme. Loaded by every page.
// Also wires the light/dark switch in the header ([data-theme-toggle]) on every page.
(() => {
  const d = document.documentElement;
  const DARK = ['phosphor', 'amber', 'ice', 'contrast'];
  const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };

  const t = get('ipterm-theme');
  if ([...DARK, 'paper'].includes(t)) d.dataset.crt = t;
  if (get('ipterm-fx') === 'off') d.dataset.fx = 'off';

  const isLight = () => d.dataset.crt === 'paper';
  function sync() {                                      // the button names the theme it switches to
    const light = isLight(), label = light ? 'Switch to the dark theme' : 'Switch to the light theme';
    document.querySelectorAll('[data-theme-toggle]').forEach(b => {
      b.textContent = light ? 'dark' : 'light';
      b.setAttribute('aria-label', label); b.title = label;
    });
  }
  function toggle() {
    if (isLight()) {                                     // back to whichever dark theme they had
      const back = get('ipterm-dark');
      if (DARK.includes(back)) { d.dataset.crt = back; put('ipterm-theme', back); }
      else { delete d.dataset.crt; put('ipterm-theme', null); }
    } else {
      put('ipterm-dark', d.dataset.crt || null);
      d.dataset.crt = 'paper'; put('ipterm-theme', 'paper');
    }
    sync();
    document.dispatchEvent(new CustomEvent('ipterm:theme', { detail: isLight() ? 'light' : 'dark' }));
  }
  window.IPTERM_PREFS = { sync, forgetDark: () => put('ipterm-dark', null) };
  const wire = () => { document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', toggle)); sync(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
