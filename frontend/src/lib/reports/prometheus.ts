/**
 * Query an in-cluster Prometheus from the server.
 *
 * Prometheus installed by this app's monitoring flow is a ClusterIP Service —
 * deliberately not exposed publicly, so there is no URL to call from here.
 * `kubectl` is the only reachable path, and rather than port-forwarding (which
 * needs a long-lived child process, a free local port, and cleanup on every
 * error path) we use the API server's **service proxy**:
 *
 *     kubectl get --raw /api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/...
 *
 * One request, no background process, no port allocation, and it inherits the
 * kubeconfig's auth. The API server does the hop into the cluster network.
 */
import { runStage } from "@/lib/runner/exec";

/** Where the monitoring stack puts Prometheus, newest chart layout first. */
const CANDIDATES: Array<{ namespace: string; service: string; port: string }> = [
  { namespace: "monitoring", service: "prometheus-operated", port: "9090" },
  { namespace: "monitoring", service: "kube-prometheus-stack-prometheus", port: "9090" },
  { namespace: "monitoring", service: "prometheus-server", port: "80" },
  { namespace: "prometheus", service: "prometheus-server", port: "80" },
  { namespace: "default", service: "prometheus-server", port: "80" },
];

export type PromSample = { metric: Record<string, string>; value: number };

type PromResponse = {
  status?: string;
  data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
  error?: string;
};

/**
 * Locate Prometheus in the cluster. Returns null when the monitoring stack
 * isn't installed — the caller degrades to a metrics-free report rather than
 * failing, since plenty of clusters have no Prometheus and their report is
 * still worth sending.
 */
export async function findPrometheus(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
}): Promise<{ namespace: string; service: string; port: string } | null> {
  const env = { ...args.execEnv, KUBECONFIG: args.kubeconfigPath };
  for (const c of CANDIDATES) {
    const res = await runStage({
      command: "kubectl",
      args: ["get", "svc", c.service, "-n", c.namespace, "-o", "name"],
      cwd: process.cwd(),
      env,
      timeoutMs: 20_000,
    });
    if (res.exitCode === 0 && res.stdout.trim()) return c;
  }
  return null;
}

/** Run one instant PromQL query. Returns [] on any failure — never throws. */
export async function promQuery(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  prom: { namespace: string; service: string; port: string };
  query: string;
}): Promise<PromSample[]> {
  const { kubeconfigPath, execEnv, prom, query } = args;
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };
  const path =
    `/api/v1/namespaces/${prom.namespace}/services/${prom.service}:${prom.port}/proxy` +
    `/api/v1/query?query=${encodeURIComponent(query)}`;

  const res = await runStage({
    command: "kubectl",
    args: ["get", "--raw", path],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.exitCode !== 0) return [];

  try {
    const json = JSON.parse(res.stdout) as PromResponse;
    if (json.status !== "success") return [];
    return (json.data?.result ?? [])
      .map((r) => ({
        metric: r.metric ?? {},
        value: Number(r.value?.[1] ?? NaN),
      }))
      .filter((s) => Number.isFinite(s.value));
  } catch {
    return [];
  }
}

export type AppMetrics = {
  /** Mean CPU cores used over the window. */
  cpuCores: number | null;
  /** Mean working-set memory in MiB. */
  memoryMiB: number | null;
  /** Requests/sec, when the app exposes HTTP metrics. */
  requestRate: number | null;
  /** Fraction of requests returning 5xx, 0-1. */
  errorRate: number | null;
  /** 95th percentile latency in seconds. */
  p95Seconds: number | null;
  /** True when Prometheus had data for at least one of the above. */
  hasData: boolean;
};

/**
 * Per-app metrics over a window (default 24h, matching a daily report).
 *
 * Container CPU/memory come from cAdvisor, which every kube-prometheus stack
 * scrapes — those are reliable. HTTP rate/error/latency come from the APP's
 * own `/metrics`, which only exists if it's instrumented and has a
 * ServiceMonitor (deploy_my_app emits one when the CRD is present). Missing
 * HTTP metrics is normal, not an error, so each is independently nullable
 * rather than the whole result failing.
 */
export async function appMetrics(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  prom: { namespace: string; service: string; port: string };
  namespace: string;
  app: string;
  windowHours?: number;
}): Promise<AppMetrics> {
  const { kubeconfigPath, execEnv, prom, namespace, app } = args;
  const w = `${args.windowHours ?? 24}h`;
  const q = (query: string) => promQuery({ kubeconfigPath, execEnv, prom, query });

  // Pod names are `<deployment>-<replicaset-hash>-<pod-hash>`, so match on the
  // deployment prefix rather than an exact label — cAdvisor metrics carry the
  // pod name, not the Deployment name.
  const podMatch = `namespace="${namespace}",pod=~"${app}-.*"`;

  const [cpu, mem, reqs, errs, p95] = await Promise.all([
    q(`sum(rate(container_cpu_usage_seconds_total{${podMatch},container!="",container!="POD"}[${w}]))`),
    q(`sum(avg_over_time(container_memory_working_set_bytes{${podMatch},container!="",container!="POD"}[${w}]))`),
    q(`sum(rate(http_requests_total{${podMatch}}[${w}]))`),
    q(`sum(rate(http_requests_total{${podMatch},status=~"5.."}[${w}]))`),
    q(`histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{${podMatch}}[${w}])) by (le))`),
  ]);

  const first = (s: PromSample[]) => (s.length > 0 ? s[0].value : null);
  const cpuCores = first(cpu);
  const memBytes = first(mem);
  const requestRate = first(reqs);
  const errCount = first(errs);
  const p95Seconds = first(p95);

  return {
    cpuCores,
    memoryMiB: memBytes === null ? null : memBytes / (1024 * 1024),
    requestRate,
    // Guard the divide: a zero request rate would otherwise yield NaN/Infinity
    // and render as "NaN%" in the email.
    errorRate:
      errCount === null || requestRate === null || requestRate === 0 ? null : errCount / requestRate,
    p95Seconds,
    hasData: [cpuCores, memBytes, requestRate, p95Seconds].some((v) => v !== null),
  };
}
