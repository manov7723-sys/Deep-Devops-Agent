import { NextResponse } from "next/server";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/security-groups?region=<region>&vpcId=<vpc-id>
 *
 * Lists security groups in a given VPC + region — powers the Jenkins wizard's
 * "attach existing SGs" multi-select. Same pattern as /aws/subnets: pick a
 * VPC first, then list SGs scoped to that VPC.
 */
type Sg = {
  groupId: string;
  groupName: string;
  description: string;
  vpcId: string;
  inboundRuleCount: number;
};

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const region = url.searchParams.get("region")?.trim() ?? "";
  const vpcId = url.searchParams.get("vpcId")?.trim() ?? "";
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(region)) {
    return NextResponse.json({ ok: false, code: "invalid_region" }, { status: 400 });
  }
  if (!/^vpc-[0-9a-f]{8,17}$/.test(vpcId)) {
    return NextResponse.json({ ok: false, code: "invalid_vpc_id" }, { status: 400 });
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "aws" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) {
    return NextResponse.json({ ok: true, connected: false, securityGroups: [] as Sg[], note: "No AWS account connected." });
  }
  const creds = await resolveAwsExecEnv(cp.id);
  if (!creds.ok) {
    return NextResponse.json({ ok: true, connected: false, securityGroups: [] as Sg[], note: creds.message });
  }

  const res = await runStage({
    command: "aws",
    args: [
      "ec2",
      "describe-security-groups",
      "--region",
      region,
      "--filters",
      `Name=vpc-id,Values=${vpcId}`,
      "--output",
      "json",
      "--no-cli-pager",
    ],
    cwd: tmpdir(),
    env: { ...creds.env, AWS_REGION: region },
    timeoutMs: 30_000,
  });

  if (res.exitCode !== 0) {
    return NextResponse.json({
      ok: true,
      connected: true,
      region,
      vpcId,
      securityGroups: [],
      note: res.stderr.slice(-400) || "aws ec2 describe-security-groups failed.",
    });
  }

  let parsed: {
    SecurityGroups?: Array<{
      GroupId?: string;
      GroupName?: string;
      Description?: string;
      VpcId?: string;
      IpPermissions?: unknown[];
    }>;
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return NextResponse.json({ ok: true, connected: true, region, vpcId, securityGroups: [], note: "aws returned non-JSON." });
  }

  const securityGroups: Sg[] = (parsed.SecurityGroups ?? []).map((s) => ({
    groupId: s.GroupId ?? "(unknown)",
    groupName: s.GroupName ?? "",
    description: s.Description ?? "",
    vpcId: s.VpcId ?? "",
    inboundRuleCount: (s.IpPermissions ?? []).length,
  }));

  return NextResponse.json({ ok: true, connected: true, region, vpcId, securityGroups });
}
