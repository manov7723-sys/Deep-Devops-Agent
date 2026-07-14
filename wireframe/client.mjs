// DeepAgent — client bundle (Preact + htm SPA)
// Read verbatim by index.js and embedded into index.html at build time.
// All runtime: browser only. No server, no backend, no DB.
import { h, render } from "https://esm.sh/preact@10.19.6";
import { useState, useEffect, useRef } from "https://esm.sh/preact@10.19.6/hooks";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

// ═════════════════════════════════════════════════════════════════════
// Mock data — mirrors the shapes the real hooks return
// ═════════════════════════════════════════════════════════════════════
const MOCK = {
  project: { slug: "agent", name: "agent", cloud: "azure" },
  envs: [
    { key: "release", name: "release", tier: "production" },
    { key: "beta", name: "beta", tier: "staging" },
    { key: "alpha", name: "alpha", tier: "dev" },
  ],
  activity: [
    { at: "2m ago", action: "kubernetes.deployment.applied", target: "release", tone: "ok" },
    { at: "8m ago", action: "chat.message_posted", target: "thread 'GKE dev cluster'", tone: "info" },
    { at: "14m ago", action: "terraform.run_started", target: "gke-dev-apply", tone: "info" },
    { at: "26m ago", action: "cloud_provider.credentials_set", target: "azure", tone: "ok" },
    { at: "41m ago", action: "eks.terraform_generated", target: "alpha/dev", tone: "ok" },
  ],
  providers: [
    { id: "p1", kind: "aws", name: "AWS (us-east-1)", env: "alpha", region: "us-east-1", services: 0, cost: 0 },
    { id: "p2", kind: "azure", name: "Azure (eastus)", env: "release", region: "eastus", services: 3, cost: 482 },
    { id: "p3", kind: "gcp", name: "GCP (us-central1)", env: "beta", region: "us-central1", services: 2, cost: 267 },
  ],
  chats: [
    { id: "c1", title: "GKE dev cluster", when: "2:41 PM", msgs: 14, group: "Today" },
    { id: "c2", title: "Deploy app to VM", when: "1:22 PM", msgs: 6, group: "Today" },
    { id: "c3", title: "EKS access entries", when: "Jul 13", msgs: 22, group: "Yesterday" },
    { id: "c4", title: "Azure OAuth reconnect", when: "Jul 13", msgs: 9, group: "Yesterday" },
    { id: "c5", title: "Cost tag audit", when: "Jul 10", msgs: 4, group: "Previous 7 days" },
  ],
  chatSeed: [
    { role: "agent", text: "Provisioning GKE in us-central1. What size?" },
    { role: "user", text: "n2-standard-4, 3 nodes" },
    { role: "agent", text: "Generated main.tf, outputs.tf, versions.tf with google_project_service preconditions and GCS backend. Ready to apply?" },
    { role: "user", text: "Apply." },
    { role: "agent", text: "Provisioning cluster… init ok, plan ok, apply running (~15-20 min for regional GKE)." },
  ],
  pipeline: [
    { id: "r1", name: "aks-dev-apply", action: "apply", env: "release", status: "running", elapsed: "12m 04s", stages: [
      { name: "init", status: "succeeded", dur: "42s" },
      { name: "plan", status: "succeeded", dur: "2m 18s" },
      { name: "apply", status: "running", dur: "9m 04s" },
    ]},
    { id: "r2", name: "gke-beta-apply", action: "apply", env: "beta", status: "succeeded", elapsed: "18m 22s", stages: [
      { name: "init", status: "succeeded", dur: "38s" },
      { name: "plan", status: "succeeded", dur: "1m 51s" },
      { name: "apply", status: "succeeded", dur: "15m 53s" },
    ]},
    { id: "r3", name: "eks-alpha-plan", action: "plan", env: "alpha", status: "failed", elapsed: "1m 02s", stages: [
      { name: "init", status: "failed", dur: "1m 02s" },
      { name: "plan", status: "skipped", dur: null },
      { name: "apply", status: "skipped", dur: null },
    ]},
  ],
  pipelines: [
    { repo: "manov7723-sys/deepagent", workflow: "build-and-push", branch: "dev", status: "succeeded", dur: "3m 04s", actor: "manov" },
    { repo: "manov7723-sys/deepagent", workflow: "deploy-aks", branch: "release", status: "running", dur: "12m 04s", actor: "manov" },
    { repo: "acme/app", workflow: "trivy-scan", branch: "main", status: "failed", dur: "42s", actor: "sriram" },
  ],
  alerts: [
    { name: "mem-usage high", target: "aks-prod / default / worker-abc123 · 92% for 12m", sev: "high", env: "release" },
    { name: "p95-latency high", target: "app.example.com · 1.2s for 5m", sev: "warn", env: "release" },
  ],
  monitors: [
    { url: "https://app.example.com/health", status: "up", uptime: "99.98%", p50: "142ms", last: "12s" },
    { url: "https://api.example.com/live", status: "up", uptime: "99.99%", p50: "89ms", last: "10s" },
    { url: "https://docs.example.com", status: "warn", uptime: "99.72%", p50: "812ms", last: "24s" },
  ],
};

// ═════════════════════════════════════════════════════════════════════
// Primitives (map 1:1 to src/components/ui in the real app)
// ═════════════════════════════════════════════════════════════════════
const Btn = ({ variant = "outline", size, icon, children, onClick, disabled, block }) => html`
  <button class=${"btn " + variant + (size ? " " + size : "") + (block ? " block" : "")} onClick=${onClick} disabled=${disabled}>
    ${icon && html`<span>${icon}</span>`}${children}
  </button>`;

const Chip = ({ active, children, onClick, icon }) => html`
  <button class=${"chip" + (active ? " active" : "")} onClick=${onClick}>
    ${icon && html`<span>${icon}</span>`}${children}
  </button>`;

const Badge = ({ tone, children }) => html`
  <span class=${"badge" + (tone ? " " + tone : "")}>${["ok","warn","danger","info"].includes(tone) && html`<span class="dot" aria-hidden></span>`}${children}</span>`;

const Dot = ({ tone = "ok" }) => html`<span class="dot" style=${{background: "var(--" + tone + ")"}}></span>`;

const Card = ({ title, sub, actions, maxWidth, pad = true, children }) => html`
  <section class="card" style=${maxWidth ? {maxWidth: maxWidth + "px", width: "100%"} : null}>
    ${title != null && html`
      <div class="card-h">
        <div class="col" style=${{gap: 2}}>
          <span class="card-title">${title}</span>
          ${sub && html`<span class="faint" style=${{fontSize: 12}}>${sub}</span>`}
        </div>
        ${actions && html`<div class="row gap-2" style=${{marginLeft: "auto"}}>${actions}</div>`}
      </div>`}
    <div class=${pad ? "card-pad" : ""}>${children}</div>
  </section>`;

const Field = ({ label, hint, children, required }) => html`
  <label class="col gap-1">
    <span class="field-label">${label}${required && html`<span style=${{color: "var(--danger)", marginLeft: 4}}>*</span>`}</span>
    ${children}
    ${hint && html`<span class="faint" style=${{fontSize: 11.5, marginTop: 4}}>${hint}</span>`}
  </label>`;

const Input = ({ value, onInput, placeholder, readonly, type = "text" }) => html`
  <input class="input" type=${type} value=${value} placeholder=${placeholder} onInput=${onInput} readonly=${readonly} />`;

const Select = ({ value, onChange, options }) => {
  const [open, setOpen] = useState(false);
  return html`
    <div style=${{position: "relative"}}>
      <button class="select" style=${{cursor: "pointer", width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between"}} onClick=${() => setOpen(!open)}>
        <span>${value ?? "Choose…"}</span>
        <span class="faint">▾</span>
      </button>
      ${open && html`
        <div style=${{position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", zIndex: 100, overflow: "hidden"}}>
          ${options.map((o) => html`
            <button style=${{display: "block", width: "100%", padding: "10px 14px", background: value === o ? "var(--surface-3)" : "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13}} onClick=${() => { onChange(o); setOpen(false); }}>${o}</button>
          `)}
        </div>`}
    </div>`;
};

const Stat = ({ label, value, sub, icon }) => html`
  <div class="card card-pad" style=${{minWidth: 0}}>
    <div class="row between" style=${{alignItems: "flex-start"}}>
      <div class="col gap-1" style=${{minWidth: 0}}>
        <span class="faint" style=${{fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>${label}</span>
        <span style=${{fontSize: 22, fontWeight: 800, letterSpacing: "-.02em"}}>${value}</span>
        ${sub && html`<span class="muted" style=${{fontSize: 12}}>${sub}</span>`}
      </div>
      ${icon && html`<span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 16}}>${icon}</span>`}
    </div>
  </div>`;

const TileGrid = ({ minTile = 320, maxTile = 420, gap = 14, children }) => {
  const template = maxTile === "1fr"
    ? "repeat(auto-fill, minmax(" + minTile + "px, 1fr))"
    : "repeat(auto-fill, minmax(" + minTile + "px, " + maxTile + "px))";
  return html`<div style=${{display: "grid", gridTemplateColumns: template, justifyContent: maxTile === "1fr" ? "stretch" : "start", gap: gap}}>${children}</div>`;
};

const PageHead = ({ title, sub, actions }) => html`
  <div class="col gap-4" style=${{marginBottom: 4}}>
    <div class="row between gap-3 wrap" style=${{alignItems: "flex-start"}}>
      <div class="col" style=${{gap: 4, minWidth: 0, maxWidth: 720}}>
        <h1 style=${{fontSize: 22, letterSpacing: "-.02em"}}>${title}</h1>
        ${sub && html`<p class="muted" style=${{fontSize: 13.5, lineHeight: 1.5}}>${sub}</p>`}
      </div>
      ${actions && html`<div class="row gap-2 wrap">${actions}</div>`}
    </div>
  </div>`;

const Table = ({ headers, rows }) => html`
  <div style=${{overflowX: "auto"}}>
    <table style=${{width: "100%", borderCollapse: "collapse", fontSize: 13}}>
      <thead><tr>${headers.map((h) => html`<th style=${{textAlign: "left", padding: "12px 14px", borderBottom: "1px solid var(--border-soft)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-muted)", fontWeight: 700}}>${h}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td style=${{padding: "12px 14px", borderBottom: "1px solid var(--border-soft)"}}>${c}</td>`)}</tr>`)}</tbody>
    </table>
  </div>`;

// ═════════════════════════════════════════════════════════════════════
// Pages
// ═════════════════════════════════════════════════════════════════════

const DashboardPage = () => html`
  <${PageHead} title="agent" sub="Production deployment target for the DeepAgent DevOps platform." actions=${html`
    <${Btn} variant="primary" icon="◈">Open chat<//>
    <${Btn}>Deploy<//>
  `} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14}}>
    <${Stat} label="Environments" value="3" sub="alpha · beta · release" icon="◨" />
    <${Stat} label="Repositories" value="5" sub="connected" icon="◱" />
    <${Stat} label="Monthly cost" value="$1,412" sub="▲ 6.4%" icon="$" />
    <${Stat} label="Health" value="OK" sub="all clusters ready" icon="✓" />
  </div>
  <div class="row gap-4 wrap" style=${{alignItems: "flex-start"}}>
    <div style=${{flex: 1, minWidth: 420}}>
      <${Card} title="Recent activity" sub="Latest 20 events">
        <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
          ${MOCK.activity.map((a) => html`
            <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}>
              <div class="row gap-3" style=${{alignItems: "center"}}>
                <${Badge} tone=${a.tone}>${a.tone === "ok" ? "succeeded" : "info"}<//>
                <span class="mono muted">${a.action}</span>
                <span class="faint">·</span>
                <span>${a.target}</span>
                <span class="faint" style=${{marginLeft: "auto"}}>${a.at}</span>
              </div>
            </li>`)}
        </ul>
      <//>
    </div>
    <div style=${{width: 340, flex: "none"}}>
      <${Card} title="Attention" sub="Blocking deploys">
        <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="danger">high<//> 1 open alert · <span class="mono">mem-usage</span> on release</li>
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="info">pending<//> 2 approvals waiting</li>
          <li style=${{padding: "10px 0", fontSize: 13}}><${Badge} tone="warn">warn<//> State backend not set on <span class="mono">alpha</span></li>
        </ul>
      <//>
    </div>
  </div>
  <${Card} title="Spend trend" sub="30-day rolling · $1,412 MTD">
    <div style=${{height: 180, background: "linear-gradient(180deg, transparent, var(--surface-2))", borderRadius: 8, display: "flex", alignItems: "flex-end", padding: 14, gap: 4}}>
      ${Array.from({length: 30}).map((_, i) => html`<div style=${{flex: 1, background: "var(--accent)", opacity: 0.4 + (i / 30) * 0.6, borderRadius: "2px 2px 0 0", height: (20 + Math.sin(i * 0.4) * 40 + i * 2) + "%"}} />`)}
    </div>
  <//>
`;

const ChatPage = () => {
  const [messages, setMessages] = useState(MOCK.chatSeed);
  const [text, setText] = useState("");
  const [railOpen, setRailOpen] = useState(true);
  const [activeChat, setActiveChat] = useState("c1");
  const scrollRef = useRef(null);
  const send = () => {
    if (!text.trim()) return;
    const t = text.trim();
    setMessages([...messages, { role: "user", text: t }]);
    setText("");
    setTimeout(() => setMessages((prev) => [...prev, { role: "agent", text: "(demo) Received: '" + t + "'. In the live app I'd analyze your repos and cloud state to answer." }]), 500);
  };
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);
  const groups = ["Today", "Yesterday", "Previous 7 days"];
  return html`
    <div style=${{height: "calc(100vh - 100px)", display: "grid", gridTemplateColumns: railOpen ? "1fr 280px" : "1fr 0px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", transition: "grid-template-columns .22s ease"}}>
      <div class="col" style=${{minWidth: 0, minHeight: 0}}>
        <header style=${{padding: "14px 20px", borderBottom: "1px solid var(--border-soft)", display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18}}>◐</span>
            <div class="col" style=${{lineHeight: 1.3}}>
              <span class="row gap-2" style=${{fontWeight: 700, fontSize: 14}}>Deep Agent <${Dot} tone="ok" /></span>
              <span class="faint" style=${{fontSize: 11.5}}>Claude Sonnet 4.5 · sees all repos & cloud state</span>
            </div>
          </div>
          <div class="row gap-2">
            <${Badge} tone="accent">agent<//>
            <${Btn} variant="outline" size="sm" icon="🗑">Clear<//>
            <${Btn} variant="outline" size="icon" onClick=${() => setRailOpen(!railOpen)}>${railOpen ? "▶" : "◀"}<//>
          </div>
        </header>
        <div ref=${scrollRef} style=${{flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16}}>
          ${messages.map((m) => m.role === "agent" ? html`
            <div class="row gap-3" style=${{alignItems: "flex-start"}}>
              <span style=${{width: 32, height: 32, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flex: "none"}}>◐</span>
              <div style=${{background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 12, padding: "12px 15px", maxWidth: 640, fontSize: 14, lineHeight: 1.6}}>${m.text}</div>
            </div>` : html`
            <div class="row gap-3" style=${{justifyContent: "flex-end", alignItems: "flex-start"}}>
              <div style=${{background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 12, padding: "12px 15px", maxWidth: 640, fontSize: 14, lineHeight: 1.6}}>${m.text}</div>
              <span style=${{width: 32, height: 32, borderRadius: 9, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11, flex: "none"}}>MV</span>
            </div>`)}
        </div>
        <div style=${{padding: "16px 24px 20px", borderTop: "1px solid var(--border-soft)", flex: "none"}}>
          <div style=${{maxWidth: 820, margin: "0 auto"}}>
            <div style=${{padding: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, boxShadow: "var(--shadow-sm)"}}>
              <textarea class="textarea" style=${{border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, minHeight: 24, maxHeight: 200, resize: "none", padding: "4px 6px", color: "var(--text)", fontFamily: "inherit"}} placeholder="Describe what you want to build or change…" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <div class="row between" style=${{alignItems: "center", marginTop: 8}}>
                <div class="row gap-2"><${Btn} variant="ghost" size="icon" icon="+" /><${Btn} variant="ghost" size="sm" icon="▤">infra<//></div>
                <${Btn} variant="primary" size="icon" onClick=${send} disabled=${!text.trim()}>▸<//>
              </div>
            </div>
            <p class="faint" style=${{fontSize: 11, textAlign: "center", marginTop: 8}}>Deep Agent can read and write to your repos. Changes require approval before they touch release.</p>
          </div>
        </div>
      </div>
      ${railOpen && html`
        <aside style=${{background: "var(--surface-2)", borderLeft: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden"}}>
          <div class="row between" style=${{padding: 12, alignItems: "center"}}>
            <span style=${{fontWeight: 700, fontSize: 13}}>Recent chats</span>
            <${Btn} variant="primary" size="sm" icon="+">New<//>
          </div>
          <div style=${{flex: 1, overflowY: "auto", padding: "0 8px 12px"}}>
            ${groups.map((g) => html`
              <div style=${{fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-faint)", padding: "10px 8px 4px"}}>${g}</div>
              ${MOCK.chats.filter((c) => c.group === g).map((c) => html`
                <button style=${{display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px", margin: "2px 0", borderRadius: 8, border: "1px solid transparent", background: activeChat === c.id ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent", width: "100%", textAlign: "left", color: "var(--text)", fontFamily: "inherit", cursor: "pointer"}} onClick=${() => setActiveChat(c.id)}>
                  <span style=${{fontSize: 13, fontWeight: 600}}>${c.title}</span>
                  <span style=${{fontSize: 11, color: "var(--text-faint)"}}>${c.when} · ${c.msgs} msgs</span>
                </button>`)}
            `)}
          </div>
        </aside>`}
    </div>`;
};

const CloudPage = () => {
  const [envFilter, setEnvFilter] = useState("all");
  const [connectOpen, setConnectOpen] = useState(false);
  const providers = envFilter === "all" ? MOCK.providers : MOCK.providers.filter((p) => p.env === envFilter);
  const envs = ["all", ...MOCK.envs.map((e) => e.key)];
  const tint = { aws: "oklch(0.72 0.19 45 / 0.15)", azure: "oklch(0.7 0.17 235 / 0.18)", gcp: "oklch(0.74 0.17 158 / 0.18)" };
  const tintFg = { aws: "oklch(0.72 0.19 45)", azure: "oklch(0.7 0.17 235)", gcp: "oklch(0.74 0.17 158)" };
  return html`
    <${PageHead} title="Cloud providers" sub="Connected accounts Deep Agent deploys to, per environment." actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => setConnectOpen(true)}>Connect provider<//>`} />
    <div class="row gap-2 wrap">${envs.map((e) => html`<${Chip} active=${envFilter === e} onClick=${() => setEnvFilter(e)}>${e}<//>`)}</div>
    <${TileGrid} minTile=${320} maxTile="1fr">
      ${providers.map((p) => html`
        <${Card}>
          <div class="row between">
            <div class="row gap-3">
              <span style=${{width: 44, height: 44, borderRadius: 11, background: tint[p.kind], color: tintFg[p.kind], display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 10}}>${p.kind.toUpperCase()}</span>
              <div class="col" style=${{gap: 2}}><div style=${{fontWeight: 700, fontSize: 14}}>${p.name}</div><div class="muted" style=${{fontSize: 12}}>${p.env} · ${p.kind.toUpperCase()}</div></div>
            </div>
            <${Dot} tone="ok" />
          </div>
          <div style=${{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 14}}>
            <div><div class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>Region</div><div class="mono" style=${{fontSize: 13, marginTop: 2}}>${p.region}</div></div>
            <div><div class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>Services</div><div style=${{fontSize: 15, fontWeight: 700, marginTop: 2}}>${p.services}</div></div>
            <div><div class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>Monthly</div><div style=${{fontSize: 15, fontWeight: 700, marginTop: 2}}>$${p.cost}</div></div>
          </div>
          <div class="row gap-2" style=${{marginTop: 14}}><${Btn} icon="▤">View stats<//><${Btn} variant="ghost" size="icon">⚙<//><${Btn} variant="ghost" size="icon">🗑<//></div>
        <//>`)}
    <//>
    <${Card} title="Vault configuration" sub="Step 1 · connect Vault. Step 2 · store cloud keys.">
      <div style=${{maxWidth: 520}}>
        <div class="row between" style=${{marginBottom: 14}}><span style=${{fontWeight: 600, fontSize: 13}}>Connection</span><${Badge} tone="warn">not connected<//></div>
        <div class="col gap-3">
          <${Field} label="Vault URL" required><${Input} placeholder="https://127.0.0.1:8200" /><//>
          <${Field} label="Vault token" required hint="Token with read/write on the KV mount (hvs.…)"><${Input} placeholder="hvs.•••••••••••" /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="🔗">Save & test<//></div>
        </div>
      </div>
    <//>
    ${connectOpen && html`<${ConnectCloudModal} onClose=${() => setConnectOpen(false)} />`}
  `;
};

const ConnectCloudModal = ({ onClose }) => {
  const [step, setStep] = useState(1);
  const [cloud, setCloud] = useState("azure");
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 560, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 20}}>
          <h2 style=${{fontSize: 18}}>Connect cloud provider · Step ${step} of 2</h2>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        ${step === 1 ? html`
          <div class="col gap-4">
            <${Field} label="Pick a cloud">
              <div class="row gap-2 wrap">
                ${[{k: "aws", n: "AWS"}, {k: "azure", n: "Azure"}, {k: "gcp", n: "GCP"}].map((c) => html`
                  <button class=${"chip " + (cloud === c.k ? "active" : "")} style=${{height: 44, padding: "0 16px"}} onClick=${() => setCloud(c.k)}>☁ ${c.n}</button>`)}
              </div>
            <//>
            <${Field} label="Environment to attach to">
              <${Select} value="release" onChange=${() => {}} options=${MOCK.envs.map((e) => e.key)} />
            <//>
            <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
              <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
              <${Btn} variant="primary" onClick=${() => setStep(2)}>Continue →<//>
            </div>
          </div>` : html`
          <div class="col gap-4">
            <p class="muted" style=${{fontSize: 13}}>Sign in with your ${cloud.toUpperCase()} account. We'll auto-provision a service principal for keyless deploys.</p>
            <${Btn} variant="primary" block>Sign in with ${cloud.toUpperCase()} →<//>
            <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
              <${Btn} variant="ghost" onClick=${() => setStep(1)}>← Back<//>
            </div>
          </div>`}
      </div>
    </div>`;
};

const InfraPage = () => {
  const [pipelineEnv, setPipelineEnv] = useState("release");
  const runs = MOCK.pipeline.filter((r) => r.env === pipelineEnv);
  return html`
    <${PageHead} title="Infrastructure" sub="Cloud credentials, Terraform state, and managed-Kubernetes cluster provisioning (EKS · GKE · AKS)." />
    <${Card} title="Cloud credentials" sub="Provider used to authenticate Terraform runs">
      <div class="row gap-2 wrap"><${Badge} tone="ok">Azure · release<//><${Btn} icon="+">Add credentials<//></div>
    <//>
    <${Card} title="Terraform state backend" sub="Cloud-aware: S3 / GCS / azurerm chosen from project cloud." maxWidth=${560}>
      <div class="col gap-3">
        <${Field} label="Environment"><${Select} value="release" onChange=${() => {}} options=${MOCK.envs.map((e) => e.key)} /><//>
        <${Field} label="Resource group"><${Input} value="rg-devops" /><//>
        <${Field} label="Storage account" hint="Globally unique, 3-24 lowercase letters/digits."><${Input} value="devclusteraccount" /><//>
        <${Field} label="Blob container"><${Input} value="tfstate" /><//>
        <div class="row gap-2"><${Btn} variant="primary" icon="✓">Save<//><${Btn} icon="☁">Provision in Azure<//></div>
      </div>
    <//>
    <${Card} title="Terraform pipeline" sub="init → plan → apply against the env's cloud creds + state backend.">
      <div class="col gap-3">
        <div class="row gap-2" style=${{alignItems: "center"}}>
          <span class="field-label" style=${{margin: 0, padding: 0}}>Environment</span>
          <div style=${{maxWidth: 220}}><${Select} value=${pipelineEnv} onChange=${setPipelineEnv} options=${MOCK.envs.map((e) => e.key)} /></div>
        </div>
        ${runs.length === 0 ? html`<div class="muted" style=${{padding: 20, textAlign: "center", fontSize: 13}}>No runs for this environment.</div>` : runs.map((r) => html`
          <${Card} pad=${true}>
            <div class="row between" style=${{alignItems: "flex-start"}}>
              <div class="col">
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <b>${r.name}</b>
                  <${Badge} tone=${r.status === "succeeded" ? "ok" : r.status === "failed" ? "danger" : "info"}>${r.status}<//>
                  <span class="muted" style=${{fontSize: 12.5}}>${r.action} · ${r.env}</span>
                  <span style=${{fontSize: 12, color: "var(--text-muted)"}}><${Dot} tone=${r.status === "running" ? "info" : "ok"} /> <span class="tnum">${r.elapsed}</span></span>
                </div>
              </div>
              <div class="row gap-2">
                <${Btn} size="sm" icon="↻" disabled=${r.status === "running"}>Rerun<//>
              </div>
            </div>
            <div style=${{marginTop: 12, display: "flex", flexDirection: "column", gap: 6}}>
              ${r.stages.map((s) => html`
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <${Badge} tone=${s.status === "succeeded" ? "ok" : s.status === "failed" ? "danger" : s.status === "running" ? "info" : "default"}>${s.name}<//>
                  <span class="muted" style=${{fontSize: 12}}>${s.status}${s.dur ? " · " + s.dur : ""}</span>
                </div>`)}
            </div>
          <//>`)}
      </div>
    <//>`;
};

const EnvironmentsPage = () => {
  const [active, setActive] = useState("release");
  return html`
    <${PageHead} title="Environments" sub="Deploy targets with per-env cloud, cluster, and remote-state configuration." actions=${html`<${Btn} variant="primary" icon="+">New environment<//>`} />
    <${Card} title="Active environment" sub="The env used by env-scoped pages by default.">
      <div class="row gap-2 wrap">
        ${MOCK.envs.map((e) => html`
          <button class="dda-env-tile" data-active=${active === e.key} onClick=${() => setActive(e.key)}>
            <div style=${{fontWeight: 700}}>${e.name}</div><div class="muted" style=${{fontSize: 11}}>${e.tier}</div>
          </button>`)}
      </div>
    <//>
    <${Card} title="All environments" sub=${MOCK.envs.length + " environments · 2 with cluster attached"}>
      <${Table} headers=${["Env", "Cloud", "Cluster", "Repos", "State backend", "Members"]} rows=${MOCK.envs.map((e, i) => [
        html`<b>${e.name}</b>`,
        html`<${Badge} tone="info">${["azure","gcp","aws"][i]}<//>`,
        i === 2 ? html`<span class="muted">—</span>` : html`<span class="mono">${["aks-prod","gke-beta","—"][i]}</span>`,
        String([2,1,1][i]),
        html`<span class="mono faint">${["azurerm · rg-devops","gcs · tfstate-agent","s3 · agent-tfstate"][i]}</span>`,
        String([5,3,3][i]),
      ])} />
    <//>`;
};

const ConnectionPage = () => {
  const [cloud, setCloud] = useState("azure");
  return html`
    <${PageHead} title="Connection" sub="Connect a running Kubernetes cluster (EKS · AKS · GKE). The kubeconfig is stored encrypted on the environment." />
    <div style=${{maxWidth: 960, width: "100%"}} class="col gap-5">
      <${Card} title="Connected clusters" sub="Persist on the environment; the AI chat queries these directly.">
        <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="ok">connected<//> <b class="mono">aks-prod</b> · release · 6 nodes ready</li>
          <li style=${{padding: "10px 0", fontSize: 13}}><${Badge} tone="ok">connected<//> <b class="mono">gke-beta</b> · beta · 3 nodes ready</li>
        </ul>
      <//>
      <${Card} title="Connect Kubernetes cluster" sub="Pick a cloud, point at a running cluster, and connect.">
        <div style=${{maxWidth: 520}}><div class="col gap-3">
          <${Field} label="Cloud provider">
            <div class="row gap-2 wrap">
              ${["aws","azure","gcp"].map((c) => html`<${Chip} active=${cloud === c} onClick=${() => setCloud(c)} icon="☁">${c.toUpperCase()}<//>`)}
            </div>
          <//>
          <${Field} label="Environment" required><${Select} value="release · connected" onChange=${() => {}} options=${MOCK.envs.map((e) => e.key)} /><//>
          ${cloud === "aws" && html`<${Field} label="Region" required><${Input} value="us-east-1" /><//>`}
          ${cloud === "azure" && html`<${Field} label="Resource group" required><${Input} value="rg-devops" /><//>`}
          ${cloud === "gcp" && html`<${Field} label="GCP project" required><${Input} value="new-project-495604" /><//>`}
          <${Field} label="Cluster name" required><${Input} value="aks-prod" /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="⚡">Connect<//><${Btn} variant="ghost">Paste kubeconfig instead<//></div>
        </div></div>
      <//>
    </div>`;
};

const CicdPage = () => html`
  <${PageHead} title="CI/CD & Repos" sub="Pipeline runs, workflow generators, and connected repositories." actions=${html`<${Btn} variant="primary" icon="+">Attach repo<//>`} />
  <${Card} title="Recent pipeline runs" sub="Latest 20 across all repos">
    <${Table} headers=${["Repo", "Workflow", "Branch", "Status", "Duration", "Actor"]} rows=${MOCK.pipelines.map((p) => [
      html`<span class="mono">${p.repo}</span>`, p.workflow, html`<span class="mono">${p.branch}</span>`,
      html`<${Badge} tone=${p.status === "succeeded" ? "ok" : p.status === "failed" ? "danger" : p.status === "running" ? "info" : "warn"}>${p.status}<//>`,
      html`<span class="tnum">${p.dur}</span>`, p.actor,
    ])} />
  <//>`;

const AlertsPage = () => html`
  <${PageHead} title="Alerts" sub="CloudWatch, Azure Monitor, GCP Monitoring, and in-cluster Prometheus." actions=${html`<${Btn}>Test alert<//><${Btn} variant="primary">Configure<//>`} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
    <${Stat} label="Open alerts" value="3" sub="5 total" icon="!" />
    <${Stat} label="High severity" value="1" sub="needs action" icon="⚠" />
    <${Stat} label="Security" value="0" sub="clean" icon="🛡" />
    <${Stat} label="Mean ack" value="14m" sub="last 30d" icon="◑" />
  </div>
  <div class="col gap-2">
    ${MOCK.alerts.map((a) => html`
      <${Card}>
        <div class="row between">
          <div class="col gap-1">
            <div class="row gap-2" style=${{alignItems: "center"}}><b>${a.name}</b><${Badge} tone=${a.sev === "high" ? "danger" : "warn"}>${a.sev}<//><${Badge} tone="info">${a.env}<//></div>
            <span class="muted" style=${{fontSize: 12.5}}>${a.target}</span>
          </div>
          <div class="row gap-2"><${Btn} size="sm">Investigate<//><${Btn} size="sm" variant="primary">Ack<//></div>
        </div>
      <//>`)}
  </div>`;

const CostPage = () => html`
  <${PageHead} title="Cost" sub="Multi-cloud spend rollup, budget tracking, and optimization findings." actions=${html`<${Btn}>Estimate infra<//><${Btn} variant="primary" icon="⚡">Optimize<//>`} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
    <${Stat} label="Month to date" value="$1,412" sub="68% of $2,100 budget" icon="$" />
    <${Stat} label="Forecast" value="$2,043" sub="within budget" icon="◆" />
    <${Stat} label="Savings" value="$187/mo" sub="3 recommendations" icon="▼" />
    <${Stat} label="Untagged" value="$96" sub="3 resources" icon="!" />
  </div>
  <${Card} title="By service" sub="Top 5 categories this month">
    <div style=${{height: 240, display: "flex", alignItems: "flex-end", gap: 12, padding: 20, background: "var(--surface-2)", borderRadius: 8}}>
      ${[["Azure", 482, "accent"], ["GCP", 267, "info"], ["GHCR", 198, "ok"], ["Vault", 124, "warn"], ["Egress", 72, "danger"]].map(([label, val, tone]) => html`
        <div style=${{flex: 1, background: "var(--" + tone + ")", borderRadius: "6px 6px 0 0", height: (val / 482 * 100) + "%", position: "relative"}}>
          <span style=${{position: "absolute", top: -22, left: 0, right: 0, textAlign: "center", fontSize: 11, fontWeight: 700}}>$${val} ${label}</span>
        </div>`)}
    </div>
  <//>`;

const UptimePage = () => html`
  <${PageHead} title="Uptime" sub="External HTTP monitors for the project's endpoints." actions=${html`<${Btn} variant="primary" icon="+">New monitor<//>`} />
  <${Card} title="Monitors" sub="3 active · 30d avg uptime 99.94%">
    <${Table} headers=${["URL", "Status", "Uptime 30d", "p50", "Last check"]} rows=${MOCK.monitors.map((m) => [
      html`<span class="mono">${m.url}</span>`,
      html`<${Badge} tone=${m.status === "up" ? "ok" : "warn"}>${m.status}<//>`,
      html`<span class="tnum">${m.uptime}</span>`,
      html`<span class="tnum">${m.p50}</span>`,
      html`<span class="faint">${m.last} ago</span>`,
    ])} />
  <//>`;

const SimplePage = (title, sub) => () => html`
  <${PageHead} title=${title} sub=${sub} />
  <${Card} title=${title} sub="Uses the same shared primitives as the pages implemented in full above.">
    <div class="muted" style=${{padding: 40, textAlign: "center", fontSize: 13}}>Real content is wired in the live app.</div>
  <//>`;

// ═════════════════════════════════════════════════════════════════════
// Nav
// ═════════════════════════════════════════════════════════════════════
const PAGES = {
  dashboard: { label: "Dashboard", icon: "▤", component: DashboardPage },
  chat: { label: "Chat", icon: "◈", component: ChatPage },
  cicd: { label: "CI/CD & Repos", icon: "◱", component: CicdPage },
  environments: { label: "Environments", icon: "◨", component: EnvironmentsPage },
  cloud: { label: "Cloud providers", icon: "☁", component: CloudPage },
  infra: { label: "Infrastructure", icon: "▤", component: InfraPage },
  topology: { label: "Topology", icon: "⟿", component: SimplePage("Topology", "Live graph of clusters, workloads, and their edges.") },
  promotions: { label: "Promotions", icon: "▲", component: SimplePage("Promotions", "Promote a deployed image between environments.") },
  github: { label: "Source control", icon: "◍", component: SimplePage("Source control", "GitHub App installations and connected repositories.") },
  connection: { label: "Clusters", icon: "⛁", component: ConnectionPage },
  stats: { label: "Cloud stats", icon: "◉", component: SimplePage("Cloud stats", "Live cluster + observability KPIs.") },
  uptime: { label: "Uptime", icon: "↺", component: UptimePage },
  scheduler: { label: "Scheduler", icon: "⏰", component: SimplePage("Scheduler", "Deploy later — schedule an image + env for automatic rollout.") },
  cost: { label: "Cost", icon: "$", component: CostPage },
  tasks: { label: "Tasks", icon: "◇", component: SimplePage("Tasks", "Autonomous agent runs — scheduled or on-demand.") },
  knowledge: { label: "Knowledge", icon: "◉", component: SimplePage("Knowledge", "Runbooks, incident postmortems, reference docs.") },
  approvals: { label: "Approvals", icon: "☑", component: SimplePage("Approvals", "Gated changes waiting on a human.") },
  alerts: { label: "Alerts", icon: "!", component: AlertsPage },
  activity: { label: "Activity", icon: "≡", component: SimplePage("Activity", "Every audit-worthy action in the project.") },
  settings: { label: "Settings", icon: "⚙", component: SimplePage("Project settings", "General, integrations, members, danger zone.") },
};

const NAV_GROUPS = [
  { label: null, items: ["dashboard","chat","cicd","environments","cloud","infra","topology"] },
  { label: "Deploy", items: ["promotions"] },
  { label: "Connection", items: ["github","connection","stats","uptime","scheduler"] },
  { label: null, items: ["cost","tasks","knowledge","approvals","alerts","activity","settings"] },
];

// ═════════════════════════════════════════════════════════════════════
// Shell
// ═════════════════════════════════════════════════════════════════════
const Sidebar = ({ active, onSelect }) => html`
  <aside class="dda-sidebar col">
    <div class="dda-sidebar-head row between">
      <div class="row gap-2" style=${{alignItems: "center"}}>
        <span style=${{width: 34, height: 34, borderRadius: 10, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14}}>◐</span>
        <div class="col">
          <span style=${{fontWeight: 800, fontSize: 13.5, letterSpacing: "-.01em"}}>DeepAgent DevOps</span>
          <span class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700}}>Autonomous infra</span>
        </div>
      </div>
    </div>
    <div style=${{padding: "0 12px 8px"}}>
      <${Btn} variant="outline" block>
        <span class="row gap-2"><span style=${{width: 22, height: 22, borderRadius: 6, background: "var(--accent)", color: "var(--accent-fg)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800}}>A</span><span>agent</span></span>
      <//>
    </div>
    <nav class="col gap-1 dda-sidebar-nav">
      ${NAV_GROUPS.map((g) => html`
        ${g.label && html`<div class="dda-sidebar-sep">${g.label}</div>`}
        ${g.items.map((id) => html`
          <a href=${"#" + id} class=${"dda-sidebar-item row" + (active === id ? " active" : "")} onClick=${(e) => { e.preventDefault(); onSelect(id); }}>
            <span style=${{width: 18, textAlign: "center"}}>${PAGES[id].icon}</span>
            <span>${PAGES[id].label}</span>
          </a>`)}
      `)}
    </nav>
    <div class="dda-sidebar-foot">
      <div class="dda-sidebar-status card card-pad">
        <div class="row gap-2" style=${{alignItems: "center"}}><${Dot} tone="ok" /><span style=${{fontWeight: 600, fontSize: 12.5}}>All systems ok</span></div>
        <div class="faint" style=${{fontSize: 11, marginTop: 4}}>Last check 2m ago</div>
      </div>
    </div>
  </aside>`;

const Topbar = ({ theme, onToggleTheme }) => html`
  <header class="dda-topbar row between" style=${{display: "flex", alignItems: "center"}}>
    <div class="row gap-3" style=${{alignItems: "center"}}>
      <${Btn} variant="ghost" size="icon">≡<//>
      <div class="row gap-1" style=${{fontSize: 13, color: "var(--text-muted)"}}>
        <span>Projects</span><span class="faint">/</span><span style=${{color: "var(--text)", fontWeight: 600}}>agent</span>
      </div>
    </div>
    <div style=${{flex: 1, maxWidth: 520, margin: "0 24px"}}>
      <div class="input row gap-2" style=${{cursor: "default", color: "var(--text-faint)"}}>
        <span>◎</span><span>Search resources, repos, agents…</span><span style=${{marginLeft: "auto", fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 4}}>⌘K</span>
      </div>
    </div>
    <div class="row gap-2">
      <${Btn} size="sm">📦 Project workspace <span class="faint">▾</span><//>
      <${Btn} variant="ghost" size="icon" onClick=${onToggleTheme}>${theme === "dark" ? "☀" : "☾"}<//>
      <${Btn} variant="ghost" size="icon">🔔<//>
      <${Btn} variant="ghost" size="icon">MV<//>
    </div>
  </header>`;

const App = () => {
  const [active, setActive] = useState(() => (location.hash.slice(1) in PAGES ? location.hash.slice(1) : "dashboard"));
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("dda-wf-theme") || "dark"; } catch (e) { return "dark"; }
  });
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("dda-wf-theme", theme); } catch (e) {} }, [theme]);
  useEffect(() => {
    const on = () => { const id = location.hash.slice(1); if (id in PAGES) setActive(id); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setActive(id); location.hash = id; };
  const Page = PAGES[active].component;
  const isChat = active === "chat";
  return html`
    <div class="dda-shell" style=${{display: "flex", height: "100vh", overflow: "hidden"}}>
      <${Sidebar} active=${active} onSelect=${select} />
      <div class="col grow" style=${{minWidth: 0, minHeight: 0}}>
        <${Topbar} theme=${theme} onToggleTheme=${() => setTheme(theme === "dark" ? "light" : "dark")} />
        <main class="dda-main grow">
          <div class="dda-page-wrap col gap-5" style=${isChat ? {maxWidth: "none", padding: 0, height: "100%"} : null}>
            <${Page} />
          </div>
        </main>
      </div>
    </div>`;
};

render(h(App, null), document.getElementById("root"));
