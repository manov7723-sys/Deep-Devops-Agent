import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildVpnCertificatesTerraform, VPN_CERTIFICATES_DEFAULTS } from "@/lib/devops/vpn-certificates";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/aws/vpn-certificates
 *
 * Standalone VPN cert-set provisioning submit:
 *   1. Generate the PKI HCL (CA + server + N clients + ACM imports).
 *   2. Commit each .tf under terraform/vpn-certificates/<name>/.
 *   3. Create an infra approval; return approvalId for the inline ApprovalCard.
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  clientCertCount: z
    .union([
      z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
      z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10),
    ])
    .optional(),
  clientNames: z.array(z.string().trim().max(60)).max(10).optional(),
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

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_aws_provider" }, { status: 409 });
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

  const clientCertCount = body.clientCertCount ?? VPN_CERTIFICATES_DEFAULTS.clientCertCount;

  const files = buildVpnCertificatesTerraform({
    name: body.name,
    region: body.region,
    env: body.envKey,
    clientCertCount,
    clientNames: body.clientNames,
    tags: { CreatedBy: "deepagent-vpn-certificates-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/vpn-certificates/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add VPN certificate set ${body.name} (${body.region})`,
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

  const stack = `vpn-certs-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create VPN certificates ${body.name} in ${body.region}`,
    summary: `CA + server cert + ${clientCertCount} client cert${clientCertCount === 1 ? "" : "s"}. Server + CA imported into ACM; client certs surfaced as sensitive Terraform outputs.`,
    cloud: "aws",
    region: body.region,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary: [
      { change: "add" as const, text: "tls_private_key + tls_self_signed_cert (CA, 10-year)" },
      { change: "add" as const, text: "tls_private_key + tls_cert_request + tls_locally_signed_cert (server, 1-year, w/ DNS SAN)" },
      { change: "add" as const, text: `${clientCertCount} × client cert (each with distinct CN, 1-year)` },
      { change: "add" as const, text: "aws_acm_certificate × 2 (server + client CA imported)" },
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
    repoPath: `terraform/vpn-certificates/${body.name}/`,
    repoFullName,
  });
}
