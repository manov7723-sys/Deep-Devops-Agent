import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildVpcPeeringTerraform, validatePeeringSpec } from "@/lib/devops/vpc-peering";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/aws/vpc-peering
 *
 * The Network > Peering page's submit action. Same end-to-end as what the
 * chat playbook does, but driven from a real UI instead of prose:
 *   1. generate the peering HCL with the current form values
 *   2. commit each .tf under terraform/vpc-peering/<name>/ on the repo's
 *      default branch (direct commit, no PR — matches the chat behavior)
 *   3. create an infra approval (policy checks + cost) — returns approvalId
 *      the client renders inline via <ApprovalCard>
 *
 * Requires:
 *   - AWS account connected on this project
 *   - At least one env on the project (to attach the approval + Terraform run)
 *   - An attached repo (for the file commit)
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Peering name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  left: z.object({
    region: z.string().trim().min(1),
    vpcId: z.string().trim().min(1),
    cidr: z.string().trim().min(1),
  }),
  right: z.object({
    region: z.string().trim().min(1),
    vpcId: z.string().trim().min(1),
    cidr: z.string().trim().min(1),
  }),
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

  // Structural validation (same-region + identical-CIDR + VPC-id shape).
  const specValidation = validatePeeringSpec({
    name: body.name,
    left: body.left,
    right: body.right,
    env: body.envKey,
  });
  if (!specValidation.ok) {
    return NextResponse.json({ ok: false, code: "invalid_spec", message: specValidation.error }, { status: 400 });
  }

  // Everything downstream needs: AWS provider + a matching env + a repo.
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
  });
  if (!cp) {
    return NextResponse.json(
      { ok: false, code: "no_aws_provider", message: "No AWS account connected to this project." },
      { status: 409 },
    );
  }
  const env = await prisma.env.findFirst({
    where: { projectId, key: body.envKey },
    select: { id: true, key: true },
  });
  if (!env) {
    return NextResponse.json(
      { ok: false, code: "env_not_found", message: `Env "${body.envKey}" not found on this project.` },
      { status: 404 },
    );
  }
  const projectRepo = await prisma.projectRepo.findFirst({
    where: { projectId, repo: { deletedAt: null } },
    orderBy: { addedAt: "desc" },
    select: { repo: { select: { fullName: true, defaultBranch: true } } },
  });
  if (!projectRepo?.repo?.fullName) {
    return NextResponse.json(
      { ok: false, code: "no_repo", message: "No repo attached to this project. Attach one on the CI/CD tab first." },
      { status: 409 },
    );
  }
  const repoFullName = projectRepo.repo.fullName;
  const defaultBranch = projectRepo.repo.defaultBranch || "main";

  // 1. Generate HCL.
  const files = buildVpcPeeringTerraform({
    name: body.name,
    env: body.envKey,
    left: body.left,
    right: body.right,
    tags: { CreatedBy: "deepagent-vpc-peering-ui" },
  });

  // 2. Commit each file under terraform/vpc-peering/<name>/ on the default
  //    branch. write_repo_file handles all the git-data-API dance itself.
  //    Fail loudly if any single file fails — a partially-committed stack
  //    would confuse the next apply run.
  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/vpc-peering/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add VPC peering ${body.name} (${body.left.region} to ${body.right.region})`,
        branch: defaultBranch,
      },
      { projectId, userId: gate.access.session.userId },
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, code: "commit_failed", message: `Failed committing ${path}: ${res.error}` },
        { status: 502 },
      );
    }
    commits.push({ path, commitSha: res.output.commitSha });
  }

  // 3. Create the infra approval (policy check + cost). Same shape as the
  //    chat flow's request_infra_approval — returns { ok, approvalId, risk }
  //    or a policy-blocked response.
  const stack = `vpc-peering-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Peer ${body.left.vpcId} (${body.left.region}) to ${body.right.vpcId} (${body.right.region})`,
    summary: `Cross-region VPC peering "${body.name}". LEFT: ${body.left.cidr} in ${body.left.region}. RIGHT: ${body.right.cidr} in ${body.right.region}. Same-account.`,
    cloud: "aws",
    region: body.left.region,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary: [
      { change: "add" as const, text: `aws_vpc_peering_connection ${body.name} (${body.left.region})` },
      { change: "add" as const, text: `aws_vpc_peering_connection_accepter ${body.name} (${body.right.region})` },
      {
        change: "info" as const,
        text: `Route ${body.right.cidr} -> peer in every route table of ${body.left.vpcId}`,
      },
      {
        change: "info" as const,
        text: `Route ${body.left.cidr} -> peer in every route table of ${body.right.vpcId}`,
      },
    ],
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
    repoPath: `terraform/vpc-peering/${body.name}/`,
    repoFullName,
  });
}
