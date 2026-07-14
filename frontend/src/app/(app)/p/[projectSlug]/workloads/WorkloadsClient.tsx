"use client";

/**
 * Workloads console — see the running apps on a connected cluster and, from
 * buttons: scale replicas (+/-), restart, and view live pod logs. No kubectl or
 * AI needed; every action runs server-side via the env's stored kubeconfig.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, PageHead, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useActiveEnv } from "@/hooks/useActiveEnv";

type Pod = { name: string; status: string; ready: string };
type Workload = { name: string; ready: number; desired: number; pods: Pod[] };
type Target = { envKey: string; name: string; namespace: string; isProduction: boolean };
type ListResp = {
  ok: true;
  targets: Target[];
  envKey: string;
  namespace: string;
  workloads: Workload[];
  error?: string;
};

export function WorkloadsClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const projectActiveEnv = useActiveEnv(slug);
  const [envKey, setEnvKey] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `${app}:${action}`
  const [logsFor, setLogsFor] = useState<{ app: string; pod: string; text: string } | null>(null);

  // Default to the project's active env until the user picks one here.
  const effEnv = envKey || projectActiveEnv || "";
  const q = useQuery<ListResp>({
    queryKey: ["p", slug, "cluster-ops", effEnv],
    queryFn: () =>
      api.get<ListResp>(
        `/projects/${slug}/cluster-ops${effEnv ? `?envKey=${encodeURIComponent(effEnv)}` : ""}`,
      ),
    refetchInterval: 15_000,
  });
  const targets = q.data?.targets ?? [];
  const workloads = q.data?.workloads ?? [];
  const activeEnv = effEnv || q.data?.envKey || "";
  const namespace = q.data?.namespace || "";
  const invalidate = () => qc.invalidateQueries({ queryKey: ["p", slug, "cluster-ops"] });

  const action = useMutation({
    mutationFn: (v: { app: string; action: "scale" | "restart"; replicas?: number }) =>
      api.post<{ ok: boolean; message: string }>(`/projects/${slug}/cluster-ops`, {
        action: v.action,
        envKey: activeEnv,
        appName: v.app,
        replicas: v.replicas,
        namespace,
      }),
    onMutate: (v) => {
      setNote(null);
      setBusy(`${v.app}:${v.action}`);
    },
    onSuccess: (r) => {
      setNote({ tone: "ok", text: r.message });
      invalidate();
    },
    onError: (e) => setNote({ tone: "danger", text: apiErrorMessage(e) }),
    onSettled: () => setBusy(null),
  });

  const logs = useMutation({
    mutationFn: (v: { app: string; pod: string }) =>
      api.get<{ ok: boolean; logs: string }>(
        `/projects/${slug}/cluster-ops/logs?envKey=${encodeURIComponent(activeEnv)}&podName=${encodeURIComponent(v.pod)}&namespace=${encodeURIComponent(namespace)}`,
      ),
    onMutate: (v) => {
      setNote(null);
      setBusy(`${v.app}:logs`);
      setLogsFor({ app: v.app, pod: v.pod, text: "Loading…" });
    },
    onSuccess: (r, v) => setLogsFor({ app: v.app, pod: v.pod, text: r.logs || "(no output)" }),
    onError: (e, v) => setLogsFor({ app: v.app, pod: v.pod, text: apiErrorMessage(e) }),
    onSettled: () => setBusy(null),
  });

  return (
    <div className="col gap-5">
      <PageHead
        title="Workloads"
        sub="Your running apps on the connected cluster. Scale, restart, or read live logs — all from here, no kubectl needed."
        actions={
          <Btn variant="outline" icon="refresh" loading={q.isFetching} onClick={() => invalidate()}>
            Refresh
          </Btn>
        }
      />

      {note && (
        <Badge tone={note.tone} icon={note.tone === "danger" ? "alert" : "check"}>
          {note.text}
        </Badge>
      )}

      {targets.length === 0 ? (
        <Block>
          <Block.Empty
            icon="globe"
            title="No connected clusters"
            description="Connect a cluster on the Clusters page first."
          />
        </Block>
      ) : (
        <>
          <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ minWidth: 220 }}>
              <Field label="Environment / cluster">
                <Select
                  value={activeEnv}
                  onValueChange={setEnvKey}
                  ariaLabel="Environment"
                  options={targets.map((t) => ({
                    value: t.envKey,
                    label: `${t.name || t.envKey}${t.isProduction ? " (prod)" : ""}`,
                  }))}
                />
              </Field>
            </div>
            {namespace && (
              <span className="muted" style={{ fontSize: 12, paddingBottom: 8 }}>
                namespace: <span className="mono">{namespace}</span>
              </span>
            )}
          </div>

          {q.data?.error && (
            <Badge tone="warn" icon="alert">
              {q.data.error}
            </Badge>
          )}

          {workloads.length === 0 ? (
            <Block>
              <Block.Empty
                icon="scale"
                title="No workloads"
                description="No Deployments found in this namespace."
              />
            </Block>
          ) : (
            <div className="col gap-3">
              {workloads.map((w) => {
                const healthy = w.desired > 0 && w.ready >= w.desired;
                return (
                  <Block key={w.name}>
                    <Block.Body>
                      <div className="row between wrap" style={{ alignItems: "center", gap: 10 }}>
                        <div className="row gap-2" style={{ alignItems: "center", minWidth: 0 }}>
                          <strong style={{ fontSize: 14 }}>{w.name}</strong>
                          <Badge tone={healthy ? "solid-ok" : "warn"} withDot>
                            {w.ready}/{w.desired} ready
                          </Badge>
                        </div>
                        <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                          <div className="row gap-1" style={{ alignItems: "center" }}>
                            <Btn
                              variant="outline"
                              size="sm"
                              disabled={busy != null || w.desired <= 0}
                              loading={busy === `${w.name}:scale`}
                              onClick={() =>
                                action.mutate({
                                  app: w.name,
                                  action: "scale",
                                  replicas: Math.max(0, w.desired - 1),
                                })
                              }
                            >
                              −
                            </Btn>
                            <span
                              className="mono"
                              style={{ minWidth: 20, textAlign: "center", fontSize: 13 }}
                            >
                              {w.desired}
                            </span>
                            <Btn
                              variant="outline"
                              size="sm"
                              disabled={busy != null}
                              loading={busy === `${w.name}:scale`}
                              onClick={() =>
                                action.mutate({
                                  app: w.name,
                                  action: "scale",
                                  replicas: w.desired + 1,
                                })
                              }
                            >
                              +
                            </Btn>
                          </div>
                          <Btn
                            variant="outline"
                            size="sm"
                            icon="refresh"
                            disabled={busy != null}
                            loading={busy === `${w.name}:restart`}
                            onClick={() => action.mutate({ app: w.name, action: "restart" })}
                          >
                            Restart
                          </Btn>
                          <Btn
                            variant="outline"
                            size="sm"
                            icon="terminal"
                            disabled={busy != null || w.pods.length === 0}
                            loading={busy === `${w.name}:logs`}
                            onClick={() => logs.mutate({ app: w.name, pod: w.pods[0].name })}
                          >
                            Logs
                          </Btn>
                        </div>
                      </div>

                      {/* pods */}
                      {w.pods.length > 0 && (
                        <div className="row gap-2 wrap" style={{ marginTop: 8 }}>
                          {w.pods.map((p) => (
                            <span
                              key={p.name}
                              className="mono faint"
                              style={{ fontSize: 11.5 }}
                              title={p.status}
                            >
                              ● {p.name.replace(`${w.name}-`, "…")}{" "}
                              <span style={{ opacity: 0.7 }}>{p.ready}</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* logs panel */}
                      {logsFor?.app === w.name && (
                        <div className="col gap-1" style={{ marginTop: 10 }}>
                          <div className="row between" style={{ alignItems: "center" }}>
                            <span className="faint mono" style={{ fontSize: 11.5 }}>
                              logs · {logsFor.pod}
                            </span>
                            <Btn variant="ghost" size="sm" onClick={() => setLogsFor(null)}>
                              Close
                            </Btn>
                          </div>
                          <pre
                            style={{
                              maxHeight: 260,
                              overflow: "auto",
                              background: "var(--surface-2)",
                              border: "1px solid var(--border-soft)",
                              borderRadius: 6,
                              padding: 10,
                              fontSize: 11.5,
                              margin: 0,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {logsFor.text}
                          </pre>
                        </div>
                      )}
                    </Block.Body>
                  </Block>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
