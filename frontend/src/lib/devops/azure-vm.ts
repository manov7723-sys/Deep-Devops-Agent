/**
 * Azure Virtual Machine Terraform generator — one VM inside an EXISTING VNet
 * + subnet. Azure's equivalent of AWS EC2. Assumes the user has already
 * created the VNet (via azure-vnet-create or manually).
 *
 * Emits (Linux path):
 *   - 1 azurerm_public_ip                (optional, but usually wanted)
 *   - 1 azurerm_network_interface        (bound to the picked subnet + optional PIP)
 *   - 1 azurerm_network_security_group   (SG rules for SSH/HTTP/HTTPS/custom)
 *   - 1 azurerm_network_interface_security_group_association
 *   - 1 azurerm_linux_virtual_machine    (image + size + SSH key + disk)
 *
 * Windows path swaps the last resource for azurerm_windows_virtual_machine
 * and uses admin_password instead of admin_ssh_key.
 */

export type AzureVmImage =
  | "ubuntu-22.04"
  | "ubuntu-24.04"
  | "debian-12"
  | "rhel-9"
  | "windows-2022";

export type AzureVmSpec = {
  name: string;
  location: string;
  env?: string;
  /** Existing Resource Group name that owns the VNet. */
  resourceGroupName: string;
  /** Existing VNet + subnet the NIC attaches to. */
  vnetName: string;
  subnetName: string;
  /** Image family. Ubuntu 22.04 default. */
  image?: AzureVmImage;
  /** VM size. Standard_B2s = 2 vCPU / 4 GB, cheap and fast enough for most demos. */
  vmSize?: string;
  /** OS disk size (GB). Default 30. */
  diskGb?: number;
  /** Also create a public IP + attach to the NIC. Default true. */
  publicIp?: boolean;
  /** Admin username. Default "azureuser". */
  adminUsername?: string;
  /** SSH public key for Linux. Required for Linux images. */
  sshPublicKey?: string;
  /** Admin password for Windows. Required for Windows images. */
  adminPassword?: string;
  /** SG rules to open. */
  allowSsh?: boolean;
  allowRdp?: boolean;
  allowHttp?: boolean;
  allowHttps?: boolean;
  /** Extra CIDR SSH ingress is restricted to. Blank = 0.0.0.0/0 when allowSsh. */
  sshCidr?: string;
  tags?: Record<string, string>;
};

export const AZURE_VM_DEFAULTS = {
  image: "ubuntu-22.04" as AzureVmImage,
  vmSize: "Standard_B2s",
  diskGb: 30,
  publicIp: true,
  adminUsername: "azureuser",
  allowSsh: true,
  allowRdp: false,
  allowHttp: false,
  allowHttps: false,
} as const;

const IMAGE_REFS: Record<AzureVmImage, { publisher: string; offer: string; sku: string; version: string }> = {
  "ubuntu-22.04": { publisher: "Canonical", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2", version: "latest" },
  "ubuntu-24.04": { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" },
  "debian-12": { publisher: "Debian", offer: "debian-12", sku: "12-gen2", version: "latest" },
  "rhel-9": { publisher: "RedHat", offer: "RHEL", sku: "9-lvm-gen2", version: "latest" },
  "windows-2022": { publisher: "MicrosoftWindowsServer", offer: "WindowsServer", sku: "2022-datacenter-azure-edition", version: "latest" },
};

export function buildAzureVmTerraform(spec: AzureVmSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const image = spec.image ?? AZURE_VM_DEFAULTS.image;
  const isWindows = image === "windows-2022";
  const vmSize = spec.vmSize ?? AZURE_VM_DEFAULTS.vmSize;
  const diskGb = spec.diskGb ?? AZURE_VM_DEFAULTS.diskGb;
  const publicIp = spec.publicIp ?? AZURE_VM_DEFAULTS.publicIp;
  const adminUsername = spec.adminUsername ?? AZURE_VM_DEFAULTS.adminUsername;
  const allowSsh = spec.allowSsh ?? AZURE_VM_DEFAULTS.allowSsh;
  const allowRdp = spec.allowRdp ?? (isWindows ? true : AZURE_VM_DEFAULTS.allowRdp);
  const allowHttp = spec.allowHttp ?? AZURE_VM_DEFAULTS.allowHttp;
  const allowHttps = spec.allowHttps ?? AZURE_VM_DEFAULTS.allowHttps;
  const sshCidr = (spec.sshCidr?.trim() || "0.0.0.0/0");
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  if (!isWindows && !spec.sshPublicKey?.trim()) {
    throw new Error("Linux VMs require an sshPublicKey.");
  }
  if (isWindows && !spec.adminPassword?.trim()) {
    throw new Error("Windows VMs require an adminPassword.");
  }

  const img = IMAGE_REFS[image];

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.100" }
  }
}

provider "azurerm" {
  features {}
}
`;

  // Auto-build the NSG rules based on which toggles are set. Priority values
  // start at 100 and ascend — Azure requires unique priorities per direction.
  const rules: string[] = [];
  let priority = 100;
  const addRule = (name: string, port: string | number, source: string) => {
    rules.push(`  security_rule {
    name                       = "${name}"
    priority                   = ${priority}
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "${port}"
    source_address_prefix      = "${source}"
    destination_address_prefix = "*"
  }`);
    priority += 10;
  };
  if (allowSsh) addRule("allow-ssh", 22, sshCidr);
  if (allowRdp) addRule("allow-rdp", 3389, sshCidr);
  if (allowHttp) addRule("allow-http", 80, "0.0.0.0/0");
  if (allowHttps) addRule("allow-https", 443, "0.0.0.0/0");

  const pipBlock = publicIp
    ? `resource "azurerm_public_ip" "this" {
  name                = "${name}-pip"
  location            = data.azurerm_resource_group.this.location
  resource_group_name = data.azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = ${jsonToHcl(tags, "  ")}
}

`
    : "";

  const vmResource = isWindows
    ? `resource "azurerm_windows_virtual_machine" "this" {
  name                  = "${name}"
  location              = data.azurerm_resource_group.this.location
  resource_group_name   = data.azurerm_resource_group.this.name
  size                  = "${vmSize}"
  admin_username        = "${adminUsername}"
  admin_password        = "${spec.adminPassword}"
  network_interface_ids = [azurerm_network_interface.this.id]

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = ${diskGb}
  }

  source_image_reference {
    publisher = "${img.publisher}"
    offer     = "${img.offer}"
    sku       = "${img.sku}"
    version   = "${img.version}"
  }

  tags = ${jsonToHcl(tags, "  ")}
}`
    : `resource "azurerm_linux_virtual_machine" "this" {
  name                  = "${name}"
  location              = data.azurerm_resource_group.this.location
  resource_group_name   = data.azurerm_resource_group.this.name
  size                  = "${vmSize}"
  admin_username        = "${adminUsername}"
  network_interface_ids = [azurerm_network_interface.this.id]

  admin_ssh_key {
    username   = "${adminUsername}"
    public_key = ${JSON.stringify(spec.sshPublicKey)}
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = ${diskGb}
  }

  source_image_reference {
    publisher = "${img.publisher}"
    offer     = "${img.offer}"
    sku       = "${img.sku}"
    version   = "${img.version}"
  }

  tags = ${jsonToHcl(tags, "  ")}
}`;

  const mainTf = `# ${name} — Azure ${isWindows ? "Windows" : "Linux"} VM in ${spec.location}
# Attaches to VNet ${spec.vnetName} / subnet ${spec.subnetName} in RG ${spec.resourceGroupName}.

data "azurerm_resource_group" "this" {
  name = "${spec.resourceGroupName}"
}

data "azurerm_virtual_network" "this" {
  name                = "${spec.vnetName}"
  resource_group_name = data.azurerm_resource_group.this.name
}

data "azurerm_subnet" "this" {
  name                 = "${spec.subnetName}"
  virtual_network_name = data.azurerm_virtual_network.this.name
  resource_group_name  = data.azurerm_resource_group.this.name
}

${pipBlock}resource "azurerm_network_security_group" "this" {
  name                = "${name}-nsg"
  location            = data.azurerm_resource_group.this.location
  resource_group_name = data.azurerm_resource_group.this.name
${rules.join("\n\n")}
  tags = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_network_interface" "this" {
  name                = "${name}-nic"
  location            = data.azurerm_resource_group.this.location
  resource_group_name = data.azurerm_resource_group.this.name

  ip_configuration {
    name                          = "primary"
    subnet_id                     = data.azurerm_subnet.this.id
    private_ip_address_allocation = "Dynamic"
${publicIp ? `    public_ip_address_id          = azurerm_public_ip.this.id\n` : ""}  }

  tags = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_network_interface_security_group_association" "this" {
  network_interface_id      = azurerm_network_interface.this.id
  network_security_group_id = azurerm_network_security_group.this.id
}

${vmResource}
`;

  const outputsTf = `output "vm_id" {
  value       = ${isWindows ? "azurerm_windows_virtual_machine" : "azurerm_linux_virtual_machine"}.this.id
  description = "VM resource id"
}

output "vm_name" {
  value       = ${isWindows ? "azurerm_windows_virtual_machine" : "azurerm_linux_virtual_machine"}.this.name
  description = "VM name"
}

output "private_ip" {
  value       = azurerm_network_interface.this.private_ip_address
  description = "Private IP inside the VNet"
}
${publicIp ? `
output "public_ip" {
  value       = azurerm_public_ip.this.ip_address
  description = "Public IP (via the Standard SKU public IP)"
}

output "ssh_command" {
  value       = ${isWindows ? `"Use Remote Desktop to \${azurerm_public_ip.this.ip_address} as ${adminUsername}"` : `"ssh ${adminUsername}@\${azurerm_public_ip.this.ip_address}"`}
  description = "How to connect once it's up"
}
` : ""}
output "resource_group" {
  value       = data.azurerm_resource_group.this.name
  description = "Resource group the VM lives in"
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
