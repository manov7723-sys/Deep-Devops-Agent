"use client";

/**
 * GCP Cloud Monitoring alert policies for the env's GKE cluster — the GCP
 * counterpart of the CloudWatch / Azure panels. Node CPU/memory/disk %
 * thresholds → email notification channel. Only renders for GCP envs.
 *
 * Backed by POST/GET /projects/[slug]/envs/[key]/gcp-monitor/alarms.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Block, Btn, Field, Input, StatusDot } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";
import type { EnvFilterValue } from "@/components/domain/EnvFilter";

type MetricKey = "cpu" | "memory";
const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "cpu", label: "Node CPU %" },
  { key: "memory", label: "Node memory %" },
];

type SetupResult = {
  ok: boolean;
  clusterName?: string;
  project?: string;
  emailWired?: boolean;
  alarms?: Array<{ label: string; ok: boolean; error?: string }>;
  error?: string;
};

export function GcpMonitorAlarmsPanel({ slug, env }: { slug: string; env: EnvFilterValue }) {
  const { data: envs } = useProjectEnvs(slug);
  const envList = useMemo(() => envs ?? [], [envs]);
  const activeKey = useMemo(() => {
    if (env !== "all" && envList.some((e) => e.key === env)) return env;
    return (
      envList.find((e) => e.cloudKind === "gcp")?.key ??
      envList.find((e) => e.cloudProviderId)?.key ??
      null
    );
  }, [env, envList]);
  const activeEnv = envList.find((e) => e.key === activeKey) ?? null;

  const [email, setEmail] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [selected, setSelected] = useState<Set<MetricKey>>(new Set(["cpu", "memory"]));
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existing = useQuery<{ ok: boolean; clusterName?: string; configured?: number }>({
    queryKey: ["p", slug, "gcp-alarms", activeKey],
    queryFn: () => api.get(`/projects/${slug}/envs/${activeKey}/gcp-monitor/alarms`),
    enabled: !!activeKey && activeEnv?.cloudKind === "gcp",
    retry: false,
    staleTime: 20_000,
  });
  const configured = existing.data?.ok ? (existing.data.configured ?? 0) : 0;

  const setup = useMutation({
    mutationFn: () =>
      api.post<SetupResult>(`/projects/${slug}/envs/${activeKey}/gcp-monitor/alarms`, {
        email: email.trim() || undefined,
        clusterName: clusterName.trim() || undefined,
        metrics: [...selected],
      }),
    onMutate: () => {
      setError(null);
      setResult(null);
    },
    onSuccess: (res) => {
      setResult(res);
      void existing.refetch();
    },
    onError: (e) => setError(apiErrorMessage(e, "Alert setup failed.")),
  });

  function toggle(k: MetricKey) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  if (!activeKey || activeEnv?.cloudKind !== "gcp") return null;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="GKE node alarms (CPU, memory, disk %) → email notification channel. GCP only.">
          GCP Monitoring alarms
        </Block.Title>
        <Block.Actions>
          {configured > 0 && <StatusDot tone="ok" label={`${configured} alarms`} />}
          <Btn
            variant="ghost"
            icon="refresh"
            loading={existing.isFetching}
            onClick={() => existing.refetch()}
          >
            Refresh
          </Btn>
        </Block.Actions>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3" style={{ maxWidth: 720 }}>
          {configured > 0 && (
            <div className="card card-pad col gap-1" style={{ fontSize: 12.5 }}>
              <span className="row gap-2" style={{ fontWeight: 600 }}>
                <span className="dot ok" /> {configured} alert policies on{" "}
                <b>{existing.data?.clusterName}</b>
              </span>
              <span className="faint">
                Re-running below replaces them. Fired alerts email your notification channel.
              </span>
            </div>
          )}

          <div className="row gap-2 wrap">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                className={`chip ${selected.has(m.key) ? "active" : ""}`}
                onClick={() => toggle(m.key)}
              >
                {selected.has(m.key) ? "✓ " : ""}
                {m.label}
              </button>
            ))}
          </div>

          <div className="row gap-3 wrap">
            <Field
              label="Notify email"
              hint="Creates a GCP notification channel that emails on alert."
            >
              <Input
                type="email"
                value={email}
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field
              label="GKE cluster (optional)"
              hint="Auto-detected from the kubeconfig if blank."
            >
              <Input
                value={clusterName}
                placeholder="auto-detect"
                onChange={(e) => setClusterName(e.target.value)}
              />
            </Field>
          </div>

          <div className="row gap-2">
            <Btn
              variant="primary"
              icon="bell"
              loading={setup.isPending}
              disabled={selected.size === 0}
              onClick={() => setup.mutate()}
            >
              Set up alarms
            </Btn>
          </div>

          {error && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {error}</span>
          )}
          {result && (
            <div className="col gap-2" style={{ fontSize: 12.5 }}>
              <span className="row gap-2">
                <StatusDot
                  tone={result.ok ? "ok" : "danger"}
                  label={result.ok ? "configured" : "failed"}
                />
                {result.ok ? (
                  <span>
                    {result.alarms?.filter((a) => a.ok).length ?? 0} alert policies on{" "}
                    <b>{result.clusterName}</b> (project {result.project}).
                    {result.emailWired ? " Email channel wired." : ""}
                  </span>
                ) : (
                  <span>{result.error}</span>
                )}
              </span>
              {result.alarms && result.alarms.some((a) => !a.ok) && (
                <div className="col gap-1">
                  {result.alarms
                    .filter((a) => !a.ok)
                    .map((a, i) => (
                      <span key={i} style={{ color: "var(--danger, #e5484d)" }}>
                        • {a.label}: {a.error}
                      </span>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
