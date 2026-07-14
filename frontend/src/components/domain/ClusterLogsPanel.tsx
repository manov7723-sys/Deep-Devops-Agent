"use client";

/**
 * In-app Kubernetes logs — pick an environment, namespace and pod, and read its
 * logs entirely in the app (server-side kubectl through the env's kubeconfig,
 * nothing exposed). No terminal needed. Optional live tail.
 *
 * Backed by:
 *   GET /projects/[slug]/envs/[key]/logs/namespaces
 *   GET /projects/[slug]/envs/[key]/logs/pods?namespace=…
 *   GET /projects/[slug]/envs/[key]/logs?namespace=…&pod=…&tail=…&previous=…
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Block, Btn, Select, StatusDot } from "@/components/ui";
import { api } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";
import type { EnvFilterValue } from "@/components/domain/EnvFilter";

type PodInfo = { name: string; phase: string; ready: boolean; restarts: number };
type PodsResp = { ok: boolean; pods?: PodInfo[]; namespace?: string; message?: string };
type NsResp = { ok: boolean; namespaces?: string[]; message?: string };
type LogsResp = { ok: boolean; logs?: string; truncated?: boolean; message?: string };

export function ClusterLogsPanel({ slug, env }: { slug: string; env: EnvFilterValue }) {
  const { data: envs, isLoading: envsLoading } = useProjectEnvs(slug);
  const envList = useMemo(() => envs ?? [], [envs]);
  const [pickedEnv, setPickedEnv] = useState<string | null>(null);

  const activeKey = useMemo(() => {
    if (pickedEnv && envList.some((e) => e.key === pickedEnv)) return pickedEnv;
    if (env !== "all" && envList.some((e) => e.key === env)) return env;
    return envList.find((e) => e.hasKubeconfig)?.key ?? envList[0]?.key ?? null;
  }, [pickedEnv, env, envList]);
  const activeEnv = envList.find((e) => e.key === activeKey) ?? null;
  const enabled = !!activeKey && !!activeEnv?.hasKubeconfig;

  const [namespace, setNamespace] = useState<string>("");
  const [pod, setPod] = useState<string>("");
  const [tail, setTail] = useState(500);
  const [previous, setPrevious] = useState(false);
  const [live, setLive] = useState(false);

  // Default the namespace to the env's app namespace once we know the env.
  useEffect(() => {
    if (!namespace && activeEnv?.namespace) setNamespace(activeEnv.namespace);
  }, [activeEnv, namespace]);

  const nsQ = useQuery<NsResp>({
    queryKey: ["p", slug, "logs-ns", activeKey],
    queryFn: () => api.get<NsResp>(`/projects/${slug}/envs/${activeKey}/logs/namespaces`),
    enabled,
    staleTime: 60_000,
  });

  const podsQ = useQuery<PodsResp>({
    queryKey: ["p", slug, "logs-pods", activeKey, namespace],
    queryFn: () =>
      api.get<PodsResp>(`/projects/${slug}/envs/${activeKey}/logs/pods`, { namespace }),
    enabled: enabled && !!namespace,
    refetchInterval: 15_000,
  });

  const logsQ = useQuery<LogsResp>({
    queryKey: ["p", slug, "logs", activeKey, namespace, pod, tail, previous],
    queryFn: () =>
      api.get<LogsResp>(`/projects/${slug}/envs/${activeKey}/logs`, {
        namespace,
        pod,
        tail,
        previous: previous ? "true" : undefined,
      }),
    enabled: enabled && !!namespace && !!pod,
    refetchInterval: live ? 3_000 : false,
  });

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
        <Block.Empty
          icon="cloud"
          title="No environments"
          description="Create an environment and connect its cluster to view logs."
        />
      </Block>
    );
  }

  const nsOptions = (nsQ.data?.namespaces ?? (namespace ? [namespace] : [])).map((n) => ({
    value: n,
    label: n,
  }));
  const pods = podsQ.data?.ok ? (podsQ.data.pods ?? []) : [];

  return (
    <div className="col gap-4">
      <Block>
        <Block.Header>
          <Block.Title sub="Read pod logs straight from the cluster — no terminal, nothing exposed.">
            Logs
          </Block.Title>
          <Block.Actions>
            {!activeEnv?.hasKubeconfig && <StatusDot tone="danger" label="no cluster" />}
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {!activeEnv?.hasKubeconfig ? (
            <span className="muted" style={{ fontSize: 13 }}>
              <b>{activeEnv?.name}</b> has no cluster connected. Connect it on the Connection tab
              first.
            </span>
          ) : (
            <div className="col gap-3">
              {/* env picker (real envs) */}
              {envList.length > 1 && (
                <div className="row gap-2 wrap" role="radiogroup" aria-label="Environment">
                  {envList.map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      role="radio"
                      aria-checked={e.key === activeKey}
                      className={`chip ${e.key === activeKey ? "active" : ""}`}
                      onClick={() => {
                        setPickedEnv(e.key);
                        setNamespace("");
                        setPod("");
                      }}
                    >
                      {e.name}
                    </button>
                  ))}
                </div>
              )}

              {/* namespace + controls */}
              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                <span className="faint" style={{ fontSize: 12 }}>
                  Namespace
                </span>
                <div style={{ minWidth: 200 }}>
                  <Select
                    ariaLabel="Namespace"
                    value={namespace || undefined}
                    placeholder="Select namespace…"
                    options={nsOptions}
                    onValueChange={(v) => {
                      setNamespace(v);
                      setPod("");
                    }}
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <Select
                    ariaLabel="Lines"
                    value={String(tail)}
                    options={[100, 500, 1000, 2000].map((n) => ({
                      value: String(n),
                      label: `${n} lines`,
                    }))}
                    onValueChange={(v) => setTail(Number(v))}
                  />
                </div>
                <button
                  type="button"
                  className={`chip ${previous ? "active" : ""}`}
                  onClick={() => setPrevious((p) => !p)}
                >
                  Previous (crashed)
                </button>
                <button
                  type="button"
                  className={`chip ${live ? "active" : ""}`}
                  onClick={() => setLive((l) => !l)}
                >
                  {live ? "● Live" : "Live tail"}
                </button>
                <Btn
                  variant="outline"
                  icon="refresh"
                  onClick={() => logsQ.refetch()}
                  loading={logsQ.isFetching && !live}
                >
                  Refresh
                </Btn>
              </div>

              {/* pod list */}
              {podsQ.data && !podsQ.data.ok ? (
                <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>
                  ❌ {podsQ.data.message}
                </span>
              ) : pods.length === 0 ? (
                <span className="muted" style={{ fontSize: 13 }}>
                  {podsQ.isFetching ? "Loading pods…" : `No pods in "${namespace}".`}
                </span>
              ) : (
                <div className="row gap-2 wrap">
                  {pods.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className={`chip ${p.name === pod ? "active" : ""}`}
                      title={`${p.phase} · ${p.restarts} restarts`}
                      onClick={() => setPod(p.name)}
                    >
                      <span
                        className={`dot ${p.ready ? "ok" : p.phase === "Running" ? "warn" : "danger"}`}
                        style={{ width: 6, height: 6, boxShadow: "none" }}
                      />
                      {p.name}
                      {p.restarts > 0 && (
                        <span className="faint" style={{ fontSize: 11 }}>
                          {" "}
                          · {p.restarts}↻
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Block.Body>
      </Block>

      {/* log output */}
      {enabled && pod && (
        <Block>
          <Block.Header>
            <Block.Title sub={`${namespace} / ${pod}${previous ? " · previous container" : ""}`}>
              Output
            </Block.Title>
            <Block.Actions>{live && <StatusDot tone="ok" label="live" />}</Block.Actions>
          </Block.Header>
          <Block.Body>
            {logsQ.data && !logsQ.data.ok ? (
              <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>
                ❌ {logsQ.data.message}
              </span>
            ) : (
              <>
                {logsQ.data?.truncated && (
                  <span className="faint" style={{ fontSize: 11 }}>
                    Showing the most recent output (truncated).
                  </span>
                )}
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    marginTop: 6,
                    padding: 12,
                    background: "var(--surface-2)",
                    borderRadius: 8,
                    maxHeight: 520,
                    overflow: "auto",
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {logsQ.isFetching && !logsQ.data
                    ? "Loading…"
                    : logsQ.data?.logs?.trim() || "(no log output)"}
                </pre>
              </>
            )}
          </Block.Body>
        </Block>
      )}
    </div>
  );
}
