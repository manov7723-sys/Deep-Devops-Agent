#!/usr/bin/env node
/**
 * DeepAgent — runnable single-file SPA clone.
 *
 *   node wireframe/index.js   →   writes wireframe/index.html
 *   open wireframe/index.html →   real interactive app in the browser
 *                                 (no server, no npm install, no DB)
 *
 * How it works:
 *   • index.js (this file) is a tiny build script — reads the app's real
 *     styles + the client bundle from client.mjs and inlines everything
 *     into a single self-contained index.html.
 *   • The generated index.html loads Preact + htm from esm.sh (CDN) and
 *     runs the full app UI in the browser. Sidebar, topbar, hash routing,
 *     dropdowns, tab switching, chat composer, theme toggle — all work.
 *     All data is in-memory mocks.
 *
 * Why two files (index.js + client.mjs) instead of one:
 *   The client bundle uses ~200 template-literal `${...}` interpolations
 *   for its own JSX. Keeping it as a separate .mjs file avoids escape hell
 *   in the Node build script and lets your editor lint/format it as real JS.
 *   The build output (index.html) is still one portable file.
 *
 * When the app's design changes: rerun this script — CSS is re-read from
 * ../frontend/src/styles so the wireframe stays in lockstep.
 */
const fs = require("node:fs");
const path = require("node:path");

const stylesRoot = path.join(__dirname, "..", "frontend", "src", "styles");
const tokensCss = fs.readFileSync(path.join(stylesRoot, "tokens.css"), "utf8");
const primitivesCss = fs.readFileSync(path.join(stylesRoot, "primitives.css"), "utf8");
const clientJs = fs.readFileSync(path.join(__dirname, "client.mjs"), "utf8");

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DeepAgent — UI (single-file SPA)</title>
  <style>
${tokensCss}
${primitivesCss}

/* Shell composition — matches src/components/shell/AppShell.tsx */
.dda-shell { display: flex; height: 100vh; overflow: hidden; }
.dda-page-wrap { max-width: 1180px !important; margin: 0 auto; padding: 24px clamp(16px, 3vw, 32px) 64px !important; }
h1 { font-size: 22px !important; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); }
@media (max-width: 900px) {
  .dda-shell { flex-direction: column; }
  .dda-sidebar { width: 100% !important; height: auto; }
}
#root { height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
${clientJs}
  </script>
</body>
</html>
`;

const outPath = path.join(__dirname, "index.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(`Wireframe written: ${outPath}`);
console.log(`Open in browser:   file://${outPath}`);
console.log(`Output size:       ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
console.log(`Runtime deps:      preact@10 + htm@3 from esm.sh (loaded once, cached)`);
