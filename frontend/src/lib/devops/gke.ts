/**
 * GKE (Google Kubernetes Engine) cluster Terraform generator.
 *
 * The GCP sibling of `eks.ts`: produces a production-shaped Terraform tree
 * (VPC-native cluster + a separately managed, autoscaling node pool) from a
 * small set of wizard answers. Deterministic (no LLM) so output is stable and
 * reviewable. Returns a map of relative file path -> file contents.
 */

export type GkeSpec = {
  name: string;
  /** GCP project id the cluster is created in. */
  project: string;
  /** Region (e.g. "us-central1") or zone (e.g. "us-central1-a"). */
  location: string;
  /** Control-plane version / release channel handling: a concrete version like "1.30". */
  kubernetesVersion: string;
  machineType: string;
  desiredNodes: number;
  minNodes: number;
  maxNodes: number;
  /** Private nodes (no public IPs) when true; public endpoint stays reachable. */
  privateNodes: boolean;
  /** Create a dedicated VPC network (default) or reuse the project's "default" network. */
  createNetwork?: boolean;
  /** Existing network name (when createNetwork is false). */
  existingNetwork?: string;
  /** Existing subnetwork name (when createNetwork is false). Optional. */
  existingSubnetwork?: string;
  /** Optional GCS remote-state backend bucket. */
  stateBucket?: string;

  // ── Production options ──────────────────────────────────────────────
  environment?: string;
  team?: string;
  costCenter?: string;
  /** GKE release channel. */
  releaseChannel?: "REGULAR" | "STABLE" | "RAPID";
  /** Private control-plane endpoint (in addition to private nodes). */
  privateEndpoint?: boolean;
  /** Master authorized networks (control-plane access CIDRs). */
  masterAuthorizedCidrs?: string; // comma-separated
  /** Dataplane V2 (eBPF) — includes network policy. */
  dataplaneV2?: boolean;
  /** Workload Identity (federated GCP IAM for pods). */
  workloadIdentity?: boolean;
  /** Shielded GKE nodes (secure boot + integrity monitoring). */
  shieldedNodes?: boolean;
  /** Binary Authorization (signed-image enforcement). */
  binaryAuthorization?: boolean;
  /** Intranode visibility (pod-to-pod traffic visible to VPC). */
  intranodeVisibility?: boolean;
  /** Gateway API. */
  gatewayApi?: boolean;
  /** Cloud DNS for cluster DNS. */
  cloudDns?: boolean;
  /** Cloud Logging + Monitoring + Managed Prometheus. */
  monitoring?: boolean;
  /** HTTP(S) Load Balancing add-on (GKE Ingress). */
  httpLoadBalancing?: boolean;
  /** Backup for GKE agent. */
  backupAgent?: boolean;
  /** Config Connector add-on. */
  configConnector?: boolean;
  /** System node pool disk. */
  systemDiskType?: "pd-ssd" | "pd-balanced" | "pd-standard";
  systemDiskSize?: number;
  /** Add an application node pool. */
  appNodePool?: boolean;
  appMachineType?: string;
  appSpot?: boolean;
  appMinNodes?: number;
  appMaxNodes?: number;
};

export type GkeDefaults = Omit<GkeSpec, "name" | "project">;

export const GKE_DEFAULTS: GkeDefaults = {
  location: "us-central1",
  kubernetesVersion: "1.33",
  machineType: "n2-standard-4",
  desiredNodes: 1,
  minNodes: 1,
  maxNodes: 3,
  privateNodes: true,
  createNetwork: true,
  environment: "production",
  team: "devops",
  costCenter: "",
  releaseChannel: "REGULAR",
  privateEndpoint: false,
  masterAuthorizedCidrs: "",
  dataplaneV2: true,
  workloadIdentity: true,
  shieldedNodes: true,
  binaryAuthorization: true,
  intranodeVisibility: true,
  gatewayApi: true,
  cloudDns: false,
  monitoring: true,
  httpLoadBalancing: true,
  backupAgent: true,
  configConnector: false,
  systemDiskType: "pd-ssd",
  systemDiskSize: 100,
  appNodePool: true,
  appMachineType: "n2-standard-4",
  appSpot: true,
  appMinNodes: 2,
  appMaxNodes: 10,
};

export const GKE_MACHINE_TYPES = ["e2-medium", "e2-standard-2", "e2-standard-4", "n2-standard-2", "n2-standard-4", "n2-standard-8"];
export const GKE_K8S_VERSIONS = ["1.36", "1.35", "1.34", "1.33", "1.32", "1.31", "1.30"];
export const GKE_DISK_TYPES = ["pd-ssd", "pd-balanced", "pd-standard"];
export const GKE_DISK_SIZES = [50, 100, 150, 200];

function backendBlock(spec: GkeSpec): string {
  if (!spec.stateBucket) {
    return `  # No GCS backend configured — state is local. Create a GCS bucket and\n  # set it as the state bucket for production use.`;
  }
  return `  backend "gcs" {
    bucket = "${spec.stateBucket}"
    prefix = "gke/${spec.name}"
  }`;
}

/** Build the full Terraform file tree for the GKE cluster. */
export function buildGkeTerraform(spec: GkeSpec): Record<string, string> {
  const cluster = spec.name;
  const useExisting = spec.createNetwork === false;

  const versions = `terraform {
  required_version = ">= 1.5.0"
${backendBlock(spec)}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

provider "google" {
  project = "${spec.project}"
  region  = "${spec.location}"
}
`;

  // Network: a dedicated VPC + subnet, or wiring to an existing network.
  const networkSection = useExisting
    ? `# Reusing existing network "${spec.existingNetwork ?? "default"}".
locals {
  network    = "${spec.existingNetwork ?? "default"}"
  subnetwork = "${spec.existingSubnetwork ?? ""}"
}
`
    : `resource "google_compute_network" "vpc" {
  name                    = "\${local.cluster_name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "\${local.cluster_name}-subnet"
  region        = local.location
  network       = google_compute_network.vpc.id
  ip_cidr_range = "10.10.0.0/20"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/16"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}

locals {
  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.subnet.id
}
`;

  // VPC-native cluster needs explicit secondary range names when we create the
  // subnet; for an existing network we let GKE auto-allocate.
  const ipAllocation = useExisting
    ? ""
    : `
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }`;

  // Production options (defaulted so older callers still produce valid HCL).
  const env = spec.environment || "production";
  const team = spec.team || "devops";
  const costCenter = spec.costCenter || "";
  const appPool = spec.appNodePool === true;
  const monitoring = spec.monitoring !== false;
  const dpv2 = spec.dataplaneV2 !== false;
  const masterCidrs = (spec.masterAuthorizedCidrs || "")
    .split(",").map((c) => c.trim()).filter(Boolean);

  // Cluster-level production blocks.
  const clusterBlocks: string[] = [];
  if (spec.releaseChannel) {
    clusterBlocks.push(`  release_channel {
    channel = "${spec.releaseChannel}"
  }`);
  }
  if (dpv2) clusterBlocks.push(`  datapath_provider = "ADVANCED_DATAPATH"`);
  if (spec.workloadIdentity !== false) {
    clusterBlocks.push(`  workload_identity_config {
    workload_pool = "${spec.project}.svc.id.goog"
  }`);
  }
  if (spec.shieldedNodes !== false) clusterBlocks.push(`  enable_shielded_nodes = true`);
  if (spec.intranodeVisibility !== false) clusterBlocks.push(`  enable_intranode_visibility = true`);
  if (spec.binaryAuthorization !== false) {
    clusterBlocks.push(`  binary_authorization {
    evaluation_mode = "PROJECT_SINGLETON_POLICY_ENFORCE"
  }`);
  }
  if (masterCidrs.length > 0) {
    clusterBlocks.push(`  master_authorized_networks_config {
${masterCidrs.map((c, i) => `    cidr_blocks {\n      cidr_block   = "${c}"\n      display_name = "authorized-${i + 1}"\n    }`).join("\n")}
  }`);
  }
  if (spec.gatewayApi !== false) {
    clusterBlocks.push(`  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }`);
  }
  if (spec.cloudDns === true) {
    clusterBlocks.push(`  dns_config {
    cluster_dns       = "CLOUD_DNS"
    cluster_dns_scope = "CLUSTER_SCOPE"
  }`);
  }
  if (monitoring) {
    clusterBlocks.push(`  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }
  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus {
      enabled = true
    }
  }`);
  }
  clusterBlocks.push(`  addons_config {
    http_load_balancing {
      disabled = ${spec.httpLoadBalancing === false ? "true" : "false"}
    }
    horizontal_pod_autoscaling {
      disabled = false
    }
    gce_persistent_disk_csi_driver_config {
      enabled = true
    }${spec.cloudDns === true ? `\n    dns_cache_config {\n      enabled = true\n    }` : ""}${spec.backupAgent !== false ? `\n    gke_backup_agent_config {\n      enabled = true\n    }` : ""}${spec.configConnector === true ? `\n    config_connector_config {\n      enabled = true\n    }` : ""}
  }`);

  // Reusable node_config (shielded + workload metadata + disk).
  const nodeConfig = (machine: string, role: string, spot: boolean, taint: boolean) => `    node_config {
      machine_type = "${machine}"
      image_type   = "COS_CONTAINERD"
      disk_type    = "${spec.systemDiskType || "pd-ssd"}"
      disk_size_gb = ${spec.systemDiskSize ?? 100}${spot ? `\n      spot         = true` : ""}
      oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
      labels = {
        role = "${role}"
        env  = "${env}"
      }${taint ? `\n      taint {\n        key    = "CriticalAddonsOnly"\n        value  = "true"\n        effect = "NO_SCHEDULE"\n      }` : ""}
      shielded_instance_config {
        enable_secure_boot          = ${spec.shieldedNodes !== false ? "true" : "false"}
        enable_integrity_monitoring = true
      }
      workload_metadata_config {
        mode = "GKE_METADATA"
      }
    }`;

  const appPoolResource = appPool
    ? `
resource "google_container_node_pool" "app_nodes" {
  name     = "\${local.cluster_name}-app"
  location = local.location
  cluster  = google_container_cluster.primary.name

  autoscaling {
    min_node_count = ${spec.appMinNodes ?? 2}
    max_node_count = ${spec.appMaxNodes ?? 10}
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

${nodeConfig(spec.appMachineType || spec.machineType, "application", spec.appSpot !== false, false)}
}
`
    : "";

  const main = `locals {
  cluster_name = "${cluster}"
  location     = "${spec.location}"
  labels = {
    managed_by  = "deepagent"
    cluster     = local.cluster_name
    environment = "${env}"
    team        = "${team}"${costCenter ? `\n    cost_center = "${costCenter}"` : ""}
  }
}

# Enable the GCP APIs the cluster + node pools need. Brand-new GCP projects
# have every API disabled by default, so without these an apply on a fresh
# project fails with SERVICE_DISABLED (Kubernetes Engine API not enabled).
# disable_on_destroy = false so terraform destroy doesn't turn them off for
# any other resources in the project that also depend on them.
resource "google_project_service" "container" {
  project            = "${spec.project}"
  service            = "container.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "compute" {
  project            = "${spec.project}"
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

${networkSection}
# Regional cluster with the default node pool removed so the node pools below
# are the single source of truth (manageable size, autoscaling, taints).
resource "google_container_cluster" "primary" {
  name     = local.cluster_name
  location = local.location

  # Wait for the API enablement before creating — GCP takes ~30-60s to
  # propagate a fresh service enablement.
  depends_on = [
    google_project_service.container,
    google_project_service.compute,
  ]

  remove_default_node_pool = true
  initial_node_count       = 1

  min_master_version = "${spec.kubernetesVersion}"

  network    = local.network
  subnetwork = local.subnetwork${ipAllocation}

  private_cluster_config {
    enable_private_nodes    = ${spec.privateNodes ? "true" : "false"}
    enable_private_endpoint = ${spec.privateEndpoint ? "true" : "false"}
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

${clusterBlocks.join("\n\n")}

  resource_labels = local.labels

  # Regional GKE creates legitimately take 20-30 min (control-plane replicas
  # across zones, ILB, metadata service). Give the provider room so it doesn't
  # give up while Google is still working.
  timeouts {
    create = "45m"
    update = "45m"
    delete = "30m"
  }
}

resource "google_container_node_pool" "system_nodes" {
  name     = "\${local.cluster_name}-system"
  location = local.location
  cluster  = google_container_cluster.primary.name

  node_count = ${spec.desiredNodes}

  autoscaling {
    min_node_count = ${spec.minNodes}
    max_node_count = ${spec.maxNodes}
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

${nodeConfig(spec.machineType, "system", false, appPool)}
}
${appPoolResource}`;

  const outputs = `output "cluster_name" {
  value = google_container_cluster.primary.name
}

output "cluster_endpoint" {
  value     = google_container_cluster.primary.endpoint
  sensitive = true
}

output "location" {
  value = local.location
}

output "update_kubeconfig_command" {
  value = "gcloud container clusters get-credentials \${google_container_cluster.primary.name} --location ${spec.location} --project ${spec.project}"
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
