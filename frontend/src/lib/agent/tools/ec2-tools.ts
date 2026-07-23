/**
 * EC2 agent tool — launch a single EC2 into an EXISTING VPC/subnet. Console-
 * style split from the old bundled vpc-ec2 tool: this one assumes the user
 * already has a VPC (either from generate_vpc_terraform or one they picked
 * from the Network > EC2 page's dropdown).
 *
 * Chat flow (via playbook):
 *   1. generate_ec2_terraform → returns SG + IAM SSM role + EC2 + EIP HCL
 *   2. write_repo_file → commit under terraform/ec2/<name>/ on default branch
 *   3. run_terraform (plan) + request_infra_approval → single approval-card
 *   4. approve → apply outputs instance_id + public_ip + ssm_command
 */
import { prisma } from "@/lib/db/prisma";
import {
  buildEc2Terraform,
  validateAwsId,
  validateCidr,
  EC2_DEFAULTS,
  EC2_INSTANCE_TYPES,
  EC2_AMI_FAMILIES,
} from "@/lib/devops/ec2";
import type { Ec2AmiFamily, Ec2VolumeType } from "@/lib/devops/ec2";
import type { Tool } from "./types";

type Input = {
  name: string;
  region: string;
  envKey?: string;
  /** VPC id (vpc-<hex>) the SG lives in — REQUIRED. */
  vpcId: string;
  /** Subnet id (subnet-<hex>) the instance launches into — REQUIRED. */
  subnetId: string;
  ami?: Ec2AmiFamily;
  instanceType?: string;
  diskGb?: number;
  volumeType?: Ec2VolumeType;
  volumeIops?: number;
  encryptVolume?: boolean;
  sshCidr?: string;
  sshKeyName?: string;
  allowHttp?: boolean;
  allowHttps?: boolean;
  userData?: string;
  customTags?: Record<string, string>;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateEc2TerraformTool: Tool<Input, Output> = {
  name: "generate_ec2_terraform",
  description:
    "Generate Terraform for a single EC2 instance in an EXISTING VPC + subnet " +
    "(SG + IAM SSM role + EC2 + EIP). NEVER hand-write EC2 HCL. Requires the " +
    "caller to have picked a VPC and subnet already (via generate_vpc_terraform " +
    "or an existing one from the Network > EC2 page dropdown). Pair with " +
    "write_repo_file (commit under terraform/ec2/<name>/) then run_terraform + " +
    "request_infra_approval to gate the apply. SSM shell-in enabled by default " +
    "so users don't need SSH keys; pass sshCidr only if the user explicitly " +
    "wants TCP/22 open.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix." },
      region: { type: "string", description: "AWS region — MUST match the VPC's region." },
      envKey: { type: "string", description: "Env key (dev / staging / prod) — tagging only. Optional." },
      vpcId: { type: "string", description: "Existing VPC id (vpc-<hex>). REQUIRED." },
      subnetId: { type: "string", description: "Existing subnet id (subnet-<hex>) inside `vpcId`. REQUIRED." },
      ami: {
        type: "string",
        enum: EC2_AMI_FAMILIES,
        description:
          'OS image family. "al2023" (default), "ubuntu-22.04", "ubuntu-24.04", "windows-2022", "rhel-9", "sles-15", "debian-12".',
      },
      instanceType: {
        type: "string",
        description: `Common: ${EC2_INSTANCE_TYPES.slice(0, 4).join(", ")}. Default ${EC2_DEFAULTS.instanceType}.`,
      },
      diskGb: { type: "number", description: `Root EBS volume size in GB. Default ${EC2_DEFAULTS.diskGb}.` },
      volumeType: {
        type: "string",
        enum: ["gp3", "gp2", "io2"],
        description: `Root volume type. Default ${EC2_DEFAULTS.volumeType}.`,
      },
      volumeIops: {
        type: "number",
        description: "Root volume IOPS. Only used for gp3/io2. Leave unset for the AWS default (3000 for gp3).",
      },
      encryptVolume: {
        type: "boolean",
        description: `Encrypt the root volume. Default ${EC2_DEFAULTS.encryptVolume}.`,
      },
      sshCidr: {
        type: "string",
        description:
          "Optional. Empty/omitted = no SSH ingress (SSM only, safest). '0.0.0.0/0' opens SSH internet-wide (dangerous). Specific CIDR (e.g. '203.0.113.5/32') scopes to that source.",
      },
      sshKeyName: {
        type: "string",
        description: "Existing key pair name in this account+region. Required for Windows AMIs; optional for Linux.",
      },
      allowHttp: {
        type: "boolean",
        description: "Open TCP/80 to 0.0.0.0/0 (for web servers).",
      },
      allowHttps: {
        type: "boolean",
        description: "Open TCP/443 to 0.0.0.0/0 (for web servers).",
      },
      userData: {
        type: "string",
        description:
          "Bash script (or cloud-init YAML) that runs on first boot as root. Optional. Passed to aws_instance.user_data raw.",
      },
      customTags: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Extra tags merged on top of the auto tags (ManagedBy, Stack, Environment).",
      },
    },
    required: ["name", "region", "vpcId", "subnetId"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // Cheap validations before we shell any HCL.
    const v = validateAwsId("vpc", input.vpcId);
    if (!v.ok) return { ok: false, error: `vpcId: ${v.error}` };
    const s = validateAwsId("subnet", input.subnetId);
    if (!s.ok) return { ok: false, error: `subnetId: ${s.error}` };
    if (input.sshCidr) {
      const c = validateCidr(input.sshCidr);
      if (!c.ok) return { ok: false, error: `sshCidr: ${c.error}` };
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
      const files = buildEc2Terraform({
        name: input.name,
        region: input.region,
        env: input.envKey,
        vpcId: input.vpcId,
        subnetId: input.subnetId,
        ami: input.ami,
        instanceType: input.instanceType,
        diskGb: input.diskGb,
        volumeType: input.volumeType,
        volumeIops: input.volumeIops,
        encryptVolume: input.encryptVolume,
        sshCidr: input.sshCidr,
        sshKeyName: input.sshKeyName,
        allowHttp: input.allowHttp,
        allowHttps: input.allowHttps,
        userData: input.userData,
        tags: { CreatedBy: "deepagent-ec2", ...(input.customTags ?? {}) },
      });
      const sshLine = input.sshCidr
        ? input.sshCidr === "0.0.0.0/0"
          ? "SSH open to 0.0.0.0/0 (WARNING: internet-wide)"
          : `SSH scoped to ${input.sshCidr}`
        : "no SSH port open (SSM shell-in only)";
      return {
        ok: true,
        output: {
          files,
          stack: `ec2-${input.name}`,
          summary:
            `EC2 ${input.instanceType ?? EC2_DEFAULTS.instanceType} (${input.ami ?? EC2_DEFAULTS.ami}, ` +
            `${input.diskGb ?? EC2_DEFAULTS.diskGb}GB gp3) in ${input.vpcId}/${input.subnetId} (${input.region}). ${sshLine}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/ec2/${input.name}/ (commitMode direct — no PR).`,
            `2. run_terraform(envKey, name:'ec2-${input.name}-apply', action:'plan', files:<returned>, stack:'ec2-${input.name}') to preview.`,
            `3. request_infra_approval with the SAME files/stack + cloud:'aws' — emit approvalId in an approval-card fence and STOP.`,
            `4. After apply, outputs instance_id / public_ip / ssm_command are what the user needs to shell in.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate EC2 Terraform." };
    }
  },
};
