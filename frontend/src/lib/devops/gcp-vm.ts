/**
 * GCP Compute Engine VM Terraform generator — one VM in an EXISTING VPC +
 * subnet. GCP's equivalent of AWS EC2 / Azure VM. Assumes the user already
 * created the network via gcp-vpc-create or manually.
 *
 * Emits:
 *   - 1 google_compute_instance (image + zone + machine_type + SSH key metadata)
 *   - Optional: attached public IP via access_config in network_interface
 *   - Firewall rules are network-scoped, so they're managed at the VPC level
 *     (or the caller adds one). This generator adds VM-specific rules only
 *     when the user explicitly toggles HTTP/HTTPS.
 */

export type GcpVmImage =
  | "debian-12"
  | "ubuntu-2204-lts"
  | "ubuntu-2404-lts"
  | "rocky-linux-9"
  | "windows-2022";

export type GcpVmSpec = {
  name: string;
  /** Full zone (e.g. us-central1-a), NOT region — Compute Engine VMs are zonal. */
  zone: string;
  /** Parent region — used for output info + validation. */
  region: string;
  env?: string;
  /** Existing VPC network name. */
  networkName: string;
  /** Existing subnetwork name in the region. */
  subnetName: string;
  image?: GcpVmImage;
  /** Machine type. Default e2-medium (2 vCPU, 4 GB — cheap general purpose). */
  machineType?: string;
  /** Boot disk size in GB. Default 20. */
  diskGb?: number;
  /** Disk type: pd-standard (HDD, cheapest), pd-balanced (default), pd-ssd (fastest). */
  diskType?: "pd-standard" | "pd-balanced" | "pd-ssd";
  /** Attach an ephemeral public IP. Default true (matches Console default). */
  publicIp?: boolean;
  /** Linux SSH user + key. For Linux images. */
  sshUsername?: string;
  sshPublicKey?: string;
  /** Windows password. For Windows images (set via startup script). */
  windowsAdminUsername?: string;
  windowsAdminPassword?: string;
  /** Add a network tag so the VPC's IAP-SSH firewall rule targets this VM. */
  allowIapSsh?: boolean;
  /** Open HTTP/HTTPS via network tags (needs matching firewall rules on the VPC). */
  allowHttp?: boolean;
  allowHttps?: boolean;
  labels?: Record<string, string>;
};

export const GCP_VM_DEFAULTS = {
  image: "ubuntu-2204-lts" as GcpVmImage,
  machineType: "e2-medium",
  diskGb: 20,
  diskType: "pd-balanced" as const,
  publicIp: true,
  sshUsername: "ubuntu",
  windowsAdminUsername: "cloudadmin",
  allowIapSsh: true,
  allowHttp: false,
  allowHttps: false,
} as const;

// Family → project mapping for GCP public images.
const IMAGE_MAP: Record<GcpVmImage, { project: string; family: string }> = {
  "debian-12": { project: "debian-cloud", family: "debian-12" },
  "ubuntu-2204-lts": { project: "ubuntu-os-cloud", family: "ubuntu-2204-lts" },
  "ubuntu-2404-lts": { project: "ubuntu-os-cloud", family: "ubuntu-2404-lts-amd64" },
  "rocky-linux-9": { project: "rocky-linux-cloud", family: "rocky-linux-9" },
  "windows-2022": { project: "windows-cloud", family: "windows-2022" },
};

export function buildGcpVmTerraform(spec: GcpVmSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const image = spec.image ?? GCP_VM_DEFAULTS.image;
  const isWindows = image === "windows-2022";
  const machineType = spec.machineType ?? GCP_VM_DEFAULTS.machineType;
  const diskGb = spec.diskGb ?? GCP_VM_DEFAULTS.diskGb;
  const diskType = spec.diskType ?? GCP_VM_DEFAULTS.diskType;
  const publicIp = spec.publicIp ?? GCP_VM_DEFAULTS.publicIp;
  const sshUsername = spec.sshUsername ?? GCP_VM_DEFAULTS.sshUsername;
  const windowsAdminUsername = spec.windowsAdminUsername ?? GCP_VM_DEFAULTS.windowsAdminUsername;
  const allowIapSsh = spec.allowIapSsh ?? GCP_VM_DEFAULTS.allowIapSsh;
  const allowHttp = spec.allowHttp ?? GCP_VM_DEFAULTS.allowHttp;
  const allowHttps = spec.allowHttps ?? GCP_VM_DEFAULTS.allowHttps;
  const labels = {
    managed_by: "deepagent",
    stack: name,
    ...(spec.env ? { environment: spec.env } : {}),
    ...(spec.labels ?? {}),
  };

  if (!isWindows && !spec.sshPublicKey?.trim()) {
    throw new Error("Linux VMs require an sshPublicKey.");
  }
  if (isWindows && !spec.windowsAdminPassword?.trim()) {
    throw new Error("Windows VMs require a windowsAdminPassword.");
  }

  const img = IMAGE_MAP[image];

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.20" }
  }
}

provider "google" {
  region = "${spec.region}"
  zone   = "${spec.zone}"
}
`;

  // Network tags — GCP firewalls target by tag rather than SG-attach.
  // Our default VPC generator adds an IAP-SSH rule that targets everything,
  // so this tag is mostly used with user-supplied allow-http/https rules.
  const tags: string[] = [];
  if (allowIapSsh) tags.push('"iap-ssh"');
  if (allowHttp) tags.push('"http-server"');
  if (allowHttps) tags.push('"https-server"');
  const tagsHcl = tags.length ? `  tags = [${tags.join(", ")}]\n\n` : "";

  const sshMetadata = !isWindows
    ? `  metadata = {
    ssh-keys = "${sshUsername}:${(spec.sshPublicKey ?? "").replace(/"/g, '\\"')}"
  }`
    : `  metadata = {
    windows-startup-script-ps1 = <<-EOT
      # Set the admin password on first boot (safer than passing via cleartext image config).
      $Password = ConvertTo-SecureString ${JSON.stringify(spec.windowsAdminPassword)} -AsPlainText -Force
      $UserExists = Get-LocalUser -Name "${windowsAdminUsername}" -ErrorAction SilentlyContinue
      if ($UserExists) {
        Set-LocalUser -Name "${windowsAdminUsername}" -Password $Password
      } else {
        New-LocalUser -Name "${windowsAdminUsername}" -Password $Password -PasswordNeverExpires
        Add-LocalGroupMember -Group "Administrators" -Member "${windowsAdminUsername}"
      }
    EOT
  }`;

  const accessConfig = publicIp ? `    access_config {}\n` : "";

  const mainTf = `# ${name} — GCP Compute Engine ${isWindows ? "Windows" : "Linux"} VM in ${spec.zone}
# Attaches to VPC ${spec.networkName} / subnet ${spec.subnetName}.

data "google_compute_network" "this" {
  name = "${spec.networkName}"
}

data "google_compute_subnetwork" "this" {
  name   = "${spec.subnetName}"
  region = "${spec.region}"
}

data "google_compute_image" "boot" {
  family  = "${img.family}"
  project = "${img.project}"
}

resource "google_compute_instance" "this" {
  name         = "${name}"
  machine_type = "${machineType}"
  zone         = "${spec.zone}"

${tagsHcl}  boot_disk {
    initialize_params {
      image = data.google_compute_image.boot.self_link
      size  = ${diskGb}
      type  = "${diskType}"
    }
  }

  network_interface {
    network    = data.google_compute_network.this.self_link
    subnetwork = data.google_compute_subnetwork.this.self_link
${accessConfig}  }

${sshMetadata}

  labels = ${jsonToHcl(labels, "  ")}
}
`;

  const outputsTf = `output "vm_name" {
  value       = google_compute_instance.this.name
  description = "VM name"
}

output "vm_id" {
  value       = google_compute_instance.this.id
  description = "VM resource id"
}

output "internal_ip" {
  value       = google_compute_instance.this.network_interface[0].network_ip
  description = "Internal IP inside the VPC"
}
${publicIp ? `
output "public_ip" {
  value       = google_compute_instance.this.network_interface[0].access_config[0].nat_ip
  description = "Ephemeral public IP"
}
${!isWindows ? `
output "ssh_command" {
  value       = "gcloud compute ssh ${sshUsername}@${name} --zone=${spec.zone}"
  description = "Recommended way to connect — routes through IAP if allow_iap_ssh is set."
}
` : `
output "rdp_command" {
  value       = "gcloud compute start-iap-tunnel ${name} 3389 --local-host-port=localhost:3389 --zone=${spec.zone}"
  description = "Recommended way to connect — starts an IAP tunnel to port 3389 that you point mstsc at."
}
`}` : ""}
output "zone" {
  value       = "${spec.zone}"
  description = "Zone the VM lives in"
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function jsonToHcl(obj: Record<string, string>, indent: string): string {
  const rows = Object.entries(obj).map(([k, v]) => `${indent}  ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + `\n${indent}}`;
}
