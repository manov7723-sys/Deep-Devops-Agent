import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildAzureVnetTerraform, validateVnetCidr, AZURE_VNET_DEFAULTS } from "@/lib/devops/azure-vnet";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/azure/vnet
 *
 * Azure VNet create submit — same shape as /aws/vpc:
 *   1. generate the VNet HCL (RG + VNet + subnets + optional NAT + NSGs)
 *   2. commit each .tf under terraform/azure-vnet/<name>/
 *   3. create an infra approval, return approvalId for inline ApprovalCard
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  location: z.string().trim().min(1),
  vnetCidr: z.string().trim().min(1),
  subnetCount: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  includePrivateSubnets: z.boolean().optional(),
  natStrategy: z.enum(["none", "single"]).optional(),
  createDefaultNsgs: z.boolean().optional(),
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
  const cidrCheck = validateVnetCidr(body.vnetCidr);
  if (!cidrCheck.ok) {
    return NextResponse.json(
      { ok: false, code: "invalid_cidr", message: `vnetCidr: ${cidrCheck.error}` },
      { status: 400 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true },
  });
  if (!cp) {
    return NextResponse.json({ ok: false, code: "no_azure_provider" }, { status: 409 });
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

  const subnetCount = (body.subnetCount ?? AZURE_VNET_DEFAULTS.subnetCount) as 1 | 2 | 3;
  const includePrivate = body.includePrivateSubnets ?? AZURE_VNET_DEFAULTS.includePrivateSubnets;
  const natStrategy = includePrivate ? (body.natStrategy ?? AZURE_VNET_DEFAULTS.natStrategy) : "none";

  const files = buildAzureVnetTerraform({
    name: body.name,
    location: body.location,
    env: body.envKey,
    vnetCidr: body.vnetCidr,
    subnetCount,
    includePrivateSubnets: includePrivate,
    natStrategy,
    createDefaultNsgs: body.createDefaultNsgs,
    tags: { CreatedBy: "deepagent-azure-vnet-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/azure-vnet/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add Azure VNet ${body.name} (${body.location})`,
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

  const stack = `azure-vnet-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const planSummary = [
    { change: "add" as const, text: `azurerm_resource_group ${body.name}-rg` },
    { change: "add" as const, text: `azurerm_virtual_network ${body.vnetCidr}` },
    { change: "add" as const, text: `${subnetCount} × azurerm_subnet (public)` },
  ];
  if (includePrivate) planSummary.push({ change: "add" as const, text: `${subnetCount} × azurerm_subnet (private)` });
  if (natStrategy === "single") planSummary.push({ change: "add" as const, text: "1 × azurerm_nat_gateway (single, shared)" });

  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create Azure VNet ${body.name} in ${body.location}`,
    summary: `${body.vnetCidr} · ${subnetCount} subnet${subnetCount === 1 ? "" : "s"}/tier${includePrivate ? " · public + private" : ""}${natStrategy === "single" ? " · NAT gateway" : ""}.`,
    cloud: "azure",
    region: body.location,
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
    repoPath: `terraform/azure-vnet/${body.name}/`,
    repoFullName,
  });
}
