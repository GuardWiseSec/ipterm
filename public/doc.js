// Applies the visitor's saved terminal theme to content pages such as the privacy policy.
(() => {
  try {
    const t = localStorage.getItem('ipterm-theme');
    if (t === 'amber' || t === 'ice') document.documentElement.dataset.crt = t;
  } catch {}
})();
