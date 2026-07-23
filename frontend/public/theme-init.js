// Pre-hydration theme initializer. Loaded synchronously from <head> so the
// document paints with the user's saved accent/density/font/theme instead of
// flashing the default and repainting after hydration (FOUC prevention).
//
// Served from /public so <script src="/theme-init.js"> is a same-origin
// resource React hoists as-is. Keeps the runtime behavior of an inline script
// but sidesteps React 19's "Encountered a script tag while rendering React
// component" dev warning that fires on ANY <script> element rendered from a
// component's JSX (regardless of whether it's a direct <head> child or
// wrapped) — that warning is what pushed this out of TSX and into a real
// static asset.
(function () {
  try {
    var raw = localStorage.getItem("dda-tweaks");
    var t = raw ? JSON.parse(raw).state || {} : {};
    var params = new URLSearchParams(location.search);
    var urlTheme = params.get("theme");
    var theme =
      urlTheme === "light" || urlTheme === "dark"
        ? urlTheme
        : t.theme === "light"
          ? "light"
          : "dark";
    var accentMap = { violet: 285, blue: 235, emerald: 158, rose: 22 };
    var densityMap = { compact: 0.85, regular: 1, comfy: 1.16 };
    var hue = accentMap[t.accent] != null ? accentMap[t.accent] : 285;
    var d = densityMap[t.density] != null ? densityMap[t.density] : 1;
    var font = t.font || "Plus Jakarta Sans";
    var r = document.documentElement;
    r.setAttribute("data-theme", theme);
    r.style.setProperty("--accent-h", hue);
    r.style.setProperty("--density", d);
    r.style.setProperty("--font-ui", "'" + font + "', system-ui, sans-serif");
  } catch (e) {}
})();
