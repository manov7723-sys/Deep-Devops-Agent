/**
 * VPC agent tool — generate Terraform for a console-style VPC:
 *   VPC + IGW + N public subnets + optional N private subnets + optional
 *   NAT gateways (none | single | per-AZ) + route tables + associations.
 *
 * Chat flow (via playbook):
 *   1. generate_vpc_terraform → returns full VPC HCL
 *   2. write_repo_file → commit under terraform/vpc/<name>/ on default branch
 *   3. run_terraform (plan) + request_infra_approval → single approval-card
 *   4. approve → apply outputs vpc_id + public/private subnet_ids
 */
import { prisma } from "@/lib/db/prisma";
import { buildVpcTerraform, validateCidr, VPC_DEFAULTS, type VpcNatStrategy } from "@/lib/devops/vpc";
import type { Tool } from "./types";

type Input = {
  name: string;
  region: string;
  envKey?: string;
  vpcCidr?: string;
  azCount?: 1 | 2 | 3;
  includePrivateSubnets?: boolean;
  natStrategy?: VpcNatStrategy;
  dnsHostnames?: boolean;
  dnsSupport?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateVpcTerraformTool: Tool<Input, Output> = {
  name: "generate_vpc_terraform",
  description:
    "Generate Terraform for an AWS console-style VPC: VPC + IGW + N public " +
    "subnets across N AZs, optional private subnets, optional NAT gateway(s). " +
    "This is VPC-ONLY — no EC2 attached. NEVER hand-write VPC HCL. " +
    "Returns the .tf file set; commit under terraform/vpc/<name>/ then plan + " +
    "request_infra_approval to gate the apply. Outputs vpc_id, vpc_cidr, " +
    "public_subnet_ids, private_subnet_ids, nat_gateway_ips are consumable by " +
    "the EC2 flow and the cross-region peering flow.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix (lowercase, dashes; tags all resources)." },
      region: { type: "string", description: "AWS region, e.g. us-east-1." },
      envKey: { type: "string", description: "Env key (dev / staging / prod) — used for tagging only. Optional." },
      vpcCidr: {
        type: "string",
        description: `IPv4 CIDR for the VPC. Default ${VPC_DEFAULTS.vpcCidr}. Use DISTINCT CIDRs across VPCs you plan to peer later. Subnet CIDRs are auto-carved from this /16 with cidrsubnet().`,
      },
      azCount: {
        type: "number",
        enum: [1, 2, 3],
        description: `How many AZs to spread subnets across. Default ${VPC_DEFAULTS.azCount}. Safe on every AWS region.`,
      },
      includePrivateSubnets: {
        type: "boolean",
        description: `Also create one private subnet per AZ. Default ${VPC_DEFAULTS.includePrivateSubnets}.`,
      },
      natStrategy: {
        type: "string",
        enum: ["none", "single", "per_az"],
        description:
          `NAT gateway strategy. Ignored when includePrivateSubnets=false. Default '${VPC_DEFAULTS.natStrategy}'. ` +
          "'single' is cheapest (~$33/mo + data), 'per_az' is HA (~$33/mo per AZ), 'none' leaves privates isolated.",
      },
      dnsHostnames: {
        type: "boolean",
        description: `enable_dns_hostnames on the VPC. Default ${VPC_DEFAULTS.dnsHostnames}.`,
      },
      dnsSupport: {
        type: "boolean",
        description: `enable_dns_support on the VPC. Default ${VPC_DEFAULTS.dnsSupport}.`,
      },
    },
    required: ["name", "region"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const vpcCidr = input.vpcCidr ?? VPC_DEFAULTS.vpcCidr;
    const r = validateCidr(vpcCidr);
    if (!r.ok) return { ok: false, error: `vpcCidr: ${r.error}` };
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
      const azCount = (input.azCount ?? VPC_DEFAULTS.azCount) as 1 | 2 | 3;
      const includePrivate = input.includePrivateSubnets ?? VPC_DEFAULTS.includePrivateSubnets;
      const natStrategy: VpcNatStrategy = includePrivate
        ? (input.natStrategy ?? VPC_DEFAULTS.natStrategy)
        : "none";
      const files = buildVpcTerraform({
        name: input.name,
        region: input.region,
        env: input.envKey,
        vpcCidr,
        azCount,
        includePrivateSubnets: includePrivate,
        natStrategy,
        dnsHostnames: input.dnsHostnames,
        dnsSupport: input.dnsSupport,
        tags: { CreatedBy: "deepagent-vpc" },
      });
      const natBits =
        includePrivate && natStrategy !== "none" ? ` · NAT: ${natStrategy}` : "";
      const privBits = includePrivate ? " · public + private" : " · public only";
      return {
        ok: true,
        output: {
          files,
          stack: `vpc-${input.name}`,
          summary: `VPC ${vpcCidr} in ${input.region} (${azCount} AZ${azCount === 1 ? "" : "s"}${privBits}${natBits}).`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/vpc/${input.name}/ (commitMode direct — no PR).`,
            `2. run_terraform(envKey, name:'vpc-${input.name}-apply', action:'plan', files:<returned>, stack:'vpc-${input.name}') to preview.`,
            `3. request_infra_approval with the SAME files/stack + cloud:'aws' — emit the returned approvalId in an approval-card fence and STOP.`,
            `4. After apply, outputs vpc_id / vpc_cidr / public_subnet_ids / private_subnet_ids are what the EC2 or peering flow needs next.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate VPC Terraform." };
    }
  },
};
