import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { buildGcpVpnTerraform, validateGcpVpnCidr, GCP_VPN_DEFAULTS } from "@/lib/devops/gcp-openvpn";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/gcp/vpn — self-hosted OpenVPN on Compute Engine.
 *
 * Mirrors /aws/client-vpn — commits Terraform to the repo, creates an infra
 * approval, returns approvalId for inline ApprovalCard rendering. Actual apply
 * runs via the shared run_terraform pipeline (same as gcp-vm/gcp-vpc).
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  zone: z.string().trim().min(1),
  networkName: z.string().trim().min(1),
  subnetName: z.string().trim().min(1),
  vpcCidr: z.string().trim().min(1),
  machineType: z.string().trim().optional(),
  diskGb: z.number().int().min(10).max(200).optional(),
  clientCidr: z.string().trim().optional(),
  certOwnerName: z.string().trim().max(60).optional(),
  splitTunnel: z.boolean().optional(),
  transportProtocol: z.enum(["udp", "tcp"]).optional(),
  vpnPort: z.union([z.literal(1194), z.literal(443)]).optional(),
  sourceRanges: z.array(z.string().trim().min(1)).max(20).optional(),
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
  const clientCidr = body.clientCidr ?? GCP_VPN_DEFAULTS.clientCidr;
  const cidrCheck = validateGcpVpnCidr(clientCidr);
  if (!cidrCheck.ok) {
    return NextResponse.json(
      { ok: false, code: "invalid_cidr", message: `clientCidr: ${cidrCheck.error}` },
      { status: 400 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "gcp" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_gcp_provider" }, { status: 409 });
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

  const files = buildGcpVpnTerraform({
    name: body.name,
    region: body.region,
    zone: body.zone,
    env: body.envKey,
    networkName: body.networkName,
    subnetName: body.subnetName,
    vpcCidr: body.vpcCidr,
    machineType: body.machineType,
    diskGb: body.diskGb,
    clientCidr,
    certOwnerName: body.certOwnerName,
    splitTunnel: body.splitTunnel,
    transportProtocol: body.transportProtocol,
    vpnPort: body.vpnPort,
    sourceRanges: body.sourceRanges,
    labels: { created_by: "deepagent-gcp-vpn-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/gcp-vpn/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add GCP OpenVPN ${body.name} (${body.region})`,
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

  // Stack prefix `gcp-vpn-` mirrors AWS's `client-vpn-` — the cert-issuance
  // endpoints branch on this prefix to know how to build the .ovpn base.
  const stack = `gcp-vpn-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const planSummary = [
    { change: "add" as const, text: `google_compute_instance ${body.name}-openvpn (${body.machineType ?? "e2-small"})` },
    { change: "add" as const, text: `google_compute_address ${body.name}-openvpn-ip (static)` },
    { change: "add" as const, text: `2 × google_compute_firewall (openvpn + iap-ssh)` },
    { change: "add" as const, text: "tls_* resources (CA + server + initial client certs auto-generated)" },
  ];
  if (body.splitTunnel === false) {
    planSummary.push({ change: "add" as const, text: "full-tunnel mode — client's ALL internet traffic goes through this VM" });
  }

  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create GCP OpenVPN ${body.name} in ${body.region}`,
    summary: `Self-hosted OpenVPN endpoint on ${body.networkName}/${body.subnetName} (${body.vpcCidr}). Client CIDR ${clientCidr}. ~$8-15/mo per endpoint.`,
    cloud: "gcp",
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
    repoPath: `terraform/gcp-vpn/${body.name}/`,
    repoFullName,
  });
}
