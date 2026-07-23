/**
 * Azure OpenVPN Terraform generator — laptop-to-VNet OpenVPN tunnel.
 *
 * Azure's managed VPN Gateway P2S costs ~$140/mo minimum. This generator
 * takes the same "self-host on a small VM" approach as the GCP generator to
 * keep monthly cost at ~$13. Same shape as gcp-openvpn.ts so downstream cert
 * flows are provider-agnostic:
 *
 *   - Same tls_* resource names (tls_private_key.ca, tls_self_signed_cert.ca,
 *     tls_locally_signed_cert.client) → resolveCaFromState works verbatim.
 *   - Same sensitive outputs (client_certificate_pem, ca_private_key_pem …).
 *   - Same "cert owner name" CN convention.
 *
 * What's provisioned:
 *   - azurerm_public_ip                (Standard SKU, static)
 *   - azurerm_network_security_group   (allow UDP/1194 from source ranges,
 *                                       allow SSH from Azure Bastion range)
 *   - azurerm_network_interface        (subnet + PIP + IP forwarding enabled)
 *   - azurerm_network_interface_security_group_association
 *   - azurerm_linux_virtual_machine    (Standard_B1s, Ubuntu 22.04,
 *                                       custom_data runs the same install
 *                                       script as GCP: openvpn + iptables
 *                                       NAT + PEMs from cloud-init)
 *   - tls_*                            (CA + server + initial client cert)
 *
 * Cost: ~$8-15/mo (B1s VM + static IP + ~2GB disk).
 */

export type AzureVpnSpec = {
  /** DNS-safe name prefix. */
  name: string;
  /** Azure region — e.g. eastus, westeurope. */
  location: string;
  env?: string;

  /** Existing Resource Group that owns the target VNet. */
  resourceGroupName: string;
  /** Existing VNet. */
  vnetName: string;
  /** Existing subnet the VM's NIC attaches to. */
  subnetName: string;
  /** Subnet CIDR — advertised to VPN clients so they can reach VMs on the subnet. */
  vpcCidr: string;

  /** VM size. Default Standard_B1s (1 vCPU / 1 GB — plenty for <20 concurrent clients). */
  vmSize?: string;
  /** OS disk size (GB). Default 30 (Azure's minimum for the Ubuntu image). */
  diskGb?: number;

  /** Non-overlapping CIDR for the tunnel's client IPs. Default 10.100.0.0/22. */
  clientCidr?: string;

  /** Owner name — CN prefix on the auto-generated CA/server/client certs. */
  certOwnerName?: string;

  /** Split tunnel (default true) → only VPC traffic goes over the tunnel. */
  splitTunnel?: boolean;

  /** Transport protocol. UDP is default + faster; TCP for restrictive networks. */
  transportProtocol?: "udp" | "tcp";
  /** VPN port. 1194 (default) or 443 (TCP-only, blends with HTTPS). */
  vpnPort?: 1194 | 443;

  /**
   * CIDR blocks allowed to initiate OpenVPN traffic. Cert auth still gates
   * access — this is just an outer defensive layer. Default any-source.
   */
  sourceRanges?: string[];

  /** Admin user for SSH-to-VM (ops). Default azureuser. */
  adminUsername?: string;
  /** SSH public key for the VM (ops-only — end users get .ovpn, not SSH). */
  sshPublicKey?: string;

  tags?: Record<string, string>;
};

export const AZURE_VPN_DEFAULTS = {
  vmSize: "Standard_B1s",
  diskGb: 30,
  clientCidr: "10.100.0.0/22",
  splitTunnel: true,
  transportProtocol: "udp" as const,
  vpnPort: 1194 as const,
  sourceRanges: ["0.0.0.0/0"] as string[],
  adminUsername: "azureuser",
} as const;

export function validateAzureVpnCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.100.0.0/22).` };
  const prefix = Number(m[5]);
  if (prefix > 24) return { ok: false, error: `Client CIDR must be /24 or larger (got /${prefix}). Try 10.100.0.0/22.` };
  if (prefix < 12) return { ok: false, error: `Client CIDR /${prefix} is unusually large; use /16 or smaller.` };
  return { ok: true };
}

export function buildAzureVpnTerraform(spec: AzureVpnSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const certOwner = sanitise(spec.certOwnerName?.trim() || spec.name);
  const vmSize = spec.vmSize ?? AZURE_VPN_DEFAULTS.vmSize;
  const diskGb = spec.diskGb ?? AZURE_VPN_DEFAULTS.diskGb;
  const clientCidr = spec.clientCidr ?? AZURE_VPN_DEFAULTS.clientCidr;
  const splitTunnel = spec.splitTunnel ?? AZURE_VPN_DEFAULTS.splitTunnel;
  const transport = spec.transportProtocol ?? AZURE_VPN_DEFAULTS.transportProtocol;
  const vpnPort = spec.vpnPort ?? AZURE_VPN_DEFAULTS.vpnPort;
  const sourceRanges = (spec.sourceRanges?.length ? spec.sourceRanges : AZURE_VPN_DEFAULTS.sourceRanges).slice();
  const adminUsername = spec.adminUsername ?? AZURE_VPN_DEFAULTS.adminUsername;
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    Purpose: "openvpn-endpoint",
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  if (!spec.sshPublicKey?.trim()) {
    throw new Error(
      "Azure Linux VMs require an sshPublicKey — even for a VPN endpoint (used for admin SSH only, not for VPN clients).",
    );
  }

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.100" }
    tls     = { source = "hashicorp/tls",     version = "~> 4.0" }
  }
}

provider "azurerm" {
  features {}
}
`;

  const pkiTf = `# ── Auto-generated PKI (CA + server + initial client cert) ──
# Same resource layout as gcp-openvpn.ts + client-vpn.ts so the shared
# resolveCaFromState helper works for all three providers. The CA private
# key is a SENSITIVE output — the app's issue-user endpoint uses it to mint
# additional per-user certs off this CA without re-running Terraform.

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem

  subject {
    common_name  = "${certOwner}-ca"
    organization = "DeepAgent Azure OpenVPN"
  }

  is_ca_certificate     = true
  validity_period_hours = 87600 # 10 years

  allowed_uses = [
    "cert_signing",
    "crl_signing",
    "digital_signature",
  ]
}

resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem

  dns_names = ["${certOwner}-server.deepagent.local"]

  subject {
    common_name  = "${certOwner}-server.deepagent.local"
    organization = "DeepAgent Azure OpenVPN"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem   = tls_cert_request.server.cert_request_pem
  ca_private_key_pem = tls_private_key.ca.private_key_pem
  ca_cert_pem        = tls_self_signed_cert.ca.cert_pem

  validity_period_hours = 8760 # 1 year — rotate before this expires

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]
}

resource "tls_private_key" "client" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "client" {
  private_key_pem = tls_private_key.client.private_key_pem

  subject {
    common_name  = "${certOwner}-client"
    organization = "DeepAgent Azure OpenVPN"
  }
}

resource "tls_locally_signed_cert" "client" {
  cert_request_pem   = tls_cert_request.client.cert_request_pem
  ca_private_key_pem = tls_private_key.ca.private_key_pem
  ca_cert_pem        = tls_self_signed_cert.ca.cert_pem

  validity_period_hours = 8760

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "client_auth",
  ]
}
`;

  // ── VM startup script (cloud-init via custom_data) ────────────────────
  // Same shape as gcp-openvpn.ts's startup script. Reads PEMs from the
  // Azure Instance Metadata Service (IMDS) tag values that terraform sets
  // on the VM. Azure has no equivalent to GCE's arbitrary metadata KVs, so
  // we ship the PEMs INLINE in the cloud-init script (base64'd).
  const startupScript = `#!/bin/bash
set -euo pipefail
exec > /var/log/deepagent-openvpn-startup.log 2>&1
echo "[deepagent] OpenVPN startup: $(date -u)"

if [[ -f /etc/openvpn/.provisioned ]]; then
  echo "[deepagent] Already provisioned — skipping."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y openvpn iptables-persistent openssl

# ── PEMs are embedded below by Terraform (base64 encoded) ──
mkdir -p /etc/openvpn/server /etc/openvpn/ccd
cat > /etc/openvpn/server/ca.crt     <<'CAEOF'
__CA_CERT_PEM_PLACEHOLDER__
CAEOF
cat > /etc/openvpn/server/server.crt <<'SRVCERTEOF'
__SERVER_CERT_PEM_PLACEHOLDER__
SRVCERTEOF
cat > /etc/openvpn/server/server.key <<'SRVKEYEOF'
__SERVER_KEY_PEM_PLACEHOLDER__
SRVKEYEOF
chmod 600 /etc/openvpn/server/server.key

# ── DH params (2048-bit; ~30-60s on Standard_B1s) ──
openssl dhparam -out /etc/openvpn/server/dh.pem 2048

# ── Server config ──
cat > /etc/openvpn/server/server.conf <<'OVPNEOF'
port ${vpnPort}
proto ${transport === "tcp" ? "tcp-server" : "udp"}
dev tun
ca   /etc/openvpn/server/ca.crt
cert /etc/openvpn/server/server.crt
key  /etc/openvpn/server/server.key
dh   /etc/openvpn/server/dh.pem
topology subnet
server ${clientCidrToOpenvpnPair(clientCidr)}
ifconfig-pool-persist /var/log/openvpn/ipp.txt
${splitTunnel ? `# Split-tunnel: only advertise the VNet route to clients.
push "route ${cidrToOpenvpnPair(spec.vpcCidr)}"` : `# Full-tunnel: send all client traffic through this endpoint.
push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 8.8.8.8"
push "dhcp-option DNS 1.1.1.1"`}
keepalive 10 60
cipher AES-256-GCM
data-ciphers AES-256-GCM:AES-128-GCM
auth SHA256
persist-key
persist-tun
user  nobody
group nogroup
verb 3
status /var/log/openvpn/status.log
log-append /var/log/openvpn/openvpn.log
OVPNEOF
mkdir -p /var/log/openvpn

# ── IP forwarding + iptables NAT ──
sysctl -w net.ipv4.ip_forward=1
grep -q "^net.ipv4.ip_forward" /etc/sysctl.conf && \\
  sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf || \\
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf

IFACE=$(ip route show default | awk '/default/ {print $5; exit}')
iptables -t nat -A POSTROUTING -s ${clientCidr} -o "$IFACE" -j MASQUERADE
iptables -A FORWARD -i tun+ -o "$IFACE" -j ACCEPT
iptables -A FORWARD -i "$IFACE" -o tun+ -j ACCEPT
netfilter-persistent save

# ── Enable + start ──
systemctl enable openvpn-server@server
systemctl start  openvpn-server@server

touch /etc/openvpn/.provisioned
echo "[deepagent] OpenVPN startup: DONE $(date -u)"
`;

  // NSG allowlist rules. Azure NSG requires unique priority per direction;
  // start at 100 and step by 10.
  const nsgRules: string[] = [];
  let priority = 100;
  for (const range of sourceRanges) {
    nsgRules.push(`  security_rule {
    name                       = "allow-openvpn-${priority}"
    priority                   = ${priority}
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "${transport === "tcp" ? "Tcp" : "Udp"}"
    source_port_range          = "*"
    destination_port_range     = "${vpnPort}"
    source_address_prefix      = "${range}"
    destination_address_prefix = "*"
  }`);
    priority += 10;
  }
  // SSH allowed ONLY from the VPN client pool. Once you're connected to the
  // VPN, you can SSH the VM at its private IP; from the raw internet you
  // can't. Keeps the attack surface tight without needing a fixed operator
  // IP. (Earlier draft used "AzureBastionSubnet" — that's a SUBNET NAME,
  // not an Azure NSG service tag, so it fails with SecurityRuleInvalidAddressPrefix.)
  nsgRules.push(`  security_rule {
    name                       = "allow-ssh-from-vpn"
    priority                   = ${priority}
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "${clientCidr}"
    destination_address_prefix = "*"
  }`);

  const mainTf = `# ${name} — Azure OpenVPN endpoint in ${spec.location}
# ${splitTunnel ? "split-tunnel" : "full-tunnel"} · ${transport.toUpperCase()}/${vpnPort} · client CIDR ${clientCidr}
# Attaches to VNet ${spec.vnetName} / subnet ${spec.subnetName} in RG ${spec.resourceGroupName}.
# Generated by DeepAgent. Regenerating overwrites this file.

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

${pkiTf}
resource "azurerm_public_ip" "vpn" {
  name                = "${name}-openvpn-pip"
  location            = "${spec.location}"
  resource_group_name = data.azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_network_security_group" "vpn" {
  name                = "${name}-openvpn-nsg"
  location            = "${spec.location}"
  resource_group_name = data.azurerm_resource_group.this.name
${nsgRules.join("\n\n")}

  tags = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_network_interface" "vpn" {
  name                = "${name}-openvpn-nic"
  location            = "${spec.location}"
  resource_group_name = data.azurerm_resource_group.this.name

  # IP forwarding at the NIC layer — without this, Azure silently drops
  # packets whose source IP isn't the NIC's own IP. Breaks NAT'd tunnel
  # traffic. Required for any router / NAT / VPN VM.
  ip_forwarding_enabled = true

  ip_configuration {
    name                          = "primary"
    subnet_id                     = data.azurerm_subnet.this.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.vpn.id
  }

  tags = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_network_interface_security_group_association" "vpn" {
  network_interface_id      = azurerm_network_interface.vpn.id
  network_security_group_id = azurerm_network_security_group.vpn.id
}

# custom_data is cloud-init's UserData. We assemble the PEMs from Terraform
# state into the script inline, then base64-encode the whole thing (Azure
# expects custom_data to be pre-encoded).
locals {
  vpn_startup_script = replace(
    replace(
      replace(
        <<-STARTUP
${startupScript.split("\n").map((l) => "        " + l).join("\n")}
        STARTUP
        ,
        "__CA_CERT_PEM_PLACEHOLDER__",
        chomp(tls_self_signed_cert.ca.cert_pem)
      ),
      "__SERVER_CERT_PEM_PLACEHOLDER__",
      chomp(tls_locally_signed_cert.server.cert_pem)
    ),
    "__SERVER_KEY_PEM_PLACEHOLDER__",
    chomp(tls_private_key.server.private_key_pem)
  )
}

resource "azurerm_linux_virtual_machine" "vpn" {
  name                  = "${name}-openvpn"
  location              = "${spec.location}"
  resource_group_name   = data.azurerm_resource_group.this.name
  size                  = "${vmSize}"
  admin_username        = "${adminUsername}"
  network_interface_ids = [azurerm_network_interface.vpn.id]

  admin_ssh_key {
    username   = "${adminUsername}"
    public_key = ${JSON.stringify(spec.sshPublicKey)}
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = ${diskGb}
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(local.vpn_startup_script)

  tags = ${jsonToHcl(tags, "  ")}
}
`;

  const outputsTf = `output "client_vpn_endpoint_id" {
  value       = azurerm_linux_virtual_machine.vpn.id
  description = "Azure VM id serving as the OpenVPN endpoint"
}

output "client_vpn_dns_name" {
  value       = azurerm_public_ip.vpn.ip_address
  description = "Static public IP clients connect to — goes into the .ovpn 'remote' line"
}

output "region" {
  value       = "${spec.location}"
  description = "Azure region the endpoint lives in"
}

output "vpn_port" {
  value       = ${vpnPort}
  description = "Port clients connect on"
}

output "vpn_transport" {
  value       = "${transport}"
  description = "Transport protocol (udp/tcp)"
}

output "ssh_command" {
  value       = "ssh ${adminUsername}@\${azurerm_public_ip.vpn.ip_address}"
  description = "Admin SSH access (ops only — VPN clients don't use this)"
}

output "client_certificate_pem" {
  value       = tls_locally_signed_cert.client.cert_pem
  description = "Initial client cert PEM — paste between <cert></cert> in the .ovpn file"
  sensitive   = true
}

output "client_private_key_pem" {
  value       = tls_private_key.client.private_key_pem_pkcs8
  description = "Initial client private key PEM — paste between <key></key> in the .ovpn file"
  sensitive   = true
}

output "ca_certificate_pem" {
  value       = tls_self_signed_cert.ca.cert_pem
  description = "CA cert PEM — paste between <ca></ca> in the .ovpn file"
}

output "ca_private_key_pem" {
  value       = tls_private_key.ca.private_key_pem
  description = "CA private key PEM. SENSITIVE — used by the app's issue-user-cert flow to mint per-user certs off this CA without re-running Terraform."
  sensitive   = true
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

// ── helpers ─────────────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function jsonToHcl(obj: Record<string, string>, indent: string): string {
  const rows = Object.entries(obj).map(([k, v]) => `${indent}  ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + `\n${indent}}`;
}

/** "10.0.0.0/24" → "10.0.0.0 255.255.255.0" — OpenVPN's `push route` and
 *  `server` directives want dotted netmask notation, not CIDR. */
function cidrToOpenvpnPair(cidr: string): string {
  const [ip, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!ip || Number.isNaN(bits)) return cidr;
  const mask = Array.from({ length: 4 }, (_, i) => {
    const n = Math.max(0, Math.min(8, bits - i * 8));
    return 256 - Math.pow(2, 8 - n);
  }).join(".");
  return `${ip} ${mask}`;
}

function clientCidrToOpenvpnPair(cidr: string): string {
  return cidrToOpenvpnPair(cidr);
}
