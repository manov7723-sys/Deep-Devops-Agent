#!/usr/bin/env node
/**
 * DeepAgent UI wireframe generator — high-fidelity single file.
 *
 * Run:  node wireframe/index.js   →   writes wireframe/index.html
 * Open: wireframe/index.html in a browser (works over file://).
 *
 * Uses the app's REAL CSS (tokens.css + primitives.css copied inline at
 * build time) and the REAL primitive class names (.card, .card-h, .chip,
 * .btn.primary, .dda-sidebar, .dda-topbar, .dda-page-wrap, .badge.ok, etc.)
 * so every screen looks like the live app instead of a placeholder mockup.
 *
 * When the app's CSS changes, rerun this script — the wireframe stays in
 * lockstep because it reads the source files at build time.
 */
const fs = require("node:fs");
const path = require("node:path");

// ── Read the app's real design tokens + primitives ─────────────────────
const stylesRoot = path.join(__dirname, "..", "frontend", "src", "styles");
const tokensCss = fs.readFileSync(path.join(stylesRoot, "tokens.css"), "utf8");
const primitivesCss = fs.readFileSync(path.join(stylesRoot, "primitives.css"), "utf8");

// ── Tiny HTML helpers ───────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cx = (...classes) => classes.filter(Boolean).join(" ");

// ── Building blocks using REAL app class names ─────────────────────────
// These mirror src/components/ui/* so structure matches the real components.
const card = (opts, ...body) => {
  const { title, sub, actions, pad = true, maxWidth } = opts;
  const style = maxWidth ? ` style="max-width:${maxWidth}px;width:100%;"` : "";
  const header = title
    ? `<div class="card-h"><div class="col" style="gap:2px;"><span class="card-title">${title}</span>${sub ? `<span class="faint" style="font-size:12px;">${sub}</span>` : ""}</div>${actions ? `<div class="row gap-2" style="margin-left:auto;">${actions}</div>` : ""}</div>`
    : "";
  const bodyEl = `<div class="${pad ? "card-pad" : ""}">${body.flat(Infinity).filter(Boolean).join("")}</div>`;
  return `<section class="card"${style}>${header}${bodyEl}</section>`;
};

const row = (opts, ...children) => {
  const { gap = 2, wrap, between, center } = opts;
  return `<div class="row ${wrap ? "wrap " : ""}${between ? "between " : ""}${center ? "center " : ""}gap-${gap}">${children.flat(Infinity).filter(Boolean).join("")}</div>`;
};
const col = (opts, ...children) => {
  const { gap = 3, w } = opts;
  const style = w ? ` style="max-width:${w}px;width:100%;"` : "";
  return `<div class="col gap-${gap}"${style}>${children.flat(Infinity).filter(Boolean).join("")}</div>`;
};

const btn = (text, opts = {}) => {
  const { variant = "outline", size, icon } = opts;
  const cls = cx("btn", variant, size);
  return `<button class="${cls}">${icon ? `<span aria-hidden>${icon}</span>` : ""}${text ?? ""}</button>`;
};
const chip = (text, opts = {}) => {
  const { active, icon } = opts;
  return `<span class="chip ${active ? "active" : ""}">${icon ? `<span>${icon}</span>` : ""}${text}</span>`;
};
const badge = (text, tone) => `<span class="badge ${tone ?? ""}">${tone === "ok" || tone === "danger" || tone === "warn" || tone === "info" ? `<span class="dot" aria-hidden></span>` : ""}${text}</span>`;
const dot = (tone = "ok") => `<span class="dot" style="background:var(--${tone});"></span>`;

const input = (opts = {}) => `<input class="input" type="text" placeholder="${esc(opts.placeholder ?? "")}" value="${esc(opts.value ?? "")}" ${opts.readonly ? "readonly" : ""}>`;
const select = (opts = {}) => `<div class="select" style="cursor:default;">${esc(opts.value ?? "Choose…")} <span class="faint" style="margin-left:auto;">▾</span></div>`;
const field = (label, control, hint) => `
  <label class="col gap-1">
    <span class="field-label">${label}</span>
    ${control}
    ${hint ? `<span class="faint" style="font-size:11.5px;margin-top:4px;">${hint}</span>` : ""}
  </label>`;

const stat = (label, value, sub, icon) => `
  <div class="card card-pad" style="min-width:0;">
    <div class="row between" style="align-items:flex-start;">
      <div class="col gap-1" style="min-width:0;">
        <span class="faint" style="font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">${label}</span>
        <span style="font-size:22px;font-weight:800;letter-spacing:-.02em;">${value}</span>
        ${sub ? `<span class="muted" style="font-size:12px;">${sub}</span>` : ""}
      </div>
      ${icon ? `<span style="width:36px;height:36px;border-radius:9px;background:var(--surface-3);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:16px;">${icon}</span>` : ""}
    </div>
  </div>`;

const tileGrid = (opts, ...children) => {
  const { minTile = 280, maxTile = 420, gap = 14 } = opts;
  const template = maxTile === "1fr" ? `repeat(auto-fill, minmax(${minTile}px, 1fr))` : `repeat(auto-fill, minmax(${minTile}px, ${maxTile}px))`;
  const justify = maxTile === "1fr" ? "stretch" : "start";
  return `<div style="display:grid;grid-template-columns:${template};justify-content:${justify};gap:${gap}px;">${children.flat(Infinity).filter(Boolean).join("")}</div>`;
};

const table = (headers, rows) => `
  <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr>${headers.map((h) => `<th style="text-align:left;padding:12px 14px;border-bottom:1px solid var(--border-soft);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);font-weight:700;">${h}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:12px 14px;border-bottom:1px solid var(--border-soft);">${c ?? ""}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  </div>`;

const list = (items) => `<ul style="list-style:none;padding:0;margin:0;">${items.map((i) => `<li style="padding:10px 0;border-bottom:1px solid var(--border-soft);font-size:13px;">${i}</li>`).join("")}</ul>`;
const empty = (icon, title, description) => `
  <div class="card-pad col gap-3 center" style="text-align:center;padding:48px 20px;">
    <span style="width:44px;height:44px;border-radius:12px;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--text-muted);">${icon}</span>
    <div style="font-weight:700;font-size:14px;">${title}</div>
    <div class="muted" style="font-size:13px;max-width:340px;">${description}</div>
  </div>`;

const pageHead = (opts) => {
  const { title, sub, actions } = opts;
  return `
    <div class="col gap-4" style="margin-bottom:4px;">
      <div class="row between gap-3 wrap" style="align-items:flex-start;">
        <div class="col" style="gap:4px;min-width:0;max-width:720px;">
          <h1 style="font-size:22px;letter-spacing:-.02em;">${title}</h1>
          ${sub ? `<p class="muted" style="font-size:13.5px;line-height:1.5;">${sub}</p>` : ""}
        </div>
        ${actions ? `<div class="row gap-2 wrap">${actions}</div>` : ""}
      </div>
    </div>`;
};

// ── Screens (22) — realistic content using the app's real classes ──────
const screens = [
  // ── Overview ────────────────────────────────────────────────────────
  {
    id: "dashboard",
    group: "Overview",
    icon: "▤",
    label: "Dashboard",
    render: () => `
      ${pageHead({
        title: "agent",
        sub: "Production deployment target for the DeepAgent DevOps platform.",
        actions: [btn("Open chat", { variant: "primary", icon: "◈" }), btn("Deploy", { variant: "outline" })].join(""),
      })}
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:14px;">
        ${stat("Environments", "3", "alpha · beta · release", "◨")}
        ${stat("Repositories", "5", "connected", "◱")}
        ${stat("Monthly cost", "$1,412", "▲ 6.4%", "$")}
        ${stat("Health", "OK", "all clusters ready", "✓")}
      </div>
      <div class="row gap-4 wrap" style="align-items:flex-start;">
        <div style="flex:1;min-width:420px;">
          ${card({ title: "Recent activity", sub: "Latest 20 events across the project", actions: btn("View all") },
            list([
              `${badge("succeeded", "ok")} kubernetes.deployment.applied · <span class="mono muted">release</span> · <span class="faint">2m ago</span>`,
              `${badge("info", "info")} chat.message_posted · <span class="muted">thread “gke dev cluster”</span> · <span class="faint">8m ago</span>`,
              `${badge("running", "info")} terraform.run_started · <span class="mono muted">gke-dev-apply</span> · <span class="faint">14m ago</span>`,
              `${badge("ok", "ok")} cloud_provider.credentials_set · <span class="muted">azure</span> · <span class="faint">26m ago</span>`,
              `${badge("ok", "ok")} eks.terraform_generated · <span class="mono muted">alpha/dev</span> · <span class="faint">41m ago</span>`,
            ]))}
        </div>
        <div style="width:340px;flex:none;">
          ${card({ title: "Attention", sub: "Things that block deploys" },
            list([
              `${badge("high", "danger")} 1 open alert · <span class="mono">mem-usage</span> on release`,
              `${badge("pending", "info")} 2 approvals waiting`,
              `${badge("warn", "warn")} State backend not set on <span class="mono">alpha</span> env`,
            ]))}
        </div>
      </div>
      ${card({ title: "Spend trend", sub: "30-day rolling · $1,412 MTD" },
        `<div style="height:180px;background:linear-gradient(90deg, var(--surface-2) 0%, var(--surface-3) 100%);border-radius:8px;display:flex;align-items:flex-end;padding:14px;gap:6px;">
          ${Array.from({ length: 30 }, (_, i) => `<div style="flex:1;background:var(--accent);opacity:${0.4 + (i / 30) * 0.6};border-radius:2px 2px 0 0;height:${20 + Math.sin(i * 0.4) * 40 + i * 2}%;"></div>`).join("")}
        </div>`)}`,
  },
  {
    id: "chat",
    group: "Overview",
    icon: "◈",
    label: "Chat",
    render: () => `
      <div class="dda-chat-shell" style="height:calc(100vh - 100px);display:grid;grid-template-columns:1fr 280px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
        <div class="col" style="min-width:0;min-height:0;">
          <header style="padding:14px 20px;border-bottom:1px solid var(--border-soft);display:flex;justify-content:space-between;align-items:center;">
            <div class="row gap-3" style="align-items:center;">
              <span style="width:36px;height:36px;border-radius:9px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;">◐</span>
              <div class="col" style="line-height:1.3;">
                <span class="row gap-2" style="font-weight:700;font-size:14px;">Deep Agent ${dot("ok")}</span>
                <span class="faint" style="font-size:11.5px;">Claude Sonnet 4.5 · sees all repos &amp; cloud state</span>
              </div>
            </div>
            <div class="row gap-2">${badge("agent", "accent")}${btn("Clear", { variant: "outline", size: "sm", icon: "🗑" })}${btn("", { variant: "outline", size: "icon", icon: "▶" })}</div>
          </header>
          <div style="flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px;">
            <div class="row gap-3" style="align-items:flex-start;">
              <span style="width:32px;height:32px;border-radius:9px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none;">◐</span>
              <div style="background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px;padding:12px 15px;max-width:640px;font-size:14px;line-height:1.6;">Provisioning GKE in <b>us-central1</b>. What size?</div>
            </div>
            <div class="row gap-3" style="justify-content:flex-end;align-items:flex-start;">
              <div style="background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:12px;padding:12px 15px;max-width:640px;font-size:14px;line-height:1.6;">n2-standard-4, 3 nodes, us-central1</div>
              <span style="width:32px;height:32px;border-radius:9px;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;flex:none;">MV</span>
            </div>
            <div class="row gap-3" style="align-items:flex-start;">
              <span style="width:32px;height:32px;border-radius:9px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none;">◐</span>
              <div style="background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px;padding:12px 15px;max-width:640px;font-size:14px;line-height:1.6;">Generated 3 Terraform files (main.tf, outputs.tf, versions.tf) with <span class="mono">google_project_service</span> preconditions, 45m resource timeouts, and GCS backend from env. Ready to apply?
                <div class="row gap-2" style="margin-top:10px;">${badge("plan · 3 to add", "info")}${badge("cost · $60/mo", "ok")}</div></div>
            </div>
            <div class="row gap-3" style="justify-content:flex-end;">
              <div style="background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:12px;padding:12px 15px;font-size:14px;">Apply.</div>
              <span style="width:32px;height:32px;border-radius:9px;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;flex:none;">MV</span>
            </div>
            <div style="padding:10px 14px;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:8px;font-size:12.5px;color:var(--text-muted);width:fit-content;margin-left:44px;">${dot("info")} Provisioning GKE cluster… <span class="faint mono">provision_gke</span></div>
          </div>
          <div style="padding:16px 24px 20px;border-top:1px solid var(--border-soft);flex:none;">
            <div style="max-width:820px;margin:0 auto;">
              <div style="padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow-sm);">
                <div style="min-height:26px;font-size:15px;color:var(--text-faint);padding:0 6px;">Describe what you want to build or change…</div>
                <div class="row between" style="align-items:center;margin-top:8px;">
                  <div class="row gap-2">${btn("", { variant: "ghost", size: "icon", icon: "+" })}${btn("infra", { variant: "ghost", size: "sm", icon: "▤" })}</div>
                  ${btn("", { variant: "primary", size: "icon", icon: "▸" })}
                </div>
              </div>
              <p class="faint" style="font-size:11px;text-align:center;margin-top:8px;">Deep Agent can read and write to your repos. Changes require approval before they touch release.</p>
            </div>
          </div>
        </div>
        <aside style="background:var(--surface-2);border-left:1px solid var(--border-soft);display:flex;flex-direction:column;min-height:0;overflow:hidden;">
          <div class="row between" style="padding:12px;align-items:center;">
            <span style="font-weight:700;font-size:13px;">Recent chats</span>
            ${btn("New", { variant: "primary", size: "sm", icon: "+" })}
          </div>
          <div style="flex:1;overflow-y:auto;padding:0 8px 12px;">
            <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:10px 8px 4px;">Today</div>
            <button style="display:flex;flex-direction:column;gap:3px;padding:8px 10px;margin:2px 0;border-radius:8px;border:1px solid transparent;background:color-mix(in srgb, var(--accent) 12%, transparent);width:100%;text-align:left;color:var(--text);font-family:inherit;">
              <span style="font-size:13px;font-weight:600;">GKE dev cluster</span><span style="font-size:11px;color:var(--text-faint);">2:41 PM · 14 msgs</span>
            </button>
            <button style="display:flex;flex-direction:column;gap:3px;padding:8px 10px;margin:2px 0;border-radius:8px;border:1px solid transparent;background:transparent;width:100%;text-align:left;color:var(--text);font-family:inherit;">
              <span style="font-size:13px;font-weight:600;">Deploy app to VM</span><span style="font-size:11px;color:var(--text-faint);">1:22 PM · 6 msgs</span>
            </button>
            <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:10px 8px 4px;">Yesterday</div>
            <button style="display:flex;flex-direction:column;gap:3px;padding:8px 10px;margin:2px 0;border-radius:8px;border:1px solid transparent;background:transparent;width:100%;text-align:left;color:var(--text);font-family:inherit;">
              <span style="font-size:13px;font-weight:600;">EKS access entries</span><span style="font-size:11px;color:var(--text-faint);">Jul 13 · 22 msgs</span>
            </button>
            <button style="display:flex;flex-direction:column;gap:3px;padding:8px 10px;margin:2px 0;border-radius:8px;border:1px solid transparent;background:transparent;width:100%;text-align:left;color:var(--text);font-family:inherit;">
              <span style="font-size:13px;font-weight:600;">Azure OAuth reconnect</span><span style="font-size:11px;color:var(--text-faint);">Jul 13 · 9 msgs</span>
            </button>
            <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:10px 8px 4px;">Previous 7 days</div>
            <button style="display:flex;flex-direction:column;gap:3px;padding:8px 10px;margin:2px 0;border-radius:8px;border:1px solid transparent;background:transparent;width:100%;text-align:left;color:var(--text);font-family:inherit;">
              <span style="font-size:13px;font-weight:600;">Cost tag audit</span><span style="font-size:11px;color:var(--text-faint);">Jul 10 · 4 msgs</span>
            </button>
          </div>
        </aside>
      </div>`,
  },
  // ── Deliver ────────────────────────────────────────────────────────
  {
    id: "cicd",
    group: "Deliver",
    icon: "◱",
    label: "CI/CD & Repos",
    render: () => `
      ${pageHead({ title: "CI/CD & Repos", sub: "Pipeline runs, workflow generators, and connected repositories.", actions: btn("Attach repo", { variant: "primary", icon: "+" }) })}
      <div class="row gap-2 wrap">${chip("Pipelines", { active: true })}${chip("Repositories")}${chip("Workflow templates")}</div>
      ${card({ title: "Recent pipeline runs", sub: "Latest 20 across all repos", actions: btn("View all") },
        table(["Repo", "Workflow", "Branch", "Status", "Duration", "Actor"], [
          [`<span class="mono">manov7723-sys/deepagent</span>`, "build-and-push", `<span class="mono">dev</span>`, badge("succeeded", "ok"), `<span class="tnum">3m 04s</span>`, "manov"],
          [`<span class="mono">manov7723-sys/deepagent</span>`, "deploy-aks", `<span class="mono">release</span>`, badge("running", "info"), `<span class="tnum">12m 04s</span>`, "manov"],
          [`<span class="mono">acme/app</span>`, "trivy-scan", `<span class="mono">main</span>`, badge("failed", "danger"), `<span class="tnum">42s</span>`, "sriram"],
          [`<span class="mono">acme/app</span>`, "build-and-push", `<span class="mono">feature/oauth</span>`, badge("queued", "warn"), `<span class="tnum">—</span>`, "sriram"],
        ]))}
      ${card({ title: "Attached repositories", sub: "Repos this project can push to", actions: btn("+ Attach repo") },
        tileGrid({ minTile: 300, maxTile: 480 },
          card({ pad: true },
            row({ gap: 2, between: true }, `<div><b class="mono">manov7723-sys/deepagent</b><div class="muted" style="font-size:12px;">default: dev · 3 workflows</div></div>`, badge("attached", "ok"))),
          card({ pad: true },
            row({ gap: 2, between: true }, `<div><b class="mono">acme/app</b><div class="muted" style="font-size:12px;">default: main · 2 workflows</div></div>`, badge("attached", "ok")))))}`,
  },
  {
    id: "environments",
    group: "Deliver",
    icon: "◨",
    label: "Environments",
    render: () => `
      ${pageHead({ title: "Environments", sub: "Deploy targets with per-env cloud, cluster, and remote-state configuration.", actions: btn("+ New environment", { variant: "primary" }) })}
      ${card({ title: "Active environment", sub: "The env used by env-scoped pages by default." },
        row({ gap: 2, wrap: true },
          `<button class="dda-env-tile" data-active="true"><div style="font-weight:700;">release</div><div class="muted" style="font-size:11px;">production</div></button>`,
          `<button class="dda-env-tile"><div style="font-weight:700;">beta</div><div class="muted" style="font-size:11px;">staging</div></button>`,
          `<button class="dda-env-tile"><div style="font-weight:700;">alpha</div><div class="muted" style="font-size:11px;">dev</div></button>`))}
      ${card({ title: "All environments", sub: "3 environments · 2 with cluster attached" },
        table(["Env", "Cloud", "Cluster", "Repos", "State backend", "Members"], [
          [`<b>release</b>`, badge("azure", "info"), `<span class="mono">aks-prod</span>`, "2", `<span class="mono faint">azurerm · rg-devops</span>`, "5"],
          [`<b>beta</b>`, badge("gcp", "info"), `<span class="mono">gke-beta</span>`, "1", `<span class="mono faint">gcs · tfstate-agent</span>`, "3"],
          [`<b>alpha</b>`, badge("aws", "info"), `<span class="muted">—</span>`, "1", `<span class="mono faint">s3 · agent-tfstate</span>`, "3"],
        ]))}`,
  },
  {
    id: "cloud",
    group: "Deliver",
    icon: "☁",
    label: "Cloud providers",
    render: () => `
      ${pageHead({ title: "Cloud providers", sub: "Connected accounts Deep Agent deploys to, per environment.", actions: btn("+ Connect provider", { variant: "primary" }) })}
      <div class="row gap-2 wrap">${chip("all", { active: true })}${chip("release")}${chip("beta")}${chip("alpha")}</div>
      ${tileGrid({ minTile: 320, maxTile: "1fr" },
        card({},
          row({ gap: 3, between: true },
            row({ gap: 3 }, `<span style="width:44px;height:44px;border-radius:11px;background:oklch(0.72 0.19 45 / 0.15);color:oklch(0.72 0.19 45);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;">AWS</span>`,
              `<div class="col" style="gap:2px;"><div style="font-weight:700;font-size:14px;">AWS (us-east-1)</div><div class="muted" style="font-size:12px;">alpha · AWS</div></div>`),
            dot("ok")),
          `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:14px;">
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Region</div><div class="mono" style="font-size:13px;margin-top:2px;">us-east-1</div></div>
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Services</div><div style="font-size:15px;font-weight:700;margin-top:2px;">0</div></div>
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Monthly</div><div style="font-size:15px;font-weight:700;margin-top:2px;">$0</div></div>
          </div>`,
          row({ gap: 2 }, btn("View stats", { icon: "▤" }), btn("", { variant: "ghost", size: "icon", icon: "⚙" }), btn("", { variant: "ghost", size: "icon", icon: "🗑" }))),
        card({},
          row({ gap: 3, between: true },
            row({ gap: 3 }, `<span style="width:44px;height:44px;border-radius:11px;background:oklch(0.7 0.17 235 / 0.18);color:oklch(0.7 0.17 235);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px;">Azure</span>`,
              `<div class="col" style="gap:2px;"><div style="font-weight:700;font-size:14px;">Azure (eastus)</div><div class="muted" style="font-size:12px;">release · Azure</div></div>`),
            dot("ok")),
          `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:14px;">
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Region</div><div class="mono" style="font-size:13px;margin-top:2px;">eastus</div></div>
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Services</div><div style="font-size:15px;font-weight:700;margin-top:2px;">3</div></div>
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Monthly</div><div style="font-size:15px;font-weight:700;margin-top:2px;">$482</div></div>
          </div>`,
          row({ gap: 2 }, btn("View stats", { icon: "▤" }), btn("", { variant: "ghost", size: "icon", icon: "⚙" }), btn("", { variant: "ghost", size: "icon", icon: "🗑" }))),
        card({},
          row({ gap: 3, between: true },
            row({ gap: 3 }, `<span style="width:44px;height:44px;border-radius:11px;background:oklch(0.74 0.17 158 / 0.18);color:oklch(0.74 0.17 158);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;">GCP</span>`,
              `<div class="col" style="gap:2px;"><div style="font-weight:700;font-size:14px;">GCP (us-central1)</div><div class="muted" style="font-size:12px;">beta · GCP</div></div>`),
            dot("ok")),
          `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:14px;">
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Project</div><div class="mono" style="font-size:12px;margin-top:2px;">new-project-495604</div></div>
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Services</div><div style="font-size:15px;font-weight:700;margin-top:2px;">2</div></div>
            <div><div class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">Monthly</div><div style="font-size:15px;font-weight:700;margin-top:2px;">$267</div></div>
          </div>`,
          row({ gap: 2 }, btn("View stats", { icon: "▤" }), btn("", { variant: "ghost", size: "icon", icon: "⚙" }), btn("", { variant: "ghost", size: "icon", icon: "🗑" }))))}
      ${card({ title: "Vault configuration", sub: "Step 1 · connect Vault. Step 2 · store AWS keys in it. Keys never touch the DB." },
        `<div style="max-width:520px;">
          <div class="row between" style="margin-bottom:14px;"><span style="font-weight:600;font-size:13px;">Connection</span>${badge("not connected", "warn")}</div>
          ${col({ gap: 3 },
            field("Vault URL *", input({ placeholder: "https://127.0.0.1:8200" })),
            field("Vault token *", input({ placeholder: "hvs.•••••••••••" }), "A token with read/write on the KV mount (hvs.…). Stored encrypted; never shown again."),
            row({ gap: 2 }, btn("Save & test connection", { variant: "primary", icon: "🔗" })))}
        </div>`)}`,
  },
  {
    id: "infra",
    group: "Deliver",
    icon: "▤",
    label: "Infrastructure",
    render: () => `
      ${pageHead({ title: "Infrastructure", sub: "Cloud credentials (Vault), Terraform state, and managed-Kubernetes cluster provisioning (EKS · GKE · AKS)." })}
      ${card({ title: "Cloud credentials", sub: "Provider you use to authenticate Terraform runs" },
        row({ gap: 2, wrap: true }, badge("Azure · release", "ok"), btn("+ Add credentials")))}
      ${card({ title: "Terraform state backend", sub: "Cloud-aware: S3 / GCS / azurerm chosen from project cloud. Set once per env.", maxWidth: 520 },
        col({ gap: 3 },
          field("Environment", select({ value: "release" })),
          field("Resource group", input({ value: "rg-devops" }), "The resource group that owns the storage account."),
          field("Storage account", input({ value: "devclusteraccount" }), "Globally unique, 3-24 lowercase letters/digits."),
          field("Blob container", input({ value: "tfstate" }), "Container inside the storage account. Required."),
          row({ gap: 2 }, btn("Save", { variant: "primary", icon: "✓" }), btn("Provision in Azure", { variant: "outline", icon: "☁" }))))}
      ${card({ title: "Create AKS cluster", sub: "Interactive wizard (auto-picks EKS/GKE/AKS from project cloud)" },
        `<div style="height:280px;background:var(--surface-2);border:1px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">AKS wizard — 5 pages: cluster basics → security → node pools → add-ons → networking + repo</div>`)}
      ${card({ title: "Delete orphaned GKE cluster", sub: "Uses stored env creds; no gcloud needed. Typical delete 3-6 min.", maxWidth: 520 },
        col({ gap: 3 },
          field("Environment", select({ value: "release" })),
          field("GCP project id", input({ value: "new-project-495604" })),
          field("Location", input({ value: "us-central1" })),
          field("Cluster name", input({ value: "dev" })),
          row({ gap: 2 }, btn("🗑 Delete cluster", { variant: "primary" }))))}
      ${card({ title: "Terraform pipeline", sub: "init → plan → apply against the env's cloud creds + state backend." },
        col({ gap: 3 },
          row({ gap: 2, wrap: true }, `<span class="field-label" style="margin:0;padding:0;">Environment</span>`, `<div style="max-width:220px;">${select({ value: "release" })}</div>`),
          card({ pad: true },
            row({ gap: 2, between: true },
              `<div class="col"><div class="row gap-2" style="align-items:center;"><b>aks-dev-apply</b>${badge("running", "info")}<span class="muted" style="font-size:12.5px;">apply · release</span><span style="font-size:12px;color:var(--text-muted);">${dot("info")} <span class="tnum">12m 04s elapsed</span></span></div><div class="faint" style="font-size:12px;margin-top:2px;">stack: aks-dev</div></div>`,
              row({ gap: 2 }, btn("↻ Rerun (apply)", { variant: "outline", size: "sm" }), btn("🗑 Delete existing cluster", { variant: "outline", size: "sm" }))),
            `<div style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">
              <div class="row gap-2" style="align-items:center;"><span class="badge ok">${dot("ok")}init</span><span class="muted" style="font-size:12px;">succeeded · exit 0 · <span class="tnum">42s</span></span></div>
              <div class="row gap-2" style="align-items:center;"><span class="badge ok">${dot("ok")}plan</span><span class="muted" style="font-size:12px;">succeeded · exit 0 · <span class="tnum">2m 18s</span></span></div>
              <div class="row gap-2" style="align-items:center;"><span class="badge info">${dot("info")}apply</span><span class="muted" style="font-size:12px;">running · <span class="tnum">9m 04s</span></span></div>
              <pre style="font-size:11.5px;overflow-x:auto;white-space:pre-wrap;margin:0;max-height:180px;background:var(--surface-2);padding:10px 12px;border-radius:6px;border:1px solid var(--border-soft);color:var(--text-muted);">google_container_cluster.primary: Creating... [9m00s elapsed]
google_container_cluster.primary: Still creating... [9m10s elapsed]
google_container_cluster.primary: Still creating... [9m20s elapsed]</pre>`)))}`,
  },
  {
    id: "topology",
    group: "Deliver",
    icon: "⟿",
    label: "Topology",
    render: () => `
      ${pageHead({ title: "Topology", sub: "Live graph of clusters, workloads, and their traffic edges across envs." })}
      <div class="row gap-3 wrap" style="align-items:center;">
        <div style="min-width:220px;">${field("Env", select({ value: "release" }))}</div>
        <div style="min-width:220px;">${field("Namespace", select({ value: "default" }))}</div>
        <div class="row gap-2 wrap" style="margin-left:auto;">${badge("service", "info")}${badge("deployment", "ok")}${badge("pod", "accent")}</div>
      </div>
      ${card({},
        `<div style="height:620px;background:radial-gradient(circle at 30% 40%, oklch(0.62 0.17 285 / 0.08), transparent 50%),radial-gradient(circle at 70% 60%, oklch(0.74 0.15 158 / 0.06), transparent 50%),var(--surface-2);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">
          <div style="text-align:center;">
            <div style="font-size:24px;margin-bottom:8px;">⟿</div>
            React Flow graph — aks-prod → default namespace → 3 deployments (app-frontend, worker, api) → 7 pods
          </div>
        </div>`)}`,
  },
  // ── Deploy ─────────────────────────────────────────────────────────
  {
    id: "promotions",
    group: "Deploy",
    icon: "▲",
    label: "Promotions",
    render: () => `
      ${pageHead({ title: "Promotions", sub: "Promote a deployed image between environments (alpha → beta → release).", actions: btn("+ New promotion", { variant: "primary" }) })}
      <div class="row gap-3 wrap"><div style="min-width:220px;">${field("Namespace", select({ value: "default" }))}</div></div>
      ${card({ title: "app-frontend", sub: `<span class="mono">manov7723-sys/deepagent/app-frontend</span>` },
        table(["Env", "Image", "Rolled out", "Health", "Actions"], [
          [`<b>alpha</b>${badge("dev", "info")}`, `<span class="mono">ghcr.io/…/app-frontend:sha-a1b2</span>`, `<span class="faint">2m ago</span>`, badge("healthy", "ok"), row({ gap: 1 }, btn("→ beta", { size: "sm" }), btn("→ release", { size: "sm" }))],
          [`<b>beta</b>${badge("staging", "warn")}`, `<span class="mono">ghcr.io/…/app-frontend:sha-a1b2</span>`, `<span class="faint">12m ago</span>`, badge("healthy", "ok"), row({ gap: 1 }, btn("→ release", { size: "sm" }))],
          [`<b>release</b>${badge("prod", "danger")}`, `<span class="mono">ghcr.io/…/app-frontend:sha-7e2f</span>`, `<span class="faint">3d ago</span>`, badge("current", "ok"), `<span class="faint">—</span>`],
        ]))}`,
  },
  {
    id: "scheduler",
    group: "Deploy",
    icon: "⏰",
    label: "Scheduler",
    render: () => `
      ${pageHead({ title: "Scheduler", sub: "Deploy later — schedule an image + env for automatic rollout.", actions: btn("+ Schedule deploy", { variant: "primary" }) })}
      ${card({ title: "New scheduled deploy" },
        row({ gap: 3, wrap: true },
          `<div style="min-width:260px;">${field("Repo", select({ value: "manov7723-sys/deepagent" }))}</div>`,
          `<div style="min-width:200px;">${field("Image tag", input({ value: "sha-a1b2" }))}</div>`,
          `<div style="min-width:180px;">${field("Target env", select({ value: "release" }))}</div>`,
          `<div style="min-width:240px;">${field("When", input({ value: "2026-07-14 22:00" }))}</div>`))}
      ${card({ title: "Upcoming", sub: "Next 30 days · 3 scheduled" },
        table(["App", "Image", "Env", "When", "Status", ""], [
          ["app-frontend", `<span class="mono">sha-a1b2</span>`, `<b>release</b>`, "Today · 10:00 PM", badge("queued", "info"), btn("Cancel", { size: "sm", variant: "ghost" })],
          ["worker", `<span class="mono">sha-c3d4</span>`, `<b>beta</b>`, "Tomorrow · 08:00 AM", badge("queued", "info"), btn("Cancel", { size: "sm", variant: "ghost" })],
          ["docs", `<span class="mono">sha-e5f6</span>`, `<b>release</b>`, "Jul 20 · 09:00 AM", badge("queued", "info"), btn("Cancel", { size: "sm", variant: "ghost" })],
        ]))}`,
  },
  // ── Connection ────────────────────────────────────────────────────
  {
    id: "github",
    group: "Connection",
    icon: "◍",
    label: "Source control",
    render: () => `
      ${pageHead({ title: "Source control", sub: "GitHub App installations and connected repositories.", actions: btn("+ Install app", { variant: "primary" }) })}
      ${card({ title: "Installations", sub: "GitHub orgs the DeepAgent app is installed on" },
        list([`${dot("ok")} <b class="mono">manov7723-sys</b> · 5 repos · installed 2025-11-04`, `${dot("ok")} <b class="mono">sriram-tecnso</b> · 1 repo · installed 2026-07-13`]))}
      ${card({ title: "Repositories", sub: "All repos across your installations" },
        table(["Repo", "Default branch", "Installed", "In project"], [
          [`<span class="mono">manov7723-sys/deepagent</span>`, `<span class="mono">dev</span>`, "2025-11-04", badge("attached", "ok")],
          [`<span class="mono">sriram-tecnso/deepagent</span>`, `<span class="mono">dev</span>`, "2026-07-13", btn("Attach", { size: "sm", variant: "outline" })],
        ]))}`,
  },
  {
    id: "connection",
    group: "Connection",
    icon: "⛁",
    label: "Clusters",
    render: () => `
      ${pageHead({ title: "Connection", sub: "Connect a running Kubernetes cluster (EKS · AKS · GKE). The kubeconfig is stored encrypted on the environment." })}
      <div style="max-width:960px;width:100%;" class="col gap-5">
        ${card({ title: "Connected clusters", sub: "Persist on the environment; the AI chat queries these directly." },
          list([
            `${badge("connected", "ok")} <b class="mono">aks-prod</b> · release · 6 nodes ready`,
            `${badge("connected", "ok")} <b class="mono">gke-beta</b> · beta · 3 nodes ready`,
          ]))}
        ${card({ title: "Terraform state backend", sub: "Cloud-aware: Azure blob container for AKS applies." },
          `<div style="max-width:480px;">${col({ gap: 3 },
            field("Environment", select({ value: "release" })),
            field("Resource group", input({ value: "rg-devops" })),
            field("Storage account", input({ value: "devclusteraccount" })),
            field("Blob container", input({ value: "tfstate" })),
            row({ gap: 2 }, btn("Save", { variant: "primary", icon: "✓" }), btn("Provision in Azure", { icon: "☁" })))}
          </div>`)}
        ${card({ title: "Connect Kubernetes cluster", sub: "Pick a cloud, point at a running cluster, and connect." },
          `<div style="max-width:520px;">${col({ gap: 3 },
            field("Cloud provider", row({ gap: 2, wrap: true }, chip("AWS", { active: true, icon: "☁" }), chip("Azure", { icon: "☁" }), chip("GCP", { icon: "☁" }))),
            field("Environment *", row({ gap: 2 }, `<div style="flex:1;">${select({ value: "release · connected" })}</div>`, badge("connected", "ok")), "Where the kubeconfig (and AWS creds, for EKS) come from / are stored."),
            field("Region *", input({ value: "us-east-1" })),
            field("Cluster name *", input({ value: "aks-prod" })),
            row({ gap: 2 }, btn("Connect", { variant: "primary", icon: "⚡" }), btn("Paste kubeconfig instead", { variant: "ghost" })))}
          </div>`)}
      </div>`,
  },
  {
    id: "stats",
    group: "Connection",
    icon: "◉",
    label: "Cloud stats",
    render: () => `
      ${pageHead({ title: "Cloud stats", sub: "Live cluster + observability KPIs and connected external observability stacks." })}
      <div class="row gap-2 wrap">${chip("release", { active: true })}${chip("beta")}${chip("alpha")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:14px;">
        ${stat("CPU (release)", "62%", "cluster average", "◍")}
        ${stat("Memory (release)", "48%", "cluster average", "▤")}
        ${stat("Pods running", "42", "3 pending", "◆")}
        ${stat("Nodes ready", "6/6", "all zones", "✓")}
      </div>
      ${card({ title: "Cluster monitoring", sub: "In-cluster Prometheus + Grafana scrape targets" },
        list([`${dot("ok")} kube-state-metrics · scraping`, `${dot("ok")} node-exporter · scraping`, `${dot("ok")} app-frontend · scraping`, `${dot("warn")} worker · degraded (last scrape 47s ago)`]))}
      ${card({ title: "Azure Monitor alarms", sub: "Alarms wired to this env's clusters" },
        table(["Alarm", "Metric", "State", "Threshold", "Last change"], [
          [`<span class="mono">aks-prod-cpu-high</span>`, "CPU %", badge("OK", "ok"), "> 85% for 5m", "2h ago"],
          [`<span class="mono">aks-prod-mem-high</span>`, "Memory %", badge("Alarm", "danger"), "> 90% for 3m", "12m ago"],
          [`<span class="mono">aks-prod-pod-restarts</span>`, "Restart count", badge("OK", "ok"), "> 5 in 10m", "1d ago"],
        ]))}
      ${card({ title: "External Prometheus / Grafana", sub: "Optional — connect an existing stack for cross-cluster views" },
        row({ gap: 2, wrap: true }, btn("Connect Prometheus", { icon: "🔗" }), btn("Connect Grafana", { icon: "🔗" })))}`,
  },
  {
    id: "uptime",
    group: "Connection",
    icon: "↺",
    label: "Uptime",
    render: () => `
      ${pageHead({ title: "Uptime", sub: "External HTTP monitors for the project's endpoints.", actions: btn("+ New monitor", { variant: "primary" }) })}
      ${card({ title: "New monitor" },
        row({ gap: 3, wrap: true },
          `<div style="min-width:320px;">${field("URL", input({ placeholder: "https://app.example.com/health" }))}</div>`,
          `<div style="min-width:160px;">${field("Interval", select({ value: "60s" }))}</div>`,
          `<div style="min-width:160px;">${field("Region", select({ value: "us-east-1" }))}</div>`,
          `<div style="min-width:200px;">${field("Notify email", input({ placeholder: "alerts@example.com" }))}</div>`))}
      ${card({ title: "Monitors", sub: "3 active · 30d avg uptime 99.94%" },
        table(["URL", "Status", "Uptime 30d", "Response p50", "Last check"], [
          [`<span class="mono">https://app.example.com/health</span>`, badge("up", "ok"), `<span class="tnum">99.98%</span>`, `<span class="tnum">142ms</span>`, `<span class="faint">12s ago</span>`],
          [`<span class="mono">https://api.example.com/live</span>`, badge("up", "ok"), `<span class="tnum">99.99%</span>`, `<span class="tnum">89ms</span>`, `<span class="faint">10s ago</span>`],
          [`<span class="mono">https://docs.example.com</span>`, badge("degraded", "warn"), `<span class="tnum">99.72%</span>`, `<span class="tnum">812ms</span>`, `<span class="faint">24s ago</span>`],
        ]))}`,
  },
  // ── Ops ──────────────────────────────────────────────────────────
  {
    id: "cost",
    group: "Ops",
    icon: "$",
    label: "Cost",
    render: () => `
      ${pageHead({ title: "Cost", sub: "Multi-cloud spend rollup, budget tracking, and optimization findings.", actions: [btn("Estimate infra"), btn("Optimize", { variant: "primary", icon: "⚡" })].join("") })}
      <div class="row gap-2 wrap">${chip("all", { active: true })}${chip("release")}${chip("beta")}${chip("alpha")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:14px;">
        ${stat("Month to date", "$1,412", "68% of $2,100 budget", "$")}
        ${stat("Forecast", "$2,043", "within budget", "◆")}
        ${stat("Savings found", "$187/mo", "3 recommendations", "▼")}
        ${stat("Untagged spend", "$96", "3 resources need tags", "!")}
      </div>
      <div class="row gap-4 wrap" style="align-items:flex-start;">
        <div style="flex:1;min-width:420px;">
          ${card({ title: "By service", sub: "Top 5 categories this month" },
            `<div style="height:220px;display:flex;align-items:flex-end;gap:10px;padding:14px;background:var(--surface-2);border-radius:8px;">
              <div style="flex:1;background:var(--accent);border-radius:6px 6px 0 0;height:85%;position:relative;"><span style="position:absolute;top:-22px;left:0;right:0;text-align:center;font-size:11px;font-weight:700;">$482 Azure</span></div>
              <div style="flex:1;background:var(--info);border-radius:6px 6px 0 0;height:52%;position:relative;"><span style="position:absolute;top:-22px;left:0;right:0;text-align:center;font-size:11px;font-weight:700;">$267 GCP</span></div>
              <div style="flex:1;background:var(--ok);border-radius:6px 6px 0 0;height:38%;position:relative;"><span style="position:absolute;top:-22px;left:0;right:0;text-align:center;font-size:11px;font-weight:700;">$198 GHCR</span></div>
              <div style="flex:1;background:var(--warn);border-radius:6px 6px 0 0;height:24%;position:relative;"><span style="position:absolute;top:-22px;left:0;right:0;text-align:center;font-size:11px;font-weight:700;">$124 Vault</span></div>
              <div style="flex:1;background:var(--danger);border-radius:6px 6px 0 0;height:14%;position:relative;"><span style="position:absolute;top:-22px;left:0;right:0;text-align:center;font-size:11px;font-weight:700;">$72 Egress</span></div>
            </div>`)}
        </div>
        <div style="width:340px;flex:none;">
          ${card({ title: "Optimization findings", sub: "Suggestions from analyze_cost_optimization" },
            list([
              `<b>Rightsize</b> aks-prod system pool<div class="faint" style="font-size:11.5px;margin-top:2px;">Standard_D8s_v3 → D4s_v3 · <span style="color:var(--ok);font-weight:700;">$84/mo</span></div>`,
              `<b>Delete</b> unused ELB in us-east-1<div class="faint" style="font-size:11.5px;margin-top:2px;">idle 45 days · <span style="color:var(--ok);font-weight:700;">$18/mo</span></div>`,
              `<b>Tier</b> object storage to Infrequent Access<div class="faint" style="font-size:11.5px;margin-top:2px;">7TB in Standard, low access · <span style="color:var(--ok);font-weight:700;">$85/mo</span></div>`,
            ]))}
        </div>
      </div>`,
  },
  {
    id: "approvals",
    group: "Ops",
    icon: "☑",
    label: "Approvals",
    render: () => `
      ${pageHead({ title: "Approvals", sub: "Gated changes waiting on a human — terraform applies, deploys, promotions." })}
      <div style="display:grid;grid-template-columns:380px 1fr;gap:20px;">
        <div class="col gap-3">
          ${card({ title: "Queue", sub: "3 pending" },
            `<div style="display:flex;flex-direction:column;">
              ${["Apply terraform-aks-dev", "Promote app-frontend beta → release", "Deploy worker sha-c3d4"].map((t, i) => `
                <button style="text-align:left;padding:12px 14px;border-bottom:1px solid var(--border-soft);background:${i === 0 ? "var(--surface-2)" : "transparent"};border:none;cursor:pointer;color:var(--text);font-family:inherit;">
                  <div class="row gap-2" style="align-items:center;">${badge("pending", "info")}</div>
                  <div style="font-weight:600;font-size:13px;margin-top:6px;">${t}</div>
                  <div class="faint" style="font-size:11.5px;margin-top:2px;">Requested by manov · 12m ago</div>
                </button>`).join("")}
            </div>`)}
        </div>
        <div class="col gap-3">
          ${card({ title: "Apply terraform-aks-dev", sub: `<span class="mono">manov7723-sys/deepagent/terraform/aks/dev@master</span> · env release` },
            col({ gap: 3 },
              row({ gap: 2, wrap: true }, badge("low risk", "ok"), badge("policy · passed", "ok"), badge("est. $60.74/mo", "info")),
              card({ pad: true },
                `<div class="col gap-1" style="font-size:12.5px;font-family:var(--font-mono);">
                  <div><span style="color:var(--ok);">+</span> resource "azurerm_kubernetes_cluster" "aks"</div>
                  <div><span style="color:var(--ok);">+</span> resource "azurerm_kubernetes_cluster_node_pool" "app"</div>
                  <div><span style="color:var(--ok);">+</span> resource "azurerm_log_analytics_workspace" "law"</div>
                </div>
                <div style="border-top:1px solid var(--border-soft);margin-top:10px;padding-top:10px;font-size:12px;color:var(--text-muted);">3 to add · 0 to change · 0 to destroy</div>`),
              row({ gap: 2 }, btn("Approve & apply", { variant: "primary", icon: "✓" }), btn("Reject", { variant: "outline", icon: "✕" }))))}
        </div>
      </div>`,
  },
  {
    id: "alerts",
    group: "Ops",
    icon: "!",
    label: "Alerts",
    render: () => `
      ${pageHead({ title: "Alerts", sub: "CloudWatch, Azure Monitor, GCP Monitoring, and in-cluster Prometheus.", actions: [btn("Test alert"), btn("Configure", { variant: "primary" })].join("") })}
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:14px;">
        ${stat("Open alerts", "3", "5 total", "!")}
        ${stat("High severity", "1", "needs action now", "⚠")}
        ${stat("Security findings", "0", "by Security Sentinel", "🛡")}
        ${stat("Mean time to ack", "14m", "last 30 days", "◑")}
      </div>
      ${card({ title: "Notification emails", sub: "Extra addresses that receive alerts" },
        row({ gap: 2, wrap: true }, chip("alerts@example.com"), chip("oncall@example.com"), btn("+ Add email", { variant: "ghost", size: "sm" })))}
      ${card({ title: "ChatOps webhook", sub: "Post alerts into Slack / Discord / Teams" },
        col({ gap: 3, w: 480 }, field("Webhook URL", input({ placeholder: "https://hooks.slack.com/services/..." })), field("Channel", input({ value: "#alerts" })), row({ gap: 2 }, btn("Save & test", { variant: "primary" }))))}
      <div class="row gap-2 wrap">${chip("all", { active: true })}${chip("infra")}${chip("app")}${chip("security")}</div>
      ${col({ gap: 2 },
        card({},
          row({ gap: 3, between: true },
            col({ gap: 1 }, `<div class="row gap-2" style="align-items:center;"><b>mem-usage high</b>${badge("high", "danger")}${badge("release", "info")}</div>`, `<span class="muted" style="font-size:12.5px;">aks-prod / default / worker-abc123 · 92% for 12m</span>`),
            row({ gap: 2 }, btn("Investigate", { size: "sm" }), btn("Ack", { size: "sm", variant: "primary" })))),
        card({},
          row({ gap: 3, between: true },
            col({ gap: 1 }, `<div class="row gap-2" style="align-items:center;"><b>p95-latency high</b>${badge("warning", "warn")}${badge("release", "info")}</div>`, `<span class="muted" style="font-size:12.5px;">app.example.com · 1.2s for 5m</span>`),
            row({ gap: 2 }, btn("Investigate", { size: "sm" }), btn("Ack", { size: "sm", variant: "primary" })))))}`,
  },
  {
    id: "activity",
    group: "Ops",
    icon: "≡",
    label: "Activity",
    render: () => `
      ${pageHead({ title: "Activity", sub: "Every audit-worthy action in the project — deploys, secret changes, provider connects, approvals." })}
      <div class="row gap-2 wrap" style="align-items:center;">${chip("all", { active: true })}${chip("deploy")}${chip("infra")}${chip("auth")}${chip("chat")}
        <div style="margin-left:auto;">${input({ placeholder: "search…" })}</div>
      </div>
      ${card({ title: "", sub: "Latest 500 events" },
        table(["When", "Action", "Target", "Actor"], [
          [`<span class="faint">Jul 13 8:42 PM</span>`, `<span class="mono">gke.cluster_deleted</span>`, `<span class="mono muted">dev / us-central1</span>`, "manov"],
          [`<span class="faint">Jul 13 8:16 PM</span>`, `<span class="mono">azure.tfstate_provisioned</span>`, `<span class="mono muted">rg-devops/devclusteraccount/tfstate</span>`, "manov"],
          [`<span class="faint">Jul 13 8:04 PM</span>`, `<span class="mono">terraform.run_started</span>`, `<span class="mono muted">aks-dev-apply</span>`, "manov"],
          [`<span class="faint">Jul 13 7:53 PM</span>`, `<span class="mono">chat.thread_created</span>`, `<span class="mono muted">GKE dev cluster</span>`, "manov"],
          [`<span class="faint">Jul 13 7:40 PM</span>`, `<span class="mono">cloud_provider.credentials_set</span>`, `<span class="mono muted">azure · release</span>`, "manov"],
          [`<span class="faint">Jul 13 7:34 PM</span>`, `<span class="mono">env.tf_backend_set</span>`, `<span class="mono muted">azure · release</span>`, "manov"],
          [`<span class="faint">Jul 13 7:12 PM</span>`, `<span class="mono">eks.terraform_generated</span>`, `<span class="mono muted">alpha/dev</span>`, "manov"],
        ]))}`,
  },
  {
    id: "knowledge",
    group: "Ops",
    icon: "◉",
    label: "Knowledge base",
    render: () => `
      ${pageHead({ title: "Knowledge", sub: "Runbooks, incident postmortems, and reference docs the agent reads.", actions: btn("+ New doc", { variant: "primary" }) })}
      <div class="row gap-2 wrap">${chip("all", { active: true })}${chip("runbooks")}${chip("postmortems")}${chip("reference")}
        <div style="margin-left:auto;">${input({ placeholder: "search knowledge…" })}</div>
      </div>
      <div>
        <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 12px;">Runbooks · 3</h3>
        ${tileGrid({ minTile: 320, maxTile: "1fr" },
          card({ title: "Rotate cloud creds", sub: "release · 5 min", actions: badge("runbook", "info") }, `<span class="muted" style="font-size:13px;">Step-by-step for cycling AWS/Azure/GCP keys without downtime.</span>`),
          card({ title: "Recover orphaned GKE cluster", sub: "release · 8 min", actions: badge("runbook", "info") }, `<span class="muted" style="font-size:13px;">When terraform state loses track of a cluster that got created.</span>`),
          card({ title: "Rebuild AKS after quota bump", sub: "beta · 12 min", actions: badge("runbook", "info") }, `<span class="muted" style="font-size:13px;">Delete → wait → recreate flow for regional AKS.</span>`))}
      </div>
      <div>
        <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 12px;">Postmortems · 2</h3>
        ${tileGrid({ minTile: 320, maxTile: "1fr" },
          card({ title: "2026-07-13 · GKE apply timeout", sub: "impact: 24 min lost", actions: badge("postmortem", "warn") }, `<span class="muted" style="font-size:13px;">Root cause: 25m runner cap. Fix: bumped to 60m, added resource-level timeouts.</span>`),
          card({ title: "2026-07-10 · S3 backend forced onto GCP", sub: "impact: 3 failed applies", actions: badge("postmortem", "warn") }, `<span class="muted" style="font-size:13px;">Root cause: runner blindly read tfBackendBucket. Fix: pickBackendForEnv() dispatches by cloud kind.</span>`))}
      </div>`,
  },
  {
    id: "tasks",
    group: "Ops",
    icon: "◇",
    label: "Tasks",
    render: () => `
      ${pageHead({ title: "Tasks", sub: "Autonomous agent runs — scheduled or on-demand. Findings surface as alerts.", actions: btn("+ New task", { variant: "primary" }) })}
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:14px;">
        ${stat("Active agents", "5", "across 7 environments", "◐")}
        ${stat("Runs today", "148", "2 currently running", "↻")}
        ${stat("Open findings", "3", "review on demand", "!")}
        ${stat("Last full sweep", "12m ago", "all envs scanned", "✓")}
      </div>
      ${col({ gap: 2 },
        card({ title: "Cost Sentinel", sub: "Weekly rollup + optimization scan · last run 3d ago", actions: row({ gap: 2 }, btn("Run now", { size: "sm", variant: "primary" }), btn("View last run", { size: "sm" })) }, row({ gap: 2 }, badge("weekly", "info"), badge("cost", "info"))),
        card({ title: "Security Sentinel", sub: "Scans images + IAM daily · last run 4h ago", actions: row({ gap: 2 }, btn("Run now", { size: "sm", variant: "primary" }), btn("View last run", { size: "sm" })) }, row({ gap: 2 }, badge("daily", "info"), badge("security", "info"))),
        card({ title: "Cluster Sentinel", sub: "Hourly cluster health check · last run 22m ago", actions: row({ gap: 2 }, btn("Run now", { size: "sm", variant: "primary" }), btn("View last run", { size: "sm" })) }, row({ gap: 2 }, badge("hourly", "info"), badge("cluster", "info"))))}`,
  },
  // ── Settings ─────────────────────────────────────────────────────
  {
    id: "settings",
    group: "Settings",
    icon: "⚙",
    label: "Settings",
    render: () => `
      ${pageHead({ title: "Project settings", sub: "General, integrations, members, and danger-zone controls for this project." })}
      <div class="row gap-2 wrap">${chip("General", { active: true })}${chip("Members")}${chip("Integrations")}${chip("Danger zone")}</div>
      <div style="max-width:720px;" class="col gap-5">
        ${card({ title: "Project identity", sub: "Name, description, and accent color" },
          col({ gap: 3 },
            row({ gap: 3 }, `<div style="width:56px;height:56px;border-radius:12px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:var(--accent-fg);font-weight:800;font-size:20px;flex:none;">A</div>`,
              col({ gap: 3 }, field("Name", input({ value: "agent" })), field("Slug (immutable)", input({ value: "agent", readonly: true })))),
            field("Description", `<textarea class="textarea" style="min-height:80px;">Production deployment target for the DeepAgent DevOps platform.</textarea>`),
            field("Accent color", row({ gap: 2 }, ...["#7c3aed", "#2563eb", "#16a34a", "#dc2626", "#ca8a04"].map((c) => `<button style="width:32px;height:32px;border-radius:9px;background:${c};border:2px solid ${c === "#7c3aed" ? "var(--text)" : "transparent"};cursor:pointer;"></button>`)))))}
        ${card({ title: "Active environment", sub: "Determines which env env-scoped pages default to" }, `<div style="max-width:280px;">${select({ value: "release" })}</div>`)}
        ${card({ title: "Integrations", sub: "Third-party services the agent can call" },
          tileGrid({ minTile: 220 },
            row({ gap: 2, between: true }, `<div class="row gap-2" style="align-items:center;"><span>💬</span><b>Slack</b></div>`, badge("connected", "ok")),
            row({ gap: 2, between: true }, `<div class="row gap-2" style="align-items:center;"><span>📊</span><b>Linear</b></div>`, btn("Connect", { size: "sm" })),
            row({ gap: 2, between: true }, `<div class="row gap-2" style="align-items:center;"><span>📟</span><b>PagerDuty</b></div>`, btn("Connect", { size: "sm" })),
            row({ gap: 2, between: true }, `<div class="row gap-2" style="align-items:center;"><span>📈</span><b>Datadog</b></div>`, btn("Connect", { size: "sm" }))))}
        ${card({ title: "Members", sub: "5 · 2 admins", actions: btn("+ Invite member", { variant: "primary", size: "sm" }) },
          list([
            `<div class="row gap-3" style="align-items:center;"><span style="width:32px;height:32px;border-radius:50%;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;">MV</span><div><b>manoi vv</b><div class="faint" style="font-size:11.5px;">manov7723@example.com</div></div><span style="margin-left:auto;">${badge("admin", "accent")}</span></div>`,
            `<div class="row gap-3" style="align-items:center;"><span style="width:32px;height:32px;border-radius:50%;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;">SR</span><div><b>sriram</b><div class="faint" style="font-size:11.5px;">sriram@tecneural.com</div></div><span style="margin-left:auto;">${badge("admin", "accent")}</span></div>`,
            `<div class="row gap-3" style="align-items:center;"><span style="width:32px;height:32px;border-radius:50%;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;">D1</span><div><b>dev1</b><div class="faint" style="font-size:11.5px;">dev1@example.com</div></div><span style="margin-left:auto;">${badge("developer", "info")}</span></div>`,
            `<div class="row gap-3" style="align-items:center;"><span style="width:32px;height:32px;border-radius:50%;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;">D2</span><div><b>dev2</b><div class="faint" style="font-size:11.5px;">dev2@example.com</div></div><span style="margin-left:auto;">${badge("viewer")}</span></div>`,
          ]))}
      </div>`,
  },
];

// ── Sidebar composition — mirrors nav-registry.ts groupings ────────
const NAV_GROUPS = [
  { label: null, items: ["dashboard", "chat", "cicd", "environments", "cloud", "infra", "topology"] },
  { label: "Deploy", items: ["promotions"] },
  { label: "Connection", items: ["github", "connection", "stats", "uptime", "scheduler"] },
  { label: null, items: ["cost", "tasks", "knowledge", "approvals", "alerts", "activity", "settings"] },
];

const sidebar = `
  <aside class="dda-sidebar col">
    <div class="dda-sidebar-head row between">
      <div class="row gap-2" style="align-items:center;">
        <span style="width:34px;height:34px;border-radius:10px;background:var(--accent);color:var(--accent-fg);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;">◐</span>
        <div class="col">
          <span style="font-weight:800;font-size:13.5px;letter-spacing:-.01em;">DeepAgent DevOps</span>
          <span class="faint" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">Autonomous infra</span>
        </div>
      </div>
    </div>
    <div style="padding:0 12px 8px;">
      <button class="btn outline block" style="width:100%;justify-content:space-between;">
        <span class="row gap-2"><span style="width:22px;height:22px;border-radius:6px;background:var(--accent);color:var(--accent-fg);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">A</span><span>agent</span></span>
        <span class="faint">▾</span>
      </button>
    </div>
    <nav class="col gap-1 dda-sidebar-nav">
      ${NAV_GROUPS.map((g) => `
        ${g.label ? `<div class="dda-sidebar-sep">${g.label}</div>` : ""}
        ${g.items.map((id) => {
          const s = screens.find((s) => s.id === id);
          if (!s) return "";
          return `<a href="#${s.id}" data-id="${s.id}" class="dda-sidebar-item row">
            <span style="width:18px;text-align:center;">${s.icon}</span>
            <span>${s.label}</span>
          </a>`;
        }).join("")}
      `).join("")}
    </nav>
    <div class="dda-sidebar-foot">
      <div class="dda-sidebar-status card card-pad">
        <div class="row gap-2" style="align-items:center;">${dot("ok")}<span style="font-weight:600;font-size:12.5px;">All systems ok</span></div>
        <div class="faint" style="font-size:11px;margin-top:4px;">Last check 2m ago</div>
      </div>
    </div>
  </aside>`;

const topbar = `
  <header class="dda-topbar row between" style="display:flex;align-items:center;">
    <div class="row gap-3" style="align-items:center;">
      <button class="btn ghost icon sm" aria-label="Menu">≡</button>
      <div class="row gap-1" style="font-size:13px;color:var(--text-muted);">
        <span>Projects</span><span class="faint">/</span><span style="color:var(--text);font-weight:600;">agent</span>
      </div>
    </div>
    <div style="flex:1;max-width:520px;margin:0 24px;">
      <div class="input row gap-2" style="cursor:default;color:var(--text-faint);">
        <span>◎</span><span>Search resources, repos, agents…</span><span style="margin-left:auto;font-size:11px;padding:1px 6px;border:1px solid var(--border);border-radius:4px;">⌘K</span>
      </div>
    </div>
    <div class="row gap-2">
      <button class="btn outline sm">📦 Project workspace <span class="faint">▾</span></button>
      <button class="btn ghost icon sm" aria-label="Theme">☀</button>
      <button class="btn ghost icon sm" aria-label="Notifications">🔔</button>
      <button class="btn ghost icon sm" aria-label="User">MV</button>
    </div>
  </header>`;

const pages = screens
  .map((s) => `
    <section class="page" data-page="${s.id}" style="display:none;">
      <div class="dda-page-wrap col gap-5">${s.render()}</div>
    </section>`)
  .join("");

// ── Assembly ─────────────────────────────────────────────────────────
const clientJs = `
  const links = document.querySelectorAll('.dda-sidebar-item');
  const pages = document.querySelectorAll('.page');
  function show(id) {
    pages.forEach(p => p.style.display = p.dataset.page === id ? 'block' : 'none');
    links.forEach(l => l.classList.toggle('active', l.dataset.id === id));
    if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  }
  links.forEach(l => l.addEventListener('click', (e) => { e.preventDefault(); show(l.dataset.id); }));
  window.addEventListener('hashchange', () => show(location.hash.slice(1) || '${screens[0].id}'));
  show(location.hash.slice(1) || '${screens[0].id}');

  // Theme toggle
  const themeBtn = document.querySelector('[aria-label="Theme"]');
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    if (themeBtn) themeBtn.textContent = t === 'dark' ? '☀' : '☾';
    try { localStorage.setItem('dda-wireframe-theme', t); } catch (e) {}
  }
  themeBtn?.addEventListener('click', () => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  try { const s = localStorage.getItem('dda-wireframe-theme'); if (s) setTheme(s); } catch (e) {}
`;

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DeepAgent — UI Wireframe</title>
  <style>
${tokensCss}
${primitivesCss}

/* Wireframe-specific tweaks */
.dda-shell { display: flex; height: 100vh; overflow: hidden; }
.page { min-height: 100%; }
.dda-page-wrap { max-width: 1180px !important; margin: 0 auto; padding: 24px clamp(16px, 3vw, 32px) 64px !important; }
h1 { font-size: 22px !important; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); }
@media (max-width: 900px) {
  .dda-shell { flex-direction: column; }
  .dda-sidebar { width: 100% !important; height: auto; }
}
  </style>
</head>
<body>
  <div class="dda-shell">
    ${sidebar}
    <div class="col grow" style="min-width: 0; min-height: 0;">
      ${topbar}
      <main class="dda-main grow">
        ${pages}
      </main>
    </div>
  </div>
  <script>${clientJs}</script>
</body>
</html>
`;

const outPath = path.join(__dirname, "index.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(`Wireframe written: ${outPath}`);
console.log(`Open in browser:   file://${outPath}`);
console.log(`Screens rendered:  ${screens.length}`);
console.log(`Output size:       ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
