/**
 * AWS Client VPN agent tool — generate Terraform for a laptop-to-VPC VPN
 * (OpenVPN-style; endpoint + network associations + authorization rules).
 *
 * Chat flow (via playbook):
 *   1. generate_client_vpn_terraform → returns endpoint + associations + auth rules
 *   2. write_repo_file → commit under terraform/client-vpn/<name>/
 *   3. run_terraform (plan) + request_infra_approval → single approval-card
 *   4. approve → apply outputs endpoint id + dns name + download command
 */
import { prisma } from "@/lib/db/prisma";
import {
  buildClientVpnTerraform,
  validateClientVpnCidr,
  validateAcmArn,
  CLIENT_VPN_DEFAULTS,
  type ClientVpnAuthMode,
  type ClientVpnCertMode,
} from "@/lib/devops/client-vpn";
import type { Tool } from "./types";

type Input = {
  name: string;
  region: string;
  envKey?: string;
  vpcId: string;
  vpcCidr: string;
  subnetIds: string[];
  clientCidr?: string;
  certOwnerName?: string;
  certMode?: ClientVpnCertMode;
  serverCertificateArn?: string;
  authMode?: ClientVpnAuthMode;
  clientRootCertificateArn?: string;
  samlProviderArn?: string;
  splitTunnel?: boolean;
  transportProtocol?: "udp" | "tcp";
  vpnPort?: 443 | 1194;
  allowInternetEgress?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateClientVpnTerraformTool: Tool<Input, Output> = {
  name: "generate_client_vpn_terraform",
  description:
    "Generate Terraform for an AWS Client VPN endpoint (laptop-to-VPC OpenVPN " +
    "tunnel). By default (certMode='auto') the generator emits a full PKI " +
    "(CA + server cert + client cert) via the Terraform tls provider and " +
    "imports both into ACM automatically — NO easy-rsa on the user's laptop, " +
    "NO manual ACM import step. Set certMode='manual' only if the user " +
    "explicitly wants to bring their own ACM cert ARNs. NEVER hand-write " +
    "Client VPN HCL. Commit under terraform/client-vpn/<name>/ then plan + " +
    "request_infra_approval to gate the apply. Outputs endpoint id, dns name, " +
    "download command, and (auto mode only) the client cert + key + CA PEMs " +
    "to paste into the .ovpn config.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix." },
      region: { type: "string", description: "AWS region — MUST match the ACM cert's region." },
      envKey: { type: "string", description: "Env key. Optional (tagging only)." },
      vpcId: { type: "string", description: "Target VPC id (e.g. vpc-0abc123). Endpoint associates to this VPC." },
      vpcCidr: { type: "string", description: "Target VPC CIDR — becomes the default authorization rule so clients can reach the VPC." },
      subnetIds: {
        type: "array",
        items: { type: "string" },
        description: "Subnets to associate with the endpoint. 1-3 recommended (spread across AZs for HA). Each association costs ~$72/mo.",
      },
      clientCidr: {
        type: "string",
        description: `Non-overlapping CIDR the tunnel hands out to clients. Must be /22 or larger. Default ${CLIENT_VPN_DEFAULTS.clientCidr}. Must NOT overlap the target VPC.`,
      },
      certOwnerName: {
        type: "string",
        description: "Auto-cert mode ONLY. Owner name used as the CN prefix on the CA / server / client certs (e.g. 'vashant' → CA='vashant-ca', client CN='vashant-client'). Shows in AWS Connection Log's Common Name column. Falls back to the stack name.",
      },
      certMode: {
        type: "string",
        enum: ["auto", "manual"],
        description: `How certificates are supplied. 'auto' (default) generates a CA + server + client cert via the Terraform tls provider and imports into ACM automatically. 'manual' requires the user to pre-generate ACM certs and paste ARNs.`,
      },
      serverCertificateArn: { type: "string", description: "MANUAL cert mode only. ACM cert ARN for the endpoint's server-side TLS. Region-scoped." },
      authMode: {
        type: "string",
        enum: ["certificate", "federated"],
        description: `Authentication. 'certificate' = mutual TLS (needs clientRootCertificateArn). 'federated' = SAML/OIDC (needs samlProviderArn). Default '${CLIENT_VPN_DEFAULTS.authMode}'.`,
      },
      clientRootCertificateArn: { type: "string", description: "MANUAL cert mode + certificate auth only. Client root CA ARN in ACM." },
      samlProviderArn: { type: "string", description: "SAML IdP provider ARN. Required for federated auth." },
      splitTunnel: {
        type: "boolean",
        description: `Split tunnel — only VPC traffic goes over VPN, internet uses local. Default ${CLIENT_VPN_DEFAULTS.splitTunnel}.`,
      },
      transportProtocol: { type: "string", enum: ["udp", "tcp"] },
      vpnPort: { type: "number", enum: [443, 1194] },
      allowInternetEgress: {
        type: "boolean",
        description: `Also authorize + route 0.0.0.0/0 through VPN (full-tunnel internet). Default ${CLIENT_VPN_DEFAULTS.allowInternetEgress}.`,
      },
    },
    required: ["name", "region", "vpcId", "vpcCidr", "subnetIds"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const clientCidr = input.clientCidr ?? CLIENT_VPN_DEFAULTS.clientCidr;
    const cidrCheck = validateClientVpnCidr(clientCidr);
    if (!cidrCheck.ok) return { ok: false, error: `clientCidr: ${cidrCheck.error}` };
    const certMode = input.certMode ?? CLIENT_VPN_DEFAULTS.certMode;
    if (certMode === "manual") {
      if (!input.serverCertificateArn) return { ok: false, error: "certMode='manual' requires serverCertificateArn." };
      const serverArnCheck = validateAcmArn(input.serverCertificateArn, input.region);
      if (!serverArnCheck.ok) return { ok: false, error: `serverCertificateArn: ${serverArnCheck.error}` };
      if ((input.authMode ?? CLIENT_VPN_DEFAULTS.authMode) === "certificate") {
        if (!input.clientRootCertificateArn) {
          return { ok: false, error: "clientRootCertificateArn is required for certificate auth mode when certMode='manual'." };
        }
        const clientArnCheck = validateAcmArn(input.clientRootCertificateArn, input.region);
        if (!clientArnCheck.ok) return { ok: false, error: `clientRootCertificateArn: ${clientArnCheck.error}` };
      }
    }
    if (!input.subnetIds.length) {
      return { ok: false, error: "At least one subnetId is required." };
    }
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) {
      return {
        ok: false,
        error: "No AWS account connected to this project. Connect one on the Cloud providers tab first.",
      };
    }
    try {
      const files = buildClientVpnTerraform({
        name: input.name,
        region: input.region,
        env: input.envKey,
        vpcId: input.vpcId,
        vpcCidr: input.vpcCidr,
        subnetIds: input.subnetIds,
        clientCidr,
        certOwnerName: input.certOwnerName,
        certMode,
        serverCertificateArn: input.serverCertificateArn,
        authMode: input.authMode,
        clientRootCertificateArn: input.clientRootCertificateArn,
        samlProviderArn: input.samlProviderArn,
        splitTunnel: input.splitTunnel,
        transportProtocol: input.transportProtocol,
        vpnPort: input.vpnPort,
        allowInternetEgress: input.allowInternetEgress,
        tags: { CreatedBy: "deepagent-client-vpn" },
      });
      return {
        ok: true,
        output: {
          files,
          stack: `client-vpn-${input.name}`,
          summary: `Client VPN in ${input.region} → ${input.vpcId} (${input.subnetIds.length} subnet${input.subnetIds.length === 1 ? "" : "s"}, client CIDR ${clientCidr}).`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/client-vpn/${input.name}/ (commitMode direct — no PR).`,
            `2. run_terraform(envKey, name:'client-vpn-${input.name}-apply', action:'plan', files:<returned>, stack:'client-vpn-${input.name}') to preview.`,
            `3. request_infra_approval with the SAME files/stack + cloud:'aws' — emit the approval-card fence and STOP.`,
            certMode === "auto"
              ? `4. After apply, run download_config_command to grab client.ovpn, then paste the client_certificate_pem / client_private_key_pem / ca_certificate_pem outputs into the .ovpn file between <cert></cert>, <key></key>, and <ca></ca> tags. NEVER print the private key output in chat — tell the user to run 'terraform output -raw client_private_key_pem' locally.`
              : `4. After apply, run download_config_command to grab client.ovpn. Hand it to end users along with their client cert + key from easy-rsa.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate Client VPN Terraform." };
    }
  },
};
