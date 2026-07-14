/**
 * In-app Prometheus querying. Runs PromQL against the project's connected
 * Prometheus (stored as an integration: credentials.endpoint + optional
 * bearer_token) so metrics render natively in the app — the user never opens a
 * separate Prometheus UI. Instant and range (time-series) queries supported.
 */
import { getIntegrationCredentials } from "@/lib/integrations/integrations";

export type PromSample = {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
};
export type PromQueryResult =
  | { ok: true; resultType: string; result: PromSample[]; endpoint: string }
  | { ok: false; error: string };

async function promEndpoint(
  projectId: string,
): Promise<{ endpoint: string; headers: Record<string, string> } | { error: string }> {
  const creds = await getIntegrationCredentials(projectId, "prometheus");
  if (!creds)
    return {
      error: "No Prometheus is connected to this project. Connect one on the Observability page.",
    };
  const endpoint = creds.credentials.endpoint?.replace(/\/$/, "") ?? "";
  if (!endpoint) return { error: "The Prometheus integration has no endpoint configured." };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (creds.credentials.bearer_token)
    headers.Authorization = `Bearer ${creds.credentials.bearer_token}`;
  return { endpoint, headers };
}

async function promFetch(url: string, headers: Record<string, string>): Promise<PromQueryResult> {
  let res: Response;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    res = await fetch(url, { headers, cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
  } catch (e) {
    return {
      ok: false,
      error: `Couldn't reach Prometheus: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
  const body = (await res.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
    data?: { resultType?: string; result?: PromSample[] };
  };
  if (!res.ok || body.status !== "success") {
    return { ok: false, error: body.error || `Prometheus returned ${res.status}` };
  }
  return {
    ok: true,
    resultType: body.data?.resultType ?? "vector",
    result: body.data?.result ?? [],
    endpoint: "",
  };
}

/** Instant PromQL query — a single value per series (the "now" snapshot). */
export async function queryPrometheusInstant(
  projectId: string,
  query: string,
): Promise<PromQueryResult> {
  const ep = await promEndpoint(projectId);
  if ("error" in ep) return { ok: false, error: ep.error };
  const url = `${ep.endpoint}/api/v1/query?query=${encodeURIComponent(query)}`;
  const r = await promFetch(url, ep.headers);
  return r.ok ? { ...r, endpoint: ep.endpoint } : r;
}

/** Range PromQL query — a time series over the last `minutes` at `stepSec`. */
export async function queryPrometheusRange(
  projectId: string,
  query: string,
  nowSec: number,
  minutes = 60,
  stepSec = 30,
): Promise<PromQueryResult> {
  const ep = await promEndpoint(projectId);
  if ("error" in ep) return { ok: false, error: ep.error };
  const start = nowSec - minutes * 60;
  const url =
    `${ep.endpoint}/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${start}&end=${nowSec}&step=${stepSec}`;
  const r = await promFetch(url, ep.headers);
  return r.ok ? { ...r, endpoint: ep.endpoint } : r;
}

/** Curated PromQL for the default in-app dashboard (kube-prometheus-stack metrics). */
export const PROM_PRESETS: { key: string; label: string; query: string; unit: string }[] = [
  {
    key: "cpu",
    label: "Cluster CPU cores used",
    unit: "cores",
    query: `sum(rate(container_cpu_usage_seconds_total{container!=""}[5m]))`,
  },
  {
    key: "mem",
    label: "Cluster memory used",
    unit: "bytes",
    query: `sum(container_memory_working_set_bytes{container!=""})`,
  },
  {
    key: "pods",
    label: "Running pods",
    unit: "count",
    query: `count(kube_pod_status_phase{phase="Running"} == 1)`,
  },
  {
    key: "restarts",
    label: "Pod restarts (1h)",
    unit: "count",
    query: `sum(increase(kube_pod_container_status_restarts_total[1h]))`,
  },
  {
    key: "nodes",
    label: "Ready nodes",
    unit: "count",
    query: `count(kube_node_status_condition{condition="Ready",status="true"} == 1)`,
  },
];
