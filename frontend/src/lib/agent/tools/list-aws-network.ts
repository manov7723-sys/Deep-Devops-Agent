/**
 * Two thin read-only agent tools for AWS network discovery:
 *   - list_aws_vpcs(region)             — VPCs in that region
 *   - list_aws_subnets(region, vpcId)   — subnets in a specific VPC + region
 *
 * These exist so the CHAT EC2/VPC-peering flows can look VPCs/subnets up
 * live and offer them as pill options — same information the console-style
 * UI pages get from /aws/vpcs and /aws/subnets. The UI pages call those
 * routes directly; agent tools live server-side and go straight to the CLI.
 *
 * Both are cloud-gated to AWS via tools/index.ts.
 */
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

// ── list_aws_vpcs ────────────────────────────────────────────────────────

type ListVpcsInput = { region: string };
type Vpc = { vpcId: string; cidr: string; name: string; isDefault: boolean };
type ListVpcsOutput = { region: string; vpcs: Vpc[]; count: number };

export const listAwsVpcsTool: Tool<ListVpcsInput, ListVpcsOutput> = {
  name: "list_aws_vpcs",
  description:
    "List every VPC in the given AWS region under the project's connected AWS " +
    "account. Use this in the chat EC2 flow AFTER the user picks a region: " +
    "the returned list is what you offer as VPC pill-options in the next step. " +
    "Returns each VPC's id, CIDR, Name tag, and default-VPC flag. If the list " +
    "is empty, tell the user there are no VPCs in that region and offer to " +
    "create one via 'create vpc' or the Network > VPCs page.",
  inputSchema: {
    type: "object",
    properties: { region: { type: "string", description: "AWS region, e.g. us-east-1." } },
    required: ["region"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No AWS account connected to this project." };
    const creds = await resolveAwsExecEnv(cp.id);
    if (!creds.ok) return { ok: false, error: creds.message };
    const region = input.region.trim();

    const res = await runStage({
      command: "aws",
      args: ["ec2", "describe-vpcs", "--region", region, "--output", "json", "--no-cli-pager"],
      cwd: tmpdir(),
      env: { ...creds.env, AWS_REGION: region },
      timeoutMs: 15000,
      maxBufferBytes: 2 * 1024 * 1024,
    });
    if (res.exitCode !== 0) {
      return { ok: false, error: `aws ec2 describe-vpcs failed in ${region}: ${res.stderr.slice(-400)}` };
    }
    let parsed: {
      Vpcs?: Array<{
        VpcId: string;
        CidrBlock?: string;
        IsDefault?: boolean;
        Tags?: Array<{ Key: string; Value: string }>;
      }>;
    };
    try {
      parsed = JSON.parse(res.stdout || "{}");
    } catch {
      return { ok: false, error: "AWS returned non-JSON." };
    }
    const vpcs = (parsed.Vpcs ?? []).map((v) => ({
      vpcId: v.VpcId,
      cidr: v.CidrBlock ?? "",
      name: v.Tags?.find((t) => t.Key === "Name")?.Value ?? "",
      isDefault: !!v.IsDefault,
    }));
    return { ok: true, output: { region, vpcs, count: vpcs.length } };
  },
};

// ── list_aws_subnets ─────────────────────────────────────────────────────

type ListSubnetsInput = { region: string; vpcId?: string };
type Subnet = { subnetId: string; vpcId: string; cidr: string; az: string; name: string; isPublic: boolean };
type ListSubnetsOutput = { region: string; vpcId: string | null; subnets: Subnet[]; count: number };

export const listAwsSubnetsTool: Tool<ListSubnetsInput, ListSubnetsOutput> = {
  name: "list_aws_subnets",
  description:
    "List subnets in the given AWS region. Pass vpcId to filter to a single " +
    "VPC; omit it to list ALL subnets across every VPC in the region (the " +
    "chat EC2 flow uses the no-vpcId variant so the user can pick a subnet " +
    "AND its VPC in one dropdown). Each returned subnet includes its vpcId " +
    "so the caller can derive the VPC from the picked subnet.",
  inputSchema: {
    type: "object",
    properties: {
      region: { type: "string", description: "AWS region." },
      vpcId: {
        type: "string",
        description: "Optional VPC id (vpc-<hex>) to filter subnets to. OMIT to list every subnet in the region.",
      },
    },
    required: ["region"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No AWS account connected to this project." };
    const creds = await resolveAwsExecEnv(cp.id);
    if (!creds.ok) return { ok: false, error: creds.message };
    const region = input.region.trim();
    const vpcId = input.vpcId?.trim() || null;
    if (vpcId && !/^vpc-[0-9a-f]{8,17}$/.test(vpcId)) {
      return { ok: false, error: `"${vpcId}" doesn't look like a VPC id (expected vpc-<hex>).` };
    }

    const args = ["ec2", "describe-subnets", "--region", region, "--output", "json", "--no-cli-pager"];
    if (vpcId) args.push("--filters", `Name=vpc-id,Values=${vpcId}`);
    const res = await runStage({
      command: "aws",
      args,
      cwd: tmpdir(),
      env: { ...creds.env, AWS_REGION: region },
      timeoutMs: 15000,
      maxBufferBytes: 2 * 1024 * 1024,
    });
    if (res.exitCode !== 0) {
      return { ok: false, error: `aws ec2 describe-subnets failed in ${region}: ${res.stderr.slice(-400)}` };
    }
    let parsed: {
      Subnets?: Array<{
        SubnetId: string;
        VpcId?: string;
        CidrBlock?: string;
        AvailabilityZone?: string;
        MapPublicIpOnLaunch?: boolean;
        Tags?: Array<{ Key: string; Value: string }>;
      }>;
    };
    try {
      parsed = JSON.parse(res.stdout || "{}");
    } catch {
      return { ok: false, error: "AWS returned non-JSON." };
    }
    const subnets = (parsed.Subnets ?? []).map((s) => ({
      subnetId: s.SubnetId,
      vpcId: s.VpcId ?? "",
      cidr: s.CidrBlock ?? "",
      az: s.AvailabilityZone ?? "",
      name: s.Tags?.find((t) => t.Key === "Name")?.Value ?? "",
      isPublic: !!s.MapPublicIpOnLaunch,
    }));
    return { ok: true, output: { region, vpcId, subnets, count: subnets.length } };
  },
};
