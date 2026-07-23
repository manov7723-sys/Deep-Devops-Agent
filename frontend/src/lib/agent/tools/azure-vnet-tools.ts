/**
 * Azure VNet agent tool — generate Terraform for a console-style Virtual
 * Network + subnets + optional NAT gateway. Azure's answer to AWS VPC.
 */
import { prisma } from "@/lib/db/prisma";
import {
  buildAzureVnetTerraform,
  validateVnetCidr,
  AZURE_VNET_DEFAULTS,
  type AzureNatStrategy,
} from "@/lib/devops/azure-vnet";
import type { Tool } from "./types";

type Input = {
  name: string;
  location: string;
  envKey?: string;
  vnetCidr?: string;
  subnetCount?: 1 | 2 | 3;
  includePrivateSubnets?: boolean;
  natStrategy?: AzureNatStrategy;
  createDefaultNsgs?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateAzureVnetTerraformTool: Tool<Input, Output> = {
  name: "generate_azure_vnet_terraform",
  description:
    "Generate Terraform for an Azure Virtual Network (VNet) — resource group + " +
    "VNet + N public subnets + optional private subnets + optional NAT gateway. " +
    "Azure's equivalent of AWS VPC. NEVER hand-write VNet HCL. Commit under " +
    "terraform/azure-vnet/<name>/ then plan + request_infra_approval.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix (lowercase, dashes)." },
      location: { type: "string", description: "Azure region, e.g. eastus, westeurope." },
      envKey: { type: "string", description: "Env key. Optional (tagging only)." },
      vnetCidr: { type: "string", description: `IPv4 CIDR. Default ${AZURE_VNET_DEFAULTS.vnetCidr}.` },
      subnetCount: { type: "number", enum: [1, 2, 3], description: `Subnets per tier. Default ${AZURE_VNET_DEFAULTS.subnetCount}.` },
      includePrivateSubnets: { type: "boolean", description: `Default ${AZURE_VNET_DEFAULTS.includePrivateSubnets}.` },
      natStrategy: {
        type: "string", enum: ["none", "single"],
        description: `NAT for private subnets. Default '${AZURE_VNET_DEFAULTS.natStrategy}'.`,
      },
      createDefaultNsgs: { type: "boolean", description: `Attach an NSG to each subnet. Default ${AZURE_VNET_DEFAULTS.createDefaultNsgs}.` },
    },
    required: ["name", "location"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const vnetCidr = input.vnetCidr ?? AZURE_VNET_DEFAULTS.vnetCidr;
    const c = validateVnetCidr(vnetCidr);
    if (!c.ok) return { ok: false, error: `vnetCidr: ${c.error}` };
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "azure" },
      select: { id: true },
    });
    if (!cp) {
      return {
        ok: false,
        error: "No Azure account connected to this project. Connect one on the Cloud providers tab first.",
      };
    }
    try {
      const subnetCount = (input.subnetCount ?? AZURE_VNET_DEFAULTS.subnetCount) as 1 | 2 | 3;
      const includePrivate = input.includePrivateSubnets ?? AZURE_VNET_DEFAULTS.includePrivateSubnets;
      const natStrategy: AzureNatStrategy = includePrivate
        ? (input.natStrategy ?? AZURE_VNET_DEFAULTS.natStrategy)
        : "none";
      const files = buildAzureVnetTerraform({
        name: input.name,
        location: input.location,
        env: input.envKey,
        vnetCidr,
        subnetCount,
        includePrivateSubnets: includePrivate,
        natStrategy,
        createDefaultNsgs: input.createDefaultNsgs,
        tags: { CreatedBy: "deepagent-azure-vnet" },
      });
      const summary = `Azure VNet ${vnetCidr} in ${input.location} (${subnetCount} subnet${subnetCount === 1 ? "" : "s"}/tier${includePrivate ? " · public + private" : " · public only"}${includePrivate && natStrategy !== "none" ? ` · NAT: ${natStrategy}` : ""}).`;
      return {
        ok: true,
        output: {
          files,
          stack: `azure-vnet-${input.name}`,
          summary,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/azure-vnet/${input.name}/.`,
            `2. run_terraform(envKey, name:'azure-vnet-${input.name}-apply', action:'plan', files:<returned>, stack:'azure-vnet-${input.name}').`,
            `3. request_infra_approval with cloud:'azure' — emit the approval-card fence and STOP.`,
            `4. After apply, outputs resource_group_name / vnet_id / vnet_cidr / public_subnet_ids feed into the Azure VM flow.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate Azure VNet Terraform." };
    }
  },
};
