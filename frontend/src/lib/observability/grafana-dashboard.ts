/**
 * App-scoped Grafana dashboard generator.
 *
 * Produces a minimal, valid Grafana dashboard JSON whose panels are filtered to
 * a single application's namespace. Provisioned into the cluster as a labeled
 * ConfigMap (see cluster-monitoring.ts) so the Grafana sidecar auto-imports it.
 * Uses a datasource template variable so it binds to the stack's default
 * Prometheus without hardcoding a UID.
 */

type Panel = {
  id: number;
  title: string;
  type: string;
  gridPos: { h: number; w: number; x: number; y: number };
  fieldConfig: { defaults: { unit?: string }; overrides: [] };
  datasource: { type: "prometheus"; uid: string };
  targets: { expr: string; refId: string; datasource: { type: "prometheus"; uid: string } }[];
};

// kube-prometheus-stack provisions the Prometheus datasource with a fixed uid
// "prometheus" — reference it directly (a datasource template variable wouldn't
// auto-resolve and the panels would show "No data").
const DS = { type: "prometheus" as const, uid: "prometheus" };

function panel(id: number, title: string, expr: string, unit: string, x: number, y: number): Panel {
  return {
    id,
    title,
    type: "timeseries",
    gridPos: { h: 8, w: 12, x, y },
    fieldConfig: { defaults: { unit }, overrides: [] },
    datasource: DS,
    targets: [{ expr, refId: "A", datasource: DS }],
  };
}

/**
 * Dashboard scoped to a namespace via a `$namespace` template variable. The
 * default is the env's namespace, but the app passes ?var-namespace=<ns> in the
 * iframe URL to LOCK it to whatever namespace the user picks — that works even
 * in kiosk mode, so the embedded panels show that namespace's metrics + logs.
 */
export function appDashboard(namespace: string, uid: string): Record<string, unknown> {
  const ns = `namespace="$namespace"`;
  return {
    uid,
    title: `Application — $namespace`,
    tags: ["deepagent", "application"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    refresh: "30s",
    time: { from: "now-6h", to: "now" },
    templating: {
      list: [
        {
          name: "namespace",
          label: "Namespace",
          type: "query",
          datasource: { type: "prometheus", uid: "prometheus" },
          query: "label_values(kube_pod_info, namespace)",
          current: { text: namespace, value: namespace },
          refresh: 2,
          sort: 1,
          includeAll: false,
          multi: false,
        },
      ],
    },
    panels: [
      panel(1, "CPU cores", `sum(rate(container_cpu_usage_seconds_total{${ns},container!=""}[5m]))`, "none", 0, 0),
      panel(2, "Memory", `sum(container_memory_working_set_bytes{${ns},container!=""})`, "bytes", 12, 0),
      panel(3, "Container restarts (1h)", `sum(increase(kube_pod_container_status_restarts_total{${ns}}[1h]))`, "none", 0, 8),
      panel(4, "Replicas ready", `sum(kube_deployment_status_replicas_ready{${ns}})`, "none", 12, 8),
      // Logs panel — backed by Loki (uid "loki"), scoped to $namespace.
      logsPanel(5, 16),
    ],
  };
}

/** A Grafana "logs" panel querying Loki for the $namespace variable. */
function logsPanel(id: number, y: number): Record<string, unknown> {
  const ds = { type: "loki", uid: "loki" };
  return {
    id,
    title: `Logs — $namespace`,
    type: "logs",
    gridPos: { h: 12, w: 24, x: 0, y },
    datasource: ds,
    targets: [{ refId: "A", datasource: ds, expr: `{namespace="$namespace"}`, queryType: "range" }],
    options: {
      showTime: true,
      wrapLogMessage: true,
      prettifyLogMessage: false,
      enableLogDetails: true,
      dedupStrategy: "none",
      sortOrder: "Descending",
    },
  };
}
