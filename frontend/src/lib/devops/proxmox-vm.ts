/**
 * Deterministic Terraform generator for a single Proxmox VE virtual machine,
 * using the bpg/proxmox provider. The provider reads its endpoint + API token
 * from PROXMOX_VE_* env vars (injected by the runner from the connected
 * CloudProvider — see runner/creds.ts), so NO secrets appear in the HCL.
 *
 * The VM is either cloned from an existing template (preferred — fast and
 * cloud-init ready) or booted from an ISO. Returns a {path: content} map, the
 * same shape as buildEksTerraform.
 *
 * Optional deploy-prep fields (sshPublicKey / installDocker) generate a
 * cloud-init snippet that creates a `deploy` user, installs its SSH key, and
 * optionally installs Docker + Compose so the VM boots deploy-ready. The
 * snippet is uploaded via `proxmox_virtual_environment_file` (requires a
 * datastore with snippets content enabled — the default "local" store on a
 * standard Proxmox install is configured for it).
 */
export type ProxmoxVmSpec = {
  name: string;
  node: string;
  cores: number;
  memoryMB: number;
  diskGB: number;
  datastore: string; // e.g. "local-lvm"
  bridge: string; // e.g. "vmbr0"
  /** Clone source template VM id (preferred). */
  templateVmId?: number;
  /** Boot ISO when not cloning, e.g. "local:iso/ubuntu-24.04-live-server-amd64.iso". */
  isoFile?: string;
  /** cloud-init IPv4: "dhcp" or a CIDR like "10.0.0.50/24". */
  ipv4?: string;
  /** cloud-init gateway (with a static ipv4). */
  gateway?: string;
  /** OpenSSH public key to install for the "deploy" user. Enables deploy prep. */
  sshPublicKey?: string;
  /** Install Docker CE + Compose plugin in the VM via cloud-init. Requires sshPublicKey. Default true. */
  installDocker?: boolean;
  /** Datastore with snippets content enabled, used for cloud-init user-data. Default "local". */
  snippetsDatastore?: string;
};

const PROVIDER_TF = `terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

# Endpoint, API token and TLS mode are read from the environment:
#   PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN, PROXMOX_VE_INSECURE
# (injected by DeepAgent from the connected Proxmox provider — no secrets in HCL).
provider "proxmox" {}
`;

/** Quote a value as a valid HCL double-quoted string. */
function hcl(s: string): string {
  return JSON.stringify(s);
}

function cloudInitYaml(spec: ProxmoxVmSpec): string {
  // Only the deploy user + SSH key are strictly required. Docker install adds
  // Docker CE via the distro package (docker.io on Ubuntu/Debian), which is
  // the most portable choice across the base images most Proxmox templates use.
  const key = spec.sshPublicKey ?? "";
  const wantDocker = spec.installDocker !== false;
  const packages = wantDocker ? ["  - docker.io", "  - docker-compose-v2"] : [];
  const runcmd = wantDocker
    ? ["  - systemctl enable --now docker", "  - usermod -aG docker deploy"]
    : [];
  return [
    "#cloud-config",
    "users:",
    "  - name: deploy",
    "    groups: [sudo]",
    "    shell: /bin/bash",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    ssh_authorized_keys:",
    `      - ${key}`,
    "package_update: true",
    ...(packages.length ? ["packages:", ...packages] : []),
    ...(runcmd.length ? ["runcmd:", ...runcmd] : []),
    "",
  ].join("\n");
}

function snippetTf(spec: ProxmoxVmSpec, resName: string): string {
  const datastore = spec.snippetsDatastore ?? "local";
  const yaml = cloudInitYaml(spec);
  // Use HCL heredoc so multi-line YAML survives verbatim. Terminator MUST be
  // on a line by itself with no leading whitespace.
  return `resource "proxmox_virtual_environment_file" "${resName}_cloud_init" {
  content_type = "snippets"
  datastore_id = ${hcl(datastore)}
  node_name    = ${hcl(spec.node)}

  source_raw {
    data = <<-EOT
${yaml
  .split("\n")
  .map((l) => (l.length ? `      ${l}` : ""))
  .join("\n")}
    EOT
    file_name = "${resName}-user-data.yaml"
  }
}
`;
}

function vmTf(spec: ProxmoxVmSpec): string {
  // Resource label must be a valid HCL identifier.
  const res = spec.name.replace(/[^a-zA-Z0-9_]/g, "_");
  const withDeployPrep = !!spec.sshPublicKey;

  const cloneBlock = spec.templateVmId
    ? `\n  clone {\n    vm_id = ${spec.templateVmId}\n    full  = true\n  }\n`
    : "";
  const cdromBlock =
    !spec.templateVmId && spec.isoFile
      ? `\n  cdrom {\n    file_id = ${hcl(spec.isoFile)}\n  }\n`
      : "";
  const userDataLine = withDeployPrep
    ? `\n    user_data_file_id = proxmox_virtual_environment_file.${res}_cloud_init.id`
    : "";
  // Pin the cloud-init disk to the chosen datastore. Without this, the
  // bpg/proxmox provider defaults it to "local-lvm", which fails on servers
  // that don't have that pool (e.g. a plain "local"-only node).
  const initBlock =
    spec.ipv4 || withDeployPrep
      ? `\n  initialization {\n    datastore_id = ${hcl(spec.datastore)}${userDataLine}${
          spec.ipv4
            ? `\n    ip_config {\n      ipv4 {\n        address = ${hcl(spec.ipv4)}${
                spec.gateway ? `\n        gateway = ${hcl(spec.gateway)}` : ""
              }\n      }\n    }`
            : ""
        }\n  }\n`
      : "";

  const snippet = withDeployPrep ? snippetTf(spec, res) + "\n" : "";

  return `${snippet}resource "proxmox_virtual_environment_vm" ${hcl(res)} {
  name      = ${hcl(spec.name)}
  node_name = ${hcl(spec.node)}
${cloneBlock}${cdromBlock}
  cpu {
    cores = ${spec.cores}
    type  = "host"
  }

  memory {
    dedicated = ${spec.memoryMB}
  }

  disk {
    datastore_id = ${hcl(spec.datastore)}
    interface    = "scsi0"
    size         = ${spec.diskGB}
  }

  network_device {
    bridge = ${hcl(spec.bridge)}
  }
${initBlock}
  agent {
    enabled = true
  }
}

output "vm_id" {
  value = proxmox_virtual_environment_vm.${res}.vm_id
}

output "vm_name" {
  value = proxmox_virtual_environment_vm.${res}.name
}

output "vm_ipv4" {
  value = try(proxmox_virtual_environment_vm.${res}.ipv4_addresses[1][0], "")
  description = "Primary IPv4 as reported by qemu-guest-agent (empty until the agent replies)."
}
`;
}

export function buildProxmoxVmTerraform(spec: ProxmoxVmSpec): Record<string, string> {
  // Flat, relative filenames — the caller supplies the destination folder;
  // embedding it here too would double it up.
  return {
    "provider.tf": PROVIDER_TF,
    "vm.tf": vmTf(spec),
  };
}
