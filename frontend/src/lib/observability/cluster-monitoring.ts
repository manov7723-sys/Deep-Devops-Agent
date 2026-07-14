/**
 * In-cluster monitoring (Model B) — the app installs kube-prometheus-stack into
 * the env's connected cluster and queries it THROUGH the cluster connection (the
 * Kubernetes API-server proxy), so nothing is exposed publicly and the user runs
 * nothing outside the app. Everything is per-project, per-environment.
 *
 *   install  → helm upgrade --install kube-prometheus-stack into ns "monitoring"
 *   status   → kubectl get pods -n monitoring
 *   query    → kubectl get --raw .../services/<prom>:9090/proxy/api/v1/query?...
 */
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import { appDashboard } from "@/lib/observability/grafana-dashboard";

export const NS = "monitoring";
const RELEASE = "monitoring";
const PROM_SVC = "monitoring-kube-prometheus-prometheus"; // <release>-kube-prometheus-prometheus
const PROM_PORT = "9090";
export const GRAFANA_SVC = "monitoring-grafana"; // <release>-grafana
export const GRAFANA_PORT = "80";
const HELM_REPO = "https://prometheus-community.github.io/helm-charts";
const GRAFANA_HELM_REPO = "https://grafana.github.io/helm-charts";
const LOKI_RELEASE = "loki"; // service name becomes "loki:3100"

/** Stable Grafana dashboard UID for an env's app dashboard (kube uid is 40 hex chars). */
export function appDashboardUid(envId: string): string {
  return `app-${envId.replace(/-/g, "").slice(0, 36)}`;
}

type RunResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string; timedOut: boolean }
  | { ok: false; error: string };

/** Run a kubectl/helm command against an env's cluster using its stored kubeconfig. */
async function runWithKubeconfig(
  envId: string,
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<RunResult> {
  const env = await prisma.env.findUnique({
    where: { id: envId },
    select: { cloudProviderId: true },
  });
  const kcfg = await getKubeconfigForEnv(envId);
  if (!kcfg.ok) return { ok: false, error: kcfg.message };
  try {
    const childEnv = await kubeExecEnv(kcfg.handle.path, env?.cloudProviderId ?? null);
    const res = await runStage({ command, args, cwd: process.cwd(), env: childEnv, timeoutMs });
    if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
      return { ok: false, error: `\`${command}\` isn't installed on the server.` };
    }
    return {
      ok: true,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
    };
  } finally {
    await kcfg.handle.cleanup();
  }
}

/** Best-effort human error from a non-zero helm/kubectl run — helm writes some
 *  failures to stdout, so fall back to it when stderr is empty. */
function runError(
  res: { stdout: string; stderr: string; timedOut: boolean },
  fallback: string,
): string {
  if (res.timedOut) return `${fallback} (timed out — the cluster was slow to apply; try again).`;
  const out = (res.stderr.trim() || res.stdout.trim()).slice(-700);
  return out || fallback;
}

export type InstallResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Build the Grafana section of the Helm values so the app can EMBED Grafana:
 *   - serve_from_sub_path + root_url → Grafana emits asset/API URLs under our
 *     app's proxy path, so it works behind the kube API-server proxy.
 *   - allow_embedding → the dashboard can render inside our <iframe>.
 *   - anonymous Viewer → read-only dashboards need no Grafana login.
 * `grafanaRootUrl` is the public URL of our proxy route, e.g.
 *   https://app.example.com/api/v1/projects/<slug>/envs/<key>/monitoring/grafana/
 */
function valuesYaml(grafanaRootUrl: string, disableNodeExporter = false): string {
  // YAML string value; wrap in double quotes and escape any embedded quote.
  const url = `"${grafanaRootUrl.replace(/"/g, '\\"')}"`;
  // node-exporter needs hostPID/hostNetwork/hostPath(/proc,/sys,/) which GKE
  // Autopilot forbids — disable it there (GKE provides node OS metrics itself).
  const nodeExporter = disableNodeExporter ? ["nodeExporter:", "  enabled: false"] : [];
  return [
    ...nodeExporter,
    // Resource requests across the stack so these pods get a GUARANTEED CPU
    // share under node contention (e.g. a CPU stress test). Without requests
    // they're best-effort QoS and get starved first — their liveness probes
    // then time out, they crash-loop, and the metrics page goes blank exactly
    // when you most need it. CPU has requests but NO limits (avoid throttling
    // the health endpoints); memory is capped.
    "kube-state-metrics:",
    "  resources:",
    "    requests:",
    "      cpu: 50m",
    "      memory: 96Mi",
    "    limits:",
    "      memory: 256Mi",
    "prometheus-node-exporter:",
    "  resources:",
    "    requests:",
    "      cpu: 30m",
    "      memory: 32Mi",
    "    limits:",
    "      memory: 64Mi",
    "grafana:",
    "  enabled: true",
    "  resources:",
    "    requests:",
    "      cpu: 50m",
    "      memory: 128Mi",
    "    limits:",
    "      memory: 320Mi",
    // Bundled K8s dashboards are ~30 large ConfigMaps that slow the apply; we
    // provision our own app-scoped dashboard, so skip them for a fast install.
    "  defaultDashboardsEnabled: false",
    "  grafana.ini:",
    "    server:",
    `      root_url: ${url}`,
    "      serve_from_sub_path: true",
    "    security:",
    "      allow_embedding: true",
    "    auth.anonymous:",
    "      enabled: true",
    "      org_role: Viewer",
    "  sidecar:",
    "    dashboards:",
    "      enabled: true",
    "      label: grafana_dashboard",
    "    datasources:",
    "      enabled: true",
    "      label: grafana_datasource",
    // The prometheus-operator admission webhook + its patch Jobs are the main
    // reason a fresh install stalls on small/slow clusters (the rest of the
    // chart waits on them). It only validates alert-rule syntax — safe to drop
    // for an app-monitoring use case, and it makes the install fast + reliable.
    "prometheusOperator:",
    "  admissionWebhooks:",
    "    enabled: false",
    "  tls:",
    "    enabled: false",
    // Trim the install to the essentials for app monitoring. Alertmanager and
    // the ~30 default alert rules aren't needed; the control-plane scrapers
    // (scheduler/controller-manager/etcd/proxy) don't even work on managed AKS.
    // This dramatically cuts the number of objects helm has to apply → fast.
    "alertmanager:",
    "  enabled: false",
    "defaultRules:",
    "  create: false",
    "kubeControllerManager:",
    "  enabled: false",
    "kubeScheduler:",
    "  enabled: false",
    "kubeEtcd:",
    "  enabled: false",
    "kubeProxy:",
    "  enabled: false",
    // CoreDNS/kube-dns monitoring creates a Service in the kube-system namespace,
    // which GKE (Autopilot / managed clusters) locks ("GKE Warden ... managed
    // namespace"). Disable it so the install works on GKE.
    "coreDns:",
    "  enabled: false",
    "kubeDns:",
    "  enabled: false",
    "prometheus:",
    "  prometheusSpec:",
    "    maximumStartupDurationSeconds: 600",
    // Guaranteed CPU/memory so the query path (the metrics page) stays
    // responsive while a node is under stress.
    "    resources:",
    "      requests:",
    "        cpu: 100m",
    "        memory: 400Mi",
    "      limits:",
    "        memory: 1Gi",
    // Discover ANY ServiceMonitor/PodMonitor in the cluster (not just ones with
    // the release label), so the app's own /metrics scrape config is picked up.
    "    serviceMonitorSelectorNilUsesHelmValues: false",
    "    podMonitorSelectorNilUsesHelmValues: false",
    "",
  ].join("\n");
}

/** Install (or upgrade) kube-prometheus-stack into the env's cluster via Helm. */
export async function installMonitoring(
  envId: string,
  opts: { grafanaRootUrl: string },
  onStep: (s: string) => void = () => {},
): Promise<InstallResult> {
  // 1 — ensure the helm repo is available (idempotent).
  onStep("Preparing Helm chart repository…");
  const add = await runWithKubeconfig(
    envId,
    "helm",
    ["repo", "add", "prometheus-community", HELM_REPO, "--force-update"],
    60_000,
  );
  if (!add.ok) return { ok: false, error: add.error };
  await runWithKubeconfig(envId, "helm", ["repo", "update", "prometheus-community"], 60_000);

  // 2 — install/upgrade the chart with a values file (Grafana embedding config).
  // No --wait so the HTTP request returns fast; the status endpoint reports pod
  // readiness as it provisions (~2–5 min).
  const dir = await mkdtemp(join(tmpdir(), "dda-mon-"));
  try {
    const valuesPath = join(dir, "values.yaml");
    await writeFile(valuesPath, valuesYaml(opts.grafanaRootUrl), { mode: 0o600 });

    const runUpgrade = (vp: string) =>
      runWithKubeconfig(
        envId,
        "helm",
        [
          "upgrade",
          "--install",
          RELEASE,
          "prometheus-community/kube-prometheus-stack",
          "--namespace",
          NS,
          "--create-namespace",
          // Skip the OpenAPI schema download — on slow/restricted API servers it
          // times out ("failed to download openapi: context deadline exceeded").
          "--disable-openapi-validation",
          "-f",
          vp,
        ],
        600_000,
      );

    onStep("Installing Prometheus + Grafana into the cluster (this is the slow step)…");
    let install = await runUpgrade(valuesPath);

    // Recover from a release that can't be UPGRADED in place by uninstalling and
    // reinstalling fresh. Covers:
    //   - a stuck "pending" release from a timed-out install, and
    //   - a failed release whose old manifest references a now-removed object the
    //     upgrade can't reconcile — e.g. a kube-system Service that GKE Warden
    //     blocks. A fresh install (new manifest only) sidesteps it.
    const recoverable =
      install.ok &&
      install.exitCode !== 0 &&
      /another operation .*is in progress|pending-(install|upgrade|rollback)|kube-system/i.test(
        `${install.stderr}\n${install.stdout}`,
      );
    if (recoverable) {
      console.warn("[monitoring] clearing release and reinstalling fresh");
      onStep("Cleaning up a previous failed install…");
      // No --wait: just drop the dead release record so the retry can proceed.
      // Waiting here can hang on half-created resources with finalizers.
      await runWithKubeconfig(
        envId,
        "helm",
        ["uninstall", RELEASE, "--namespace", NS, "--ignore-not-found"],
        120_000,
      );
      // Remove orphaned admission webhook configs from earlier (webhook-enabled)
      // attempts — a dead webhook rejects new resources and re-stalls the install.
      for (const kind of ["validatingwebhookconfiguration", "mutatingwebhookconfiguration"]) {
        await runWithKubeconfig(
          envId,
          "kubectl",
          [
            "delete",
            kind,
            "-l",
            "app.kubernetes.io/name=kube-prometheus-stack",
            "--ignore-not-found",
          ],
          30_000,
        );
      }
      onStep("Reinstalling Prometheus + Grafana…");
      install = await runUpgrade(valuesPath);
    }

    // GKE Autopilot rejects the node-exporter DaemonSet (hostPID/hostNetwork/
    // hostPath). It's the only blocked component — retry without it (GKE still
    // provides node OS metrics; pod/container/app metrics are unaffected).
    if (
      install.ok &&
      install.exitCode !== 0 &&
      /node-exporter[\s\S]*?(denied|forbidden|warden|not allowed)|(denied|warden)[\s\S]*?node-exporter|autopilot|hostPID|hostNetwork/i.test(
        `${install.stderr}\n${install.stdout}`,
      )
    ) {
      console.warn("[monitoring] retrying without node-exporter (GKE Autopilot)");
      onStep("Adjusting for GKE Autopilot (disabling node-exporter)…");
      const apValues = join(dir, "values-autopilot.yaml");
      await writeFile(apValues, valuesYaml(opts.grafanaRootUrl, true), { mode: 0o600 });
      install = await runUpgrade(apValues);
    }

    if (!install.ok) return { ok: false, error: install.error };
    if (install.exitCode !== 0) {
      // Surface the full output in the server log — the UI message is truncated.
      console.error("[monitoring] helm install failed", {
        exitCode: install.exitCode,
        timedOut: install.timedOut,
        stderr: install.stderr,
        stdout: install.stdout,
      });
      return { ok: false, error: runError(install, "helm install failed.") };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 3 — provision the app dashboard (best-effort; Grafana's sidecar imports it).
  const env = await prisma.env.findUnique({ where: { id: envId }, select: { namespace: true } });
  await provisionAppDashboard(envId, env?.namespace || "default").catch(() => {});

  // 4 — install log collection (Loki + Promtail) and wire it into Grafana so the
  // embedded dashboard shows logs too. Best-effort: a Loki failure must not fail
  // the (already-working) metrics install.
  onStep("Installing log collection (Loki + Promtail)…");
  await installLogging(envId).catch((e) => console.error("[monitoring] loki install failed", e));

  return {
    ok: true,
    message: `Monitoring installing into namespace "${NS}". Prometheus, Grafana and logs (Loki) come up over the next few minutes.`,
  };
}

/**
 * Install Loki + Promtail (central log storage) into the monitoring namespace and
 * register Loki as a Grafana datasource (uid "loki") so the app dashboard's logs
 * panel works. Promtail ships every pod's logs to Loki; we query them scoped to
 * the app's namespace.
 */
async function installLogging(envId: string): Promise<void> {
  const add = await runWithKubeconfig(
    envId,
    "helm",
    ["repo", "add", "grafana", GRAFANA_HELM_REPO, "--force-update"],
    60_000,
  );
  if (!add.ok) throw new Error(add.error);
  await runWithKubeconfig(envId, "helm", ["repo", "update", "grafana"], 60_000);

  const install = await runWithKubeconfig(
    envId,
    "helm",
    [
      "upgrade",
      "--install",
      LOKI_RELEASE,
      "grafana/loki-stack",
      "--namespace",
      NS,
      "--create-namespace",
      "--disable-openapi-validation",
      "--set",
      "grafana.enabled=false",
      "--set",
      "promtail.enabled=true",
      "--set",
      "loki.isDefault=false",
    ],
    300_000,
  );
  if (!install.ok) throw new Error(install.error);
  if (install.exitCode !== 0) throw new Error(runError(install, "loki install failed."));

  // Register Loki as a Grafana datasource via a labeled ConfigMap — Grafana's
  // datasource sidecar auto-imports it (no Grafana API auth needed).
  const datasource = {
    apiVersion: 1,
    datasources: [
      {
        name: "Loki",
        type: "loki",
        uid: "loki",
        access: "proxy",
        url: `http://${LOKI_RELEASE}:3100`,
        jsonData: { maxLines: 1000 },
      },
    ],
  };
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "dda-loki-datasource",
      namespace: NS,
      labels: { grafana_datasource: "1", "app.kubernetes.io/managed-by": "deepagent" },
    },
    data: { "loki-datasource.yaml": JSON.stringify(datasource) },
  };
  const dir = await mkdtemp(join(tmpdir(), "dda-loki-ds-"));
  try {
    const path = join(dir, "datasource.json");
    await writeFile(path, JSON.stringify(configMap), { mode: 0o600 });
    await runWithKubeconfig(envId, "kubectl", ["apply", "-f", path], 30_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Background install tracking ------------------------------------------
// Helm install (esp. with stuck-release recovery) can take minutes, so we run
// it in the background and let the status endpoint report progress instead of
// blocking the HTTP request. State is in-memory (per server process) — good
// enough: pod readiness is the source of truth once helm has applied.
export type InstallPhase = {
  status: "running" | "error" | "done";
  error?: string;
  step?: string;
  at: number;
};
const installs = new Map<string, InstallPhase>();
// Safety net: never treat a "running" phase as live forever. installMonitoring
// is bounded by per-command timeouts (~25 min absolute worst case with full
// recovery), but a hot-reload or crash could orphan the promise — after this
// the UI re-enables the button so the user can retry.
const MAX_RUNNING_MS = 25 * 60_000;

function isLiveRunning(p: InstallPhase | undefined): boolean {
  return !!p && p.status === "running" && Date.now() - p.at < MAX_RUNNING_MS;
}

// Persist the last install outcome to disk so the error survives a dev
// hot-reload / server restart (in-memory state alone is lost on reload).
type Outcome = { status: "done" | "error"; error?: string; at: number };
const outcomeFile = (envId: string) =>
  join(tmpdir(), `dda-mon-outcome-${envId.replace(/[^a-z0-9-]/gi, "")}.json`);
async function persistOutcome(envId: string, o: Outcome) {
  try {
    await writeFile(outcomeFile(envId), JSON.stringify(o));
  } catch {
    /* best-effort */
  }
}
async function readOutcome(envId: string): Promise<Outcome | null> {
  try {
    return JSON.parse(await readFile(outcomeFile(envId), "utf8")) as Outcome;
  } catch {
    return null;
  }
}

/** What the status endpoint reports to the client about the background install. */
export async function installPhaseView(
  envId: string,
): Promise<{ installing: boolean; installStep?: string; installError?: string }> {
  const p = installs.get(envId);
  if (isLiveRunning(p)) return { installing: true, installStep: p?.step };
  if (p?.status === "error") return { installing: false, installError: p.error };
  if (p?.status === "done") return { installing: false };
  // No in-memory phase (e.g. after a hot-reload) — fall back to the last
  // persisted outcome so a failure is still shown instead of "not installed".
  const o = await readOutcome(envId);
  if (o?.status === "error") return { installing: false, installError: o.error };
  return { installing: false };
}

/** Start the install in the background (no-op if one is already running). */
export function beginInstallMonitoring(
  envId: string,
  opts: { grafanaRootUrl: string },
): { alreadyRunning: boolean } {
  if (isLiveRunning(installs.get(envId))) return { alreadyRunning: true };
  const startedAt = Date.now();
  installs.set(envId, { status: "running", step: "Starting…", at: startedAt });
  const onStep = (step: string) => {
    const cur = installs.get(envId);
    if (cur?.status === "running") installs.set(envId, { ...cur, step });
  };
  void installMonitoring(envId, opts, onStep)
    .then((res) => {
      const o: Outcome = res.ok
        ? { status: "done", at: Date.now() }
        : { status: "error", error: res.error, at: Date.now() };
      installs.set(envId, o);
      void persistOutcome(envId, o);
    })
    .catch((e) => {
      const o: Outcome = {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        at: Date.now(),
      };
      installs.set(envId, o);
      void persistOutcome(envId, o);
    });
  return { alreadyRunning: false };
}

/**
 * Apply a labeled ConfigMap holding an app-scoped Grafana dashboard. The
 * kube-prometheus-stack Grafana sidecar watches for `grafana_dashboard` labels
 * and imports the JSON automatically — no Grafana API auth needed.
 */
async function provisionAppDashboard(envId: string, namespace: string): Promise<void> {
  const uid = appDashboardUid(envId);
  const dashboard = appDashboard(namespace, uid);
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `dda-app-dashboard-${envId}`.slice(0, 253),
      namespace: NS,
      labels: { grafana_dashboard: "1", "app.kubernetes.io/managed-by": "deepagent" },
    },
    data: { [`${uid}.json`]: JSON.stringify(dashboard) },
  };
  const dir = await mkdtemp(join(tmpdir(), "dda-dash-"));
  try {
    const path = join(dir, "dashboard.json");
    await writeFile(path, JSON.stringify(configMap), { mode: 0o600 });
    await runWithKubeconfig(envId, "kubectl", ["apply", "-f", path], 30_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type ScrapeTarget = {
  kind: "ServiceMonitor" | "PodMonitor";
  name: string;
  namespace: string;
  matchLabels: Record<string, string>;
  port: string; // a named port (e.g. "metrics") or a number ("8080")
  path: string; // e.g. "/metrics"
  interval: string; // e.g. "30s"
};

/**
 * Create a ServiceMonitor or PodMonitor so Prometheus scrapes the app's own
 * /metrics endpoint. Discovery is enabled cluster-wide (see valuesYaml), so the
 * object just needs the right selector + port + path. Applied via kubectl.
 */
export async function createScrapeTarget(
  envId: string,
  t: ScrapeTarget,
): Promise<{ ok: boolean; message: string }> {
  const numeric = /^\d+$/.test(t.port.trim());
  const portField = numeric ? { targetPort: Number(t.port) } : { port: t.port };
  const endpoint = { ...portField, path: t.path || "/metrics", interval: t.interval || "30s" };
  const spec =
    t.kind === "ServiceMonitor"
      ? { selector: { matchLabels: t.matchLabels }, endpoints: [endpoint] }
      : { selector: { matchLabels: t.matchLabels }, podMetricsEndpoints: [endpoint] };
  const safeName = `dda-${t.name}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .slice(0, 63);
  const crd = {
    apiVersion: "monitoring.coreos.com/v1",
    kind: t.kind,
    metadata: {
      name: safeName,
      namespace: t.namespace,
      // `release: monitoring` also satisfies the default selector as a belt-and-braces.
      labels: { "app.kubernetes.io/managed-by": "deepagent", release: RELEASE },
    },
    spec,
  };
  const dir = await mkdtemp(join(tmpdir(), "dda-sm-"));
  try {
    const path = join(dir, "scrape.json");
    await writeFile(path, JSON.stringify(crd), { mode: 0o600 });
    const res = await runWithKubeconfig(envId, "kubectl", ["apply", "-f", path], 30_000);
    if (!res.ok) return { ok: false, message: res.error };
    if (res.exitCode !== 0) {
      const err = (res.stderr.trim() || res.stdout.trim()).slice(-400);
      if (/no matches for kind|could not find/i.test(err)) {
        return {
          ok: false,
          message: "Prometheus Operator CRDs not found — install monitoring first.",
        };
      }
      return { ok: false, message: err || "kubectl apply failed." };
    }
    return {
      ok: true,
      message: `${t.kind} "${safeName}" created in "${t.namespace}". Prometheus will start scraping within ~1 min.`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Deploy a tiny demo app that exposes Prometheus /metrics (and wire a
 * ServiceMonitor), entirely server-side via the env's kubeconfig — so the user
 * can SEE service metrics work without touching a terminal. Idempotent.
 */
export async function deployDemoMetricsApp(
  envId: string,
  namespace: string,
): Promise<{ ok: boolean; message: string }> {
  const app = "sample-metrics-app";
  const labels = { app };
  const list = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace },
      },
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: app, namespace, labels },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: "app",
                  image: "quay.io/brancz/prometheus-example-app:v0.5.0",
                  ports: [{ name: "metrics", containerPort: 8080 }],
                  resources: {
                    requests: { cpu: "10m", memory: "16Mi" },
                    limits: { cpu: "100m", memory: "64Mi" },
                  },
                },
              ],
            },
          },
        },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: app, namespace, labels },
        spec: { selector: labels, ports: [{ name: "metrics", port: 8080, targetPort: 8080 }] },
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "dda-demo-"));
  try {
    const path = join(dir, "demo.json");
    await writeFile(path, JSON.stringify(list), { mode: 0o600 });
    const apply = await runWithKubeconfig(envId, "kubectl", ["apply", "-f", path], 60_000);
    if (!apply.ok) return { ok: false, message: apply.error };
    if (apply.exitCode !== 0)
      return {
        ok: false,
        message: (apply.stderr.trim() || apply.stdout.trim()).slice(-400) || "deploy failed.",
      };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // Wire the ServiceMonitor so Prometheus scrapes it.
  const sm = await createScrapeTarget(envId, {
    kind: "ServiceMonitor",
    name: app,
    namespace,
    matchLabels: { app },
    port: "metrics",
    path: "/metrics",
    interval: "30s",
  });
  if (!sm.ok)
    return { ok: false, message: `App deployed, but scrape wiring failed: ${sm.message}` };
  return {
    ok: true,
    message: `Demo app deployed in "${namespace}" with a ServiceMonitor. Service metrics appear in ~1–2 min.`,
  };
}

/**
 * Generate HTTP traffic to a service from in-app (via the kube API-server proxy)
 * so request-rate / latency metrics have something to show. No terminal needed.
 */
export async function sendServiceTraffic(
  envId: string,
  namespace: string,
  service = "sample-metrics-app",
  port = "8080",
  requests = 200,
): Promise<{ ok: boolean; sent: number; message: string }> {
  const raw = `/api/v1/namespaces/${namespace}/services/${service}:${port}/proxy/`;
  let sent = 0;
  // Fire in small concurrent batches so it finishes quickly without spawning 60
  // kubectl processes at once.
  const batch = 10;
  for (let i = 0; i < requests; i += batch) {
    const n = Math.min(batch, requests - i);
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        runWithKubeconfig(envId, "kubectl", ["get", "--raw", raw], 10_000),
      ),
    );
    sent += results.filter((r) => r.ok && r.exitCode === 0).length;
  }
  if (sent === 0)
    return {
      ok: false,
      sent,
      message: `Couldn't reach ${service}:${port} in "${namespace}". Is it running?`,
    };
  return {
    ok: true,
    sent,
    message: `Sent ${sent} requests to ${service}. Request-rate metrics update within ~30s.`,
  };
}

export type AppHealth = {
  name: string;
  kind: "Deployment" | "StatefulSet";
  desired: number;
  ready: number;
  status: "available" | "degraded" | "down";
};

/**
 * Plain-language "is my app up?" for a namespace — based on workload readiness
 * (works for ANY app, even ones without /metrics). No PromQL; the non-DevOps
 * view just sees Available / Degraded / Down per app.
 */
export async function appHealth(
  envId: string,
  namespace: string,
): Promise<{ ok: true; apps: AppHealth[] } | { ok: false; error: string }> {
  const tmpl =
    "{range .items[*]}{.metadata.name}{'~'}{.spec.replicas}{'~'}{.status.readyReplicas}{';'}{end}";
  const out: AppHealth[] = [];
  for (const kind of ["deployments", "statefulsets"] as const) {
    const res = await runWithKubeconfig(
      envId,
      "kubectl",
      ["get", kind, "-n", namespace, "-o", `jsonpath=${tmpl}`],
      20_000,
    );
    if (!res.ok) return { ok: false, error: res.error };
    if (res.exitCode !== 0) {
      if (/forbidden|not found/i.test(res.stderr)) continue;
      return { ok: false, error: (res.stderr.trim() || "list workloads failed").slice(-300) };
    }
    for (const rec of res.stdout
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [name = "", desiredStr = "0", readyStr = "0"] = rec.split("~");
      const desired = Number(desiredStr) || 0;
      const ready = Number(readyStr) || 0;
      const status: AppHealth["status"] =
        ready === 0 ? "down" : ready < desired ? "degraded" : "available";
      out.push({
        name,
        kind: kind === "deployments" ? "Deployment" : "StatefulSet",
        desired,
        ready,
        status,
      });
    }
  }
  return { ok: true, apps: out };
}

export type ScrapeCandidate = {
  kind: "ServiceMonitor" | "PodMonitor";
  target: string;
  selectorKey: string;
  selectorValue: string;
  port: string;
  path: string;
  hint: string;
};

/** Does this response body look like Prometheus exposition format? */
function looksLikeMetrics(body: string): boolean {
  return (
    /(^|\n)#\s*(HELP|TYPE)\s/.test(body) ||
    /(^|\n)[a-zA-Z_:][\w:]*(\{[^}]*\})?\s+[-+0-9.eE]+/.test(body)
  );
}

/** Probe a service/pod port for a real /metrics endpoint via the API-server proxy. */
async function probeMetrics(
  envId: string,
  kindPath: "services" | "pods",
  namespace: string,
  name: string,
  port: string,
  path: string,
): Promise<boolean> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const raw = `/api/v1/namespaces/${namespace}/${kindPath}/${name}:${port}/proxy${p}`;
  const res = await runWithKubeconfig(envId, "kubectl", ["get", "--raw", raw], 8_000);
  return res.ok && res.exitCode === 0 && looksLikeMetrics(res.stdout);
}

type PortRef = { name: string; num: string };
function parsePorts(csv: string): PortRef[] {
  return csv
    .split(",")
    .filter(Boolean)
    .map((p) => {
      const [name, num] = p.split(":");
      return { name, num };
    });
}
function pickSelector(appLabel: string, k8sName: string) {
  return appLabel
    ? { key: "app", value: appLabel }
    : k8sName
      ? { key: "app.kubernetes.io/name", value: k8sName }
      : null;
}

/**
 * Adaptive detection: PROBE the namespace's Services and Pods to find which
 * ports actually return Prometheus metrics — using whatever labels/ports the
 * app already has. No YAML changes, no reliance on naming conventions. Services
 * → ServiceMonitor candidates; bare pods (no Service) → PodMonitor candidates.
 */
export async function detectScrapeCandidates(
  envId: string,
  namespace: string,
): Promise<{ ok: true; candidates: ScrapeCandidate[] } | { ok: false; error: string }> {
  const candidates: ScrapeCandidate[] = [];
  const covered = new Set<string>();

  // ---- Services → ServiceMonitor -----------------------------------------
  const svcTmpl =
    "{range .items[*]}{.metadata.name}{'~'}{.metadata.labels['app']}{'~'}{.metadata.labels['app.kubernetes.io/name']}{'~'}" +
    "{range .spec.ports[*]}{.name}:{.port}{','}{end}{'~'}{.metadata.annotations['prometheus.io/port']}{'~'}{.metadata.annotations['prometheus.io/path']}{';'}{end}";
  const svc = await runWithKubeconfig(
    envId,
    "kubectl",
    ["get", "services", "-n", namespace, "-o", `jsonpath=${svcTmpl}`],
    20_000,
  );
  if (!svc.ok) return { ok: false, error: svc.error };
  if (svc.exitCode === 0) {
    for (const rec of svc.stdout
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 15)) {
      const [name = "", appLabel = "", k8sName = "", portsCsv = "", promPort = "", promPath = ""] =
        rec.split("~");
      const ports = parsePorts(portsCsv);
      const selector = pickSelector(appLabel, k8sName);
      if (!selector || !ports.length) continue;
      const path = promPath || "/metrics";
      const tryPorts = [promPort, ...ports.map((p) => p.num)].filter(Boolean).slice(0, 4);
      for (const tp of tryPorts) {
        if (await probeMetrics(envId, "services", namespace, name, tp, path)) {
          const named = ports.find((p) => p.num === tp && p.name);
          candidates.push({
            kind: "ServiceMonitor",
            target: name,
            selectorKey: selector.key,
            selectorValue: selector.value,
            port: named?.name || tp,
            path,
            hint: "verified /metrics ✓",
          });
          covered.add(`${selector.key}=${selector.value}`);
          break;
        }
      }
    }
  }

  // ---- Bare pods (no Service) → PodMonitor -------------------------------
  const podTmpl =
    "{range .items[*]}{.metadata.name}{'~'}{.metadata.labels['app']}{'~'}{.metadata.labels['app.kubernetes.io/name']}{'~'}" +
    "{range .spec.containers[*].ports[*]}{.name}:{.containerPort}{','}{end}{'~'}{.metadata.annotations['prometheus.io/port']}{'~'}{.metadata.annotations['prometheus.io/path']}{';'}{end}";
  const pods = await runWithKubeconfig(
    envId,
    "kubectl",
    ["get", "pods", "-n", namespace, "-o", `jsonpath=${podTmpl}`],
    20_000,
  );
  if (pods.ok && pods.exitCode === 0) {
    const seen = new Set(covered);
    for (const rec of pods.stdout
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (seen.size > 25) break;
      const [name = "", appLabel = "", k8sName = "", portsCsv = "", promPort = "", promPath = ""] =
        rec.split("~");
      const ports = parsePorts(portsCsv);
      const selector = pickSelector(appLabel, k8sName);
      if (!selector || !ports.length) continue;
      const dedupe = `${selector.key}=${selector.value}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const path = promPath || "/metrics";
      const tryPorts = [promPort, ...ports.map((p) => p.num)].filter(Boolean).slice(0, 4);
      for (const tp of tryPorts) {
        if (await probeMetrics(envId, "pods", namespace, name, tp, path)) {
          const named = ports.find((p) => p.num === tp && p.name);
          candidates.push({
            kind: "PodMonitor",
            target: `${selector.value} (pods)`,
            selectorKey: selector.key,
            selectorValue: selector.value,
            port: named?.name || tp,
            path,
            hint: "verified /metrics ✓ (no Service)",
          });
          break;
        }
      }
    }
  }

  return { ok: true, candidates };
}

export type MonitoringStatus = {
  installed: boolean;
  ready: number;
  total: number;
  prometheusReady: boolean;
  grafanaReady: boolean;
  loggingReady: boolean;
  note?: string;
};

/** Check whether the monitoring stack exists and how many pods are ready. */
export async function monitoringStatus(envId: string): Promise<MonitoringStatus> {
  // Use a compact jsonpath projection, NOT `-o json`: full pod JSON for the
  // stack is well over runStage's 32KB stdout cap, which truncates it to invalid
  // JSON and made us wrongly report "not installed". This emits one tiny record
  // per pod: `name=ready,ready,;name=ready,;…`.
  const tmpl =
    '{range .items[*]}{.metadata.name}{"="}{range .status.containerStatuses[*]}{.ready}{","}{end}{";"}{end}';
  const res = await runWithKubeconfig(
    envId,
    "kubectl",
    ["get", "pods", "-n", NS, "-o", `jsonpath=${tmpl}`],
    20_000,
  );
  if (!res.ok)
    return {
      installed: false,
      ready: 0,
      total: 0,
      prometheusReady: false,
      grafanaReady: false,
      loggingReady: false,
      note: res.error,
    };
  if (res.exitCode !== 0) {
    // Namespace missing = not installed (not an error to surface loudly).
    return {
      installed: false,
      ready: 0,
      total: 0,
      prometheusReady: false,
      grafanaReady: false,
      loggingReady: false,
    };
  }

  const records = res.stdout
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const pods = records.map((rec) => {
    const eq = rec.indexOf("=");
    const name = eq >= 0 ? rec.slice(0, eq) : rec;
    const readies = (eq >= 0 ? rec.slice(eq + 1) : "").split(",").filter(Boolean);
    const ready = readies.length > 0 && readies.every((r) => r === "true");
    return { name, ready };
  });

  const ready = pods.filter((p) => p.ready).length;
  const prometheusReady = pods.some(
    (p) => p.name.includes("prometheus-monitoring-kube-prometheus") && p.ready,
  );
  const grafanaReady = pods.some((p) => p.name.includes("grafana") && p.ready);
  const loggingReady = pods.some(
    (p) => p.name.includes("loki") && !p.name.includes("promtail") && p.ready,
  );
  return {
    installed: pods.length > 0,
    ready,
    total: pods.length,
    prometheusReady,
    grafanaReady,
    loggingReady,
  };
}

export type PromSample = {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
};
export type ClusterPromResult =
  { ok: true; resultType: string; result: PromSample[] } | { ok: false; error: string };

/** Query the in-cluster Prometheus via the kube API-server proxy (no exposed URL). */
export async function queryClusterPrometheus(
  envId: string,
  query: string,
  opts?: { range?: boolean; nowSec?: number; minutes?: number; step?: number },
): Promise<ClusterPromResult> {
  let promPath: string;
  if (opts?.range) {
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const start = now - (opts.minutes ?? 60) * 60;
    promPath = `/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${now}&step=${opts.step ?? 60}`;
  } else {
    promPath = `/api/v1/query?query=${encodeURIComponent(query)}`;
  }
  const rawPath = `/api/v1/namespaces/${NS}/services/${PROM_SVC}:${PROM_PORT}/proxy${promPath}`;

  const res = await runWithKubeconfig(envId, "kubectl", ["get", "--raw", rawPath], 20_000);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.exitCode !== 0) {
    const stderr = res.stderr.toLowerCase();
    if (stderr.includes("not found") || stderr.includes("could not find")) {
      return {
        ok: false,
        error: "Monitoring isn't installed in this cluster yet — click “Install monitoring”.",
      };
    }
    return { ok: false, error: res.stderr.slice(-300) || "Prometheus proxy query failed." };
  }
  try {
    const body = JSON.parse(res.stdout) as {
      status?: string;
      error?: string;
      data?: { resultType?: string; result?: PromSample[] };
    };
    if (body.status !== "success")
      return { ok: false, error: body.error || "Prometheus returned an error." };
    return {
      ok: true,
      resultType: body.data?.resultType ?? "vector",
      result: body.data?.result ?? [],
    };
  } catch {
    return { ok: false, error: "Prometheus returned non-JSON output." };
  }
}
