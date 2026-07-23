import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildVpcTerraform, validateCidr, VPC_DEFAULTS } from "@/lib/devops/vpc";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/aws/vpc
 *
 * Network > VPC create submit — same shape as /aws/vpc-peering:
 *   1. generate the console-style VPC HCL (multi-AZ, optional private, NAT)
 *   2. commit each .tf under terraform/vpc/<name>/ on the default branch
 *   3. create an infra approval, return approvalId for inline ApprovalCard
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  vpcCidr: z.string().trim().min(1),
  azCount: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  includePrivateSubnets: z.boolean().optional(),
  natStrategy: z.enum(["none", "single", "per_az"]).optional(),
  dnsHostnames: z.boolean().optional(),
  dnsSupport: z.boolean().optional(),
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
  const cidrCheck = validateCidr(body.vpcCidr);
  if (!cidrCheck.ok) {
    return NextResponse.json(
      { ok: false, code: "invalid_cidr", message: `vpcCidr: ${cidrCheck.error}` },
      { status: 400 },
    );
  }
  void VPC_DEFAULTS; // referenced by generator, keep in scope

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
  });
  if (!cp) {
    return NextResponse.json({ ok: false, code: "no_aws_provider" }, { status: 409 });
  }
  const env = await prisma.env.findFirst({
    where: { projectId, key: body.envKey },
    select: { id: true, key: true },
  });
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  const pr = await prisma.projectRepo.findFirst({
    where: { projectId, repo: { deletedAt: null } },
    orderBy: { addedAt: "desc" },
    select: { repo: { select: { fullName: true, defaultBranch: true } } },
  });
  if (!pr?.repo?.fullName) {
    return NextResponse.json({ ok: false, code: "no_repo", message: "Attach a repo first." }, { status: 409 });
  }
  const repoFullName = pr.repo.fullName;
  const defaultBranch = pr.repo.defaultBranch || "main";

  const azCount = (body.azCount ?? VPC_DEFAULTS.azCount) as 1 | 2 | 3;
  const includePrivate = body.includePrivateSubnets ?? VPC_DEFAULTS.includePrivateSubnets;
  const natStrategy = includePrivate ? (body.natStrategy ?? VPC_DEFAULTS.natStrategy) : "none";

  const files = buildVpcTerraform({
    name: body.name,
    region: body.region,
    env: body.envKey,
    vpcCidr: body.vpcCidr,
    azCount,
    includePrivateSubnets: includePrivate,
    natStrategy,
    dnsHostnames: body.dnsHostnames,
    dnsSupport: body.dnsSupport,
    tags: { CreatedBy: "deepagent-vpc-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/vpc/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add VPC ${body.name} (${body.region})`,
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

  const stack = `vpc-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const planSummary = [
    { change: "add" as const, text: `aws_vpc ${body.vpcCidr} (${azCount} AZ${azCount === 1 ? "" : "s"})` },
    { change: "add" as const, text: `${azCount} × aws_subnet (public)` },
    { change: "add" as const, text: "aws_internet_gateway + public route table" },
  ];
  if (includePrivate) {
    planSummary.push({ change: "add" as const, text: `${azCount} × aws_subnet (private)` });
    planSummary.push({ change: "add" as const, text: `${azCount} × aws_route_table (private)` });
  }
  if (natStrategy === "single") planSummary.push({ change: "add" as const, text: "1 × aws_nat_gateway (shared)" });
  if (natStrategy === "per_az") planSummary.push({ change: "add" as const, text: `${azCount} × aws_nat_gateway (per-AZ)` });

  const summaryBits = [
    `VPC ${body.vpcCidr} in ${body.region}`,
    `${azCount} AZ${azCount === 1 ? "" : "s"}`,
    includePrivate ? "public + private subnets" : "public subnets only",
  ];
  if (includePrivate && natStrategy !== "none") summaryBits.push(`NAT: ${natStrategy}`);

  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create VPC ${body.name} in ${body.region}`,
    summary: summaryBits.join(" · ") + ".",
    cloud: "aws",
    region: body.region,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary,
  });
  if (!approval.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "policy_blocked",
        message: `Policy blocked this change: ${approval.policy.violations.map((v) => v.message).join(" ")}`,
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
    repoPath: `terraform/vpc/${body.name}/`,
    repoFullName,
  });
}
