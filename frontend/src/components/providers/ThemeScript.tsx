/**
 * Inline pre-hydration script. Reads dda-tweaks from localStorage (and an
 * optional ?theme= URL param so headless QA can flip themes without
 * cross-origin localStorage trickery), then sets data-theme + CSS vars
 * BEFORE the page paints. Prevents FOUC.
 *
 * Placed in <head> via app/layout.tsx. Rendered as a raw <script> with
 * dangerouslySetInnerHTML — NOT next/script, because Script's runtime
 * defers execution and pre-hydration must run before first paint. Next
 * 16 also warns "Encountered a script tag while rendering React component"
 * on inline <Script strategy="beforeInteractive">, so the raw tag is now
 * the canonical anti-FOUC pattern (matches next-themes, Tailwind, etc.).
 */
const SCRIPT = `
(function () {
  try {
    var raw = localStorage.getItem('dda-tweaks');
    var t = raw ? (JSON.parse(raw).state || {}) : {};
    var params = new URLSearchParams(location.search);
    var urlTheme = params.get('theme');
    var theme = (urlTheme === 'light' || urlTheme === 'dark')
      ? urlTheme
      : (t.theme === 'light' ? 'light' : 'dark');
    var accentMap = { violet: 285, blue: 235, emerald: 158, rose: 22 };
    var densityMap = { compact: 0.85, regular: 1, comfy: 1.16 };
    var hue = accentMap[t.accent] != null ? accentMap[t.accent] : 285;
    var d = densityMap[t.density] != null ? densityMap[t.density] : 1;
    var font = t.font || 'Plus Jakarta Sans';
    var r = document.documentElement;
    r.setAttribute('data-theme', theme);
    r.style.setProperty('--accent-h', hue);
    r.style.setProperty('--density', d);
    r.style.setProperty('--font-ui', "'" + font + "', system-ui, sans-serif");
  } catch (e) {}
})();
`;

export function ThemeScript() {
  return <script id="dda-theme" dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
