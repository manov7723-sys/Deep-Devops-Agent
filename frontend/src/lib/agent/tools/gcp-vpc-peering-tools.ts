/**
 * GCP VPC Network Peering agent tool — bidirectional peering between two
 * GCP VPC networks (same or different project). Simpler than AWS peering
 * because routes propagate automatically — no route-table entries needed.
 */
import { prisma } from "@/lib/db/prisma";
import { buildGcpVpcPeeringTerraform } from "@/lib/devops/gcp-vpc-peering";
import type { Tool } from "./types";

type Input = {
  name: string;
  envKey?: string;
  leftNetwork: string;
  rightNetwork: string;
  leftProject?: string;
  exportCustomRoutes?: boolean;
  importCustomRoutes?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateGcpVpcPeeringTerraformTool: Tool<Input, Output> = {
  name: "generate_gcp_vpc_peering_terraform",
  description:
    "Generate Terraform for a bidirectional GCP VPC Network peering. " +
    "Global — works across regions natively. NO route table entries needed " +
    "(GCP propagates them automatically). Pass bare network names when both " +
    "sides live in the same project, or full self-links for cross-project. " +
    "NEVER hand-write this HCL.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix." },
      envKey: { type: "string", description: "Env key. Optional (tagging only)." },
      leftNetwork: { type: "string", description: "Left network — bare name (same project) or full self-link URL (cross-project)." },
      rightNetwork: { type: "string", description: "Right network — same shape as left." },
      leftProject: { type: "string", description: "GCP project id for the LEFT network. Defaults to the provider's project." },
      exportCustomRoutes: { type: "boolean", description: "Export non-standard routes to the peer. Default false." },
      importCustomRoutes: { type: "boolean", description: "Import non-standard routes from the peer. Default false." },
    },
    required: ["name", "leftNetwork", "rightNetwork"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "gcp" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No GCP account connected to this project." };
    try {
      const files = buildGcpVpcPeeringTerraform({
        name: input.name,
        env: input.envKey,
        leftNetwork: input.leftNetwork,
        rightNetwork: input.rightNetwork,
        leftProject: input.leftProject,
        exportCustomRoutes: input.exportCustomRoutes,
        importCustomRoutes: input.importCustomRoutes,
      });
      return {
        ok: true,
        output: {
          files,
          stack: `gcp-vpc-peering-${input.name}`,
          summary: `GCP VPC Peering: ${input.leftNetwork} ↔ ${input.rightNetwork}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/gcp-vpc-peering/${input.name}/.`,
            `2. run_terraform to plan.`,
            `3. request_infra_approval with cloud:'gcp'. STOP after emitting the approval-card fence.`,
            `4. After apply, both peering states should be ACTIVE — subnets on both sides can now reach each other. No route-table changes needed.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate GCP VPC peering Terraform." };
    }
  },
};
