"use client";

/**
 * Live Prometheus metrics, rendered natively in the app — the user never opens
 * a separate Prometheus UI. Each preset PromQL is fetched as a range series and
 * shown as a current value + sparkline. A free-form PromQL box runs ad-hoc
 * instant queries. Backed by /observability/prometheus/query.
 */
import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Block, Btn, Input, Spark } from "@/components/ui";
import { api } from "@/lib/api/client";

type PromSample = {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
};
type PromResult =
  { ok: true; resultType: string; result: PromSample[] } | { ok: false; message?: string };

export type MetricPreset = {
  key: string;
  label: string;
  unit: string;
  scale?: number;
  query: string;
};
export type QueryPreset = { label: string; query: string; unit?: string };

const PRESETS: MetricPreset[] = [
  {
    key: "cpu",
    label: "CPU cores used",
    unit: "cores",
    query: `sum(rate(container_cpu_usage_seconds_total{container!=""}[5m]))`,
  },
  {
    key: "mem",
    label: "Memory used (GiB)",
    unit: "GiB",
    scale: 1 / 1024 ** 3,
    query: `sum(container_memory_working_set_bytes{container!=""})`,
  },
  {
    key: "pods",
    label: "Running pods",
    unit: "",
    query: `count(kube_pod_status_phase{phase="Running"} == 1)`,
  },
  {
    key: "restarts",
    label: "Pod restarts (1h)",
    unit: "",
    query: `sum(increase(kube_pod_container_status_restarts_total[1h]))`,
  },
  {
    key: "nodes",
    label: "Ready nodes",
    unit: "",
    query: `count(kube_node_status_condition{condition="Ready",status="true"} == 1)`,
  },
];

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

export function PrometheusMetricsPanel({
  slug,
  connected,
  queryPath = `/projects/${slug}/observability/prometheus/query`,
  source = "connected Prometheus",
  presets = PRESETS,
  title = "Cluster metrics",
  showQueryBox = true,
  queryPresets = [],
}: {
  slug: string;
  connected: boolean;
  /** Endpoint that runs PromQL. Defaults to Model-A; pass the env's in-cluster route for Model B. */
  queryPath?: string;
  /** Human label for where the metrics come from (shown in subtitles). */
  source?: string;
  /** Metric cards to render. Defaults to cluster-wide; pass app-scoped presets for one application. */
  presets?: MetricPreset[];
  /** Heading for the metrics block. */
  title?: string;
  /** Show the ad-hoc PromQL box under the cards. Hide it when stacking panels. */
  showQueryBox?: boolean;
  /** Plain-language clickable queries for the box (non-DevOps friendly). */
  queryPresets?: QueryPreset[];
}) {
  const results = useQueries({
    queries: presets.map((p) => ({
      queryKey: ["p", queryPath, "prom", p.key],
      queryFn: () =>
        api.post<PromResult>(queryPath, { query: p.query, type: "range", minutes: 60, step: 60 }),
      enabled: connected,
      refetchInterval: 30_000,
      staleTime: 25_000,
    })),
  });

  if (!connected) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub="Connect a Prometheus endpoint on this tab to see live metrics here.">
            Live metrics
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <span className="muted" style={{ fontSize: 13 }}>
            No Prometheus connected. Once connected, cluster CPU, memory, pods, restarts and node
            health render here automatically.
          </span>
        </Block.Body>
      </Block>
    );
  }

  return (
    <>
      <Block>
        <Block.Header>
          <Block.Title sub={`Live from your ${source} — refreshes every 30s.`}>{title}</Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="row gap-3 wrap">
            {presets.map((p, i) => {
              const r = results[i]?.data;
              const series = r?.ok ? (r.result[0]?.values ?? []) : [];
              const nums = series
                .map(([, v]) => Number(v) * (p.scale ?? 1))
                .filter((n) => Number.isFinite(n));
              const latest = nums.length ? nums[nums.length - 1] : NaN;
              const err = r && !r.ok ? (r.message ?? "query failed") : null;
              return (
                <div
                  key={p.key}
                  className="card card-pad col gap-1"
                  style={{ minWidth: 180, flex: "1 1 180px" }}
                >
                  <span className="faint" style={{ fontSize: 12 }}>
                    {p.label}
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 22 }}>
                    {err ? "—" : `${fmt(latest)}${p.unit ? ` ${p.unit}` : ""}`}
                  </span>
                  {nums.length > 1 && <Spark data={nums} width={160} height={32} />}
                  {err && (
                    <span style={{ color: "var(--danger, #e5484d)", fontSize: 11 }}>
                      {err.slice(0, 80)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Block.Body>
      </Block>
      {showQueryBox && <PromQueryBox queryPath={queryPath} queryPresets={queryPresets} />}
    </>
  );
}

/**
 * Clickable plain-language questions (non-DevOps) + an advanced PromQL box.
 * Click a question → runs its query → shows a clean single-number answer.
 */
function PromQueryBox({
  queryPath,
  queryPresets,
}: {
  queryPath: string;
  queryPresets: QueryPreset[];
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [active, setActive] = useState<QueryPreset | null>(null);
  const { data, isFetching } = useQuery<PromResult>({
    queryKey: ["p", queryPath, "prom-adhoc", submitted],
    queryFn: () => api.post<PromResult>(queryPath, { query: submitted, type: "instant" }),
    enabled: submitted.length > 0,
    staleTime: 10_000,
  });

  function runPreset(p: QueryPreset) {
    setActive(p);
    setQ(p.query);
    setSubmitted(p.query);
  }

  const scalar = data?.ok && data.result.length ? data.result[0]?.value?.[1] : undefined;
  const scalarNum = scalar !== undefined ? Number(scalar) : NaN;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Click a question to see the answer — no query writing needed.">
          Check your app
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3" style={{ maxWidth: 760 }}>
          {queryPresets.length > 0 && (
            <div className="row gap-2 wrap">
              {queryPresets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`chip ${active?.label === p.label ? "active" : ""}`}
                  onClick={() => runPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {/* Clean answer for a clicked question. */}
          {active && (
            <div className="card card-pad col gap-1" style={{ maxWidth: 320 }}>
              <span className="faint" style={{ fontSize: 12 }}>
                {active.label}
              </span>
              <span style={{ fontWeight: 700, fontSize: 26 }}>
                {isFetching
                  ? "…"
                  : data && !data.ok
                    ? "—"
                    : Number.isFinite(scalarNum)
                      ? `${fmt(scalarNum)}${active.unit ? ` ${active.unit}` : ""}`
                      : "No data"}
              </span>
            </div>
          )}

          {/* Raw series only for manual queries. */}
          {!active && data && !data.ok && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>
              ❌ {data.message ?? "query failed"}
            </span>
          )}
          {!active &&
            data &&
            data.ok &&
            (data.result.length === 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                No series returned.
              </span>
            ) : (
              <div className="col gap-1">
                {data.result.slice(0, 20).map((s, i) => (
                  <div key={i} className="row between" style={{ gap: 12, fontSize: 12.5 }}>
                    <span className="mono faint" style={{ overflowX: "auto" }}>
                      {Object.entries(s.metric)
                        .map(([k, v]) => `${k}="${v}"`)
                        .join(", ") || "(scalar)"}
                    </span>
                    <span style={{ fontWeight: 600 }}>{s.value ? s.value[1] : ""}</span>
                  </div>
                ))}
              </div>
            ))}

          {/* Advanced: raw PromQL for DevOps. */}
          <details>
            <summary className="faint" style={{ fontSize: 12, cursor: "pointer" }}>
              Advanced — write your own PromQL
            </summary>
            <div className="row gap-2" style={{ alignItems: "center", marginTop: 8 }}>
              <Input
                className="mono"
                value={q}
                placeholder={`sum(rate(container_cpu_usage_seconds_total[5m]))`}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && q.trim()) {
                    setActive(null);
                    setSubmitted(q.trim());
                  }
                }}
              />
              <Btn
                variant="primary"
                icon="send"
                loading={isFetching}
                disabled={!q.trim()}
                onClick={() => {
                  setActive(null);
                  setSubmitted(q.trim());
                }}
              >
                Run
              </Btn>
            </div>
          </details>
        </div>
      </Block.Body>
    </Block>
  );
}
