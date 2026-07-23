/**
 * VPN Certificate Set agent tool — standalone PKI for AWS Client VPN.
 * Creates CA + server + N client certs, imports the server + CA into ACM.
 * Then the Client VPN endpoint can be created in `certMode: "manual"` and
 * reference these ARNs.
 *
 * Chat flow:
 *   1. generate_vpn_certificates_terraform → returns the PKI HCL
 *   2. write_repo_file → commit under terraform/vpn-certificates/<name>/
 *   3. run_terraform (plan) + request_infra_approval → approval-card
 *   4. approve → apply outputs server_certificate_arn + client_ca_certificate_arn
 */
import { prisma } from "@/lib/db/prisma";
import { buildVpnCertificatesTerraform, VPN_CERTIFICATES_DEFAULTS } from "@/lib/devops/vpn-certificates";
import type { Tool } from "./types";

type Input = {
  name: string;
  region: string;
  envKey?: string;
  clientCertCount?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  clientNames?: string[];
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateVpnCertificatesTerraformTool: Tool<Input, Output> = {
  name: "generate_vpn_certificates_terraform",
  description:
    "Generate Terraform for a standalone VPN certificate set — CA + server " +
    "+ N client certs, with server + CA imported into ACM. Independent of " +
    "the Client VPN endpoint so the PKI can be reused across multiple VPNs. " +
    "Once applied, the ARNs plug into a Client VPN wizard in 'manual' cert " +
    "mode. NEVER hand-write this HCL — the tls provider blocks are subtle.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix — used as the CN prefix on the CA, server cert, and each client cert. Shows in AWS Connection Log's Common Name column." },
      region: { type: "string", description: "AWS region — ACM is region-scoped and MUST match the VPN endpoint's region." },
      envKey: { type: "string" },
      clientCertCount: {
        type: "number", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        description: `How many client certs to issue. Default ${VPN_CERTIFICATES_DEFAULTS.clientCertCount}. Bump to hand distinct certs to individual team members — Connection Log then attributes each session by CN.`,
      },
      clientNames: {
        type: "array", items: { type: "string" },
        description: "Per-client CN overrides, one per index. When omitted, entries default to '<name>-client-N'.",
      },
    },
    required: ["name", "region"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No AWS account connected to this project." };
    try {
      const files = buildVpnCertificatesTerraform({
        name: input.name,
        region: input.region,
        env: input.envKey,
        clientCertCount: input.clientCertCount,
        clientNames: input.clientNames,
        tags: { CreatedBy: "deepagent-vpn-certificates" },
      });
      const count = input.clientCertCount ?? VPN_CERTIFICATES_DEFAULTS.clientCertCount;
      return {
        ok: true,
        output: {
          files,
          stack: `vpn-certs-${input.name}`,
          summary: `VPN certificates for ${input.name} in ${input.region} — CA + server + ${count} client cert${count === 1 ? "" : "s"}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/vpn-certificates/${input.name}/.`,
            `2. run_terraform to plan.`,
            `3. request_infra_approval with cloud:'aws'. Emit the approval-card fence and STOP.`,
            `4. After apply, the outputs 'server_certificate_arn' + 'client_ca_certificate_arn' are what you paste into 'create client vpn' → Manual cert mode.`,
            `5. Per-client cert PEMs land in outputs 'client_N_certificate_pem' + 'client_N_private_key_pem' — hand these + the ca_certificate_pem to each team member for their .ovpn file. NEVER print any private key in chat.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate VPN certificate Terraform." };
    }
  },
};
