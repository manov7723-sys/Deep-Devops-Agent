"use client";

/**
 * Model B — in-cluster monitoring, fully managed by the app.
 *
 * The user clicks "Install monitoring" and the app deploys kube-prometheus-stack
 * (Prometheus + Grafana + exporters) INTO the selected environment's cluster via
 * Helm. Nothing runs outside the app, nothing is exposed publicly. Metrics are
 * read back through the Kubernetes API-server proxy and rendered natively here.
 *
 * Targets the project's REAL environments (from /projects/[slug]/envs), not the
 * cosmetic Alpha/Beta/Release filter pills — those keys may not exist here.
 *
 * Backed by:
 *   GET  /projects/[slug]/envs/[key]/monitoring/status
 *   POST /projects/[slug]/envs/[key]/monitoring/install
 *   POST /projects/[slug]/envs/[key]/monitoring/query   (used by the metrics panel)
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Block, Btn, Field, Input, Select, StatusDot } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";
import { PrometheusMetricsPanel, type MetricPreset, type QueryPreset } from "@/components/domain/PrometheusMetricsPanel";
import { AppMetricsScrapeForm } from "@/components/domain/AppMetricsScrapeForm";
import { AppHealthPanel } from "@/components/domain/AppHealthPanel";
import type { EnvFilterValue } from "@/components/domain/EnvFilter";

type Status = {
  ok: boolean;
  installed: boolean;
  ready: number;
  total: number;
  prometheusReady: boolean;
  grafanaReady: boolean;
  loggingReady?: boolean;
  namespace?: string;
  grafanaUid?: string;
  installing?: boolean;
  installStep?: string;
  installError?: string;
  note?: string;
};

/**
 * PromQL scoped to ONE application: filtered to the app's namespace, and
 * optionally to a single workload (Deployment/Helm release) by pod-name prefix.
 * Each project is a single app, so the default (namespace-only) IS that app.
 */
function appPresets(namespace: string, workload: string): MetricPreset[] {
  const ns = `namespace="${namespace}"`;
  const pod = workload ? `,pod=~"${workload}-.*"` : "";
  const dep = workload ? `${ns},deployment="${workload}"` : ns;
  return [
    { key: "cpu", label: "CPU cores", unit: "cores", query: `sum(rate(container_cpu_usage_seconds_total{${ns}${pod},container!=""}[5m]))` },
    { key: "mem", label: "Memory (GiB)", unit: "GiB", scale: 1 / 1024 ** 3, query: `sum(container_memory_working_set_bytes{${ns}${pod},container!=""})` },
    { key: "pods", label: "Running pods", unit: "", query: `count(kube_pod_status_phase{${ns}${pod},phase="Running"} == 1)` },
    { key: "ready", label: "Replicas ready", unit: "", query: `sum(kube_deployment_status_replicas_ready{${dep}})` },
    { key: "restarts", label: "Restarts (1h)", unit: "", query: `sum(increase(kube_pod_container_status_restarts_total{${ns}${pod}}[1h]))` },
  ];
}

/** Plain-language clickable questions for the query box, scoped to a namespace. */
function friendlyQueries(namespace: string): QueryPreset[] {
  const ns = `namespace="${namespace}"`;
  return [
    { label: "Running pods", query: `count(kube_pod_status_phase{${ns},phase="Running"})`, unit: "pods" },
    { label: "Pod restarts (1h)", query: `sum(increase(kube_pod_container_status_restarts_total{${ns}}[1h]))` },
    { label: "CPU used", query: `sum(rate(container_cpu_usage_seconds_total{${ns},container!=""}[5m]))`, unit: "cores" },
    { label: "Memory used", query: `sum(container_memory_working_set_bytes{${ns},container!=""}) / 1024^2`, unit: "MiB" },
    { label: "Total requests (so far)", query: `sum(http_requests_total{${ns}})`, unit: "requests" },
    { label: "Request rate", query: `sum(rate(http_requests_total{${ns}}[5m]))`, unit: "req/s" },
    { label: "Error rate (5xx)", query: `sum(rate(http_requests_total{${ns},status=~"5.."}[5m]))`, unit: "req/s" },
    { label: "p95 latency", query: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{${ns}}[5m])) by (le))`, unit: "s" },
    { label: "Apps being monitored", query: `count(up{${ns}} == 1)` },
  ];
}

/**
 * SERVICE-level metrics — the app's OWN /metrics (scraped via a ServiceMonitor/
 * PodMonitor), using the standard names most Prometheus client libraries expose.
 * `up` and `process_*` exist on any scraped target; the HTTP ones appear if the
 * app instruments them. Anything missing shows "—" (use Query Prometheus for
 * custom names).
 */
function servicePresets(namespace: string): MetricPreset[] {
  const ns = `namespace="${namespace}"`;
  return [
    { key: "up", label: "Targets up", unit: "", query: `sum(up{${ns}})` },
    { key: "req", label: "Request rate (req/s)", unit: "/s", query: `sum(rate(http_requests_total{${ns}}[5m]))` },
    { key: "err", label: "5xx errors (req/s)", unit: "/s", query: `sum(rate(http_requests_total{${ns},status=~"5.."}[5m]))` },
    { key: "p95", label: "p95 latency (s)", unit: "s", query: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{${ns}}[5m])) by (le))` },
    { key: "appcpu", label: "App CPU (cores)", unit: "cores", query: `sum(rate(process_cpu_seconds_total{${ns}}[5m]))` },
    { key: "appmem", label: "App memory (MiB)", unit: "MiB", scale: 1 / 1024 ** 2, query: `sum(process_resident_memory_bytes{${ns}})` },
  ];
}

export function ClusterMonitoringPanel({ slug, env }: { slug: string; env: EnvFilterValue }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [workload, setWorkload] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // The namespace the user has "locked" monitoring to (persists in localStorage
  // so the embedded Grafana + native metrics stay scoped to it across refreshes).
  const [lockedNs, setLockedNs] = useState<string>("");

  const { data: envs, isLoading: envsLoading } = useProjectEnvs(slug);
  const envList = useMemo(() => envs ?? [], [envs]);

  // Which real env to act on: honour the picker, else the URL filter if it maps
  // to a real env, else the first env that has a cluster wired, else the first.
  const activeKey = useMemo(() => {
    if (picked && envList.some((e) => e.key === picked)) return picked;
    if (env !== "all" && envList.some((e) => e.key === env)) return env;
    return envList.find((e) => e.hasKubeconfig)?.key ?? envList[0]?.key ?? null;
  }, [picked, env, envList]);
  const activeEnv = envList.find((e) => e.key === activeKey) ?? null;

  const statusKey = ["p", slug, "cluster-monitoring", activeKey];
  const { data: status, isLoading } = useQuery<Status>({
    queryKey: statusKey,
    queryFn: () => api.get<Status>(`/projects/${slug}/envs/${activeKey}/monitoring/status`),
    enabled: !!activeKey && !!activeEnv?.hasKubeconfig,
    // While installing or provisioning, poll faster so the UI advances on its own.
    refetchInterval: (q) => {
      const s = q.state.data as Status | undefined;
      if (s?.installing) return 5_000;
      if (s && s.installed && !(s.prometheusReady && s.grafanaReady)) return 10_000;
      return 30_000;
    },
  });

  const install = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message?: string }>(`/projects/${slug}/envs/${activeKey}/monitoring/install`, {}),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      if (!res.ok) setError((res as { message?: string }).message ?? "Install failed.");
      qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: unknown) => setError(apiErrorMessage(e, "Install failed.")),
  });

  // Load/persist the locked namespace per env (all hooks must precede any early
  // return — Rules of Hooks).
  const nsStorageKey = `dda-mon-ns-${slug}-${activeKey}`;
  useEffect(() => {
    if (typeof window === "undefined" || !activeKey) return;
    setLockedNs(window.localStorage.getItem(nsStorageKey) ?? "");
  }, [nsStorageKey, activeKey]);

  // Namespaces in the cluster (to pick which one to lock monitoring to).
  const nsQ = useQuery<{ ok: boolean; namespaces?: string[] }>({
    queryKey: ["p", slug, "mon-ns", activeKey],
    queryFn: () => api.get(`/projects/${slug}/envs/${activeKey}/logs/namespaces`),
    enabled: !!activeKey && !!activeEnv?.hasKubeconfig && !!status?.prometheusReady && !!status?.grafanaReady,
    staleTime: 60_000,
  });

  function lockNamespace(ns: string) {
    setLockedNs(ns);
    if (typeof window !== "undefined") window.localStorage.setItem(nsStorageKey, ns);
  }

  // ---- early states -------------------------------------------------------
  if (envsLoading) {
    return (
      <Block>
        <Block.Loading />
      </Block>
    );
  }
  if (envList.length === 0) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub="The app installs and runs Prometheus + Grafana inside your cluster — you run nothing.">
            In-cluster monitoring
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <span className="muted" style={{ fontSize: 13 }}>
            This project has no environments yet. Create an environment and connect its cluster, then come back to install
            monitoring.
          </span>
        </Block.Body>
      </Block>
    );
  }

  const ready = !!status && status.prometheusReady && status.grafanaReady;
  const installing = !!status?.installing || install.isPending;
  const provisioning = !!status && status.installed && !ready && !installing;
  const queryPath = `/projects/${slug}/envs/${activeKey}/monitoring/query`;

  // Effective namespace: the locked one, else the env's, else default.
  const namespace = lockedNs || status?.namespace || activeEnv?.namespace || "default";
  // Absolute path to the in-app Grafana reverse proxy (trailing slash matters).
  const grafanaBase = `/api/v1/projects/${slug}/envs/${activeKey}/monitoring/grafana/`;
  const noKubeconfig = !!activeEnv && !activeEnv.hasKubeconfig;

  return (
    <div className="col gap-4">
      <Block>
        <Block.Header>
          <Block.Title sub="kube-prometheus-stack runs inside this environment's cluster — installed and queried entirely by the app.">
            In-cluster monitoring
          </Block.Title>
          <Block.Actions>
            <StatusDot
              tone={ready ? "ok" : installing || provisioning ? "warn" : "danger"}
              label={
                noKubeconfig
                  ? "no cluster"
                  : isLoading
                    ? "checking…"
                    : ready
                      ? "live"
                      : installing
                        ? "installing…"
                        : provisioning
                          ? `provisioning ${status!.ready}/${status!.total}`
                          : "not installed"
              }
            />
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            {/* Environment picker — the project's REAL envs. */}
            {envList.length > 1 && (
              <div className="row gap-2 wrap" role="radiogroup" aria-label="Environment">
                {envList.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    role="radio"
                    aria-checked={e.key === activeKey}
                    onClick={() => setPicked(e.key)}
                    className={`chip ${e.key === activeKey ? "active" : ""}`}
                    title={e.hasKubeconfig ? "Cluster connected" : "No cluster connected"}
                  >
                    {e.name}
                    {!e.hasKubeconfig && <span className="faint" style={{ fontSize: 11 }}> · no cluster</span>}
                  </button>
                ))}
              </div>
            )}

            {noKubeconfig ? (
              <span className="muted" style={{ fontSize: 13 }}>
                <b>{activeEnv?.name}</b> has no cluster connected yet. Connect its cluster on the Connection tab first, then
                install monitoring here.
              </span>
            ) : (
              <>
                {!status?.installed && !installing && !isLoading && (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Click below and the app deploys Prometheus + Grafana + Loki (logs) into <b>{activeEnv?.name}</b>&apos;s
                    cluster via Helm, and auto-provisions a dashboard (metrics + logs) scoped to this application. It runs as
                    pods in your cluster (not on our servers, not exposed publicly) and is shown in-app through the cluster
                    connection. Pods come up over ~2–5 minutes.
                  </span>
                )}
                {installing && (
                  <div className="col gap-1">
                    <span style={{ fontSize: 13 }}>⏳ {status?.installStep ?? "Installing…"}</span>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      Installing Prometheus + Grafana into <b>{activeEnv?.name}</b>&apos;s cluster via Helm — this can take a few
                      minutes (longer if a previous attempt has to be cleaned up first). You can leave this page; it keeps
                      running. The panel updates on its own.
                    </span>
                  </div>
                )}
                {provisioning && (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Monitoring is provisioning — {status!.ready}/{status!.total} pods ready. Prometheus{" "}
                    {status!.prometheusReady ? "✅" : "⏳"} · Grafana {status!.grafanaReady ? "✅" : "⏳"}. This panel switches
                    to live metrics automatically.
                  </span>
                )}
                {status?.note && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12 }}>{status.note}</span>}
                {(error || status?.installError) && (
                  <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {error ?? status?.installError}</span>
                )}
                <div className="row gap-2">
                  <Btn
                    variant={status?.installed ? "outline" : "primary"}
                    icon="download"
                    loading={install.isPending}
                    onClick={() => install.mutate()}
                  >
                    {installing ? "Installing… (click to retry)" : status?.installed ? "Re-run / upgrade" : "Install monitoring"}
                  </Btn>
                </div>
              </>
            )}
          </div>
        </Block.Body>
      </Block>

      {ready && (
        <>
          {activeKey && <AppHealthPanel slug={slug} envKey={activeKey} namespace={namespace} />}
          <Block>
            <Block.Header>
              <Block.Title sub={`Locked to namespace "${namespace}"${workload ? `, workload "${workload}"` : ""} — metrics, logs and Grafana all scope to it.`}>
                Scope
              </Block.Title>
            </Block.Header>
            <Block.Body>
              <div className="row gap-3 wrap">
                <Field label="Namespace (lock)" hint="The embedded Grafana logs + metrics follow this namespace.">
                  <div style={{ minWidth: 220 }}>
                    <Select
                      ariaLabel="Namespace"
                      value={namespace}
                      options={Array.from(new Set([namespace, ...(nsQ.data?.namespaces ?? [])])).map((n) => ({ value: n, label: n }))}
                      onValueChange={(v) => lockNamespace(v)}
                    />
                  </div>
                </Field>
                <Field label="Workload (optional)" hint="Deployment / Helm release name. Blank = whole namespace.">
                  <Input value={workload} placeholder="all workloads" onChange={(e) => setWorkload(e.target.value.trim())} />
                </Field>
              </div>
            </Block.Body>
          </Block>
          <PrometheusMetricsPanel
            slug={slug}
            connected
            queryPath={queryPath}
            source={`in-cluster Prometheus (namespace "${namespace}")`}
            presets={appPresets(namespace, workload)}
            title="Pod metrics (resources)"
            showQueryBox={false}
          />
          <PrometheusMetricsPanel
            slug={slug}
            connected
            queryPath={queryPath}
            source={`the app's scraped /metrics (namespace "${namespace}")`}
            presets={servicePresets(namespace)}
            title="Service metrics (app)"
            queryPresets={friendlyQueries(namespace)}
          />
          {activeKey && <AppMetricsScrapeForm slug={slug} envKey={activeKey} defaultNamespace={namespace} />}
          {status?.grafanaUid && (
            <Block>
              <Block.Header>
                <Block.Title sub={`Live Grafana dashboard for this application — metrics and logs${status?.loggingReady ? "" : " (logs panel populates once Loki is ready)"}.`}>
                  Grafana
                </Block.Title>
                <Block.Actions>
                  <a className="btn ghost sm" style={{ textDecoration: "none" }} href={grafanaBase} target="_blank" rel="noopener noreferrer">
                    Open full Grafana ↗
                  </a>
                </Block.Actions>
              </Block.Header>
              <Block.Body>
                <iframe
                  // var-namespace locks the dashboard to the chosen namespace (works in kiosk mode).
                  title="Application Grafana dashboard"
                  src={`${grafanaBase}d/${status.grafanaUid}/app?kiosk&theme=light&from=now-6h&to=now&refresh=30s&var-namespace=${encodeURIComponent(namespace)}`}
                  style={{ width: "100%", height: 560, border: "none", borderRadius: 10, background: "var(--surface-2)" }}
                />
              </Block.Body>
            </Block>
          )}
        </>
      )}
    </div>
  );
}
