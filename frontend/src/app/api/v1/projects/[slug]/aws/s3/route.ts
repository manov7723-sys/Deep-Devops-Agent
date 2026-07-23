import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildS3Terraform, validateBucketName } from "@/lib/devops/s3";
import type { S3Encryption } from "@/lib/devops/s3";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/aws/s3
 *
 * Storage > S3 page submit action. Same commit-then-approval shape as the
 * other page-driven infra endpoints.
 */
const Body = z.object({
  name: z.string().trim().min(3).max(63),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  encryptionMode: z.enum(["AES256", "aws:kms"]).optional(),
  kmsKeyId: z.string().trim().optional(),
  versioning: z.boolean().optional(),
  noncurrentVersionExpirationDays: z.coerce.number().int().min(1).max(3650).optional(),
  addRandomSuffix: z.boolean().optional(),
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

  const nameCheck = validateBucketName(body.name);
  if (!nameCheck.ok) {
    return NextResponse.json({ ok: false, code: "invalid_bucket_name", message: nameCheck.error }, { status: 400 });
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

  const encryption: S3Encryption =
    body.encryptionMode === "aws:kms"
      ? { kind: "aws:kms", kmsKeyId: body.kmsKeyId }
      : { kind: "AES256" };

  const files = buildS3Terraform({
    name: body.name,
    region: body.region,
    env: body.envKey,
    versioning: body.versioning,
    encryption,
    noncurrentVersionExpirationDays: body.noncurrentVersionExpirationDays,
    addRandomSuffix: body.addRandomSuffix,
    tags: { CreatedBy: "deepagent-s3-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/s3/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add S3 bucket ${body.name} (${body.region})`,
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

  const stack = `s3-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create S3 bucket ${body.name} in ${body.region}`,
    summary: `${encryption.kind === "AES256" ? "SSE-S3" : "SSE-KMS"} encryption, versioning ${body.versioning === false ? "off" : "on"}, public access blocked. ${body.addRandomSuffix ? "Random suffix appended." : ""}`,
    cloud: "aws",
    region: body.region,
    publicBucket: false,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary: [
      { change: "add" as const, text: `aws_s3_bucket ${body.name}` },
      { change: "add" as const, text: "aws_s3_bucket_public_access_block (all four flags true)" },
      { change: "add" as const, text: `aws_s3_bucket_server_side_encryption_configuration (${encryption.kind})` },
      { change: "add" as const, text: `aws_s3_bucket_versioning (${body.versioning === false ? "Suspended" : "Enabled"})` },
      ...(body.noncurrentVersionExpirationDays
        ? [{ change: "add" as const, text: `aws_s3_bucket_lifecycle_configuration (expire noncurrent after ${body.noncurrentVersionExpirationDays}d)` }]
        : []),
    ],
  });
  if (!approval.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "policy_blocked",
        message: `Policy blocked: ${approval.policy.violations.map((v) => v.message).join(" ")}`,
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
    repoPath: `terraform/s3/${body.name}/`,
    repoFullName,
  });
}
