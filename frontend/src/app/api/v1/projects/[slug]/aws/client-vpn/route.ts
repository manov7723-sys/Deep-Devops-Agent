import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  buildClientVpnTerraform,
  validateClientVpnCidr,
  validateAcmArn,
  CLIENT_VPN_DEFAULTS,
} from "@/lib/devops/client-vpn";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";

/**
 * POST /projects/[slug]/aws/client-vpn
 *
 * Client VPN create submit — same shape as /aws/vpc:
 *   1. generate the Client VPN HCL (endpoint + associations + auth rule)
 *   2. commit each .tf under terraform/client-vpn/<name>/ on the default branch
 *   3. create an infra approval, return approvalId for inline ApprovalCard
 */
const Body = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, "Name must be lowercase, dashes, 2-41 chars, starting with a letter."),
  envKey: z.string().trim().min(1),
  region: z.string().trim().min(1),
  vpcId: z.string().trim().min(1),
  vpcCidr: z.string().trim().min(1),
  subnetIds: z.array(z.string().trim().min(1)).min(1).max(3),
  clientCidr: z.string().trim().optional(),
  certOwnerName: z.string().trim().max(60).optional(),
  certMode: z.enum(["auto", "manual"]).optional(),
  serverCertificateArn: z.string().trim().optional(),
  authMode: z.enum(["certificate", "federated"]).optional(),
  clientRootCertificateArn: z.string().trim().optional(),
  samlProviderArn: z.string().trim().optional(),
  splitTunnel: z.boolean().optional(),
  transportProtocol: z.enum(["udp", "tcp"]).optional(),
  vpnPort: z.union([z.literal(443), z.literal(1194)]).optional(),
  allowInternetEgress: z.boolean().optional(),
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
  const clientCidr = body.clientCidr ?? CLIENT_VPN_DEFAULTS.clientCidr;
  const cidrCheck = validateClientVpnCidr(clientCidr);
  if (!cidrCheck.ok) {
    return NextResponse.json(
      { ok: false, code: "invalid_cidr", message: `clientCidr: ${cidrCheck.error}` },
      { status: 400 },
    );
  }
  const certMode = body.certMode ?? CLIENT_VPN_DEFAULTS.certMode;
  const authMode = body.authMode ?? CLIENT_VPN_DEFAULTS.authMode;
  if (certMode === "manual") {
    if (!body.serverCertificateArn) {
      return NextResponse.json(
        { ok: false, code: "missing_server_arn", message: "certMode='manual' requires serverCertificateArn." },
        { status: 400 },
      );
    }
    const serverArnCheck = validateAcmArn(body.serverCertificateArn, body.region);
    if (!serverArnCheck.ok) {
      return NextResponse.json(
        { ok: false, code: "invalid_arn", message: `serverCertificateArn: ${serverArnCheck.error}` },
        { status: 400 },
      );
    }
    if (authMode === "certificate") {
      if (!body.clientRootCertificateArn) {
        return NextResponse.json(
          { ok: false, code: "missing_client_arn", message: "Certificate auth + manual cert mode requires clientRootCertificateArn." },
          { status: 400 },
        );
      }
      const clientArnCheck = validateAcmArn(body.clientRootCertificateArn, body.region);
      if (!clientArnCheck.ok) {
        return NextResponse.json(
          { ok: false, code: "invalid_arn", message: `clientRootCertificateArn: ${clientArnCheck.error}` },
          { status: 400 },
        );
      }
    }
  }
  if (authMode === "federated" && !body.samlProviderArn) {
    return NextResponse.json(
      { ok: false, code: "missing_saml_arn", message: "Federated auth requires samlProviderArn." },
      { status: 400 },
    );
  }

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

  // Guard used to hard-reject full-tunnel without an IGW subnet — but users
  // asked for the freedom to try anyway. The wizard shows an inline warning;
  // the server no longer blocks. Terraform will apply; if the subnet is
  // private-with-no-egress, connecting the VPN will break the client's
  // internet (documented + shown in the wizard).

  const files = buildClientVpnTerraform({
    name: body.name,
    region: body.region,
    env: body.envKey,
    vpcId: body.vpcId,
    vpcCidr: body.vpcCidr,
    subnetIds: body.subnetIds,
    clientCidr,
    certOwnerName: body.certOwnerName,
    certMode,
    serverCertificateArn: body.serverCertificateArn,
    authMode,
    clientRootCertificateArn: body.clientRootCertificateArn,
    samlProviderArn: body.samlProviderArn,
    splitTunnel: body.splitTunnel,
    transportProtocol: body.transportProtocol,
    vpnPort: body.vpnPort,
    allowInternetEgress: body.allowInternetEgress,
    tags: { CreatedBy: "deepagent-client-vpn-ui" },
  });

  const commits: Array<{ path: string; commitSha: string }> = [];
  for (const [filename, content] of Object.entries(files)) {
    const path = `terraform/client-vpn/${body.name}/${filename}`;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        message: `Add Client VPN ${body.name} (${body.region})`,
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

  const stack = `client-vpn-${body.name}`;
  const tfFiles: TerraformFile[] = Object.entries(files).map(([path, content]) => ({ path, content }));
  const planSummary = [
    { change: "add" as const, text: `aws_ec2_client_vpn_endpoint (${authMode}, ${body.splitTunnel === false ? "full-tunnel" : "split-tunnel"})` },
    { change: "add" as const, text: `${body.subnetIds.length} × aws_ec2_client_vpn_network_association` },
    { change: "add" as const, text: `aws_ec2_client_vpn_authorization_rule → ${body.vpcCidr}` },
  ];
  if (certMode === "auto") {
    planSummary.push({ change: "add" as const, text: "tls_* resources (CA + server + client certs auto-generated)" });
    planSummary.push({ change: "add" as const, text: "2 × aws_acm_certificate (server + client CA imported)" });
  }
  if (body.allowInternetEgress) {
    planSummary.push({ change: "add" as const, text: "auth rule + route for 0.0.0.0/0 (full-tunnel internet)" });
  }

  const approval = await createInfraApproval({
    projectId,
    envId: env.id,
    envKey: env.key,
    title: `Create Client VPN ${body.name} in ${body.region}`,
    summary: `Laptop-to-VPC OpenVPN endpoint for ${body.vpcId} (${body.vpcCidr}). Client CIDR ${clientCidr}. ~$72/mo per subnet association plus $0.05/hr per connected client.`,
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
    repoPath: `terraform/client-vpn/${body.name}/`,
    repoFullName,
  });
}
