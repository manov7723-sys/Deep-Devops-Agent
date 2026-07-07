/**
 * Deterministic Terraform generator for a single Proxmox VE virtual machine,
 * using the bpg/proxmox provider. The provider reads its endpoint + API token
 * from PROXMOX_VE_* env vars (injected by the runner from the connected
 * CloudProvider — see runner/creds.ts), so NO secrets appear in the HCL.
 *
 * The VM is either cloned from an existing template (preferred — fast and
 * cloud-init ready) or booted from an ISO. Returns a {path: content} map, the
 * same shape as buildEksTerraform.
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

function vmTf(spec: ProxmoxVmSpec): string {
  // Resource label must be a valid HCL identifier.
  const res = spec.name.replace(/[^a-zA-Z0-9_]/g, "_");

  const cloneBlock = spec.templateVmId
    ? `\n  clone {\n    vm_id = ${spec.templateVmId}\n    full  = true\n  }\n`
    : "";
  const cdromBlock =
    !spec.templateVmId && spec.isoFile ? `\n  cdrom {\n    file_id = ${hcl(spec.isoFile)}\n  }\n` : "";
  const initBlock = spec.ipv4
    ? `\n  initialization {\n    ip_config {\n      ipv4 {\n        address = ${hcl(spec.ipv4)}${
        spec.gateway ? `\n        gateway = ${hcl(spec.gateway)}` : ""
      }\n      }\n    }\n  }\n`
    : "";

  return `resource "proxmox_virtual_environment_vm" ${hcl(res)} {
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
`;
}

export function buildProxmoxVmTerraform(spec: ProxmoxVmSpec): Record<string, string> {
  const base = `terraform/proxmox/${spec.name}`;
  return {
    [`${base}/provider.tf`]: PROVIDER_TF,
    [`${base}/vm.tf`]: vmTf(spec),
  };
}
