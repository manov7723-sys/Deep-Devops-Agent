/**
 * AWS Client VPN Terraform generator — laptop-to-VPC OpenVPN tunnel.
 *
 * Two certificate modes:
 *
 *   - `certMode: "auto"` (recommended) — the generator emits a full PKI
 *     alongside the endpoint using the Terraform `tls` provider:
 *       CA key + self-signed CA cert
 *       server key + CSR + CA-signed server cert
 *       client key + CSR + CA-signed client cert
 *       aws_acm_certificate imports for both server + CA
 *     No easy-rsa on the user's laptop, no manual ACM import step. The client
 *     private key + cert land in Terraform outputs (marked sensitive) so the
 *     user can grab them for the .ovpn file post-apply.
 *
 *   - `certMode: "manual"` — user pastes ARNs of ACM certs they generated
 *     themselves (via easy-rsa, cert-manager, whatever). Kept for teams that
 *     already have their own PKI and want to reuse it.
 *
 * Emits either way:
 *   - 1 aws_ec2_client_vpn_endpoint          (server cert, client CIDR, auth mode)
 *   - N aws_ec2_client_vpn_network_association (one per subnet — spread across AZs for HA)
 *   - 1 aws_ec2_client_vpn_authorization_rule  ("who can reach what") — VPC CIDR by default
 *   - Optional: authorization rule + route for full-tunnel internet access
 */

export type ClientVpnAuthMode = "certificate" | "federated";
export type ClientVpnCertMode = "auto" | "manual";

export type ClientVpnSpec = {
  /** DNS-safe name prefix for tagged resources. */
  name: string;
  region: string;
  env?: string;

  /** VPC the endpoint is associated with. Its CIDR becomes the default authorization target. */
  vpcId: string;
  /** VPC CIDR — needed for the "reach the VPC" authorization rule. */
  vpcCidr: string;
  /** Subnets to associate the endpoint with. 1-3 recommended (each adds ~$72/mo). */
  subnetIds: string[];

  /** Non-overlapping CIDR for the tunnel's client IPs. Must be /22 or larger. Default 10.100.0.0/22. */
  clientCidr?: string;

  /**
   * Owner name used as the Common Name prefix on the auto-generated CA,
   * server, and client certs. When set, the CA is "<name>-ca", the server
   * cert is "<name>-server.deepagent.local", the client cert is
   * "<name>-client". Falls back to the stack name if omitted. Only used in
   * certMode="auto"; ignored in manual mode.
   *
   * Why it matters: this shows up in the AWS Connection Log's "Common Name"
   * column (per-session identity), in ACM's cert list, and in the CA subject
   * — makes downstream ops (auditing / revocation / debugging) way easier
   * when you have more than one Client VPN.
   */
  certOwnerName?: string;

  /** How server + client certs are supplied. Default "auto". */
  certMode?: ClientVpnCertMode;

  /**
   * MANUAL cert mode only — ACM cert ARN in the SAME region (server-side TLS).
   * Ignored (and not required) in auto mode.
   */
  serverCertificateArn?: string;

  /** Auth mode. Certificate = mutual TLS (client cert), Federated = SAML/OIDC via IdP. */
  authMode?: ClientVpnAuthMode;

  /**
   * MANUAL cert mode only — root/client CA ARN. Required for certificate
   * mode when certMode="manual". Ignored (and not required) in auto mode.
   */
  clientRootCertificateArn?: string;

  /** SAML provider ARN. Required for federated mode. */
  samlProviderArn?: string;

  /** Split tunnel — true means only VPC traffic goes over the VPN. Default true (recommended). */
  splitTunnel?: boolean;

  /** Transport protocol. UDP is the default and much faster; TCP for restrictive networks. */
  transportProtocol?: "udp" | "tcp";

  /** VPN port. 443 (default, blends with HTTPS) or 1194 (traditional OpenVPN). */
  vpnPort?: 443 | 1194;

  /** Also authorize + route 0.0.0.0/0 through the VPN (full-tunnel). Default false. */
  allowInternetEgress?: boolean;

  /** Additional tags merged on top of the app's defaults. */
  tags?: Record<string, string>;
};

export const CLIENT_VPN_DEFAULTS = {
  clientCidr: "10.100.0.0/22",
  certMode: "auto" as ClientVpnCertMode,
  authMode: "certificate" as ClientVpnAuthMode,
  splitTunnel: true,
  transportProtocol: "udp" as const,
  vpnPort: 443 as const,
  allowInternetEgress: false,
} as const;

/** Cheap sanity check — proper CIDR validation is Terraform's job at plan time. */
export function validateClientVpnCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.100.0.0/22).` };
  const prefix = Number(m[5]);
  if (prefix > 22) return { ok: false, error: `Client CIDR must be /22 or larger (got /${prefix}). Try 10.100.0.0/22.` };
  if (prefix < 12) return { ok: false, error: `Client CIDR /${prefix} is unusually large; use /16 or smaller.` };
  return { ok: true };
}

/** ACM ARN shape check — catches most paste mistakes without being too strict. */
export function validateAcmArn(arn: string, region: string): { ok: true } | { ok: false; error: string } {
  if (!arn.startsWith("arn:aws:acm:")) {
    return { ok: false, error: `ARN must start with "arn:aws:acm:" (got "${arn.slice(0, 20)}…").` };
  }
  const parts = arn.split(":");
  if (parts.length < 6 || !parts[5]?.startsWith("certificate/")) {
    return { ok: false, error: "ARN is missing the certificate/<uuid> suffix." };
  }
  if (parts[3] !== region) {
    return {
      ok: false,
      error: `ACM cert is in region "${parts[3]}" but Client VPN is in "${region}". ACM certs are region-scoped — import the cert into ${region}.`,
    };
  }
  return { ok: true };
}

export function buildClientVpnTerraform(spec: ClientVpnSpec): Record<string, string> {
  const name = sanitise(spec.name);
  // Cert owner name → CN prefix on the auto-generated CA/server/client
  // certs. Falls back to the stack name (back-compat with earlier stacks).
  const certOwner = sanitise(spec.certOwnerName?.trim() || spec.name);
  const clientCidr = spec.clientCidr ?? CLIENT_VPN_DEFAULTS.clientCidr;
  const certMode = spec.certMode ?? CLIENT_VPN_DEFAULTS.certMode;
  const authMode = spec.authMode ?? CLIENT_VPN_DEFAULTS.authMode;
  const splitTunnel = spec.splitTunnel ?? CLIENT_VPN_DEFAULTS.splitTunnel;
  const transport = spec.transportProtocol ?? CLIENT_VPN_DEFAULTS.transportProtocol;
  const vpnPort = spec.vpnPort ?? CLIENT_VPN_DEFAULTS.vpnPort;
  const allowInternet = spec.allowInternetEgress ?? CLIENT_VPN_DEFAULTS.allowInternetEgress;
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  if (spec.subnetIds.length === 0) {
    throw new Error("At least one subnetId is required for Client VPN network associations.");
  }
  if (certMode === "manual") {
    if (!spec.serverCertificateArn) throw new Error("Manual cert mode requires serverCertificateArn.");
    if (authMode === "certificate" && !spec.clientRootCertificateArn) {
      throw new Error("Manual cert mode + certificate auth requires clientRootCertificateArn.");
    }
  }
  // Federated auth requires SAML regardless of cert mode (federated ignores client cert).
  if (authMode === "federated" && !spec.samlProviderArn) {
    throw new Error("Federated auth mode requires samlProviderArn.");
  }

  // Auto mode adds the tls provider to the required_providers block so
  // Terraform can generate the CA + server + client keys/certs locally
  // during apply. Manual mode skips it (nothing to generate).
  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }${certMode === "auto" ? `
    tls = { source = "hashicorp/tls", version = "~> 4.0" }` : ""}
  }
}

provider "aws" {
  region = "${spec.region}"
}
`;

  // ── PKI (auto mode only) ─────────────────────────────────────────────
  // Generates a fresh self-signed CA + server + client cert every apply.
  // Certs live in Terraform state (encrypt your backend) — the client cert
  // + key are surfaced as sensitive outputs so users can copy them into the
  // .ovpn file. If you rotate, all previously-issued client certs are
  // invalidated at once (self-signed CA changes → clients need new certs).
  const pkiBlock = certMode === "auto"
    ? `# ── Auto-generated PKI (CA + server + client) ──
# Terraform's tls provider generates keys + self-signed certs during apply,
# then aws_acm_certificate imports them into ACM in the Client VPN's region.
# Regenerate any of these and the endpoint picks up the new cert on next apply.

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem

  subject {
    common_name  = "${certOwner}-ca"
    organization = "DeepAgent Client VPN"
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

  # AWS Client VPN rejects server certs without a domain — CN must be a
  # FQDN-shape string AND we add a DNS SAN so both validation paths pass.
  dns_names = ["${certOwner}-server.deepagent.local"]

  subject {
    common_name  = "${certOwner}-server.deepagent.local"
    organization = "DeepAgent Client VPN"
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
    organization = "DeepAgent Client VPN"
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

resource "aws_acm_certificate" "server" {
  private_key       = tls_private_key.server.private_key_pem
  certificate_body  = tls_locally_signed_cert.server.cert_pem
  certificate_chain = tls_self_signed_cert.ca.cert_pem
  tags              = ${jsonToHcl({ ...tags, Purpose: "client-vpn-server" }, "  ")}
}

resource "aws_acm_certificate" "client_ca" {
  private_key       = tls_private_key.ca.private_key_pem
  certificate_body  = tls_self_signed_cert.ca.cert_pem
  tags              = ${jsonToHcl({ ...tags, Purpose: "client-vpn-client-ca" }, "  ")}
}

`
    : "";

  // Auth stanza differs per mode + cert mode. In auto mode we reference the
  // generated ACM cert resources directly; in manual mode we use the ARNs
  // the user pasted.
  const authStanza =
    authMode === "certificate"
      ? `  authentication_options {
    type                       = "certificate-authentication"
    root_certificate_chain_arn = ${certMode === "auto" ? "aws_acm_certificate.client_ca.arn" : `"${spec.clientRootCertificateArn}"`}
  }`
      : `  authentication_options {
    type              = "federated-authentication"
    saml_provider_arn = "${spec.samlProviderArn}"
  }`;

  const serverCertRef = certMode === "auto"
    ? "aws_acm_certificate.server.arn"
    : `"${spec.serverCertificateArn}"`;

  const associationBlocks = spec.subnetIds
    .map((sid, i) => `resource "aws_ec2_client_vpn_network_association" "assoc_${i}" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.this.id
  subnet_id              = "${sid}"
}`)
    .join("\n\n");

  const internetBlocks = allowInternet
    ? `

resource "aws_ec2_client_vpn_authorization_rule" "internet" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.this.id
  target_network_cidr    = "0.0.0.0/0"
  authorize_all_groups   = true
  description            = "Allow internet-bound traffic (full-tunnel)"
}

resource "aws_ec2_client_vpn_route" "internet" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.this.id
  destination_cidr_block = "0.0.0.0/0"
  target_vpc_subnet_id   = "${spec.subnetIds[0]}"
  description            = "Full-tunnel internet route"

  depends_on = [aws_ec2_client_vpn_network_association.assoc_0]
}`
    : "";

  const mainTf = `# ${name} — AWS Client VPN in ${spec.region}
# ${spec.subnetIds.length} subnet association${spec.subnetIds.length === 1 ? "" : "s"} · ${authMode} auth · ${splitTunnel ? "split-tunnel" : "full-tunnel"} · ${transport.toUpperCase()}/${vpnPort} · certs: ${certMode}
# Generated by DeepAgent. Rerunning the wizard regenerates this file.

# ── Dedicated Client VPN Security Group ──
# Attach this to your RDS / EC2 / other in-VPC SGs as an INGRESS source, e.g.
#   aws_security_group_rule "rds_from_vpn" {
#     type                     = "ingress"
#     from_port                = 3306
#     to_port                  = 3306
#     protocol                 = "tcp"
#     security_group_id        = <your-rds-sg-id>
#     source_security_group_id = aws_security_group.vpn.id
#   }
# That's the pattern in AWS's Client VPN docs — safer than CIDR-based rules.
resource "aws_security_group" "vpn" {
  name        = "${name}-clientvpn-sg"
  # AWS rejects apostrophes + a bunch of other chars in SG descriptions (allowed:
  # a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*). Keep this plain.
  description = "Attached to Client VPN endpoint ${name}. Reference from downstream SGs as ingress source."
  vpc_id      = "${spec.vpcId}"

  # Default all-outbound so the endpoint can reach anything the auth rules
  # + route table allow. Downstream resources gate access via their own
  # ingress rules that reference THIS SG as source.
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = ${jsonToHcl({ ...tags, Purpose: "client-vpn-endpoint" }, "  ")}
}

${pkiBlock}# ── Connection logging ──
# Ships each VPN connect/disconnect event to CloudWatch Logs, including the
# client's SOURCE public IP (not just the pool-assigned 10.100.x.x IP AWS
# shows in the endpoint's Connections tab). This is the only way to see
# "who connected from where" — the console table only shows the pool IP.
#
# Retention is 30 days by default (cheap, ~$0.03/GB/mo storage). Bump if
# you need longer audit trails.
resource "aws_cloudwatch_log_group" "vpn" {
  name              = "/aws/clientvpn/${name}"
  retention_in_days = 30
  tags              = ${jsonToHcl(tags, "  ")}
}

resource "aws_cloudwatch_log_stream" "vpn" {
  name           = "connection-log"
  log_group_name = aws_cloudwatch_log_group.vpn.name
}

resource "aws_ec2_client_vpn_endpoint" "this" {
  description            = "${name} Client VPN"
  server_certificate_arn = ${serverCertRef}
  client_cidr_block      = "${clientCidr}"
  vpc_id                 = "${spec.vpcId}"
  security_group_ids     = [aws_security_group.vpn.id]
  split_tunnel           = ${splitTunnel}
  transport_protocol     = "${transport}"
  vpn_port               = ${vpnPort}
  session_timeout_hours  = 24

${authStanza}

  connection_log_options {
    enabled               = true
    cloudwatch_log_group  = aws_cloudwatch_log_group.vpn.name
    cloudwatch_log_stream = aws_cloudwatch_log_stream.vpn.name
  }

  tags = ${jsonToHcl(tags, "  ")}
}

${associationBlocks}

resource "aws_ec2_client_vpn_authorization_rule" "vpc" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.this.id
  target_network_cidr    = "${spec.vpcCidr}"
  authorize_all_groups   = true
  description            = "Allow reaching the target VPC"
}${internetBlocks}
`;

  // In auto mode the client cert + key are surfaced as sensitive outputs so
  // the user can copy them into the .ovpn file. `terraform output -raw
  // client_certificate_pem` prints just the PEM (no wrapping quotes).
  //
  // ca_private_key_pem is SENSITIVE and specifically exposed so the app's
  // "issue-user-cert" flow can mint additional per-user client certs signed
  // by this CA WITHOUT re-running Terraform. Never printed in chat; only
  // read server-side by the /aws/client-vpn/.../issue-user endpoint.
  const autoOutputs = certMode === "auto"
    ? `

output "client_certificate_pem" {
  value       = tls_locally_signed_cert.client.cert_pem
  description = "Client cert PEM — paste between <cert></cert> tags in the .ovpn file"
  sensitive   = true
}

output "client_private_key_pem" {
  value       = tls_private_key.client.private_key_pem_pkcs8
  description = "Client private key PEM — paste between <key></key> tags in the .ovpn file"
  sensitive   = true
}

output "ca_certificate_pem" {
  value       = tls_self_signed_cert.ca.cert_pem
  description = "CA cert PEM — paste between <ca></ca> tags in the .ovpn file"
}

output "ca_private_key_pem" {
  value       = tls_private_key.ca.private_key_pem
  description = "CA private key PEM. SENSITIVE — used by the app's issue-user-cert flow to mint additional per-user certs against this CA without re-running Terraform."
  sensitive   = true
}`
    : "";

  const outputsTf = `output "client_vpn_endpoint_id" {
  value       = aws_ec2_client_vpn_endpoint.this.id
  description = "Client VPN endpoint ID"
}

output "client_vpn_security_group_id" {
  value       = aws_security_group.vpn.id
  description = "SG attached to the Client VPN endpoint. Add this as an ingress source on your RDS/EC2 SGs to let VPN clients reach them (safer than CIDR-based rules)."
}

output "connection_log_group" {
  value       = aws_cloudwatch_log_group.vpn.name
  description = "CloudWatch log group where per-connection events (source IP, common name, bytes, duration) land. View in AWS Console → CloudWatch Logs, or 'aws logs tail /aws/clientvpn/<name> --follow'."
}

output "client_vpn_dns_name" {
  value       = aws_ec2_client_vpn_endpoint.this.dns_name
  description = "DNS name clients connect to (part of the .ovpn config)"
}

output "download_config_command" {
  value       = "aws ec2 export-client-vpn-client-configuration --client-vpn-endpoint-id \${aws_ec2_client_vpn_endpoint.this.id} --region ${spec.region} --output text > client.ovpn"
  description = "Command to download the .ovpn config — ${certMode === "auto" ? "then append the client_certificate_pem / client_private_key_pem outputs into it" : "then hand the file to end users along with their client cert + key"}"
}

output "region" {
  value       = "${spec.region}"
  description = "Region the Client VPN lives in"
}${autoOutputs}
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
