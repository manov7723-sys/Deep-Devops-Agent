import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  buildEc2Terraform,
  validateAwsId,
  validateCidr,
  EC2_AMI_FAMILIES,
} from "@/lib/devops/ec2";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/aws/ec2
 *
 * Network > EC2 page submit action — launches one EC2 into a picked
 * (existing) VPC + subnet. Same commit + approval shape as /aws/vpc.
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  vpcId: z.string().trim().min(1),
  subnetId: z.string().trim().min(1),
  ami: z.enum(EC2_AMI_FAMILIES as [string, ...string[]]).optional(),
  instanceType: z.string().trim().min(1).optional(),
  diskGb: z.coerce.number().int().min(8).max(16384).optional(),
  volumeType: z.enum(["gp3", "gp2", "io2"]).optional(),
  volumeIops: z.coerce.number().int().min(100).max(64000).optional(),
  encryptVolume: z.boolean().optional(),
  sshCidr: z.string().trim().optional(),
  sshKeyName: z.string().trim().optional(),
  allowHttp: z.boolean().optional(),
  allowHttps: z.boolean().optional(),
  userData: z.string().max(64 * 1024).optional(),
  customTags: z.record(z.string(), z.string()).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const v = validateAwsId("vpc", body.vpcId);
  if (!v.ok) return NextResponse.json({ ok: false, code: "invalid_vpc_id", message: v.error }, { status: 400 });
  const s = validateAwsId("subnet", body.subnetId);
  if (!s.ok) return NextResponse.json({ ok: false, code: "invalid_subnet_id", message: s.error }, { status: 400 });
  if (body.sshCidr) {
    const c = validateCidr(body.sshCidr);
    if (!c.ok) return NextResponse.json({ ok: false, code: "invalid_cidr", message: c.error }, { status: 400 });
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_aws_provider" }, { status: 409 });
  const env = await prisma.env.findFirst({ where: { projectId, key: body.envKey }, select: { id: true, key: true } });
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  const pr = await prisma.projectRepo.findFirst({
    where: { projectId, repo: { deletedAt: null } },
    orderBy: { addedAt: "desc" },
    select: { repo: { select: { fullName: true, defaultBranch: true } } },
  });
  if (!pr?.repo?.fullName) return NextResponse.json({ ok: false, code: "no_repo" }, { status: 409 });
  const repoFullName = pr.repo.fullName;
  const defaultBranch = pr.repo.defaultBranch || "main";

  const files = buildEc2Terraform({
    name: body.name,
    region: body.region,
    env: body.envKey,
    vpcId: body.vpcId,
    subnetId: body.subnetId,
    ami: body.ami as
      | "al2023"
      | "ubuntu-22.04"
      | "ubuntu-24.04"
      | "windows-2022"
      | "rhel-9"
      | "sles-15"
      | "debian-12"
      | undefined,
    instanceType: body.instanceType,
    diskGb: body.diskGb,
    volumeType: body.volumeType,
    volumeIops: body.volumeIops,
    encryptVolume: body.encryptVolume,
    sshCidr: body.sshCidr,
    sshKeyName: body.sshKeyName,
    allowHttp: body.allowHttp,
    allowHttps: body.allowHttps,
    userData: body.userData,
    tags: { CreatedBy: "deepagent-ec2-ui", ...(body.customTags ?? {}) },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/ec2/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add EC2 ${body.name} in ${body.region}`,
        branch: defaultBranch,
      },
      { projectId, userId: gate.access.session.userId },
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, code: "commit_failed", message: `${path}: ${res.error}` },
        { status: 502 },
      );
    }
    commits.push({ path, commitSha: res.output.commitSha });
  }

  const stack = `ec2-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Launch EC2 ${body.name} (${body.instanceType ?? "t3.micro"}) in ${body.region}`,
    summary: `${body.ami ?? "al2023"} · ${body.instanceType ?? "t3.micro"} · ${body.diskGb ?? 20}GB gp3 · into ${body.vpcId}/${body.subnetId}. ${body.sshCidr ? `SSH from ${body.sshCidr}.` : "SSM only, no SSH port."}`,
    cloud: "aws",
    region: body.region,
    instanceType: body.instanceType,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary: [
      { change: "add" as const, text: `aws_instance ${body.name} (${body.instanceType ?? "t3.micro"})` },
      { change: "add" as const, text: "aws_security_group + egress + IAM SSM role + instance profile" },
      { change: "add" as const, text: "aws_eip attached to the instance" },
    ],
  });
  if (!approval.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "policy_blocked",
        message: `Policy blocked: ${approval.policy.violations.map((vi) => vi.message).join(" ")}`,
        violations: approval.policy.violations,
      },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    approvalId: approval.approvalId,
    risk: approval.risk,
    committedFiles: commits,
    repoPath: `terraform/ec2/${body.name}/`,
    repoFullName,
  });
}
