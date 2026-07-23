import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildGcpVmTerraform } from "@/lib/devops/gcp-vm";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/gcp/vm — same shape as /aws/ec2 / /azure/vm.
 */
const Body = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars."),
  envKey: z.string().trim().min(1),
  zone: z.string().trim().min(1),
  region: z.string().trim().min(1),
  networkName: z.string().trim().min(1),
  subnetName: z.string().trim().min(1),
  image: z.enum(["debian-12", "ubuntu-2204-lts", "ubuntu-2404-lts", "rocky-linux-9", "windows-2022"]).optional(),
  machineType: z.string().trim().optional(),
  diskGb: z.number().int().min(10).max(4096).optional(),
  diskType: z.enum(["pd-standard", "pd-balanced", "pd-ssd"]).optional(),
  publicIp: z.boolean().optional(),
  sshUsername: z.string().trim().optional(),
  sshPublicKey: z.string().trim().optional(),
  windowsAdminUsername: z.string().trim().optional(),
  windowsAdminPassword: z.string().optional(),
  allowIapSsh: z.boolean().optional(),
  allowHttp: z.boolean().optional(),
  allowHttps: z.boolean().optional(),
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
  const isWindows = body.image === "windows-2022";
  if (!isWindows && !body.sshPublicKey?.trim()) {
    return NextResponse.json({ ok: false, code: "missing_ssh_key", message: "Linux VMs require an SSH public key." }, { status: 400 });
  }
  if (isWindows && !body.windowsAdminPassword?.trim()) {
    return NextResponse.json({ ok: false, code: "missing_password", message: "Windows VMs require an admin password." }, { status: 400 });
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

  const files = buildGcpVmTerraform({ ...body, env: body.envKey, labels: { created_by: "deepagent-gcp-vm-ui" } });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/gcp-vm/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add GCP VM ${body.name} (${body.zone})`,
        branch: defaultBranch,
      },
      { projectId, userId: gate.access.session.userId },
    );
    if (!res.ok) {
      return NextResponse.json({ ok: false, code: "commit_failed", message: `${path}: ${res.error}` }, { status: 502 });
    }
    commits.push({ path, commitSha: res.output.commitSha });
  }

  const stack = `gcp-vm-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Launch GCP VM ${body.name} in ${body.zone}`,
    summary: `${isWindows ? "Windows" : "Linux"} VM (${body.machineType ?? "e2-medium"}) on ${body.networkName}/${body.subnetName} in ${body.zone}.`,
    cloud: "gcp",
    region: body.region,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary: [{ change: "add" as const, text: `google_compute_instance ${body.name}` }],
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
    repoPath: `terraform/gcp-vm/${body.name}/`,
    repoFullName,
  });
}
