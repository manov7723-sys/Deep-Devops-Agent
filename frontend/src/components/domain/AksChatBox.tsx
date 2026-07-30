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

/**
 * Read a list from the live `azureCapacity` source when it's populated,
 * falling back to the wizard's static `opts` list otherwise.
 *
 * Populated means "the region has been picked AND the ARM lookup returned
 * something usable". Until then we show the static list so the picker isn't
 * empty (the user hasn't chosen a region yet, so nothing region-specific to
 * filter by).
 */
const liveList = (c: StepCtx, field: "vmSizes" | "kubernetesVersions", fallback: string[]): string[] => {
  const src = c.sources?.azureCapacity as
    | { ok?: boolean; vmSizes?: string[]; kubernetesVersions?: string[] }
    | undefined;
  const live = src?.[field];
  if (Array.isArray(live) && live.length > 0) return live;
  return strList(c, field, fallback);
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

type AzureStorageAccount = { name: string; resourceGroup: string; location: string };

/**
 * Suggest a globally-unique-enough default Storage account name from the
 * cluster name. Storage account names must be 3-24 lowercase alphanumeric
 * (no dashes), so hyphens are stripped and we append "tf" + a short cluster
 * hash to reduce global-name collisions with other subscriptions.
 */
function suggestStateStorageAccountName(clusterName: string): string {
  const base = clusterName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  // Deterministic 4-char hash (no Math.random — deterministic keeps re-renders stable).
  let h = 0;
  for (let i = 0; i < clusterName.length; i++) h = (h * 31 + clusterName.charCodeAt(i)) | 0;
  const suffix = Math.abs(h).toString(36).slice(0, 4);
  return `${base}tf${suffix}`.slice(0, 24);
}

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
    options: (c) => liveList(c, "kubernetesVersions", ["1.30"]).map((v) => ({ value: v, label: v })),
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
    hint: "HA across zones 1, 2, 3. Not all subscriptions/regions/VM sizes support zones — trial subs in particular often report no zone capacity, and the apply then fails with 'AvailabilityZoneNotSupported'. Default off; opt in only when you know your sub + region + SKU allow it.",
    choices: [
      // Order matters — first item is the default when unanswered. "Single
      // zone" defaults on for safety; it works on every sub/region/SKU.
      { value: false, label: "Single zone (recommended)" },
      { value: true, label: "Zones 1, 2, 3" },
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
    // Reject a name that ALREADY EXISTS in the subscription. Terraform's
    // azurerm_resource_group is a create-only resource: pointed at an existing
    // group it fails the apply — but only ~11 minutes in, after the AKS
    // control plane has already started building. Worse, if that group holds
    // the Terraform state storage account (a very common layout), a later
    // `destroy` on this stack proposes deleting the state bucket along with
    // every other stack's resources sharing the group.
    // Catch it here, in the form, and point at the "Use an existing one"
    // branch which reads the group via a data source instead.
    validate: (v, _a, c) => {
      const name = v.trim();
      if (!name) return "A resource group name is required.";
      const src = c.sources?.azureNetworks as AzureNetworksSource | undefined;
      const existing = (src?.resourceGroups ?? []).map((g) => g.name.toLowerCase());
      if (existing.includes(name.toLowerCase())) {
        return `Resource group "${name}" already exists in this subscription. Switch "Resource group" above to "Use an existing one" and pick it from the list — creating over an existing group fails the apply and can put shared resources (including Terraform state) at risk on a later destroy.`;
      }
      return null;
    },
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
  // ── Terraform state backend ─────────────────────────────────────────
  // Every cluster picks a fresh state backend rather than silently trusting
  // whatever the env last had. Motivation: a stale account reference caused
  // `terraform init` to fail mid-apply with "no such host" (2026-07 incident).
  {
    page: 1,
    kind: "choice",
    key: "stateBackendMode",
    label: "Terraform state",
    hint: "Where cluster state lives after apply. 'Create' is safest — the wizard provisions the storage account before init runs.",
    choices: [
      { value: "create", label: "Create new (recommended)" },
      { value: "existing", label: "Use an existing storage account" },
      { value: "local", label: "Local (state stays on the runner disk)" },
    ],
  },
  {
    page: 1,
    kind: "text",
    key: "stateStorageAccount",
    label: "State storage account name",
    hint: "3-24 lowercase letters/digits only, globally unique across Azure.",
    mono: true,
    placeholder: "e.g. mydevopstf1234",
    skip: (a) => a.stateBackendMode !== "create",
    default: (c) => suggestStateStorageAccountName(String(c.answers.name ?? "cluster")),
    validate: (v) =>
      /^[a-z0-9]{3,24}$/.test(v.trim())
        ? null
        : "Must be 3-24 lowercase letters/digits (no dashes, no uppercase).",
  },
  {
    page: 1,
    kind: "select",
    key: "stateStorageAccountExisting",
    label: "Existing state storage account",
    hint: "Storage accounts visible in the connected subscription.",
    emptyNote:
      "No storage accounts found in this subscription. Pick 'Create new' above instead.",
    skip: (a) => a.stateBackendMode !== "existing",
    options: (c) => {
      const accs = (c.opts?.storageAccounts as AzureStorageAccount[] | undefined) ?? [];
      return accs.map((s) => ({
        value: s.name,
        label: `${s.name} · ${s.resourceGroup} · ${s.location}`,
      }));
    },
  },
  {
    page: 1,
    kind: "text",
    key: "stateContainer",
    label: "State container name",
    hint: "Blob container inside the storage account. 'tfstate' is the convention.",
    mono: true,
    default: () => "tfstate",
    skip: (a) => a.stateBackendMode === "local",
    validate: (v) =>
      /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/.test(v.trim())
        ? null
        : "Must be 3-63 lowercase letters/digits/dashes, starting and ending alphanumeric.",
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
    hint: "Filtered to what your subscription can actually provision in the chosen region — no red 'SKU not supported' at apply time.",
    options: (c) => liveList(c, "vmSizes", ["Standard_D2s_v3"]).map((t) => ({ value: t, label: t })),
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
    // Order matters — first option is the default. 30 GB is what AKS_DEFAULTS
    // uses and what small D-series VMs can actually hold as Ephemeral OS.
    // 128 GB was the old default and it fails on D2s_v3 (~50 GB cache) with
    // 'VMCannotFitEphemeralOSDisk'.
    options: (c) =>
      (strList(c, "diskSizes", ["30", "64", "128", "256", "512"]) as unknown[]).map((d) => ({
        value: String(d),
        label: `${d} GB`,
      })),
    default: () => "30",
  },
  {
    page: 3,
    kind: "choice",
    key: "systemOsDiskType",
    label: "OS disk type",
    hint: "Managed is universal. Ephemeral is faster and cheaper but only fits SKUs with enough cache/temp disk for the chosen size — D2s_v3 (~50 GB cache) can't hold a 128 GB ephemeral image, for instance.",
    choices: [
      { value: "Managed", label: "Managed (recommended)" },
      { value: "Ephemeral", label: "Ephemeral" },
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
    hint: "Same filtered list as the system pool — only SKUs your subscription can provision here.",
    skip: (a) => a.appNodePool !== true,
    options: (c) => liveList(c, "vmSizes", ["Standard_D2s_v3"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 3,
    kind: "choice",
    key: "appSpot",
    label: "App node priority",
    hint: "Regular is the safe pick — Spot uses a separate 'LowPriorityCores' quota that trial subs cap at 3, making a 2-vCPU Spot pool (4 cores) impossible without a quota bump.",
    skip: (a) => a.appNodePool !== true,
    choices: [
      // Order matters: first is default. Regular first because Spot needs a
      // separate LowPriorityCores quota trial subs don't have.
      { value: false, label: "Regular (recommended)" },
      { value: true, label: "Spot (cost-saving — needs LowPriorityCores quota)" },
    ],
  },
  {
    page: 3,
    kind: "number",
    key: "appMinNodes",
    label: "App min nodes",
    // Was "2" — but AKS_DEFAULTS says 1, and a 2-node minimum immediately
    // needs 2×vmSize vCPUs which trial subs (4 vCPU total) can't afford
    // when combined with the system pool.
    default: () => "1",
    skip: (a) => a.appNodePool !== true,
  },
  {
    page: 3,
    kind: "number",
    key: "appMaxNodes",
    label: "App max nodes",
    // Was "20" — that's 20×2=40 vCPU potential, absurd for a trial cluster
    // and often rejected by ARM at cluster-create if the sub quota can't
    // hold it. AKS_DEFAULTS caps at 2; bump upwards deliberately when the
    // sub can support it.
    default: () => "2",
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
  extraQueries: [
    // Live resource groups + VNets/subnets for the "existing" pickers.
    {
      key: "azureNetworks",
      path: "azure/networks",
      enabled: (a) => a.createResourceGroup === false || a.useExistingSubnet === true,
    },
    // Per-region capacity: filter the VM-size and K8s-version pickers by what
    // this subscription can ACTUALLY provision in the chosen region. The
    // location param goes into the cache key so React Query refetches on
    // region change and the pickers update in place.
    {
      key: "azureCapacity",
      path: "azure/capacity",
      params: (a) => (a.location ? { location: String(a.location) } : null),
      enabled: (a) => !!a.location,
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
    // Explicit-opt-in default. The generator + AKS_DEFAULTS already default
    // to false; the previous `!== false` inverted that and shipped `true` to
    // every trial-sub cluster, which crashed the apply with
    // AvailabilityZoneNotSupported. Match the schema default here so the
    // wizard's "Single zone" first choice actually wins when unanswered.
    zones: a.zones === true,
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
    // Both defaults MUST match AKS_DEFAULTS. The previous `?? 128` + inverted
    // Ephemeral default sent (128 GB Ephemeral) to every cluster and crashed
    // apply with VMCannotFitEphemeralOSDisk on D2s_v3 (~50 GB cache).
    systemDiskSize: Number(a.systemDiskSize ?? 30),
    systemOsDiskType: a.systemOsDiskType === "Ephemeral" ? "Ephemeral" : "Managed",
    systemMaxPods: Number(a.systemMaxPods ?? 50),
    appNodePool: a.appNodePool === true,
    appVmSize: a.appNodePool === true ? String(a.appVmSize ?? a.vmSize) : undefined,
    // Match AKS_DEFAULTS explicitly. Previously `!== false` sent Spot to
    // every trial cluster (LowPriorityCores=3 vs 4 needed → apply fails),
    // and `?? 2`/`?? 20` requested nodes trial vCPU quotas can't fit.
    appSpot: a.appNodePool === true ? a.appSpot === true : undefined,
    appMinNodes: a.appNodePool === true ? Number(a.appMinNodes ?? 1) : undefined,
    appMaxNodes: a.appNodePool === true ? Number(a.appMaxNodes ?? 2) : undefined,
    monitoring: a.monitoring !== false,
    keyVaultSecretsProvider: a.keyVaultSecretsProvider !== false,
    kedaVpa: a.kedaVpa !== false,
    // Terraform state backend. The server actually PROVISIONS the SA (mode
    // "create") or verifies it exists (mode "existing") before terraform init
    // runs, so we ship the picked names straight through.
    stateBackendMode: (a.stateBackendMode as "local" | "existing" | "create" | undefined) ?? "create",
    stateStorageAccount:
      a.stateBackendMode === "existing"
        ? String(a.stateStorageAccountExisting ?? "").trim() || undefined
        : a.stateBackendMode === "create"
          ? String(a.stateStorageAccount ?? "").trim() || undefined
          : undefined,
    // stateResourceGroup: reuse the cluster's RG when creating; when picking
    // an existing SA, the server can look up the RG from the name via the SA
    // list — but sending it here saves that round-trip.
    stateResourceGroup:
      a.stateBackendMode === "existing"
        ? (() => {
            // opts isn't reachable from buildBody, so let the server infer.
            return undefined;
          })()
        : a.stateBackendMode === "create"
          ? a.createResourceGroup === false
            ? String(a.resourceGroupExisting ?? "").trim() || undefined
            : String(a.resourceGroupNew ?? "").trim() || undefined
          : undefined,
    stateContainer:
      a.stateBackendMode !== "local"
        ? String(a.stateContainer ?? "tfstate").trim() || "tfstate"
        : undefined,
  }),
};

export function AksChatBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={AKS_CONFIG} />;
}
