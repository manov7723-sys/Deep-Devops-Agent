/**
 * GCP VPC Terraform generator — GCP's answer to AWS VPC. GCP's VPC model is
 * simpler than AWS/Azure: subnets are regional (not zonal), firewall rules
 * are network-scoped (not subnet-scoped), and there's no "public vs private"
 * distinction on subnets — a VM has a public IP only if you attach one.
 *
 * Emits:
 *   - 1 google_compute_network (auto_create_subnetworks=false, REGIONAL routing)
 *   - N google_compute_subnetwork (in the picked region, /20 slices)
 *   - Sane default firewall rules: allow-internal (all traffic between subnets),
 *     allow-icmp (ping across VPC), allow-ssh (from IAP CIDR if enabled)
 *   - Optional: Cloud NAT (google_compute_router + router_nat) for private
 *     VMs' outbound internet — GCP's Cloud NAT is much cheaper than AWS NAT
 *     ($0.045/hr flat regardless of NAT count, no per-GB egress fee)
 */

export type GcpVpcSpec = {
  name: string;
  region: string;
  env?: string;
  /** IPv4 CIDR for the VPC. GCP allows any RFC1918 range. Default 10.20.0.0/16. */
  vpcCidr?: string;
  /** How many subnets to create in the region. 1-3. Default 2. */
  subnetCount?: 1 | 2 | 3;
  /** Turn on private Google access on each subnet (VMs w/o public IP can reach googleapis.com). Default true. */
  privateGoogleAccess?: boolean;
  /** Create a Cloud NAT so private VMs can reach the internet outbound. Default true. */
  enableCloudNat?: boolean;
  /** Allow SSH from IAP CIDR (35.235.240.0/20) — safer than 0.0.0.0/0. Default true. */
  allowIapSsh?: boolean;
  labels?: Record<string, string>;
};

export const GCP_VPC_DEFAULTS = {
  vpcCidr: "10.20.0.0/16",
  subnetCount: 2 as 1 | 2 | 3,
  privateGoogleAccess: true,
  enableCloudNat: true,
  allowIapSsh: true,
} as const;

export function validateGcpCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.20.0.0/16).` };
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 29) return { ok: false, error: `Prefix /${prefix} out of range.` };
  return { ok: true };
}

export function buildGcpVpcTerraform(spec: GcpVpcSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const vpcCidr = spec.vpcCidr ?? GCP_VPC_DEFAULTS.vpcCidr;
  const subnetCount = spec.subnetCount ?? GCP_VPC_DEFAULTS.subnetCount;
  const privateGoogleAccess = spec.privateGoogleAccess ?? GCP_VPC_DEFAULTS.privateGoogleAccess;
  const enableNat = spec.enableCloudNat ?? GCP_VPC_DEFAULTS.enableCloudNat;
  const allowIap = spec.allowIapSsh ?? GCP_VPC_DEFAULTS.allowIapSsh;
  const labels = {
    managed_by: "deepagent",
    stack: name,
    ...(spec.env ? { environment: spec.env } : {}),
    ...(spec.labels ?? {}),
  };

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.20" }
  }
}

provider "google" {
  region = "${spec.region}"
}
`;

  const subnetBlocks: string[] = [];
  for (let i = 0; i < subnetCount; i++) {
    subnetBlocks.push(`resource "google_compute_subnetwork" "sub_${i}" {
  name                     = "${name}-subnet-${i + 1}"
  network                  = google_compute_network.this.id
  region                   = "${spec.region}"
  ip_cidr_range            = cidrsubnet("${vpcCidr}", 4, ${i})
  private_ip_google_access = ${privateGoogleAccess}
}`);
  }

  // Firewall rules — GCP firewalls are network-scoped, not subnet-scoped.
  const firewallBlocks: string[] = [
    `resource "google_compute_firewall" "allow_internal" {
  name        = "${name}-allow-internal"
  network     = google_compute_network.this.name
  description = "Allow all traffic between VMs inside the VPC"
  direction   = "INGRESS"
  priority    = 1000

  source_ranges = ["${vpcCidr}"]

  allow { protocol = "tcp" }
  allow { protocol = "udp" }
  allow { protocol = "icmp" }
}`,
  ];
  if (allowIap) {
    // IAP TCP forwarding CIDR is a fixed Google-owned block.
    firewallBlocks.push(`resource "google_compute_firewall" "allow_iap_ssh" {
  name        = "${name}-allow-iap-ssh"
  network     = google_compute_network.this.name
  description = "Allow SSH from Google's IAP TCP forwarding range (safer than 0.0.0.0/0)"
  direction   = "INGRESS"
  priority    = 1000

  source_ranges = ["35.235.240.0/20"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}`);
  }

  const natBlocks: string[] = [];
  if (enableNat) {
    natBlocks.push(`resource "google_compute_router" "nat" {
  name    = "${name}-router"
  network = google_compute_network.this.name
  region  = "${spec.region}"
}

resource "google_compute_router_nat" "nat" {
  name                               = "${name}-nat"
  router                             = google_compute_router.nat.name
  region                             = google_compute_router.nat.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}`);
  }

  const mainTf = `# ${name} — GCP VPC in ${spec.region} (${subnetCount} subnet${subnetCount === 1 ? "" : "s"}${enableNat ? " · Cloud NAT" : ""})
# Generated by DeepAgent.

resource "google_compute_network" "this" {
  name                    = "${name}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  description             = "Managed by DeepAgent — stack ${name}"
}

${subnetBlocks.join("\n\n")}

${firewallBlocks.join("\n\n")}${natBlocks.length ? "\n\n" + natBlocks.join("\n\n") : ""}
`;

  const subnetIdsList = Array.from({ length: subnetCount }, (_, i) => `google_compute_subnetwork.sub_${i}.id`).join(", ");
  const subnetNamesList = Array.from({ length: subnetCount }, (_, i) => `google_compute_subnetwork.sub_${i}.name`).join(", ");

  // GCP output labels aren't a top-level VPC concept — labels attach to
  // resources that support them (subnets don't). Kept ${JSON.stringify(labels)}
  // available for tooling that wants to attach labels when creating VMs later.
  void labels;

  const outputsTf = `output "vpc_id" {
  value       = google_compute_network.this.id
  description = "Self-link of the new VPC"
}

output "vpc_name" {
  value       = google_compute_network.this.name
  description = "Name of the new VPC"
}

output "subnet_ids" {
  value       = [${subnetIdsList}]
  description = "Self-links of the subnets"
}

output "subnet_names" {
  value       = [${subnetNamesList}]
  description = "Names of the subnets"
}

output "region" {
  value       = "${spec.region}"
  description = "Region the VPC lives in"
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
