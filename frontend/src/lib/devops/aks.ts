/**
 * AKS (Azure Kubernetes Service) cluster Terraform generator.
 *
 * The Azure sibling of `eks.ts`: produces a production-shaped Terraform tree
 * (resource group + AKS cluster with system + optional application node pools,
 * Entra ID / Azure RBAC, private cluster, monitoring, and security add-ons).
 * Deterministic (no LLM). Returns a map of relative file path -> file contents.
 */

export type AksSpec = {
  name: string;
  /** Azure region, e.g. "eastus". */
  location: string;
  /** Control-plane version, e.g. "1.30". */
  kubernetesVersion: string;
  vmSize: string;
  desiredNodes: number;
  minNodes: number;
  maxNodes: number;
  /** Create a new resource group (default) or reference an existing one. */
  createResourceGroup?: boolean;
  /** Resource group name (created when createResourceGroup, else referenced). */
  resourceGroup: string;
  /** Existing subnet resource id to place nodes in. Omit to let AKS manage networking. */
  vnetSubnetId?: string;
  /** Optional Azure Storage remote-state backend. */
  stateResourceGroup?: string;
  stateStorageAccount?: string;
  stateContainer?: string;

  // ── Production options ──────────────────────────────────────────────
  environment?: string;
  team?: string;
  costCenter?: string;
  /** Standard SKU (uptime SLA) vs Free. */
  skuTier?: "Standard" | "Free";
  /** Spread node pools across availability zones 1, 2, 3. */
  zones?: boolean;
  /** Auto-upgrade channel for the control plane ("patch" | "none"). */
  automaticUpgrade?: "patch" | "none";
  /** CNI network policy engine. */
  networkPolicy?: "azure" | "calico";
  serviceCidr?: string;
  dnsServiceIp?: string;
  /** Private API server (no public endpoint). */
  privateCluster?: boolean;
  /** Authorized IP ranges for the public endpoint (when not private). */
  authorizedIpRanges?: string; // comma-separated CIDRs
  /** Entra ID auth + Azure RBAC for Kubernetes authorization. */
  azureRbac?: boolean;
  /** Force Entra ID only (disable local/static admin accounts). */
  disableLocalAccounts?: boolean;
  /** OIDC issuer + workload identity (federated pod identity). */
  workloadIdentity?: boolean;
  /** Azure Policy add-on (Gatekeeper). */
  azurePolicy?: boolean;
  /** System node pool disk. */
  systemDiskSize?: number;
  systemOsDiskType?: "Ephemeral" | "Managed";
  systemMaxPods?: number;
  /** Add an application node pool. */
  appNodePool?: boolean;
  appVmSize?: string;
  appSpot?: boolean;
  appMinNodes?: number;
  appMaxNodes?: number;
  /** Azure Monitor (Log Analytics + Container Insights) + Managed Prometheus. */
  monitoring?: boolean;
  /** Key Vault Secrets Provider (CSI). */
  keyVaultSecretsProvider?: boolean;
  /** KEDA (event autoscaling) + Vertical Pod Autoscaler. */
  kedaVpa?: boolean;
};

export type AksDefaults = Omit<AksSpec, "name" | "resourceGroup">;

export const AKS_DEFAULTS: AksDefaults = {
  location: "eastus",
  kubernetesVersion: "1.33",
  vmSize: "Standard_D4s_v3",
  desiredNodes: 2,
  minNodes: 2,
  maxNodes: 5,
  createResourceGroup: true,
  environment: "production",
  team: "devops",
  costCenter: "",
  skuTier: "Standard",
  zones: true,
  automaticUpgrade: "patch",
  networkPolicy: "azure",
  serviceCidr: "10.100.0.0/16",
  dnsServiceIp: "10.100.0.10",
  privateCluster: false,
  authorizedIpRanges: "",
  azureRbac: true,
  disableLocalAccounts: false,
  workloadIdentity: true,
  azurePolicy: true,
  systemDiskSize: 128,
  systemOsDiskType: "Ephemeral",
  systemMaxPods: 50,
  appNodePool: true,
  appVmSize: "Standard_D4s_v3",
  appSpot: true,
  appMinNodes: 2,
  appMaxNodes: 20,
  monitoring: true,
  keyVaultSecretsProvider: true,
  kedaVpa: true,
};

export const AKS_VM_SIZES = ["Standard_B2s", "Standard_DS2_v2", "Standard_D2s_v3", "Standard_D4s_v3", "Standard_D8s_v3", "Standard_E4s_v3"];
export const AKS_K8S_VERSIONS = ["1.36", "1.35", "1.34", "1.33", "1.32", "1.31", "1.30"];
export const AKS_DISK_SIZES = [64, 128, 256, 512];
export const AKS_REGIONS = [
  "eastus", "eastus2", "westus2", "westus3", "centralus", "northeurope", "westeurope",
  "uksouth", "francecentral", "germanywestcentral", "southeastasia", "australiaeast", "centralindia", "japaneast",
];

function backendBlock(spec: AksSpec): string {
  if (!spec.stateStorageAccount || !spec.stateContainer) {
    return `  # No azurerm backend configured — state is local. Create a Storage\n  # Account + container and set them for production use.`;
  }
  return `  backend "azurerm" {
    resource_group_name  = "${spec.stateResourceGroup ?? spec.resourceGroup}"
    storage_account_name = "${spec.stateStorageAccount}"
    container_name       = "${spec.stateContainer}"
    key                  = "aks/${spec.name}.tfstate"
  }`;
}

/** Build the full Terraform file tree for the AKS cluster. */
export function buildAksTerraform(spec: AksSpec): Record<string, string> {
  const cluster = spec.name;
  const createRg = spec.createResourceGroup !== false;

  // Defaults so older callers still produce valid HCL.
  const env = spec.environment || "production";
  const team = spec.team || "devops";
  const costCenter = spec.costCenter || "";
  const zones = spec.zones !== false;
  const zonesAttr = zones ? `\n    zones                        = ["1", "2", "3"]` : "";
  const appPool = spec.appNodePool === true;
  const monitoring = spec.monitoring !== false;
  const privateCluster = spec.privateCluster === true;
  const authedIps = (spec.authorizedIpRanges || "")
    .split(",").map((c) => c.trim()).filter(Boolean).map((c) => `"${c}"`).join(", ");

  const versions = `terraform {
  required_version = ">= 1.5.0"
${backendBlock(spec)}
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.80" }
  }
}

provider "azurerm" {
  features {}
}
`;

  const rgSection = createRg
    ? `resource "azurerm_resource_group" "rg" {
  name     = "${spec.resourceGroup}"
  location = local.location
  tags     = local.tags
}

locals {
  rg_name     = azurerm_resource_group.rg.name
  rg_location = azurerm_resource_group.rg.location
}
`
    : `data "azurerm_resource_group" "rg" {
  name = "${spec.resourceGroup}"
}

locals {
  rg_name     = data.azurerm_resource_group.rg.name
  rg_location = data.azurerm_resource_group.rg.location
}
`;

  const lawBlock = monitoring
    ? `resource "azurerm_log_analytics_workspace" "law" {
  name                = "\${local.cluster_name}-law"
  location            = local.rg_location
  resource_group_name = local.rg_name
  sku                 = "PerGB2018"
  retention_in_days   = 90
  tags                = local.tags
}

`
    : "";

  // Cluster-level production blocks.
  const blocks: string[] = [];
  if (spec.azureRbac !== false) {
    blocks.push(`  azure_active_directory_role_based_access_control {
    managed            = true
    azure_rbac_enabled = true
  }`);
  }
  blocks.push(`  network_profile {
    network_plugin    = "azure"
    network_policy    = "${spec.networkPolicy || "azure"}"
    load_balancer_sku = "standard"${spec.serviceCidr ? `\n    service_cidr      = "${spec.serviceCidr}"` : ""}${spec.dnsServiceIp ? `\n    dns_service_ip    = "${spec.dnsServiceIp}"` : ""}
  }`);
  if (!privateCluster && authedIps) {
    blocks.push(`  api_server_access_profile {
    authorized_ip_ranges = [${authedIps}]
  }`);
  }
  if (monitoring) {
    blocks.push(`  oms_agent {
    log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
  }`);
    blocks.push(`  monitor_metrics {}`);
  }
  if (spec.keyVaultSecretsProvider !== false) {
    blocks.push(`  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }`);
  }
  if (spec.kedaVpa !== false) {
    blocks.push(`  workload_autoscaler_profile {
    keda_enabled                    = true
    vertical_pod_autoscaler_enabled = true
  }`);
  }

  const clusterFlags = [
    spec.skuTier === "Free" ? "" : `  sku_tier                  = "Standard"`,
    spec.automaticUpgrade === "none" ? "" : `  automatic_channel_upgrade = "patch"`,
    spec.disableLocalAccounts === true ? `  local_account_disabled    = true` : "",
    spec.workloadIdentity !== false ? `  oidc_issuer_enabled       = true\n  workload_identity_enabled = true` : "",
    spec.azurePolicy !== false ? `  azure_policy_enabled      = true` : "",
    privateCluster ? `  private_cluster_enabled   = true` : "",
  ].filter(Boolean).join("\n");

  const main = `locals {
  cluster_name = "${cluster}"
  location     = "${spec.location}"
  tags = {
    ManagedBy   = "DeepAgent"
    Cluster     = "${cluster}"
    Environment = "${env}"
    Team        = "${team}"${costCenter ? `\n    CostCenter  = "${costCenter}"` : ""}
  }
}

${rgSection}
${lawBlock}resource "azurerm_kubernetes_cluster" "aks" {
  name                = local.cluster_name
  location            = local.rg_location
  resource_group_name = local.rg_name
  dns_prefix          = local.cluster_name
  kubernetes_version  = "${spec.kubernetesVersion}"
${clusterFlags}

  default_node_pool {
    name                         = "systempool"
    vm_size                      = "${spec.vmSize}"
    node_count                   = ${spec.desiredNodes}
    enable_auto_scaling          = true
    min_count                    = ${spec.minNodes}
    max_count                    = ${spec.maxNodes}
    os_disk_size_gb              = ${spec.systemDiskSize ?? 128}
    os_disk_type                 = "${spec.systemOsDiskType || "Ephemeral"}"
    max_pods                     = ${spec.systemMaxPods ?? 50}
    only_critical_addons_enabled = ${appPool ? "true" : "false"}${zonesAttr}${spec.vnetSubnetId ? `\n    vnet_subnet_id               = "${spec.vnetSubnetId}"` : ""}
    tags                         = local.tags
  }

  identity {
    type = "SystemAssigned"
  }

${blocks.join("\n\n")}

  tags = local.tags

  # AKS creates typically take 15-25 min; private clusters + workload identity
  # + monitoring add-ons can push past 30. Give the provider room so it
  # doesn't give up while Azure is still working.
  timeouts {
    create = "45m"
    update = "45m"
    delete = "30m"
  }
}
${appPool ? `
resource "azurerm_kubernetes_cluster_node_pool" "app" {
  name                  = "apppool"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.aks.id
  vm_size               = "${spec.appVmSize || spec.vmSize}"
  enable_auto_scaling   = true
  min_count             = ${spec.appMinNodes ?? 2}
  max_count             = ${spec.appMaxNodes ?? 20}${zones ? `\n  zones                 = ["1", "2", "3"]` : ""}
  priority              = "${spec.appSpot ? "Spot" : "Regular"}"${spec.appSpot ? `\n  eviction_policy       = "Delete"\n  spot_max_price        = -1\n  node_taints           = ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"]` : ""}
  node_labels = {
    role = "application"
    env  = "${env}"
  }
  tags = local.tags
}
` : ""}`;

  const outputs = `output "cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "resource_group" {
  value = local.rg_name
}

output "location" {
  value = local.location
}

output "update_kubeconfig_command" {
  value = "az aks get-credentials --resource-group \${local.rg_name} --name \${azurerm_kubernetes_cluster.aks.name}"
}
`;

  // Flat, relative filenames — the caller supplies the destination folder;
  // embedding it here too would double it up.
  return {
    "versions.tf": versions,
    "main.tf": main,
    "outputs.tf": outputs,
  };
}
