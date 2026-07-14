"use client";

/**
 * Set up AWS CloudWatch alarms for the env's EKS cluster, in-app.
 *
 * CPU + Status Check are native EC2 metrics; Memory + Disk enable Container
 * Insights (the CloudWatch agent). Alarms are wired to an SNS email topic and
 * firing alarms are mirrored into the project's Alerts section.
 *
 * Backed by POST/GET /projects/[slug]/envs/[key]/cloudwatch/alarms.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Block, Btn, Field, Input, StatusDot } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";
import type { EnvFilterValue } from "@/components/domain/EnvFilter";

type MetricKey = "cpu" | "status" | "memory" | "disk";
const METRICS: Array<{ key: MetricKey; label: string; note: string }> = [
  { key: "cpu", label: "CPU Utilization", note: "native" },
  { key: "status", label: "Status Check Failed", note: "native" },
  { key: "memory", label: "Memory", note: "needs agent" },
  { key: "disk", label: "Disk Space", note: "needs agent" },
];

type SetupResult = {
  ok: boolean;
  clusterName?: string;
  region?: string;
  nodeCount?: number;
  topicArn?: string;
  containerInsights?: string;
  alarms?: Array<{ label: string; target: string; ok: boolean; error?: string }>;
  error?: string;
};

export function CloudWatchAlarmsPanel({ slug, env }: { slug: string; env: EnvFilterValue }) {
  const { data: envs } = useProjectEnvs(slug);
  const envList = useMemo(() => envs ?? [], [envs]);
  const activeKey = useMemo(() => {
    if (env !== "all" && envList.some((e) => e.key === env)) return env;
    return (
      envList.find((e) => e.cloudKind === "aws")?.key ??
      envList.find((e) => e.cloudProviderId)?.key ??
      envList[0]?.key ??
      null
    );
  }, [env, envList]);
  const activeEnv = envList.find((e) => e.key === activeKey) ?? null;

  const [email, setEmail] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [selected, setSelected] = useState<Set<MetricKey>>(
    new Set(["cpu", "status", "memory", "disk"]),
  );
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setup = useMutation({
    mutationFn: () =>
      api.post<SetupResult>(`/projects/${slug}/envs/${activeKey}/cloudwatch/alarms`, {
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
    onError: (e) => setError(apiErrorMessage(e, "Alarm setup failed.")),
  });

  // Load already-configured alarms on mount so the state persists across refresh.
  // (Errors silently for non-AWS envs / no cluster — we just show nothing then.)
  const existing = useQuery<{
    ok: boolean;
    clusterName?: string;
    configured?: number;
    firing?: number;
    alarms?: Array<{ name: string; state: string }>;
  }>({
    queryKey: ["p", slug, "cw-alarms", activeKey],
    queryFn: () => api.get(`/projects/${slug}/envs/${activeKey}/cloudwatch/alarms`),
    enabled: !!activeKey,
    retry: false,
    staleTime: 20_000,
  });
  const configured = existing.data?.ok ? (existing.data.configured ?? 0) : 0;

  function toggle(k: MetricKey) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  // Only relevant for AWS environments.
  if (!activeKey || activeEnv?.cloudKind !== "aws") return null;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="EKS node alarms (CPU, status check, memory, disk) → SNS email + the Alerts tab. AWS only.">
          CloudWatch alarms
        </Block.Title>
        <Block.Actions>
          {configured > 0 && (
            <StatusDot
              tone={(existing.data?.firing ?? 0) > 0 ? "danger" : "ok"}
              label={
                (existing.data?.firing ?? 0) > 0
                  ? `${existing.data?.firing} firing`
                  : `${configured} alarms`
              }
            />
          )}
          <Btn
            variant="ghost"
            icon="refresh"
            loading={existing.isFetching}
            onClick={() => existing.refetch()}
          >
            Sync states
          </Btn>
        </Block.Actions>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3" style={{ maxWidth: 720 }}>
          {/* Persistent summary of already-configured alarms (survives refresh). */}
          {configured > 0 && (
            <div className="card card-pad col gap-1" style={{ fontSize: 12.5 }}>
              <span className="row gap-2" style={{ fontWeight: 600 }}>
                <span className="dot ok" /> {configured} alarms configured on{" "}
                <b>{existing.data?.clusterName}</b>
              </span>
              <span className="faint">
                {(() => {
                  const a = existing.data?.alarms ?? [];
                  const c = (s: string) => a.filter((x) => x.state === s).length;
                  return `${c("OK")} OK · ${c("ALARM")} firing · ${c("INSUFFICIENT_DATA")} pending data`;
                })()}
                . Re-running below updates them; firing alarms show in the Alerts tab.
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
                title={
                  m.note === "needs agent"
                    ? "Enables Container Insights (CloudWatch agent)"
                    : "Native EC2 metric"
                }
              >
                {selected.has(m.key) ? "✓ " : ""}
                {m.label}
                <span className="faint" style={{ fontSize: 11 }}>
                  {" "}
                  · {m.note}
                </span>
              </button>
            ))}
          </div>

          <div className="row gap-3 wrap">
            <Field
              label="Notify email (SNS)"
              hint="You'll get an AWS email to confirm the subscription."
            >
              <Input
                type="email"
                value={email}
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field
              label="EKS cluster (optional)"
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
                    {result.alarms?.filter((a) => a.ok).length ?? 0} alarms on{" "}
                    <b>{result.clusterName}</b> ({result.nodeCount} nodes, {result.region}).
                    {result.topicArn ? " SNS email sent — confirm it to get notified." : ""}
                  </span>
                ) : (
                  <span>{result.error}</span>
                )}
              </span>
              {result.containerInsights && (
                <span className="faint">{result.containerInsights}</span>
              )}
              {result.alarms && result.alarms.some((a) => !a.ok) && (
                <div className="col gap-1">
                  {result.alarms
                    .filter((a) => !a.ok)
                    .map((a, i) => (
                      <span key={i} style={{ color: "var(--danger, #e5484d)" }}>
                        • {a.label} ({a.target}): {a.error}
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
