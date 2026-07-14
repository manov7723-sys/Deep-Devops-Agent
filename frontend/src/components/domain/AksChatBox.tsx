"use client";

/**
 * AKS creation wizard — the Azure field script for the shared console-style
 * `ClusterChat` engine. Production-shaped: tags, SKU tier, zones, Entra ID +
 * Azure RBAC, private cluster, system + app node pools, monitoring and security
 * add-ons. Resource group / VNet / subnet are live dropdowns. No LLM.
 */
import {
  ClusterChat,
  type ClusterChatConfig,
  type Step,
  type StepCtx,
} from "@/components/domain/cluster-chat-engine";

const NAME_RE = /^[a-z][a-z0-9-]{1,38}$/;

const strList = (c: StepCtx, key: string, fallback: string[]): string[] => {
  const v = c.opts?.[key];
  return Array.isArray(v) && v.length ? (v as string[]) : fallback;
};

type AzVnet = {
  name: string;
  resourceGroup: string;
  location: string;
  subnets: { name: string; id: string; addressPrefix: string }[];
};
type AzureNetworksSource = {
  connected?: boolean;
  resourceGroups?: { name: string; location: string }[];
  vnets?: AzVnet[];
  note?: string;
};

const vnetRefValue = (v: AzVnet) => `${v.resourceGroup}|${v.name}`;

const STEPS: Step[] = [
  // ── Page 1 · Cluster basics ──────────────────────────────────────────
  {
    page: 1,
    kind: "select",
    key: "envKey",
    label: "Environment",
    hint: "Provides the Azure credentials and state backend.",
    emptyNote: "Create an environment first, then come back.",
    options: (c) => c.envs.map((e) => ({ value: e.key, label: e.name || e.key })),
  },
  {
    page: 1,
    kind: "text",
    key: "name",
    label: "Cluster name",
    hint: "Lowercase letters, digits, hyphens; start with a letter.",
    placeholder: "my-cluster",
    validate: (v) =>
      NAME_RE.test(v) ? null : "Lowercase letters, digits and hyphens; start with a letter.",
  },
  {
    page: 1,
    kind: "select",
    key: "location",
    label: "Region",
    options: (c) => strList(c, "regions", ["eastus"]).map((r) => ({ value: r, label: r })),
    default: () => "eastus",
  },
  {
    page: 1,
    kind: "choice",
    key: "skuTier",
    label: "Pricing tier",
    hint: "Standard gives an uptime SLA — recommended for prod.",
    choices: [
      { value: "Standard", label: "Standard (SLA)" },
      { value: "Free", label: "Free" },
    ],
  },
  {
    page: 1,
    kind: "select",
    key: "kubernetesVersion",
    label: "Kubernetes version",
    options: (c) => strList(c, "kubernetesVersions", ["1.30"]).map((v) => ({ value: v, label: v })),
  },
  {
    page: 1,
    kind: "choice",
    key: "automaticUpgrade",
    label: "Automatic upgrades",
    choices: [
      { value: "patch", label: "Patch (recommended)" },
      { value: "none", label: "None" },
    ],
  },
  {
    page: 1,
    kind: "choice",
    key: "zones",
    label: "Availability zones",
    hint: "Spread nodes across zones 1, 2, 3 for HA.",
    choices: [
      { value: true, label: "Zones 1, 2, 3" },
      { value: false, label: "Single zone" },
    ],
  },
  {
    page: 1,
    kind: "choice",
    key: "createResourceGroup",
    label: "Resource group",
    choices: [
      { value: true, label: "Create a new resource group" },
      { value: false, label: "Use an existing one" },
    ],
  },
  {
    page: 1,
    kind: "text",
    key: "resourceGroupNew",
    label: "New resource group name",
    mono: true,
    placeholder: "my-cluster-rg",
    skip: (a) => a.createResourceGroup === false,
    default: (c) =>
      String(c.answers.name ?? "").trim() ? `${String(c.answers.name).trim()}-rg` : "",
    validate: (v) => (v.trim() ? null : "A resource group name is required."),
  },
  {
    page: 1,
    kind: "select",
    key: "resourceGroupExisting",
    label: "Existing resource group",
    hint: "Resource groups in the subscription.",
    emptyNote: "No resource groups found.",
    skip: (a) => a.createResourceGroup !== false,
    options: (c) => {
      const src = c.sources?.azureNetworks as AzureNetworksSource | undefined;
      return (src?.resourceGroups ?? []).map((g) => ({
        value: g.name,
        label: `${g.name} · ${g.location}`,
      }));
    },
  },
  // ── Page 2 · Security & identity ─────────────────────────────────────
  {
    page: 2,
    kind: "choice",
    key: "azureRbac",
    label: "Entra ID + Azure RBAC",
    hint: "Authenticate with Microsoft Entra ID and authorize via Azure RBAC.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 2,
    kind: "choice",
    key: "disableLocalAccounts",
    label: "Local accounts",
    hint: "Disabling forces Entra ID only (no static admin certs).",
    choices: [
      { value: false, label: "Keep local accounts" },
      { value: true, label: "Disable (Entra only)" },
    ],
  },
  {
    page: 2,
    kind: "choice",
    key: "workloadIdentity",
    label: "Workload Identity (OIDC)",
    hint: "Federated pod identity — replaces service-account keys.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 2,
    kind: "choice",
    key: "azurePolicy",
    label: "Azure Policy add-on",
    choices: [
      { value: true, label: "Enabled" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 2,
    kind: "choice",
    key: "privateCluster",
    label: "Private cluster",
    hint: "Private API server (no public endpoint).",
    choices: [
      { value: false, label: "Public endpoint" },
      { value: true, label: "Private cluster" },
    ],
  },
  {
    page: 2,
    kind: "text",
    key: "authorizedIpRanges",
    label: "Authorized IP ranges",
    mono: true,
    optional: true,
    hint: "Restrict the public endpoint to these CIDRs (comma-separated). Leave blank for open.",
    placeholder: "1.2.3.4/32, 10.0.0.0/8",
    skip: (a) => a.privateCluster === true,
  },
  {
    page: 2,
    kind: "choice",
    key: "networkPolicy",
    label: "Network policy",
    hint: "CNI network policy engine (Azure CNI is always used).",
    choices: [
      { value: "azure", label: "Azure" },
      { value: "calico", label: "Calico" },
    ],
  },
  {
    page: 2,
    kind: "text",
    key: "serviceCidr",
    label: "Service CIDR",
    mono: true,
    placeholder: "10.100.0.0/16",
    default: () => "10.100.0.0/16",
  },
  {
    page: 2,
    kind: "text",
    key: "dnsServiceIp",
    label: "DNS service IP",
    mono: true,
    hint: "Must sit inside the service CIDR.",
    placeholder: "10.100.0.10",
    default: () => "10.100.0.10",
  },
  // ── Page 3 · Node pools ──────────────────────────────────────────────
  {
    page: 3,
    kind: "select",
    key: "vmSize",
    label: "System node VM size",
    options: (c) => strList(c, "vmSizes", ["Standard_D4s_v3"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 3,
    kind: "number",
    key: "desiredNodes",
    label: "System desired nodes",
    default: () => "2",
    validate: (v) => (Number(v) >= 1 ? null : "At least 1 node."),
  },
  {
    page: 3,
    kind: "number",
    key: "minNodes",
    label: "System min nodes",
    default: () => "2",
    validate: (v, a) =>
      Number(v) >= 1 && Number(v) <= Number(a.desiredNodes)
        ? null
        : "Min must be ≥ 1 and ≤ desired.",
  },
  {
    page: 3,
    kind: "number",
    key: "maxNodes",
    label: "System max nodes",
    default: () => "5",
    validate: (v, a) => (Number(v) >= Number(a.desiredNodes) ? null : "Max must be ≥ desired."),
  },
  {
    page: 3,
    kind: "select",
    key: "systemDiskSize",
    label: "System node disk (GB)",
    options: (c) =>
      (strList(c, "diskSizes", ["64", "128", "256", "512"]) as unknown[]).map((d) => ({
        value: String(d),
        label: `${d} GB`,
      })),
    default: () => "128",
  },
  {
    page: 3,
    kind: "choice",
    key: "systemOsDiskType",
    label: "OS disk type",
    hint: "Ephemeral is faster and cheaper (recommended).",
    choices: [
      { value: "Ephemeral", label: "Ephemeral" },
      { value: "Managed", label: "Managed" },
    ],
  },
  {
    page: 3,
    kind: "number",
    key: "systemMaxPods",
    label: "Max pods per node",
    default: () => "50",
  },
  {
    page: 3,
    kind: "choice",
    key: "appNodePool",
    label: "Application node pool",
    hint: "Add a second user node pool (system pool gets tainted for critical add-ons).",
    choices: [
      { value: true, label: "Add app node pool" },
      { value: false, label: "System pool only" },
    ],
  },
  {
    page: 3,
    kind: "select",
    key: "appVmSize",
    label: "App node VM size",
    skip: (a) => a.appNodePool !== true,
    options: (c) => strList(c, "vmSizes", ["Standard_D4s_v3"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 3,
    kind: "choice",
    key: "appSpot",
    label: "App node priority",
    skip: (a) => a.appNodePool !== true,
    choices: [
      { value: true, label: "Spot (cost-saving)" },
      { value: false, label: "Regular" },
    ],
  },
  {
    page: 3,
    kind: "number",
    key: "appMinNodes",
    label: "App min nodes",
    default: () => "2",
    skip: (a) => a.appNodePool !== true,
  },
  {
    page: 3,
    kind: "number",
    key: "appMaxNodes",
    label: "App max nodes",
    default: () => "20",
    skip: (a) => a.appNodePool !== true,
    validate: (v, a) => (Number(v) >= Number(a.appMinNodes ?? 1) ? null : "Max must be ≥ min."),
  },
  // ── Page 4 · Add-ons & tags ──────────────────────────────────────────
  {
    page: 4,
    kind: "choice",
    key: "monitoring",
    label: "Azure Monitor + Prometheus",
    hint: "Log Analytics + Container Insights + Managed Prometheus.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 4,
    kind: "choice",
    key: "keyVaultSecretsProvider",
    label: "Key Vault Secrets Provider",
    hint: "CSI driver to mount Key Vault secrets into pods.",
    choices: [
      { value: true, label: "Enabled" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 4,
    kind: "choice",
    key: "kedaVpa",
    label: "KEDA + Vertical Pod Autoscaler",
    choices: [
      { value: true, label: "Enabled" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 4,
    kind: "text",
    key: "environment",
    label: "Environment tag",
    placeholder: "production",
    default: () => "production",
  },
  {
    page: 4,
    kind: "text",
    key: "team",
    label: "Team tag",
    placeholder: "devops",
    default: () => "devops",
  },
  {
    page: 4,
    kind: "text",
    key: "costCenter",
    label: "Cost center tag",
    optional: true,
    placeholder: "CC-1234",
  },
  // ── Page 5 · Networking & repository ─────────────────────────────────
  {
    page: 5,
    kind: "choice",
    key: "useExistingSubnet",
    label: "Node networking",
    choices: [
      { value: false, label: "Let AKS manage networking" },
      { value: true, label: "Use an existing subnet" },
    ],
  },
  {
    page: 5,
    kind: "select",
    key: "vnetRef",
    label: "Virtual network",
    hint: "VNets in the subscription.",
    emptyNote: "No virtual networks found.",
    skip: (a) => a.useExistingSubnet !== true,
    options: (c) => {
      const src = c.sources?.azureNetworks as AzureNetworksSource | undefined;
      return (src?.vnets ?? []).map((v) => ({
        value: vnetRefValue(v),
        label: `${v.name} · ${v.resourceGroup} · ${v.location}`,
      }));
    },
  },
  {
    page: 5,
    kind: "select",
    key: "subnet",
    label: "Subnet",
    hint: "Subnets in the selected VNet. Nodes join this subnet.",
    emptyNote: "No subnets found in the selected VNet.",
    skip: (a) => a.useExistingSubnet !== true,
    options: (c) => {
      const src = c.sources?.azureNetworks as AzureNetworksSource | undefined;
      const ref = String(c.answers.vnetRef ?? "");
      const vnet = (src?.vnets ?? []).find((v) => vnetRefValue(v) === ref);
      return (vnet?.subnets ?? []).map((s) => ({
        value: s.id,
        label: `${s.name} · ${s.addressPrefix}`,
      }));
    },
  },
  {
    page: 5,
    kind: "select",
    key: "repoFullName",
    label: "GitHub repository",
    hint: "The generated Terraform is committed here.",
    emptyNote: "Attach a repo on the CI/CD & Repos tab first.",
    options: (c) => c.repos.map((r) => ({ value: r.fullName, label: r.fullName })),
  },
  {
    page: 5,
    kind: "text",
    key: "ghPath",
    label: "GitHub file path (folder)",
    placeholder: "terraform/aks/my-cluster",
    default: (c) => `terraform/aks/${String(c.answers.name ?? "").trim() || "my-cluster"}`,
  },
];

const AKS_CONFIG: ClusterChatConfig = {
  cloud: "azure",
  cloudLabel: "Azure",
  title: "Create AKS cluster",
  blueprintSub:
    "Production AKS blueprint (Entra RBAC, zones, system + app pools, monitoring). No LLM — runs init → plan → apply.",
  optionsPath: "aks",
  stackPrefix: "aks",
  ghPathPrefix: "terraform/aks",
  branchPrefix: "aks",
  applyEta: "~5–10 min",
  pageTitles: [
    "Cluster basics",
    "Security & identity",
    "Node pools",
    "Add-ons & tags",
    "Networking & repository",
  ],
  // Live resource groups + VNets/subnets for the "existing" pickers.
  extraQueries: [
    {
      key: "azureNetworks",
      path: "azure/networks",
      enabled: (a) => a.createResourceGroup === false || a.useExistingSubnet === true,
    },
  ],
  steps: STEPS,
  buildBody: (a) => ({
    name: String(a.name).trim(),
    location: String(a.location).trim(),
    kubernetesVersion: a.kubernetesVersion,
    vmSize: a.vmSize,
    desiredNodes: Number(a.desiredNodes),
    minNodes: Number(a.minNodes),
    maxNodes: Number(a.maxNodes),
    envKey: a.envKey,
    createResourceGroup: a.createResourceGroup !== false,
    resourceGroup:
      a.createResourceGroup === false
        ? String(a.resourceGroupExisting ?? "").trim()
        : String(a.resourceGroupNew ?? "").trim(),
    vnetSubnetId:
      a.useExistingSubnet === true ? String(a.subnet ?? "").trim() || undefined : undefined,
    // Production options.
    environment: String(a.environment ?? "production").trim() || "production",
    team: String(a.team ?? "devops").trim() || "devops",
    costCenter: String(a.costCenter ?? "").trim() || undefined,
    skuTier: a.skuTier === "Free" ? "Free" : "Standard",
    zones: a.zones !== false,
    automaticUpgrade: a.automaticUpgrade === "none" ? "none" : "patch",
    networkPolicy: a.networkPolicy === "calico" ? "calico" : "azure",
    serviceCidr: String(a.serviceCidr ?? "10.100.0.0/16").trim() || undefined,
    dnsServiceIp: String(a.dnsServiceIp ?? "10.100.0.10").trim() || undefined,
    privateCluster: a.privateCluster === true,
    authorizedIpRanges:
      a.privateCluster !== true
        ? String(a.authorizedIpRanges ?? "").trim() || undefined
        : undefined,
    azureRbac: a.azureRbac !== false,
    disableLocalAccounts: a.disableLocalAccounts === true,
    workloadIdentity: a.workloadIdentity !== false,
    azurePolicy: a.azurePolicy !== false,
    systemDiskSize: Number(a.systemDiskSize ?? 128),
    systemOsDiskType: a.systemOsDiskType === "Managed" ? "Managed" : "Ephemeral",
    systemMaxPods: Number(a.systemMaxPods ?? 50),
    appNodePool: a.appNodePool === true,
    appVmSize: a.appNodePool === true ? String(a.appVmSize ?? a.vmSize) : undefined,
    appSpot: a.appNodePool === true ? a.appSpot !== false : undefined,
    appMinNodes: a.appNodePool === true ? Number(a.appMinNodes ?? 2) : undefined,
    appMaxNodes: a.appNodePool === true ? Number(a.appMaxNodes ?? 20) : undefined,
    monitoring: a.monitoring !== false,
    keyVaultSecretsProvider: a.keyVaultSecretsProvider !== false,
    kedaVpa: a.kedaVpa !== false,
  }),
};

export function AksChatBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={AKS_CONFIG} />;
}
