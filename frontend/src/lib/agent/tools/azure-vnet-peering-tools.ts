/**
 * Azure Virtual Network Peering agent tool — bidirectional peering between
 * two Azure VNets (same or different subscription). Global peering (cross-
 * region) works natively — no special resource type needed.
 */
import { prisma } from "@/lib/db/prisma";
import { buildAzureVnetPeeringTerraform } from "@/lib/devops/azure-vnet-peering";
import type { Tool } from "./types";

type Input = {
  name: string;
  envKey?: string;
  leftResourceGroup: string;
  leftVnetName: string;
  rightResourceGroup: string;
  rightVnetName: string;
  allowGatewayTransit?: boolean;
  useRemoteGateways?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateAzureVnetPeeringTerraformTool: Tool<Input, Output> = {
  name: "generate_azure_vnet_peering_terraform",
  description:
    "Generate Terraform for a bidirectional Azure VNet Peering. Emits ONE " +
    "peering resource per side (Azure requires both). Global peering (cross-" +
    "region) works out of the box — no special resource type. NEVER hand-" +
    "write this HCL.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix." },
      envKey: { type: "string" },
      leftResourceGroup: { type: "string", description: "Resource group name for the LEFT VNet." },
      leftVnetName: { type: "string", description: "VNet name on the LEFT side." },
      rightResourceGroup: { type: "string", description: "Resource group name for the RIGHT VNet." },
      rightVnetName: { type: "string", description: "VNet name on the RIGHT side." },
      allowGatewayTransit: {
        type: "boolean",
        description: "LEFT vnet lets its Virtual Network Gateway be used by the RIGHT vnet as a transit hop. Default false.",
      },
      useRemoteGateways: {
        type: "boolean",
        description: "LEFT vnet uses the RIGHT vnet's Virtual Network Gateway (e.g. a hub-spoke topology). Default false.",
      },
    },
    required: ["name", "leftResourceGroup", "leftVnetName", "rightResourceGroup", "rightVnetName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "azure" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No Azure account connected to this project." };
    try {
      const files = buildAzureVnetPeeringTerraform({
        name: input.name,
        env: input.envKey,
        leftResourceGroup: input.leftResourceGroup,
        leftVnetName: input.leftVnetName,
        rightResourceGroup: input.rightResourceGroup,
        rightVnetName: input.rightVnetName,
        allowGatewayTransit: input.allowGatewayTransit,
        useRemoteGateways: input.useRemoteGateways,
        tags: { CreatedBy: "deepagent-azure-vnet-peering" },
      });
      return {
        ok: true,
        output: {
          files,
          stack: `azure-vnet-peering-${input.name}`,
          summary: `Azure VNet Peering: ${input.leftResourceGroup}/${input.leftVnetName} ↔ ${input.rightResourceGroup}/${input.rightVnetName}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/azure-vnet-peering/${input.name}/.`,
            `2. run_terraform to plan.`,
            `3. request_infra_approval with cloud:'azure'. STOP after emitting the approval-card fence.`,
            `4. After apply, VMs on both sides can reach each other by private IP.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate Azure VNet peering Terraform." };
    }
  },
};
