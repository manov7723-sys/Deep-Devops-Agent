"use client";

/**
 * Cluster connection — the new-app "Connection" section. Connect a running
 * Kubernetes cluster across the three clouds (EKS / AKS / GKE), styled like the
 * original app's EKSModal but extended to Azure + GCP. Connecting runs the
 * cloud CLI server-side, stores the kubeconfig (encrypted) on the chosen env,
 * and verifies with `kubectl get nodes`.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api/client";
import { useClusterStatus, useConnectCluster, useProvisionAzureTfstate, type ConnectClusterResult } from "@/hooks/queries/connectivity";
import { useActiveEnv } from "@/hooks/useActiveEnv";

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

// GCP regions (note: no dash before the number — unlike AWS).
const GCP_REGIONS = [
  "us-central1", "us-east1", "us-east4", "us-east5", "us-west1", "us-west2", "us-west3", "us-west4", "us-south1",
  "northamerica-northeast1", "southamerica-east1", "europe-west1", "europe-west2", "europe-west3", "europe-west4",
  "europe-north1", "asia-east1", "asia-northeast1", "asia-south1", "asia-southeast1", "australia-southeast1",
];

type GcpContext = { projects?: { projectId: string; name: string }[] };
type AzureCluster = { name: string; resourceGroup: string; location: string };
type AzureClustersResp = { clusters?: AzureCluster[]; note?: string };
type AwsCluster = { name: string; status?: string; version?: string };
type AwsClustersResp = { connected?: boolean; clusters?: AwsCluster[]; note?: string };

export function ProjectConnectionClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });

  // The cloud this project targets — isolates the Connect-cluster UI so only the
  // project's own provider (e.g. AWS-only project → EKS only) is offered. Null on
  // legacy projects with no chosen cloud, in which case we fall back to all three.
  const { data: projectInfo } = useQuery<{ project: { cloud: string | null } }>({
    queryKey: ["p", slug, "project-cloud"],
    queryFn: () => api.get<{ project: { cloud: string | null } }>(`/projects/${slug}`),
    staleTime: 60_000,
  });
  const lockedCloud = (projectInfo?.project?.cloud as Cloud | null) ?? null;
  const availableClouds = lockedCloud ? CLOUDS.filter((c) => c.key === lockedCloud) : CLOUDS;

  // ── Kubernetes cluster ────────────────────────────────────────────────
  const projectActiveEnv = useActiveEnv(slug);
  const [envKey, setEnvKey] = useState("");
  const [cloud, setCloud] = useState<Cloud>("aws");
  const [clusterName, setClusterName] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [resourceGroup, setResourceGroup] = useState("");
  const [project, setProject] = useState("");
  const [result, setResult] = useState<ConnectClusterResult | null>(null);

  // Azure connection method: organizational accounts auto-connect (like AWS/GCP);
  // personal Microsoft accounts can't fetch credentials via the app, so they use
  // the guided Cloud Shell + paste flow.
  const [azureMethod, setAzureMethod] = useState<"org" | "personal">("org");

  // Paste-a-kubeconfig fallback — for clusters/accounts the API can't auto-fetch
  // (e.g. a personal Microsoft account owning the subscription). Saves the
  // pasted kubeconfig onto the selected env, same result as auto-connect.
  const [showPaste, setShowPaste] = useState(false);
  const [kubeText, setKubeText] = useState("");
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);

  // Default to the project's ACTIVE env (if it exists), else the first env.
  useEffect(() => {
    if (envKey || !envs || envs.length === 0) return;
    const active = projectActiveEnv && envs.find((e) => e.key === projectActiveEnv) ? projectActiveEnv : envs[0].key;
    setEnvKey(active);
  }, [envs, envKey, projectActiveEnv]);

  // Lock the selected cloud to the project's target once it's known so the form
  // can't sit on a cloud this project doesn't use.
  useEffect(() => {
    if (lockedCloud && cloud !== lockedCloud) setCloud(lockedCloud);
  }, [lockedCloud, cloud]);

  // Keep the region valid for the chosen cloud (GCP uses us-central1-style
  // names, AWS uses us-east-1-style) so you can't submit an AWS region to GCP.
  useEffect(() => {
    if (cloud === "gcp" && !GCP_REGIONS.includes(region)) setRegion("us-central1");
    if (cloud === "aws" && !AWS_REGIONS.includes(region)) setRegion("us-east-1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud]);

  // Live GCP project list (for the Project dropdown) — only when connecting GCP.
  const { data: gcpCtx } = useQuery<GcpContext>({
    queryKey: ["p", slug, "gcp-context"],
    queryFn: () => api.get<GcpContext>(`/projects/${slug}/gcp/context`),
    enabled: cloud === "gcp",
    staleTime: 60_000,
  });
  const gcpProjects = gcpCtx?.projects ?? [];

  // Live AKS cluster list (resource group + cluster dropdowns) — only for Azure.
  const { data: azClustersResp } = useQuery<AzureClustersResp>({
    queryKey: ["p", slug, "azure-clusters"],
    queryFn: () => api.get<AzureClustersResp>(`/projects/${slug}/azure/clusters`),
    enabled: cloud === "azure",
    staleTime: 60_000,
  });
  const azClusters = azClustersResp?.clusters ?? [];
  const azResourceGroups = Array.from(new Set(azClusters.map((c) => c.resourceGroup))).filter(Boolean).sort();
  const azClustersInRg = azClusters.filter((c) => c.resourceGroup === resourceGroup);

  // Live EKS cluster list for the chosen AWS region — mirrors the Azure flow so
  // you pick a region → pick a cluster instead of typing the name.
  const { data: awsClustersResp, isFetching: awsClustersLoading } = useQuery<AwsClustersResp>({
    queryKey: ["p", slug, "aws-clusters", region],
    queryFn: () => api.get<AwsClustersResp>(`/projects/${slug}/aws/clusters?region=${encodeURIComponent(region)}`),
    enabled: cloud === "aws" && !!region.trim(),
    staleTime: 30_000,
  });
  const awsClusters = awsClustersResp?.clusters ?? [];
  // The exact command the user runs in Cloud Shell to get a pasteable kubeconfig.
  const azCommand = `az aks get-credentials -g ${resourceGroup.trim() || "<resource-group>"} -n ${clusterName.trim() || "<cluster>"} --admin --file -`;
  const [copied, setCopied] = useState(false);
  // The paste box is the primary action for Azure-personal; a toggle elsewhere.
  const isAzurePersonal = cloud === "azure" && azureMethod === "personal";
  const pasteOpen = showPaste || isAzurePersonal;

  const connect = useConnectCluster(slug, envKey);
  const meta = CLOUDS.find((c) => c.key === cloud)!;

  // Save a pasted kubeconfig onto the selected env (the manual fallback).
  const pasteSave = useMutation({
    mutationFn: () => api.patch(`/projects/${slug}/envs/${envKey}`, { kubeconfig: kubeText.trim() }),
    onSuccess: () => {
      setPasteMsg("✅ Saved — cluster connected.");
      setKubeText("");
      qc.invalidateQueries({ queryKey: ["p", slug, "envs"] });
      qc.invalidateQueries({ queryKey: ["p", slug, "cluster-status", envKey] });
    },
    onError: (e: unknown) => setPasteMsg(e instanceof Error ? e.message : "Save failed."),
  });

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

      {/* ── Terraform state backend ──────────────────────────────────────── */}
      {envs && envs.length > 0 && (
        <TerraformStateSection slug={slug} envs={envs} projectCloud={lockedCloud} />
      )}

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
            {/* Cloud provider pills — scoped to the project's target cloud. */}
            <Field label="Cloud provider">
              <div className="row gap-2 wrap">
                {availableClouds.map((c) => (
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
              <Field label="Account type" hint={azureMethod === "org" ? "Organizational (Entra) account or service principal — connects automatically." : "Personal Microsoft account that owns the subscription — connect via Cloud Shell + paste."}>
                <div className="row gap-2 wrap">
                  <button type="button" className={`chip ${azureMethod === "org" ? "active" : ""}`} style={{ height: 38 }}
                    onClick={() => { setAzureMethod("org"); setResult(null); }}>
                    Organizational account
                  </button>
                  <button type="button" className={`chip ${azureMethod === "personal" ? "active" : ""}`} style={{ height: 38 }}
                    onClick={() => { setAzureMethod("personal"); setResult(null); }}>
                    Personal account
                  </button>
                </div>
              </Field>
            )}
            {cloud === "azure" && (
              <Field label="Resource group" required hint="Resource groups that contain AKS clusters.">
                {azResourceGroups.length > 0 ? (
                  <Select value={resourceGroup} onValueChange={(v) => { setResourceGroup(v); setClusterName(""); }} ariaLabel="Resource group"
                    options={azResourceGroups.map((r) => ({ value: r, label: r }))} />
                ) : (
                  <Input value={resourceGroup} onChange={(e) => setResourceGroup(e.target.value)} placeholder="my-resource-group" />
                )}
              </Field>
            )}
            {cloud === "gcp" && (
              <>
                <Field label="Project" required hint="The GCP project ID (not the display name).">
                  {gcpProjects.length > 0 ? (
                    <Select value={project} onValueChange={setProject} ariaLabel="GCP project"
                      options={gcpProjects.map((p) => ({ value: p.projectId, label: p.name ? `${p.name} · ${p.projectId}` : p.projectId }))} />
                  ) : (
                    <Input className="mono" value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-project-id-123456" />
                  )}
                </Field>
                <Field label="Region / location" required hint="GCP location (e.g. us-central1) — the cluster's region or zone.">
                  <Select value={region} onValueChange={setRegion} ariaLabel="GCP location"
                    options={GCP_REGIONS.map((r) => ({ value: r, label: r }))} />
                </Field>
              </>
            )}

            <Field
              label={`${meta.clusterLabel} name`}
              required
              hint={cloud === "aws"
                ? (awsClustersLoading ? "Finding EKS clusters in this region…"
                  : awsClusters.length > 0 ? `Found ${awsClusters.length} cluster${awsClusters.length === 1 ? "" : "s"} in ${region} — pick one.`
                  : awsClustersResp?.note || "No EKS clusters found in this region — pick another region or type a name.")
                : undefined}
            >
              {cloud === "azure" && azClusters.length > 0 ? (
                <Select value={clusterName} onValueChange={setClusterName} ariaLabel="AKS cluster"
                  options={azClustersInRg.map((c) => ({ value: c.name, label: c.name }))} />
              ) : cloud === "aws" && awsClusters.length > 0 ? (
                <Select value={clusterName} onValueChange={setClusterName} ariaLabel="EKS cluster"
                  options={awsClusters.map((c) => ({ value: c.name, label: `${c.name}${c.version ? ` · v${c.version}` : ""}${c.status && c.status !== "ACTIVE" ? ` · ${c.status}` : ""}` }))} />
              ) : (
                <Input value={clusterName} onChange={(e) => setClusterName(e.target.value)}
                  placeholder={`type the ${meta.clusterLabel} name`}
                  onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
              )}
            </Field>

            {/* Auto-connect — for everything except Azure-personal (which can't
                fetch credentials via the app and uses the guided paste below). */}
            {(cloud !== "azure" || azureMethod === "org") && (
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Btn variant="primary" icon="globe" loading={connect.isPending} disabled={!canConnect} onClick={run}>
                  {connect.isPending ? "Connecting…" : `Connect ${meta.label}`}
                </Btn>
              </div>
            )}

            {result && <ConnectResult result={result} clusterLabel={meta.clusterLabel} />}

            {/* Azure PERSONAL-account guided connect: pick RG + cluster above, run
                this in Cloud Shell, paste the result below. */}
            {cloud === "azure" && azureMethod === "personal" && !!resourceGroup.trim() && !!clusterName.trim() && (
              <div className="col gap-2" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Get this cluster&apos;s kubeconfig</span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  1. Open Azure <b>Cloud Shell</b> (the <span className="mono">&gt;_</span> icon at the top of the Azure Portal) and run:
                </span>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <code className="mono" style={{ fontSize: 12, background: "var(--surface-2, #0000000a)", padding: "6px 8px", borderRadius: 6, flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
                    {azCommand}
                  </code>
                  <Btn variant="outline" size="sm" icon="copy"
                    onClick={() => { navigator.clipboard?.writeText(azCommand); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                    {copied ? "Copied" : "Copy"}
                  </Btn>
                </div>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  2. Copy its full output, then paste it below and Save.
                </span>
              </div>
            )}

            {/* Manual fallback: paste a kubeconfig (for clusters/accounts the
                API can't auto-fetch). Same result as auto-connect. */}
            <div className="col gap-2" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {!pasteOpen ? (
                <button
                  type="button"
                  onClick={() => { setShowPaste(true); setPasteMsg(null); }}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--accent, #5b8cff)", cursor: "pointer", fontSize: 13, textAlign: "left" }}
                >
                  Can&apos;t auto-connect? Paste a kubeconfig instead →
                </button>
              ) : (
                <>
                  <Field
                    label="Paste kubeconfig YAML"
                    required
                    hint="e.g. from Azure Cloud Shell: az aks get-credentials -g <rg> -n <name> --admin --file -  · stored encrypted on the selected environment."
                  >
                    <Textarea
                      rows={6}
                      className="mono"
                      style={{ fontSize: 12 }}
                      placeholder={"apiVersion: v1\nclusters:\n- cluster:\n    server: https://..."}
                      value={kubeText}
                      onChange={(e) => setKubeText(e.target.value)}
                    />
                  </Field>
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <Btn
                      variant="primary"
                      icon="check"
                      loading={pasteSave.isPending}
                      disabled={!envKey || kubeText.trim().length < 20 || pasteSave.isPending}
                      onClick={() => { setPasteMsg(null); pasteSave.mutate(); }}
                    >
                      Save kubeconfig
                    </Btn>
                    {!isAzurePersonal && (
                      <Btn variant="ghost" size="sm" onClick={() => { setShowPaste(false); setPasteMsg(null); }}>Cancel</Btn>
                    )}
                    {pasteMsg && <span className="muted" style={{ fontSize: 12.5 }}>{pasteMsg}</span>}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Block>
    </div>
  );
}

type TfBackend = {
  bucket: string | null;
  region: string | null;
  table: string | null;
  gcsBucket: string | null;
  azureResourceGroup: string | null;
  azureStorageAccount: string | null;
  azureContainer: string | null;
  cloudKind: string | null;
};

/**
 * Terraform remote-state backend per environment. The form shape is driven
 * by the PROJECT's cloud (locked at project creation), not the env's attached
 * provider — so a fresh GCP project shows the GCS form immediately, before
 * any env has a provider attached. Set once per environment; every cluster
 * or infra apply for that env references the same remote state.
 *
 *   • AWS   → S3 bucket + region + optional DynamoDB lock table
 *   • GCP   → GCS bucket (locks via object generations, no separate table)
 *   • Azure → Resource group + Storage Account + Blob Container (leases lock)
 */
function TerraformStateSection({
  slug,
  envs,
  projectCloud,
}: {
  slug: string;
  envs: EnvRow[];
  projectCloud: Cloud | null;
}) {
  const qc = useQueryClient();
  const [envKey, setEnvKey] = useState(envs[0]?.key ?? "");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [table, setTable] = useState("");
  const [gcsBucket, setGcsBucket] = useState("");
  const [azResourceGroup, setAzResourceGroup] = useState("");
  const [azStorageAccount, setAzStorageAccount] = useState("");
  const [azContainer, setAzContainer] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const backend = useQuery<TfBackend>({
    queryKey: ["p", slug, "tf-backend", envKey],
    queryFn: () => api.get<TfBackend>(`/projects/${slug}/envs/${envKey}/tf-backend`),
    enabled: !!envKey,
    staleTime: 30_000,
  });

  useEffect(() => {
    setBucket(backend.data?.bucket ?? "");
    setRegion(backend.data?.region ?? "us-east-1");
    setTable(backend.data?.table ?? "");
    setGcsBucket(backend.data?.gcsBucket ?? "");
    setAzResourceGroup(backend.data?.azureResourceGroup ?? "");
    setAzStorageAccount(backend.data?.azureStorageAccount ?? "");
    setAzContainer(backend.data?.azureContainer ?? "");
    setSaveMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKey, backend.data]);

  // Which form we show is a function of the project's cloud (locked at
  // creation), not the env's currently-attached provider — the point of the
  // Connection page is to set this BEFORE anything is applied. Legacy projects
  // without a locked cloud fall through to the env's cloudKind, and finally to
  // the S3 form to preserve the pre-multi-cloud behavior.
  const effectiveCloud: Cloud | null =
    projectCloud ?? (backend.data?.cloudKind as Cloud | null) ?? null;
  const isGcp = effectiveCloud === "gcp";
  const isAzure = effectiveCloud === "azure";

  const save = useMutation({
    mutationFn: () =>
      api.put<{ ok: boolean }>(
        `/projects/${slug}/envs/${envKey}/tf-backend`,
        isGcp
          ? { gcsBucket: gcsBucket.trim() }
          : isAzure
            ? {
                azureResourceGroup: azResourceGroup.trim(),
                azureStorageAccount: azStorageAccount.trim(),
                azureContainer: azContainer.trim(),
              }
            : {
                bucket: bucket.trim(),
                region: region.trim() || "us-east-1",
                table: table.trim() || undefined,
              },
      ),
    onSuccess: () => {
      setSaveMsg("Saved — every apply for this environment will use it.");
      qc.invalidateQueries({ queryKey: ["p", slug, "tf-backend", envKey] });
    },
    onError: (e: unknown) => setSaveMsg(e instanceof Error ? e.message : "Save failed."),
  });

  // Azure-only: provision the RG + storage account + container via ARM REST
  // (using the env's stored Azure creds) so the user never has to touch the
  // Azure Portal or CLI. Endpoint also persists the fields onto the env.
  const provisionAzure = useProvisionAzureTfstate(slug, envKey);
  const provisionMsg = provisionAzure.data?.ok
    ? `✅ ${provisionAzure.data.steps?.join(" · ") ?? "Provisioned."} Saved onto the env — you can Rerun the apply now.`
    : provisionAzure.error instanceof Error
      ? provisionAzure.error.message
      : provisionAzure.data && provisionAzure.data.ok === false
        ? provisionAzure.data.message ?? "Provision failed."
        : null;

  const saveDisabled =
    save.isPending ||
    (isGcp
      ? !gcsBucket.trim()
      : isAzure
        ? !azResourceGroup.trim() || !azStorageAccount.trim() || !azContainer.trim()
        : !bucket.trim());

  const sub = isGcp
    ? "Where Terraform state lives for this environment's applies (GCS bucket — GCS uses object generations for locking, no separate lock table). Set once — required before any GKE/GCP apply."
    : isAzure
      ? "Where Terraform state lives for this environment's applies (Resource group + Storage Account + Blob Container — Azure uses blob leases for locking, no separate lock table). Set once — required before any AKS/Azure apply."
      : "Where Terraform state lives for this environment's applies (S3 bucket + optional DynamoDB lock table). Set once per environment — required before any 'Apply to AWS' step.";

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={sub}>
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="db" size={16} /> Terraform state backend
          </span>
        </Block.Title>
      </Block.Header>
      <div className="col gap-3" style={{ maxWidth: 480 }}>
        <Field label="Environment">
          <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment"
            options={envs.map((e) => ({ value: e.key, label: e.name || e.key }))} />
        </Field>
        {isGcp ? (
          <Field label="GCS state bucket" hint="Stores this environment's Terraform state remotely. Required before applying.">
            <Input className="mono" value={gcsBucket} placeholder="tfstate-yourorg-projectname" onChange={(e) => setGcsBucket(e.target.value)} />
          </Field>
        ) : isAzure ? (
          <>
            <Field label="Resource group" hint="The resource group that owns the storage account.">
              <Input className="mono" value={azResourceGroup} placeholder="tfstate-rg" onChange={(e) => setAzResourceGroup(e.target.value)} />
            </Field>
            <Field label="Storage account" hint="Globally unique, 3-24 lowercase letters/digits.">
              <Input className="mono" value={azStorageAccount} placeholder="mytfstateacct" onChange={(e) => setAzStorageAccount(e.target.value)} />
            </Field>
            <Field label="Blob container" hint="Container inside the storage account. Required.">
              <Input className="mono" value={azContainer} placeholder="tfstate" onChange={(e) => setAzContainer(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="S3 state bucket" hint="Stores this environment's Terraform state remotely. Required before applying.">
              <Input className="mono" value={bucket} placeholder="my-project-tfstate" onChange={(e) => setBucket(e.target.value)} />
            </Field>
            <Field label="Bucket region">
              <Select value={region} onValueChange={setRegion} ariaLabel="Bucket region"
                options={AWS_REGIONS.map((r) => ({ value: r, label: r }))} />
            </Field>
            <Field label="DynamoDB lock table" hint="Prevents concurrent applies from corrupting state. Optional.">
              <Input className="mono" value={table} placeholder="terraform-locks" onChange={(e) => setTable(e.target.value)} />
            </Field>
          </>
        )}
        <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
          <Btn variant="primary" icon="check" loading={save.isPending} disabled={saveDisabled} onClick={() => save.mutate()}>
            Save
          </Btn>
          {isAzure && (
            <Btn
              variant="outline"
              icon="cloud"
              loading={provisionAzure.isPending}
              disabled={saveDisabled || provisionAzure.isPending}
              title="Create the resource group, storage account, and blob container in Azure using this env's stored creds. 30-90s."
              onClick={() =>
                provisionAzure.mutate({
                  resourceGroup: azResourceGroup.trim(),
                  storageAccount: azStorageAccount.trim(),
                  container: azContainer.trim(),
                })
              }
            >
              Provision in Azure
            </Btn>
          )}
          {saveMsg && <span className="muted" style={{ fontSize: 12.5 }}>{saveMsg}</span>}
          {provisionMsg && (
            <span
              style={{
                fontSize: 12.5,
                color: provisionAzure.data?.ok ? "var(--ok, #30a46c)" : "var(--danger, #e5484d)",
              }}
            >
              {provisionMsg}
            </span>
          )}
        </div>
      </div>
    </Block>
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
