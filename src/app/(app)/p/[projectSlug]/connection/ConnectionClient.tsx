"use client";

/**
 * Cluster connection — the new-app "Connection" section. Connect a running
 * Kubernetes cluster across the three clouds (EKS / AKS / GKE), styled like the
 * original app's EKSModal but extended to Azure + GCP. Connecting runs the
 * cloud CLI server-side, stores the kubeconfig (encrypted) on the chosen env,
 * and verifies with `kubectl get nodes`.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead, Select } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api/client";
import { useClusterStatus, useConnectCluster, type ConnectClusterResult } from "@/hooks/queries/connectivity";

type EnvRow = { id: string; key: string; name: string; cloudProviderId?: string | null; hasKubeconfig?: boolean };
type Cloud = "aws" | "azure" | "gcp";

const CLOUDS: { key: Cloud; label: string; clusterLabel: string }[] = [
  { key: "aws", label: "AWS", clusterLabel: "EKS cluster" },
  { key: "azure", label: "Azure", clusterLabel: "AKS cluster" },
  { key: "gcp", label: "GCP", clusterLabel: "GKE cluster" },
];

const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-west-2",
  "eu-central-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ca-central-1", "sa-east-1",
];

export function ProjectConnectionClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });

  // ── Kubernetes cluster ────────────────────────────────────────────────
  const [envKey, setEnvKey] = useState("");
  const [cloud, setCloud] = useState<Cloud>("aws");
  const [clusterName, setClusterName] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [resourceGroup, setResourceGroup] = useState("");
  const [project, setProject] = useState("");
  const [result, setResult] = useState<ConnectClusterResult | null>(null);

  useEffect(() => {
    if (!envKey && envs && envs.length > 0) setEnvKey(envs[0].key);
  }, [envs, envKey]);

  const connect = useConnectCluster(slug, envKey);
  const meta = CLOUDS.find((c) => c.key === cloud)!;

  // Live status of the selected env's connected cluster (re-lists nodes after a
  // refresh so the connection clearly shows as active, not an empty form).
  const selectedHasKube = !!envs?.find((e) => e.key === envKey)?.hasKubeconfig;
  const clusterStatus = useClusterStatus(slug, envKey, selectedHasKube);

  const canConnect =
    !!envKey &&
    !!clusterName.trim() &&
    (cloud !== "aws" || !!region.trim()) &&
    (cloud !== "azure" || !!resourceGroup.trim()) &&
    (cloud !== "gcp" || !!project.trim()) &&
    !connect.isPending;

  function run() {
    if (!canConnect) return;
    setResult(null);
    connect.mutate(
      {
        cloud,
        clusterName: clusterName.trim(),
        ...(cloud !== "azure" ? { region: region.trim() } : {}),
        ...(cloud === "azure" ? { resourceGroup: resourceGroup.trim() } : {}),
        ...(cloud === "gcp" ? { project: project.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          setResult(r);
          // Refresh envs + cluster status so the persistent "connected" view updates.
          qc.invalidateQueries({ queryKey: ["p", slug, "envs"] });
          qc.invalidateQueries({ queryKey: ["p", slug, "cluster-status", envKey] });
        },
        onError: (e: unknown) =>
          setResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed." }),
      },
    );
  }

  const selectedEnv = envs?.find((e) => e.key === envKey);
  const connectedEnvs = (envs ?? []).filter((e) => e.hasKubeconfig);

  return (
    <div className="col gap-5">
      <PageHead
        title="Connection"
        sub="Connect a running Kubernetes cluster (EKS · AKS · GKE). The kubeconfig is stored encrypted on the environment so deploys and the agent can reach it."
      />

      {/* Persistent connection status — survives navigating away/back. */}
      <Block>
        <Block.Header>
          <Block.Title sub="Connections persist on the environment; the AI chat queries these clusters directly.">
            <span className="row gap-2" style={{ alignItems: "center" }}>
              <Icon name="check" size={16} /> Connected clusters
            </span>
          </Block.Title>
        </Block.Header>
        {connectedEnvs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>No cluster connected yet. Connect one below.</span>
        ) : (
          <div className="row gap-2 wrap">
            {connectedEnvs.map((e) => (
              <Badge key={e.id} tone="ok" withDot>{e.name || e.key} · connected</Badge>
            ))}
          </div>
        )}
      </Block>

      {/* ── Kubernetes cluster ──────────────────────────────────────────── */}
      <Block>
        <Block.Header>
          <Block.Title sub="Pick a cloud, point at a running cluster, and connect. After connecting, the agent can list pods, scale, and read logs.">
            <span className="row gap-2" style={{ alignItems: "center" }}>
              <Icon name="globe" size={16} /> Connect Kubernetes cluster
            </span>
          </Block.Title>
        </Block.Header>

        {!envs || envs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Create an environment first to store the cluster connection.</span>
        ) : (
          <div className="col gap-3" style={{ maxWidth: 520 }}>
            {/* Cloud provider pills */}
            <Field label="Cloud provider">
              <div className="row gap-2 wrap">
                {CLOUDS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`chip ${cloud === c.key ? "active" : ""}`}
                    style={{ height: 38 }}
                    onClick={() => { setCloud(c.key); setResult(null); }}
                  >
                    <Icon name="cloud" size={15} /> {c.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Environment" required hint="Where the kubeconfig (and AWS creds, for EKS) come from / are stored.">
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment"
                  options={envs.map((e) => ({ value: e.key, label: `${e.name || e.key}${e.hasKubeconfig ? " · connected" : ""}` }))} />
                {selectedEnv?.hasKubeconfig && <Badge tone="ok" withDot>connected</Badge>}
              </div>
            </Field>

            {/* Live status of the already-connected cluster (persists across refresh). */}
            {selectedHasKube && (
              <div className="col gap-2" style={{ marginTop: 4 }}>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <Badge tone="ok" withDot>connected</Badge>
                  {clusterStatus.data?.cluster && <span style={{ fontWeight: 600 }}>{clusterStatus.data.cluster}</span>}
                  <span className="muted" style={{ fontSize: 12.5 }}>kubeconfig stored on env</span>
                </div>
                {clusterStatus.isLoading ? (
                  <span className="muted" style={{ fontSize: 12.5 }}>Checking cluster…</span>
                ) : clusterStatus.data?.verified && clusterStatus.data.nodes && clusterStatus.data.nodes.length > 0 ? (
                  <div className="col gap-1">
                    <span className="muted" style={{ fontSize: 12.5 }}>{clusterStatus.data.nodes.length} node(s):</span>
                    {clusterStatus.data.nodes.map((n) => (
                      <div key={n.name} className="row gap-2" style={{ alignItems: "center", fontSize: 12.5 }}>
                        <Badge tone={n.status === "Ready" ? "ok" : "warn"} withDot>{n.status}</Badge>
                        <span className="mono">{n.name}</span>
                        <span className="faint">{n.version}</span>
                      </div>
                    ))}
                  </div>
                ) : clusterStatus.data?.verified ? (
                  <span className="muted" style={{ fontSize: 12.5 }}>Verified — no nodes reported.</span>
                ) : (
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Stored, but couldn&apos;t verify with kubectl{clusterStatus.data?.verifyError ? ` (${clusterStatus.data.verifyError.slice(0, 120)})` : ""}.
                  </span>
                )}
              </div>
            )}

            {/* Per-cloud locating fields */}
            {cloud === "aws" && (
              <Field label="Region" required>
                <Select value={region} onValueChange={setRegion} ariaLabel="AWS region"
                  options={AWS_REGIONS.map((r) => ({ value: r, label: r }))} />
              </Field>
            )}
            {cloud === "azure" && (
              <Field label="Resource group" required>
                <Input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} placeholder="my-resource-group" />
              </Field>
            )}
            {cloud === "gcp" && (
              <>
                <Field label="Project" required>
                  <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-gcp-project" />
                </Field>
                <Field label="Region / location" required>
                  <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-central1" />
                </Field>
              </>
            )}

            <Field label={`${meta.clusterLabel} name`} required>
              <Input value={clusterName} onChange={(e) => setClusterName(e.target.value)}
                placeholder={`type the ${meta.clusterLabel} name`}
                onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
            </Field>

            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Btn variant="primary" icon="globe" loading={connect.isPending} disabled={!canConnect} onClick={run}>
                {connect.isPending ? "Connecting…" : `Connect ${meta.label}`}
              </Btn>
            </div>

            {result && <ConnectResult result={result} clusterLabel={meta.clusterLabel} />}
          </div>
        )}
      </Block>
    </div>
  );
}

function ConnectResult({ result, clusterLabel }: { result: ConnectClusterResult; clusterLabel: string }) {
  if (!result.ok) {
    return (
      <div className="col gap-1" style={{ marginTop: 4 }}>
        <span style={{ color: "var(--danger, #e5484d)", fontSize: 13 }}>
          ❌ {result.message ?? "Connection failed."}
        </span>
        {result.stderr && (
          <pre style={{ fontSize: 11.5, whiteSpace: "pre-wrap", margin: 0, maxHeight: 180, overflowY: "auto", background: "var(--surface-2, #0000000a)", padding: 8, borderRadius: 6 }}>
            {result.stderr}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div className="col gap-2" style={{ marginTop: 4 }}>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <Badge tone="ok" withDot>connected</Badge>
        <span style={{ fontWeight: 600 }}>{result.cluster}</span>
        <span className="muted" style={{ fontSize: 12.5 }}>kubeconfig stored on env</span>
      </div>
      {result.verified ? (
        result.nodes && result.nodes.length > 0 ? (
          <div className="col gap-1">
            <span className="muted" style={{ fontSize: 12.5 }}>{result.nodes.length} node(s):</span>
            {result.nodes.map((n) => (
              <div key={n.name} className="row gap-2" style={{ alignItems: "center", fontSize: 12.5 }}>
                <Badge tone={n.status === "Ready" ? "ok" : "warn"} withDot>{n.status}</Badge>
                <span className="mono">{n.name}</span>
                <span className="faint">{n.version}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12.5 }}>Verified — no nodes reported.</span>
        )
      ) : (
        <span className="muted" style={{ fontSize: 12.5 }}>
          Stored, but couldn&apos;t verify with kubectl{result.verifyError ? ` (${result.verifyError.slice(0, 120)})` : ""}. The {clusterLabel} may be unreachable from the server.
        </span>
      )}
    </div>
  );
}
