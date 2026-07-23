/**
 * VPN Certificate Set Terraform generator — standalone PKI for AWS Client VPN.
 *
 * Emits ONLY the certificate side of a Client VPN setup: a self-signed CA
 * + a server cert + a client cert, all imported into ACM. No VPN endpoint,
 * no subnets, no auth rules. Intent: users can create the PKI ONCE and
 * reuse the ACM ARNs across multiple VPN endpoints (staging, prod, per-
 * team, whatever) — no need to regenerate certs every time.
 *
 * Downstream flow:
 *   1. `create vpn certificates` → get server ARN + client CA ARN + client PEM
 *   2. `create client vpn` with certMode='manual' → paste the ARNs
 *   3. Endpoint uses the certs; PKI lifecycle is independent of the VPN
 *
 * Same emit shape as the auto-cert block inside the endpoint generator so
 * users can compare / migrate between the two approaches.
 */

export type VpnCertificatesSpec = {
  /**
   * Owner name used as the CN prefix on all three certs. Required — this
   * is what makes cert sets identifiable in ACM's list view and in the
   * Client VPN Connection Log's Common Name column.
   */
  name: string;

  /** AWS region — ACM is region-scoped and the certs must live in the same
   *  region as the VPN endpoint that consumes them. Required. */
  region: string;

  env?: string;

  /**
   * Number of client certs to issue (each with a numeric suffix, e.g.
   * <name>-client-1, <name>-client-2). Default 1. Bump when you want to
   * hand a distinct cert to each team member — Connection Log's Common
   * Name column then tells you who's connecting. Only the client_ca ARN
   * feeds into the endpoint; the endpoint validates ANY cert signed by
   * that CA, regardless of count.
   */
  clientCertCount?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

  /**
   * Individual client cert owner names, one per index. Length should match
   * `clientCertCount`. When omitted, entries default to "<name>-client-N".
   */
  clientNames?: string[];

  /** Additional tags merged on top of the app's defaults. */
  tags?: Record<string, string>;
};

export const VPN_CERTIFICATES_DEFAULTS = {
  clientCertCount: 1 as const,
} as const;

export function buildVpnCertificatesTerraform(spec: VpnCertificatesSpec): Record<string, string> {
  const owner = sanitise(spec.name);
  const clientCount = spec.clientCertCount ?? VPN_CERTIFICATES_DEFAULTS.clientCertCount;
  const clientNames = Array.from({ length: clientCount }, (_, i) => {
    const raw = spec.clientNames?.[i]?.trim();
    return sanitise(raw || `${owner}-client-${i + 1}`);
  });
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: `vpn-certs-${owner}`,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  if (!spec.name.trim()) throw new Error("name is required (used as CN prefix).");
  if (!spec.region.trim()) throw new Error("region is required (ACM is region-scoped).");

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
    tls = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

provider "aws" {
  region = "${spec.region}"
}
`;

  // ── CA + server ──────────────────────────────────────────────────────
  const caAndServer = `# ── Certificate Authority (self-signed, 10-year validity) ──
resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem = tls_private_key.ca.private_key_pem

  subject {
    common_name  = "${owner}-ca"
    organization = "DeepAgent VPN Certificates"
  }

  is_ca_certificate     = true
  validity_period_hours = 87600 # 10 years

  allowed_uses = [
    "cert_signing",
    "crl_signing",
    "digital_signature",
  ]
}

# ── Server certificate (signed by the CA) ──
resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem

  # AWS Client VPN rejects server certs without a DNS entry — CN in FQDN
  # form + DNS SAN so both validation paths pass.
  dns_names = ["${owner}-server.deepagent.local"]

  subject {
    common_name  = "${owner}-server.deepagent.local"
    organization = "DeepAgent VPN Certificates"
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
`;

  // ── Client certs (one per requested count, all signed by the same CA) ──
  const clientBlocks: string[] = [];
  for (let i = 0; i < clientCount; i++) {
    const cn = clientNames[i];
    clientBlocks.push(`resource "tls_private_key" "client_${i}" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "client_${i}" {
  private_key_pem = tls_private_key.client_${i}.private_key_pem

  subject {
    common_name  = "${cn}"
    organization = "DeepAgent VPN Certificates"
  }
}

resource "tls_locally_signed_cert" "client_${i}" {
  cert_request_pem   = tls_cert_request.client_${i}.cert_request_pem
  ca_private_key_pem = tls_private_key.ca.private_key_pem
  ca_cert_pem        = tls_self_signed_cert.ca.cert_pem

  validity_period_hours = 8760

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "client_auth",
  ]
}`);
  }

  // ── ACM imports (server + CA — client cert doesn't go into ACM) ──
  const acmImports = `resource "aws_acm_certificate" "server" {
  private_key       = tls_private_key.server.private_key_pem
  certificate_body  = tls_locally_signed_cert.server.cert_pem
  certificate_chain = tls_self_signed_cert.ca.cert_pem
  tags              = ${jsonToHcl({ ...tags, Purpose: "vpn-server" }, "  ")}
}

resource "aws_acm_certificate" "client_ca" {
  private_key       = tls_private_key.ca.private_key_pem
  certificate_body  = tls_self_signed_cert.ca.cert_pem
  tags              = ${jsonToHcl({ ...tags, Purpose: "vpn-client-ca" }, "  ")}
}`;

  const mainTf = `# ${owner} — VPN certificate set for ${spec.region}
# ${clientCount} client cert${clientCount === 1 ? "" : "s"}: ${clientNames.join(", ")}
#
# Generated by DeepAgent. Reuse the emitted ARNs across multiple Client VPN
# endpoints. Regenerating any resource replaces just that piece; the CA is
# stable across replacements so existing client certs stay valid.

${caAndServer}
${clientBlocks.join("\n\n")}

${acmImports}
`;

  // Outputs: ACM ARNs (for endpoint config) + client cert/key PEMs
  // (sensitive; users grab via `terraform output -raw`).
  const clientOutputs: string[] = [];
  for (let i = 0; i < clientCount; i++) {
    const cn = clientNames[i];
    clientOutputs.push(`output "client_${i}_common_name" {
  value       = "${cn}"
  description = "CN of client cert #${i + 1} — shows in AWS Connection Log."
}

output "client_${i}_certificate_pem" {
  value       = tls_locally_signed_cert.client_${i}.cert_pem
  description = "PEM of client cert #${i + 1} (${cn}). Hand this + key + ca_certificate_pem to the person using it."
  sensitive   = true
}

output "client_${i}_private_key_pem" {
  value       = tls_private_key.client_${i}.private_key_pem_pkcs8
  description = "Private key of client cert #${i + 1} (${cn}). Sensitive — never print in chat."
  sensitive   = true
}`);
  }

  const outputsTf = `output "server_certificate_arn" {
  value       = aws_acm_certificate.server.arn
  description = "Paste this into 'Server certificate ARN' when creating a Client VPN endpoint in Manual cert mode."
}

output "client_ca_certificate_arn" {
  value       = aws_acm_certificate.client_ca.arn
  description = "Paste this into 'Client root CA ARN' when creating a Client VPN endpoint in Manual cert mode. The endpoint accepts any client cert signed by this CA."
}

output "ca_certificate_pem" {
  value       = tls_self_signed_cert.ca.cert_pem
  description = "CA cert PEM — paste between <ca></ca> in the .ovpn file."
}

output "region" {
  value       = "${spec.region}"
  description = "ACM region — must match the Client VPN endpoint's region."
}

output "client_certificate_count" {
  value       = ${clientCount}
  description = "Number of client certs issued."
}

${clientOutputs.join("\n\n")}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function jsonToHcl(obj: Record<string, string>, indent: string): string {
  const rows = Object.entries(obj).map(([k, v]) => `${indent}  ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + `\n${indent}}`;
}
