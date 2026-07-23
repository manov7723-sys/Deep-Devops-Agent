import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildGcpVpcTerraform, validateGcpCidr, GCP_VPC_DEFAULTS } from "@/lib/devops/gcp-vpc";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/gcp/vpc
 *
 * GCP VPC create submit — same shape as /aws/vpc:
 *   1. generate the VPC HCL (network + N subnets + firewalls + optional NAT)
 *   2. commit each .tf under terraform/gcp-vpc/<name>/
 *   3. create an infra approval
 */
const Body = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars."),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  vpcCidr: z.string().trim().min(1),
  subnetCount: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  privateGoogleAccess: z.boolean().optional(),
  enableCloudNat: z.boolean().optional(),
  allowIapSsh: z.boolean().optional(),
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
  const cidrCheck = validateGcpCidr(body.vpcCidr);
  if (!cidrCheck.ok) {
    return NextResponse.json({ ok: false, code: "invalid_cidr", message: `vpcCidr: ${cidrCheck.error}` }, { status: 400 });
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "gcp" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_gcp_provider" }, { status: 409 });
  const env = await prisma.env.findFirst({ where: { projectId, key: body.envKey }, select: { id: true, key: true } });
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  const pr = await prisma.projectRepo.findFirst({
    where: { projectId, repo: { deletedAt: null } },
    orderBy: { addedAt: "desc" },
    select: { repo: { select: { fullName: true, defaultBranch: true } } },
  });
  if (!pr?.repo?.fullName) return NextResponse.json({ ok: false, code: "no_repo", message: "Attach a repo first." }, { status: 409 });
  const repoFullName = pr.repo.fullName;
  const defaultBranch = pr.repo.defaultBranch || "main";

  const subnetCount = (body.subnetCount ?? GCP_VPC_DEFAULTS.subnetCount) as 1 | 2 | 3;
  const files = buildGcpVpcTerraform({
    name: body.name,
    region: body.region,
    env: body.envKey,
    vpcCidr: body.vpcCidr,
    subnetCount,
    privateGoogleAccess: body.privateGoogleAccess,
    enableCloudNat: body.enableCloudNat,
    allowIapSsh: body.allowIapSsh,
    labels: { created_by: "deepagent-gcp-vpc-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/gcp-vpc/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add GCP VPC ${body.name} (${body.region})`,
        branch: defaultBranch,
      },
      { projectId, userId: gate.access.session.userId },
    );
    if (!res.ok) {
      return NextResponse.json({ ok: false, code: "commit_failed", message: `${path}: ${res.error}` }, { status: 502 });
    }
    commits.push({ path, commitSha: res.output.commitSha });
  }

  const stack = `gcp-vpc-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const planSummary = [
    { change: "add" as const, text: `google_compute_network ${body.name}-vpc` },
    { change: "add" as const, text: `${subnetCount} × google_compute_subnetwork` },
    { change: "add" as const, text: "google_compute_firewall (allow-internal)" },
  ];
  if (body.allowIapSsh !== false) planSummary.push({ change: "add" as const, text: "google_compute_firewall (allow IAP SSH)" });
  if (body.enableCloudNat !== false) planSummary.push({ change: "add" as const, text: "google_compute_router + router_nat (Cloud NAT)" });

  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create GCP VPC ${body.name} in ${body.region}`,
    summary: `${body.vpcCidr} · ${subnetCount} subnet${subnetCount === 1 ? "" : "s"}${body.enableCloudNat !== false ? " · Cloud NAT" : ""}.`,
    cloud: "gcp",
    region: body.region,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary,
  });
  if (!approval.ok) {
    return NextResponse.json(
      { ok: false, code: "policy_blocked", message: `Policy blocked this change: ${approval.policy.violations.map((v) => v.message).join(" ")}`, violations: approval.policy.violations },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    approvalId: approval.approvalId,
    risk: approval.risk,
    committedFiles: commits,
    repoPath: `terraform/gcp-vpc/${body.name}/`,
    repoFullName,
  });
}
