import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildAzureVmTerraform } from "@/lib/devops/azure-vm";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/azure/vm
 *
 * Azure VM launch submit — same shape as /aws/ec2:
 *   1. generate the VM HCL (NIC + NSG + optional PIP + VM resource)
 *   2. commit each .tf under terraform/azure-vm/<name>/
 *   3. create an infra approval
 */
const Body = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars."),
  envKey: z.string().trim().min(1),
  location: z.string().trim().min(1),
  resourceGroupName: z.string().trim().min(1),
  vnetName: z.string().trim().min(1),
  subnetName: z.string().trim().min(1),
  image: z.enum(["ubuntu-22.04", "ubuntu-24.04", "debian-12", "rhel-9", "windows-2022"]).optional(),
  vmSize: z.string().trim().optional(),
  diskGb: z.number().int().min(20).max(4096).optional(),
  publicIp: z.boolean().optional(),
  adminUsername: z.string().trim().optional(),
  sshPublicKey: z.string().trim().optional(),
  adminPassword: z.string().optional(),
  allowSsh: z.boolean().optional(),
  allowRdp: z.boolean().optional(),
  allowHttp: z.boolean().optional(),
  allowHttps: z.boolean().optional(),
  sshCidr: z.string().trim().optional(),
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
  const image = body.image ?? "ubuntu-22.04";
  const isWindows = image === "windows-2022";
  if (!isWindows && !body.sshPublicKey?.trim()) {
    return NextResponse.json({ ok: false, code: "missing_ssh_key", message: "Linux VMs require an SSH public key." }, { status: 400 });
  }
  if (isWindows && !body.adminPassword?.trim()) {
    return NextResponse.json({ ok: false, code: "missing_password", message: "Windows VMs require an admin password." }, { status: 400 });
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_azure_provider" }, { status: 409 });
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

  const files = buildAzureVmTerraform({
    ...body,
    env: body.envKey,
    tags: { CreatedBy: "deepagent-azure-vm-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/azure-vm/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add Azure VM ${body.name} (${body.location})`,
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

  const stack = `azure-vm-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Launch Azure VM ${body.name} in ${body.location}`,
    summary: `${isWindows ? "Windows" : "Linux"} VM (${body.vmSize ?? "Standard_B2s"}) attached to ${body.vnetName}/${body.subnetName} in RG ${body.resourceGroupName}.`,
    cloud: "azure",
    region: body.location,
    name: `${stack}-apply`,
    stack,
    files: tfFiles,
    planSummary: [
      { change: "add" as const, text: `${isWindows ? "azurerm_windows_virtual_machine" : "azurerm_linux_virtual_machine"} ${body.name}` },
      { change: "add" as const, text: "azurerm_network_interface + NSG" },
      ...(body.publicIp !== false ? [{ change: "add" as const, text: "azurerm_public_ip (Standard SKU)" }] : []),
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
    repoPath: `terraform/azure-vm/${body.name}/`,
    repoFullName,
  });
}
