/**
 * GCP OpenVPN Terraform generator — laptop-to-VPC OpenVPN tunnel.
 *
 * GCP has no managed "Client VPN" equivalent to AWS's, so we self-host on a
 * tiny Compute Engine VM. The generated stack is deliberately shaped to match
 * AWS Client VPN in the ways that matter for the app's downstream flows:
 *
 *   - The CA + server + initial client cert are generated inline via the
 *     Terraform `tls` provider. Same resource names (tls_private_key.ca,
 *     tls_self_signed_cert.ca, tls_locally_signed_cert.client) so the
 *     app's existing `resolveCaFromState` helper works verbatim for per-user
 *     cert issuance later.
 *   - The CA private key + client cert are surfaced as sensitive outputs
 *     with the SAME names AWS emits (client_certificate_pem,
 *     client_private_key_pem, ca_certificate_pem, ca_private_key_pem) so
 *     the cert-download UI is provider-agnostic.
 *   - A `client_vpn_dns_name` output exposes the static public IP as a DNS
 *     shape (OpenVPN clients accept both a name and a bare IP) so downstream
 *     cert issuance can build .ovpn files without special-casing GCP.
 *
 * What's actually provisioned:
 *   - google_compute_address    (static regional external IP)
 *   - google_compute_firewall   (UDP/1194 or TCP/443 depending on transport)
 *   - google_compute_firewall   (allow-ssh from IAP tunnel range, for ops)
 *   - google_compute_instance   (e2-small Ubuntu 22.04, startup script
 *                                writes CA/server/client PEMs from metadata,
 *                                installs openvpn, enables systemd unit,
 *                                sets iptables NAT for full-tunnel egress)
 *   - tls_*                     (CA + server cert + initial client cert)
 *
 * Cost: ~$8-15/mo (e2-small preemptible-optional + static IP + egress).
 */

export type GcpVpnSpec = {
  /** DNS-safe name prefix. */
  name: string;
  /** Region for the static IP + subnet lookup. */
  region: string;
  /** Zone for the VM (must be in `region`). */
  zone: string;
  env?: string;

  /** Existing VPC network name (in the caller's GCP project). */
  networkName: string;
  /** Existing subnetwork name in `region`. */
  subnetName: string;
  /** Subnet CIDR — used to advertise the "reach the VPC" route to clients. */
  vpcCidr: string;

  /** VM machine type. Default e2-small (2 vCPU burstable, 2 GB — plenty for OpenVPN). */
  machineType?: string;
  /** Boot disk size in GB. Default 15. */
  diskGb?: number;

  /** Non-overlapping CIDR for the tunnel's client IPs. Default 10.100.0.0/22. */
  clientCidr?: string;

  /**
   * Owner name — becomes the CN prefix on the auto-generated CA + server +
   * initial client certs. Falls back to the stack name. Matches the AWS
   * `certOwnerName` field so the two flows share prompts.
   */
  certOwnerName?: string;

  /** Split-tunnel (default true) → only VPC traffic goes over the tunnel. */
  splitTunnel?: boolean;

  /** Transport protocol. UDP is default + faster; TCP for restrictive networks. */
  transportProtocol?: "udp" | "tcp";
  /** VPN port. 1194 (default) or 443 (TCP-only, blends with HTTPS). */
  vpnPort?: 1194 | 443;

  /**
   * IPv4 CIDR blocks that may initiate an OpenVPN connection. Default
   * ["0.0.0.0/0"] (any-source) — the endpoint authenticates via client cert
   * regardless, so restricting source IPs is an extra layer, not a hard req.
   */
  sourceRanges?: string[];

  labels?: Record<string, string>;
};

export const GCP_VPN_DEFAULTS = {
  machineType: "e2-small",
  diskGb: 15,
  clientCidr: "10.100.0.0/22",
  splitTunnel: true,
  transportProtocol: "udp" as const,
  vpnPort: 1194 as const,
  sourceRanges: ["0.0.0.0/0"] as string[],
} as const;

export function validateGcpVpnCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.100.0.0/22).` };
  const prefix = Number(m[5]);
  if (prefix > 24) return { ok: false, error: `Client CIDR must be /24 or larger (got /${prefix}). Try 10.100.0.0/22.` };
  if (prefix < 12) return { ok: false, error: `Client CIDR /${prefix} is unusually large; use /16 or smaller.` };
  return { ok: true };
}

export function buildGcpVpnTerraform(spec: GcpVpnSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const certOwner = sanitise(spec.certOwnerName?.trim() || spec.name);
  const machineType = spec.machineType ?? GCP_VPN_DEFAULTS.machineType;
  const diskGb = spec.diskGb ?? GCP_VPN_DEFAULTS.diskGb;
  const clientCidr = spec.clientCidr ?? GCP_VPN_DEFAULTS.clientCidr;
  const splitTunnel = spec.splitTunnel ?? GCP_VPN_DEFAULTS.splitTunnel;
  const transport = spec.transportProtocol ?? GCP_VPN_DEFAULTS.transportProtocol;
  const vpnPort = spec.vpnPort ?? GCP_VPN_DEFAULTS.vpnPort;
  const sourceRanges = (spec.sourceRanges?.length ? spec.sourceRanges : GCP_VPN_DEFAULTS.sourceRanges).slice();
  const labels = {
    managed_by: "deepagent",
    stack: name,
    purpose: "openvpn-endpoint",
    ...(spec.env ? { environment: spec.env } : {}),
    ...(spec.labels ?? {}),
  };

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.20" }
    tls    = { source = "hashicorp/tls",    version = "~> 4.0" }
  }
}

provider "google" {
  region = "${spec.region}"
  zone   = "${spec.zone}"
}
`;

  const pkiTf = `# ── Auto-generated PKI (CA + server + initial client cert) ──
# Same resource layout as the AWS Client VPN generator so the shared
# resolveCaFromState helper works for both providers. The CA private key is
# a SENSITIVE output on purpose — the app's issue-user endpoint uses it to
# mint additional per-user certs off this CA without re-running Terraform.

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem

  subject {
    common_name  = "${certOwner}-ca"
    organization = "DeepAgent GCP OpenVPN"
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
    organization = "DeepAgent GCP OpenVPN"
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
    organization = "DeepAgent GCP OpenVPN"
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

# Diffie-Hellman parameters for OpenVPN. Terraform can't generate real DH
# params, so the startup script does it on first boot (openssl dhparam).
`;

  // ── VM startup script ────────────────────────────────────────────────
  // Runs on FIRST boot. Reads the CA + server cert/key from GCE instance
  // metadata (written by Terraform via metadata.ca_cert_pem etc.), sets up
  // OpenVPN as a systemd unit, opens iptables NAT for full-tunnel, and
  // arms IP forwarding. Idempotent — checks for /etc/openvpn/.provisioned
  // before doing anything, so a reboot doesn't re-run it.
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
apt-get install -y openvpn iptables-persistent openssl curl

# ── Fetch PEMs from instance metadata (Terraform put them there) ──
MD="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
H='Metadata-Flavor: Google'
mkdir -p /etc/openvpn/server /etc/openvpn/ccd
curl -fsS -H "$H" "$MD/ca-cert-pem"       > /etc/openvpn/server/ca.crt
curl -fsS -H "$H" "$MD/server-cert-pem"   > /etc/openvpn/server/server.crt
curl -fsS -H "$H" "$MD/server-key-pem"    > /etc/openvpn/server/server.key
chmod 600 /etc/openvpn/server/server.key

# ── DH params (2048-bit; ~30s on e2-small) ──
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
${splitTunnel ? `# Split-tunnel: only advertise the VPC route to clients.
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

# ── IP forwarding + iptables NAT (needed even for split-tunnel so return
#    traffic from the VPC reaches the client via the tun interface) ──
sysctl -w net.ipv4.ip_forward=1
grep -q "^net.ipv4.ip_forward" /etc/sysctl.conf && \\
  sed -i 's/^net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf || \\
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf

# NAT client subnet → outbound interface. GCE VMs have their public IP
# assigned via SNAT at the hypervisor, so we NAT the tunnel subnet on the
# instance's primary interface.
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

  const firewallTf = `# ── Firewall: allow client OpenVPN traffic to the VM ──
resource "google_compute_firewall" "vpn_ingress" {
  name    = "${name}-openvpn-ingress"
  network = data.google_compute_network.this.self_link

  allow {
    protocol = "${transport}"
    ports    = ["${vpnPort}"]
  }

  # Cert auth happens at the OpenVPN layer regardless of source_ranges; this
  # is the outer defensive layer. Default 0.0.0.0/0 keeps the UX simple —
  # tighten via sourceRanges if you know your team's egress IPs.
  source_ranges = [${sourceRanges.map((r) => JSON.stringify(r)).join(", ")}]

  target_tags = ["${name}-openvpn"]
}

# ── Firewall: allow IAP-tunnel SSH for ops (35.235.240.0/20 is GCP's IAP range) ──
resource "google_compute_firewall" "vpn_ssh" {
  name    = "${name}-openvpn-ssh"
  network = data.google_compute_network.this.self_link

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["${name}-openvpn"]
}
`;

  const mainTf = `# ${name} — GCP OpenVPN endpoint in ${spec.zone}
# ${splitTunnel ? "split-tunnel" : "full-tunnel"} · ${transport.toUpperCase()}/${vpnPort} · client CIDR ${clientCidr}
# Generated by DeepAgent. Regenerating overwrites this file.

data "google_compute_network" "this" {
  name = "${spec.networkName}"
}

data "google_compute_subnetwork" "this" {
  name   = "${spec.subnetName}"
  region = "${spec.region}"
}

data "google_compute_image" "boot" {
  family  = "ubuntu-2204-lts"
  project = "ubuntu-os-cloud"
}

${pkiTf}
resource "google_compute_address" "vpn" {
  name         = "${name}-openvpn-ip"
  region       = "${spec.region}"
  address_type = "EXTERNAL"
  description  = "Static public IP for the ${name} OpenVPN endpoint"
}

${firewallTf}
resource "google_compute_instance" "vpn" {
  name         = "${name}-openvpn"
  machine_type = "${machineType}"
  zone         = "${spec.zone}"
  tags         = ["${name}-openvpn"]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.boot.self_link
      size  = ${diskGb}
      type  = "pd-balanced"
    }
  }

  network_interface {
    network    = data.google_compute_network.this.self_link
    subnetwork = data.google_compute_subnetwork.this.self_link
    access_config {
      # Bind the static IP so clients have a stable endpoint address.
      nat_ip = google_compute_address.vpn.address
    }
  }

  # ── IP-forwarding at the GCE layer ──
  # Without this, the hypervisor drops packets whose source IP isn't the
  # instance's own — breaks the NAT'd tunnel traffic. Required for any
  # NAT/router VM in GCP.
  can_ip_forward = true

  # Pass the PEMs into the VM as instance metadata. The startup script pulls
  # them from the metadata service on first boot. Startup script itself is
  # also delivered via metadata (metadata_startup_script is a convenience).
  metadata = {
    "ca-cert-pem"     = tls_self_signed_cert.ca.cert_pem
    "server-cert-pem" = tls_locally_signed_cert.server.cert_pem
    "server-key-pem"  = tls_private_key.server.private_key_pem
  }

  metadata_startup_script = <<-EOT
${startupScript.split("\n").map((l) => "    " + l).join("\n")}
  EOT

  labels = ${jsonToHcl(labels, "  ")}

  # Force a replace if the PKI changes — otherwise the startup script has
  # already run on the old boot and the new certs won't be picked up.
  lifecycle {
    create_before_destroy = false
  }
}
`;

  const outputsTf = `output "client_vpn_endpoint_id" {
  value       = google_compute_instance.vpn.id
  description = "GCE instance id serving as the OpenVPN endpoint"
}

output "client_vpn_dns_name" {
  value       = google_compute_address.vpn.address
  description = "Static public IP (or DNS name) clients connect to — goes into the .ovpn 'remote' line"
}

output "region" {
  value       = "${spec.region}"
  description = "Region the endpoint lives in"
}

output "vpn_port" {
  value       = ${vpnPort}
  description = "Port clients connect on"
}

output "vpn_transport" {
  value       = "${transport}"
  description = "Transport protocol (udp/tcp)"
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

/** Same as cidrToOpenvpnPair but for the client-tunnel pool. OpenVPN's
 *  `server` directive uses the same "IP MASK" shape. */
function clientCidrToOpenvpnPair(cidr: string): string {
  return cidrToOpenvpnPair(cidr);
}
