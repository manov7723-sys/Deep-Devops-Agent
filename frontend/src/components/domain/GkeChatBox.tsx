"use client";

/**
 * GKE creation wizard — the GCP field script for the shared console-style
 * `ClusterChat` engine. Production-shaped: release channel, private cluster,
 * Dataplane V2, Workload Identity, Shielded nodes, Binary Authorization,
 * system + app node pools, Managed Prometheus and add-ons. The GCP project +
 * networks are live dropdowns. No LLM.
 */
import { ClusterChat, type ClusterChatConfig, type Step, type StepCtx } from "@/components/domain/cluster-chat-engine";

const NAME_RE = /^[a-z][a-z0-9-]{1,38}$/;

const strList = (c: StepCtx, key: string, fallback: string[]): string[] => {
  const v = c.opts?.[key];
  return Array.isArray(v) && v.length ? (v as string[]) : fallback;
};

type GcpContext = {
  connected?: boolean;
  gcpProjectId?: string | null;
  projects?: { projectId: string; name: string; lifecycleState: string }[];
};
type GcpNetworksSource = {
  connected?: boolean;
  networks?: { name: string; selfLink: string }[];
  subnetworks?: { name: string; network: string; region: string; ipCidrRange: string }[];
  note?: string;
};

const STEPS: Step[] = [
  // ── Page 1 · Cluster basics ──────────────────────────────────────────
  {
    page: 1, kind: "select", key: "envKey", label: "Environment",
    hint: "Provides the GCP credentials and state backend.",
    emptyNote: "Create an environment first, then come back.",
    options: (c) => c.envs.map((e) => ({ value: e.key, label: e.name || e.key })),
  },
  {
    page: 1, kind: "text", key: "name", label: "Cluster name",
    hint: "Lowercase letters, digits, hyphens; start with a letter.",
    placeholder: "my-cluster",
    validate: (v) => (NAME_RE.test(v) ? null : "Lowercase letters, digits and hyphens; start with a letter."),
  },
  {
    page: 1, kind: "select", key: "project", label: "GCP project",
    hint: "The Google Cloud project the cluster is created in.",
    emptyNote: "No GCP projects visible. Connect GCP (with Resource Manager access) on the Cloud providers page.",
    options: (c) => {
      const ctx = c.sources?.gcpProjects as GcpContext | undefined;
      const list = ctx?.projects ?? [];
      const opts = list.map((p) => ({ value: p.projectId, label: p.name ? `${p.name} · ${p.projectId}` : p.projectId }));
      if (opts.length === 0 && ctx?.gcpProjectId) return [{ value: ctx.gcpProjectId, label: ctx.gcpProjectId }];
      return opts;
    },
    default: (c) => {
      const ctx = c.sources?.gcpProjects as GcpContext | undefined;
      return ctx?.gcpProjectId ?? ctx?.projects?.[0]?.projectId ?? "";
    },
  },
  {
    page: 1, kind: "text", key: "location", label: "Location (region)",
    hint: "Region (e.g. us-central1) for a regional cluster — recommended for prod.",
    placeholder: "us-central1", default: () => "us-central1",
  },
  {
    page: 1, kind: "choice", key: "releaseChannel", label: "Release channel",
    choices: [{ value: "REGULAR", label: "Regular" }, { value: "STABLE", label: "Stable" }, { value: "RAPID", label: "Rapid" }],
  },
  {
    page: 1, kind: "select", key: "kubernetesVersion", label: "Kubernetes version",
    options: (c) => strList(c, "kubernetesVersions", ["1.30"]).map((v) => ({ value: v, label: v })),
  },
  {
    page: 1, kind: "select", key: "machineType", label: "System node machine type",
    options: (c) => strList(c, "machineTypes", ["n2-standard-4"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 1, kind: "number", key: "desiredNodes", label: "System nodes per zone",
    default: () => "1", validate: (v) => (Number(v) >= 1 ? null : "At least 1 node."),
  },
  {
    page: 1, kind: "number", key: "minNodes", label: "System min nodes",
    default: () => "1",
    validate: (v, a) => (Number(v) >= 1 && Number(v) <= Number(a.desiredNodes) ? null : "Min must be ≥ 1 and ≤ desired."),
  },
  {
    page: 1, kind: "number", key: "maxNodes", label: "System max nodes",
    default: () => "3", validate: (v, a) => (Number(v) >= Number(a.desiredNodes) ? null : "Max must be ≥ desired."),
  },
  // ── Page 2 · Security & identity ─────────────────────────────────────
  {
    page: 2, kind: "choice", key: "workloadIdentity", label: "Workload Identity",
    hint: "Federated GCP IAM for pods — replaces service-account keys.",
    choices: [{ value: true, label: "Enabled (recommended)" }, { value: false, label: "Disabled" }],
  },
  {
    page: 2, kind: "choice", key: "shieldedNodes", label: "Shielded GKE nodes",
    hint: "Secure boot + integrity monitoring.",
    choices: [{ value: true, label: "Enabled (recommended)" }, { value: false, label: "Disabled" }],
  },
  {
    page: 2, kind: "choice", key: "binaryAuthorization", label: "Binary Authorization",
    hint: "Enforce signed/attested images only.",
    choices: [{ value: true, label: "Enabled" }, { value: false, label: "Disabled" }],
  },
  {
    page: 2, kind: "choice", key: "dataplaneV2", label: "Dataplane V2",
    hint: "eBPF dataplane (includes network policy).",
    choices: [{ value: true, label: "Enabled (recommended)" }, { value: false, label: "Disabled" }],
  },
  {
    page: 2, kind: "choice", key: "intranodeVisibility", label: "Intranode visibility",
    choices: [{ value: true, label: "Enabled" }, { value: false, label: "Disabled" }],
  },
  {
    page: 2, kind: "choice", key: "privateNodes", label: "Private nodes",
    hint: "Nodes get no public IPs.",
    choices: [{ value: true, label: "Private nodes (recommended)" }, { value: false, label: "Public nodes" }],
  },
  {
    page: 2, kind: "choice", key: "privateEndpoint", label: "Private control-plane endpoint",
    hint: "Control plane reachable only from authorized networks.",
    skip: (a) => a.privateNodes !== true,
    choices: [{ value: false, label: "Public endpoint" }, { value: true, label: "Private endpoint" }],
  },
  {
    page: 2, kind: "text", key: "masterAuthorizedCidrs", label: "Master authorized networks", mono: true, optional: true,
    hint: "CIDRs allowed to reach the control plane (comma-separated). Leave blank for open.",
    placeholder: "1.2.3.4/32, 10.0.0.0/8",
  },
  // ── Page 3 · Node pools ──────────────────────────────────────────────
  {
    page: 3, kind: "select", key: "systemDiskType", label: "Node disk type",
    options: (c) => strList(c, "diskTypes", ["pd-ssd", "pd-balanced", "pd-standard"]).map((d) => ({ value: d, label: d })),
    default: () => "pd-ssd",
  },
  {
    page: 3, kind: "select", key: "systemDiskSize", label: "Node disk size (GB)",
    options: (c) => (strList(c, "diskSizes", ["50", "100", "150", "200"]) as unknown[]).map((d) => ({ value: String(d), label: `${d} GB` })),
    default: () => "100",
  },
  {
    page: 3, kind: "choice", key: "appNodePool", label: "Application node pool",
    hint: "Add a second node pool for app workloads (system pool gets tainted for critical add-ons).",
    choices: [{ value: true, label: "Add app node pool" }, { value: false, label: "System pool only" }],
  },
  {
    page: 3, kind: "select", key: "appMachineType", label: "App node machine type",
    skip: (a) => a.appNodePool !== true,
    options: (c) => strList(c, "machineTypes", ["n2-standard-4"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 3, kind: "choice", key: "appSpot", label: "App node type",
    skip: (a) => a.appNodePool !== true,
    choices: [{ value: true, label: "Spot (cost-saving)" }, { value: false, label: "Standard" }],
  },
  {
    page: 3, kind: "number", key: "appMinNodes", label: "App min nodes", default: () => "2",
    skip: (a) => a.appNodePool !== true,
  },
  {
    page: 3, kind: "number", key: "appMaxNodes", label: "App max nodes", default: () => "10",
    skip: (a) => a.appNodePool !== true,
    validate: (v, a) => (Number(v) >= Number(a.appMinNodes ?? 1) ? null : "Max must be ≥ min."),
  },
  // ── Page 4 · Add-ons & tags ──────────────────────────────────────────
  {
    page: 4, kind: "choice", key: "monitoring", label: "Cloud Logging + Managed Prometheus",
    choices: [{ value: true, label: "Enabled (recommended)" }, { value: false, label: "Disabled" }],
  },
  {
    page: 4, kind: "choice", key: "httpLoadBalancing", label: "HTTP(S) Load Balancing",
    choices: [{ value: true, label: "Enabled" }, { value: false, label: "Disabled" }],
  },
  {
    page: 4, kind: "choice", key: "gatewayApi", label: "Gateway API",
    choices: [{ value: true, label: "Enabled" }, { value: false, label: "Disabled" }],
  },
  {
    page: 4, kind: "choice", key: "backupAgent", label: "Backup for GKE",
    choices: [{ value: true, label: "Enabled" }, { value: false, label: "Disabled" }],
  },
  {
    page: 4, kind: "choice", key: "cloudDns", label: "Cloud DNS for cluster",
    choices: [{ value: false, label: "kube-dns (default)" }, { value: true, label: "Cloud DNS" }],
  },
  {
    page: 4, kind: "choice", key: "configConnector", label: "Config Connector",
    choices: [{ value: false, label: "Disabled" }, { value: true, label: "Enabled" }],
  },
  { page: 4, kind: "text", key: "environment", label: "Environment label", placeholder: "production", default: () => "production" },
  { page: 4, kind: "text", key: "team", label: "Team label", placeholder: "devops", default: () => "devops" },
  { page: 4, kind: "text", key: "costCenter", label: "Cost center label", optional: true, placeholder: "cc-1234" },
  // ── Page 5 · Networking & repository ─────────────────────────────────
  {
    page: 5, kind: "choice", key: "createNetwork", label: "Networking",
    choices: [{ value: true, label: "Create a new VPC" }, { value: false, label: "Reuse an existing network" }],
  },
  {
    page: 5, kind: "select", key: "existingNetwork", label: "Existing network",
    hint: "VPC networks in the selected GCP project.",
    emptyNote: "No networks found (or GCP isn't reachable). Switch back to “Create a new VPC”, or check the GCP connection.",
    skip: (a) => a.createNetwork !== false,
    options: (c) => {
      const src = c.sources?.gcpNetworks as GcpNetworksSource | undefined;
      return (src?.networks ?? []).map((n) => ({ value: n.name, label: n.name }));
    },
  },
  {
    page: 5, kind: "select", key: "existingSubnetwork", label: "Existing subnetwork", optional: true,
    hint: "Subnetworks in the selected network & region. Leave unset to let GKE auto-allocate.",
    emptyNote: "No subnetworks found for the selected network in this region.",
    skip: (a) => a.createNetwork !== false,
    options: (c) => {
      const src = c.sources?.gcpNetworks as GcpNetworksSource | undefined;
      const net = String(c.answers.existingNetwork ?? "");
      return (src?.subnetworks ?? [])
        .filter((s) => !net || s.network === net)
        .map((s) => ({ value: s.name, label: `${s.name} · ${s.ipCidrRange}` }));
    },
  },
  {
    page: 5, kind: "select", key: "repoFullName", label: "GitHub repository",
    hint: "The generated Terraform is committed here.",
    emptyNote: "Attach a repo on the CI/CD & Repos tab first.",
    options: (c) => c.repos.map((r) => ({ value: r.fullName, label: r.fullName })),
  },
  {
    page: 5, kind: "text", key: "ghPath", label: "GitHub file path (folder)",
    placeholder: "terraform/gke/my-cluster",
    default: (c) => `terraform/gke/${String(c.answers.name ?? "").trim() || "my-cluster"}`,
  },
];

const GKE_CONFIG: ClusterChatConfig = {
  cloud: "gcp",
  cloudLabel: "GCP",
  title: "Create GKE cluster",
  blueprintSub: "Production GKE blueprint (private, Dataplane V2, Workload Identity, system + app pools, Managed Prometheus). No LLM — runs init → plan → apply.",
  optionsPath: "gke",
  stackPrefix: "gke",
  ghPathPrefix: "terraform/gke",
  branchPrefix: "gke",
  applyEta: "~5–10 min",
  pageTitles: ["Cluster basics", "Security & identity", "Node pools", "Add-ons & tags", "Networking & repository"],
  extraQueries: [
    { key: "gcpProjects", path: "gcp/context" },
    {
      key: "gcpNetworks",
      path: "gcp/networks",
      params: (a) => (a.project ? { project: String(a.project), region: String(a.location ?? "") } : null),
      enabled: (a) => a.createNetwork === false && !!a.project,
    },
  ],
  steps: STEPS,
  buildBody: (a) => ({
    name: String(a.name).trim(),
    project: String(a.project).trim(),
    location: String(a.location).trim(),
    kubernetesVersion: a.kubernetesVersion,
    machineType: a.machineType,
    desiredNodes: Number(a.desiredNodes),
    minNodes: Number(a.minNodes),
    maxNodes: Number(a.maxNodes),
    privateNodes: a.privateNodes !== false,
    envKey: a.envKey,
    createNetwork: a.createNetwork !== false,
    existingNetwork: a.createNetwork === false ? String(a.existingNetwork ?? "").trim() : undefined,
    existingSubnetwork:
      a.createNetwork === false && String(a.existingSubnetwork ?? "").trim()
        ? String(a.existingSubnetwork).trim()
        : undefined,
    // Production options.
    environment: String(a.environment ?? "production").trim() || "production",
    team: String(a.team ?? "devops").trim() || "devops",
    costCenter: String(a.costCenter ?? "").trim() || undefined,
    releaseChannel: a.releaseChannel === "STABLE" ? "STABLE" : a.releaseChannel === "RAPID" ? "RAPID" : "REGULAR",
    privateEndpoint: a.privateNodes !== false && a.privateEndpoint === true,
    masterAuthorizedCidrs: String(a.masterAuthorizedCidrs ?? "").trim() || undefined,
    dataplaneV2: a.dataplaneV2 !== false,
    workloadIdentity: a.workloadIdentity !== false,
    shieldedNodes: a.shieldedNodes !== false,
    binaryAuthorization: a.binaryAuthorization !== false,
    intranodeVisibility: a.intranodeVisibility !== false,
    gatewayApi: a.gatewayApi !== false,
    cloudDns: a.cloudDns === true,
    monitoring: a.monitoring !== false,
    httpLoadBalancing: a.httpLoadBalancing !== false,
    backupAgent: a.backupAgent !== false,
    configConnector: a.configConnector === true,
    systemDiskType: a.systemDiskType === "pd-balanced" ? "pd-balanced" : a.systemDiskType === "pd-standard" ? "pd-standard" : "pd-ssd",
    systemDiskSize: Number(a.systemDiskSize ?? 100),
    appNodePool: a.appNodePool === true,
    appMachineType: a.appNodePool === true ? String(a.appMachineType ?? a.machineType) : undefined,
    appSpot: a.appNodePool === true ? a.appSpot !== false : undefined,
    appMinNodes: a.appNodePool === true ? Number(a.appMinNodes ?? 2) : undefined,
    appMaxNodes: a.appNodePool === true ? Number(a.appMaxNodes ?? 10) : undefined,
  }),
};

export function GkeChatBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={GKE_CONFIG} />;
}
