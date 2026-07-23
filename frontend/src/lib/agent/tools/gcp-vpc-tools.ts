/**
 * GCP VPC agent tool — generate Terraform for a console-style VPC (network +
 * subnets + sane firewall rules + optional Cloud NAT).
 */
import { prisma } from "@/lib/db/prisma";
import { buildGcpVpcTerraform, validateGcpCidr, GCP_VPC_DEFAULTS } from "@/lib/devops/gcp-vpc";
import type { Tool } from "./types";

type Input = {
  name: string;
  region: string;
  envKey?: string;
  vpcCidr?: string;
  subnetCount?: 1 | 2 | 3;
  privateGoogleAccess?: boolean;
  enableCloudNat?: boolean;
  allowIapSsh?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateGcpVpcTerraformTool: Tool<Input, Output> = {
  name: "generate_gcp_vpc_terraform",
  description:
    "Generate Terraform for a GCP VPC — network + N regional subnets + sane " +
    "firewall rules (allow-internal + optional IAP SSH) + optional Cloud NAT. " +
    "GCP's answer to AWS VPC. NEVER hand-write GCP VPC HCL.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      region: { type: "string", description: "GCP region, e.g. us-central1." },
      envKey: { type: "string" },
      vpcCidr: { type: "string", description: `Default ${GCP_VPC_DEFAULTS.vpcCidr}.` },
      subnetCount: { type: "number", enum: [1, 2, 3] },
      privateGoogleAccess: { type: "boolean" },
      enableCloudNat: { type: "boolean" },
      allowIapSsh: { type: "boolean" },
    },
    required: ["name", "region"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const vpcCidr = input.vpcCidr ?? GCP_VPC_DEFAULTS.vpcCidr;
    const c = validateGcpCidr(vpcCidr);
    if (!c.ok) return { ok: false, error: `vpcCidr: ${c.error}` };
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "gcp" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No GCP account connected to this project." };
    try {
      const subnetCount = (input.subnetCount ?? GCP_VPC_DEFAULTS.subnetCount) as 1 | 2 | 3;
      const files = buildGcpVpcTerraform({
        name: input.name,
        region: input.region,
        env: input.envKey,
        vpcCidr,
        subnetCount,
        privateGoogleAccess: input.privateGoogleAccess,
        enableCloudNat: input.enableCloudNat,
        allowIapSsh: input.allowIapSsh,
        labels: { created_by: "deepagent-gcp-vpc" },
      });
      return {
        ok: true,
        output: {
          files,
          stack: `gcp-vpc-${input.name}`,
          summary: `GCP VPC ${vpcCidr} in ${input.region} (${subnetCount} subnet${subnetCount === 1 ? "" : "s"}${input.enableCloudNat !== false ? " · Cloud NAT" : ""}).`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/gcp-vpc/${input.name}/.`,
            `2. run_terraform(envKey, name:'gcp-vpc-${input.name}-apply', action:'plan', files:<returned>, stack:'gcp-vpc-${input.name}').`,
            `3. request_infra_approval with cloud:'gcp' — emit the approval-card fence and STOP.`,
            `4. After apply, outputs vpc_name / subnet_names feed into the GCP VM flow.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate GCP VPC Terraform." };
    }
  },
};
