/**
 * Cross-region VPC peering agent tool — wires two VPCs in different AWS
 * regions (same account) together with a single Terraform stack.
 *
 * Chat flow (via playbook):
 *   1. generate_vpc_peering_terraform → returns HCL for the peering + accepter + routes
 *   2. write_repo_file → commit under terraform/vpc-peering/<name>/ on default branch
 *   3. run_terraform (plan) → preview
 *   4. request_infra_approval → single approval-card in chat
 *   5. (user clicks approve) → apply runs; outputs peering id + status
 *
 * The inputs mirror the outputs of the VPC+EC2 flow (vpc_id, vpc_cidr,
 * region) so a user who just ran that tool on two regions has all six values
 * ready to paste in.
 */
import { prisma } from "@/lib/db/prisma";
import { buildVpcPeeringTerraform, validatePeeringSpec } from "@/lib/devops/vpc-peering";
import type { Tool } from "./types";

type Input = {
  /** Short DNS-safe name (used as Terraform stack name + tag Name). */
  name: string;
  /** Env key (dev / staging / prod) — used for tagging only. Optional. */
  envKey?: string;
  /** LEFT side (requester). */
  leftRegion: string;
  leftVpcId: string;
  leftCidr: string;
  /** RIGHT side (accepter). MUST be in a different region than left. */
  rightRegion: string;
  rightVpcId: string;
  rightCidr: string;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateVpcPeeringTerraformTool: Tool<Input, Output> = {
  name: "generate_vpc_peering_terraform",
  description:
    "Generate Terraform for a CROSS-REGION AWS VPC peering: two aliased AWS " +
    "providers (one per region) + aws_vpc_peering_connection + " +
    "aws_vpc_peering_connection_accepter + routes wired into every route table " +
    "in BOTH VPCs. Same account only (cross-account is out of scope). NEVER " +
    "hand-write peering HCL. Both VPCs must already exist (created earlier via " +
    "generate_vpc_terraform or manually) — the tool doesn't create the " +
    "VPCs, only the peering. Non-overlapping CIDRs are required (peered VPCs " +
    "with the same CIDR can't route to each other). Pair with write_repo_file " +
    "(commit under terraform/vpc-peering/<name>/) then run_terraform + " +
    "request_infra_approval to gate the apply.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "DNS-safe short name for the peering (used as stack name + Name tag).",
      },
      envKey: { type: "string", description: "Env key (dev / staging / prod) — tagging only. Optional." },
      leftRegion: { type: "string", description: "Region of the LEFT / requester VPC (e.g. us-east-1)." },
      leftVpcId: { type: "string", description: "VPC id of the LEFT / requester VPC (vpc-<hex>)." },
      leftCidr: { type: "string", description: "IPv4 CIDR of the LEFT VPC (e.g. 10.0.0.0/16)." },
      rightRegion: { type: "string", description: "Region of the RIGHT / accepter VPC — MUST differ from leftRegion." },
      rightVpcId: { type: "string", description: "VPC id of the RIGHT / accepter VPC." },
      rightCidr: {
        type: "string",
        description: "IPv4 CIDR of the RIGHT VPC — MUST NOT overlap leftCidr, or the peering can't route.",
      },
    },
    required: ["name", "leftRegion", "leftVpcId", "leftCidr", "rightRegion", "rightVpcId", "rightCidr"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
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

    const spec = {
      name: input.name,
      env: input.envKey,
      left: { region: input.leftRegion, vpcId: input.leftVpcId, cidr: input.leftCidr },
      right: { region: input.rightRegion, vpcId: input.rightVpcId, cidr: input.rightCidr },
      tags: { CreatedBy: "deepagent-vpc-peering" },
    };
    const v = validatePeeringSpec(spec);
    if (!v.ok) return { ok: false, error: v.error };

    try {
      const files = buildVpcPeeringTerraform(spec);
      return {
        ok: true,
        output: {
          files,
          stack: `vpc-peering-${input.name}`,
          summary:
            `Cross-region VPC peering "${input.name}": ${input.leftVpcId} (${input.leftRegion}, ${input.leftCidr}) ` +
            `<-> ${input.rightVpcId} (${input.rightRegion}, ${input.rightCidr}). ` +
            `Routes will be added to every route table in both VPCs so the CIDRs can reach each other.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/vpc-peering/${input.name}/ on the repo's default branch (commitMode direct — no PR).`,
            `2. run_terraform(envKey, name:'vpc-peering-${input.name}-apply', action:'plan', files:<returned>, stack:'vpc-peering-${input.name}') to preview. Note: this stack has NO cloudProviderId dependency for a single region — the two aliased providers pick up creds from the connected AWS account.`,
            `3. request_infra_approval with the SAME files/stack + cloud:'aws' — emit the returned approvalId in an approval-card fence and STOP.`,
            `4. After the user approves, the apply runs; read outputs peering_connection_id + peering_status (should be 'active') + verify_command from the completed run.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate VPC peering Terraform." };
    }
  },
};
