"use client";

/**
 * Connect an EXISTING Kubernetes cluster (EKS / AKS / GKE) — ported from the
 * deleted Connection tab. No LLM: pick a cloud, point at a running cluster,
 * connect. Rendered inline in chat via the ```cluster-connect``` fence. For
 * PROVISIONING a brand-new cluster use the eks-create/gke-create/aks-create/
 * proxmox-vm fences instead — this box only wires up one that already exists.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api/client";
import {
  useClusterStatus,
  useConnectCluster,
  type ConnectClusterResult,
} from "@/hooks/queries/connectivity";
import { useActiveEnv } from "@/hooks/useActiveEnv";

type EnvRow = {
  id: string;
  key: string;
  name: string;
  cloudProviderId?: string | null;
  hasKubeconfig?: boolean;
};
type Cloud = "aws" | "azure" | "gcp";

const CLOUDS: { key: Cloud; label: string; clusterLabel: string }[] = [
  { key: "aws", label: "AWS", clusterLabel: "EKS cluster" },
  { key: "azure", label: "Azure", clusterLabel: "AKS cluster" },
  { key: "gcp", label: "GCP", clusterLabel: "GKE cluster" },
];

const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ca-central-1",
  "sa-east-1",
];
const GCP_REGIONS = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
  "us-south1",
  "northamerica-northeast1",
  "southamerica-east1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-north1",
  "asia-east1",
  "asia-northeast1",
  "asia-south1",
  "asia-southeast1",
  "australia-southeast1",
];

type GcpContext = { projects?: { projectId: string; name: string }[] };
type AzureCluster = { name: string; resourceGroup: string; location: string };
type AzureClustersResp = { clusters?: AzureCluster[]; note?: string };
type AwsCluster = { name: string; status?: string; version?: string };
type AwsClustersResp = { connected?: boolean; clusters?: AwsCluster[]; note?: string };

export function ClusterConnectBox({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  const { data: projectInfo } = useQuery<{ project: { cloud: string | null } }>({
    queryKey: ["p", slug, "project-cloud"],
    queryFn: () => api.get<{ project: { cloud: string | null } }>(`/projects/${slug}`),
    staleTime: 60_000,
  });
  const lockedCloud = (projectInfo?.project?.cloud as Cloud | null) ?? null;
  const availableClouds = lockedCloud ? CLOUDS.filter((c) => c.key === lockedCloud) : CLOUDS;

  const projectActiveEnv = useActiveEnv(slug);
  const [envKey, setEnvKey] = useState("");
  const [cloud, setCloud] = useState<Cloud>("aws");
  const [clusterName, setClusterName] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [resourceGroup, setResourceGroup] = useState("");
  const [project, setProject] = useState("");
  const [result, setResult] = useState<ConnectClusterResult | null>(null);
  const [azureMethod, setAzureMethod] = useState<"org" | "personal">("org");
  const [showPaste, setShowPaste] = useState(false);
  const [kubeText, setKubeText] = useState("");
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);

  useEffect(() => {
    if (envKey || !envs || envs.length === 0) return;
    const active =
      projectActiveEnv && envs.find((e) => e.key === projectActiveEnv)
        ? projectActiveEnv
        : envs[0].key;
    setEnvKey(active);
  }, [envs, envKey, projectActiveEnv]);

  useEffect(() => {
    if (lockedCloud && cloud !== lockedCloud) setCloud(lockedCloud);
  }, [lockedCloud, cloud]);

  useEffect(() => {
    if (cloud === "gcp" && !GCP_REGIONS.includes(region)) setRegion("us-central1");
    if (cloud === "aws" && !AWS_REGIONS.includes(region)) setRegion("us-east-1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud]);

  const { data: gcpCtx } = useQuery<GcpContext>({
    queryKey: ["p", slug, "gcp-context"],
    queryFn: () => api.get<GcpContext>(`/projects/${slug}/gcp/context`),
    enabled: cloud === "gcp",
    staleTime: 60_000,
  });
  const gcpProjects = gcpCtx?.projects ?? [];

  const { data: azClustersResp } = useQuery<AzureClustersResp>({
    queryKey: ["p", slug, "azure-clusters"],
    queryFn: () => api.get<AzureClustersResp>(`/projects/${slug}/azure/clusters`),
    enabled: cloud === "azure",
    staleTime: 60_000,
  });
  const azClusters = azClustersResp?.clusters ?? [];
  const azResourceGroups = Array.from(new Set(azClusters.map((c) => c.resourceGroup)))
    .filter(Boolean)
    .sort();
  const azClustersInRg = azClusters.filter((c) => c.resourceGroup === resourceGroup);

  const { data: awsClustersResp, isFetching: awsClustersLoading } = useQuery<AwsClustersResp>({
    queryKey: ["p", slug, "aws-clusters", region],
    queryFn: () =>
      api.get<AwsClustersResp>(
        `/projects/${slug}/aws/clusters?region=${encodeURIComponent(region)}`,
      ),
    enabled: cloud === "aws" && !!region.trim(),
    staleTime: 30_000,
  });
  const awsClusters = awsClustersResp?.clusters ?? [];
  const azCommand = `az aks get-credentials -g ${resourceGroup.trim() || "<resource-group>"} -n ${clusterName.trim() || "<cluster>"} --admin --file -`;
  const [copied, setCopied] = useState(false);
  const isAzurePersonal = cloud === "azure" && azureMethod === "personal";
  const pasteOpen = showPaste || isAzurePersonal;

  const connect = useConnectCluster(slug, envKey);
  const meta = CLOUDS.find((c) => c.key === cloud)!;

  const pasteSave = useMutation({
    mutationFn: () =>
      api.patch(`/projects/${slug}/envs/${envKey}`, { kubeconfig: kubeText.trim() }),
    onSuccess: () => {
      setPasteMsg("Saved — cluster connected.");
      setKubeText("");
      qc.invalidateQueries({ queryKey: ["p", slug, "envs"] });
      qc.invalidateQueries({ queryKey: ["p", slug, "cluster-status", envKey] });
    },
    onError: (e: unknown) => setPasteMsg(e instanceof Error ? e.message : "Save failed."),
  });

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
          qc.invalidateQueries({ queryKey: ["p", slug, "envs"] });
          qc.invalidateQueries({ queryKey: ["p", slug, "cluster-status", envKey] });
        },
        onError: (e: unknown) =>
          setResult({ ok: false, message: e instanceof Error ? e.message : "Connection failed." }),
      },
    );
  }

  const selectedEnv = envs?.find((e) => e.key === envKey);

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Pick a cloud, point at a running cluster, and connect. After connecting, the agent can list pods, scale, and read logs.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="globe" size={16} /> Connect Kubernetes cluster
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {!envs || envs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Create an environment first — ask the agent to create one.
          </span>
        ) : (
          <div className="col gap-3" style={{ maxWidth: 520 }}>
            <Field label="Cloud provider">
              <div className="row gap-2 wrap">
                {availableClouds.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`chip ${cloud === c.key ? "active" : ""}`}
                    style={{ height: 38 }}
                    onClick={() => {
                      setCloud(c.key);
                      setResult(null);
                    }}
                  >
                    <Icon name="cloud" size={15} /> {c.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label="Environment"
              hint="Where the kubeconfig (and AWS creds, for EKS) come from / are stored."
            >
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Select
                  value={envKey}
                  onValueChange={setEnvKey}
                  ariaLabel="Environment"
                  options={envs.map((e) => ({
                    value: e.key,
                    label: `${e.name || e.key}${e.hasKubeconfig ? " · connected" : ""}`,
                  }))}
                />
                {selectedEnv?.hasKubeconfig && (
                  <Badge tone="ok" withDot>
                    connected
                  </Badge>
                )}
              </div>
            </Field>

            {selectedHasKube && (
              <div className="col gap-2" style={{ marginTop: 4 }}>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <Badge tone="ok" withDot>
                    connected
                  </Badge>
                  {clusterStatus.data?.cluster && (
                    <span style={{ fontWeight: 600 }}>{clusterStatus.data.cluster}</span>
                  )}
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    kubeconfig stored on env
                  </span>
                </div>
                {clusterStatus.isLoading ? (
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Checking cluster…
                  </span>
                ) : clusterStatus.data?.verified &&
                  clusterStatus.data.nodes &&
                  clusterStatus.data.nodes.length > 0 ? (
                  <div className="col gap-1">
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {clusterStatus.data.nodes.length} node(s):
                    </span>
                    {clusterStatus.data.nodes.map((n) => (
                      <div
                        key={n.name}
                        className="row gap-2"
                        style={{ alignItems: "center", fontSize: 12.5 }}
                      >
                        <Badge tone={n.status === "Ready" ? "ok" : "warn"} withDot>
                          {n.status}
                        </Badge>
                        <span className="mono">{n.name}</span>
                        <span className="faint">{n.version}</span>
                      </div>
                    ))}
                  </div>
                ) : clusterStatus.data?.verified ? (
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Verified — no nodes reported.
                  </span>
                ) : (
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Stored, but couldn&apos;t verify with kubectl
                    {clusterStatus.data?.verifyError
                      ? ` (${clusterStatus.data.verifyError.slice(0, 120)})`
                      : ""}
                    .
                  </span>
                )}
              </div>
            )}

            {cloud === "aws" && (
              <Field label="Region" required>
                <Select
                  value={region}
                  onValueChange={setRegion}
                  ariaLabel="AWS region"
                  options={AWS_REGIONS.map((r) => ({ value: r, label: r }))}
                />
              </Field>
            )}
            {cloud === "azure" && (
              <Field
                label="Account type"
                hint={
                  azureMethod === "org"
                    ? "Organizational (Entra) account or service principal — connects automatically."
                    : "Personal Microsoft account that owns the subscription — connect via Cloud Shell + paste."
                }
              >
                <div className="row gap-2 wrap">
                  <button
                    type="button"
                    className={`chip ${azureMethod === "org" ? "active" : ""}`}
                    style={{ height: 38 }}
                    onClick={() => {
                      setAzureMethod("org");
                      setResult(null);
                    }}
                  >
                    Organizational account
                  </button>
                  <button
                    type="button"
                    className={`chip ${azureMethod === "personal" ? "active" : ""}`}
                    style={{ height: 38 }}
                    onClick={() => {
                      setAzureMethod("personal");
                      setResult(null);
                    }}
                  >
                    Personal account
                  </button>
                </div>
              </Field>
            )}
            {cloud === "azure" && (
              <Field
                label="Resource group"
                required
                hint="Resource groups that contain AKS clusters."
              >
                {azResourceGroups.length > 0 ? (
                  <Select
                    value={resourceGroup}
                    onValueChange={(v) => {
                      setResourceGroup(v);
                      setClusterName("");
                    }}
                    ariaLabel="Resource group"
                    options={azResourceGroups.map((r) => ({ value: r, label: r }))}
                  />
                ) : (
                  <Input
                    value={resourceGroup}
                    onChange={(e) => setResourceGroup(e.target.value)}
                    placeholder="my-resource-group"
                  />
                )}
              </Field>
            )}
            {cloud === "gcp" && (
              <>
                <Field label="Project" required hint="The GCP project ID (not the display name).">
                  {gcpProjects.length > 0 ? (
                    <Select
                      value={project}
                      onValueChange={setProject}
                      ariaLabel="GCP project"
                      options={gcpProjects.map((p) => ({
                        value: p.projectId,
                        label: p.name ? `${p.name} · ${p.projectId}` : p.projectId,
                      }))}
                    />
                  ) : (
                    <Input
                      className="mono"
                      value={project}
                      onChange={(e) => setProject(e.target.value)}
                      placeholder="my-project-id-123456"
                    />
                  )}
                </Field>
                <Field
                  label="Region / location"
                  required
                  hint="GCP location (e.g. us-central1) — the cluster's region or zone."
                >
                  <Select
                    value={region}
                    onValueChange={setRegion}
                    ariaLabel="GCP location"
                    options={GCP_REGIONS.map((r) => ({ value: r, label: r }))}
                  />
                </Field>
              </>
            )}

            <Field
              label={`${meta.clusterLabel} name`}
              required
              hint={
                cloud === "aws"
                  ? awsClustersLoading
                    ? "Finding EKS clusters in this region…"
                    : awsClusters.length > 0
                      ? `Found ${awsClusters.length} cluster${awsClusters.length === 1 ? "" : "s"} in ${region} — pick one.`
                      : awsClustersResp?.note ||
                        "No EKS clusters found in this region — pick another region or type a name."
                  : undefined
              }
            >
              {cloud === "azure" && azClusters.length > 0 ? (
                <Select
                  value={clusterName}
                  onValueChange={setClusterName}
                  ariaLabel="AKS cluster"
                  options={azClustersInRg.map((c) => ({ value: c.name, label: c.name }))}
                />
              ) : cloud === "aws" && awsClusters.length > 0 ? (
                <Select
                  value={clusterName}
                  onValueChange={setClusterName}
                  ariaLabel="EKS cluster"
                  options={awsClusters.map((c) => ({
                    value: c.name,
                    label: `${c.name}${c.version ? ` · v${c.version}` : ""}${c.status && c.status !== "ACTIVE" ? ` · ${c.status}` : ""}`,
                  }))}
                />
              ) : (
                <Input
                  value={clusterName}
                  onChange={(e) => setClusterName(e.target.value)}
                  placeholder={`type the ${meta.clusterLabel} name`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") run();
                  }}
                />
              )}
            </Field>

            {(cloud !== "azure" || azureMethod === "org") && (
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Btn
                  variant="primary"
                  icon="globe"
                  loading={connect.isPending}
                  disabled={!canConnect}
                  onClick={run}
                >
                  {connect.isPending ? "Connecting…" : `Connect ${meta.label}`}
                </Btn>
              </div>
            )}

            {result && <ConnectResult result={result} clusterLabel={meta.clusterLabel} />}

            {cloud === "azure" &&
              azureMethod === "personal" &&
              !!resourceGroup.trim() &&
              !!clusterName.trim() && (
                <div
                  className="col gap-2"
                  style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    Get this cluster&apos;s kubeconfig
                  </span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    1. Open Azure <b>Cloud Shell</b> (the <span className="mono">&gt;_</span> icon
                    at the top of the Azure Portal) and run:
                  </span>
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <code
                      className="mono"
                      style={{
                        fontSize: 12,
                        background: "var(--surface-2, #0000000a)",
                        padding: "6px 8px",
                        borderRadius: 6,
                        flex: 1,
                        overflowX: "auto",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {azCommand}
                    </code>
                    <Btn
                      variant="outline"
                      size="sm"
                      icon="copy"
                      onClick={() => {
                        navigator.clipboard?.writeText(azCommand);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? "Copied" : "Copy"}
                    </Btn>
                  </div>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    2. Copy its full output, then paste it below and Save.
                  </span>
                </div>
              )}

            <div
              className="col gap-2"
              style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
            >
              {!pasteOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowPaste(true);
                    setPasteMsg(null);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--accent, #5b8cff)",
                    cursor: "pointer",
                    fontSize: 13,
                    textAlign: "left",
                  }}
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
                      onClick={() => {
                        setPasteMsg(null);
                        pasteSave.mutate();
                      }}
                    >
                      Save kubeconfig
                    </Btn>
                    {!isAzurePersonal && (
                      <Btn
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowPaste(false);
                          setPasteMsg(null);
                        }}
                      >
                        Cancel
                      </Btn>
                    )}
                    {pasteMsg && (
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {pasteMsg}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Block.Body>
    </Block>
  );
}

function ConnectResult({
  result,
  clusterLabel,
}: {
  result: ConnectClusterResult;
  clusterLabel: string;
}) {
  if (!result.ok) {
    return (
      <div className="col gap-1" style={{ marginTop: 4 }}>
        <span style={{ color: "var(--danger, #e5484d)", fontSize: 13 }}>
          {result.message ?? "Connection failed."}
        </span>
        {result.stderr && (
          <pre
            style={{
              fontSize: 11.5,
              whiteSpace: "pre-wrap",
              margin: 0,
              maxHeight: 180,
              overflowY: "auto",
              background: "var(--surface-2, #0000000a)",
              padding: 8,
              borderRadius: 6,
            }}
          >
            {result.stderr}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div className="col gap-2" style={{ marginTop: 4 }}>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <Badge tone="ok" withDot>
          connected
        </Badge>
        <span style={{ fontWeight: 600 }}>{result.cluster}</span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          kubeconfig stored on env
        </span>
      </div>
      {result.verified ? (
        result.nodes && result.nodes.length > 0 ? (
          <div className="col gap-1">
            <span className="muted" style={{ fontSize: 12.5 }}>
              {result.nodes.length} node(s):
            </span>
            {result.nodes.map((n) => (
              <div
                key={n.name}
                className="row gap-2"
                style={{ alignItems: "center", fontSize: 12.5 }}
              >
                <Badge tone={n.status === "Ready" ? "ok" : "warn"} withDot>
                  {n.status}
                </Badge>
                <span className="mono">{n.name}</span>
                <span className="faint">{n.version}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Verified — no nodes reported.
          </span>
        )
      ) : (
        <span className="muted" style={{ fontSize: 12.5 }}>
          Stored, but couldn&apos;t verify with kubectl
          {result.verifyError ? ` (${result.verifyError.slice(0, 120)})` : ""}. The {clusterLabel}{" "}
          may be unreachable from the server.
        </span>
      )}
    </div>
  );
}
