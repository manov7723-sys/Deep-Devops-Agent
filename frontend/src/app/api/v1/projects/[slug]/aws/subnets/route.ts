import { NextResponse } from "next/server";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/subnets?region=us-east-1&vpcId=vpc-xxx
 *
 * Lists subnets in a specific VPC + region — used by the Network > EC2 UI's
 * subnet picker after the user selects a VPC. Uses the project's connected
 * AWS provider (same fallback path as /aws/vpcs).
 *
 * Response: { ok: true, subnets: [{subnetId, cidr, az, name, isPublic}] }
 */
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
  });
  if (!cp) {
    return NextResponse.json({ ok: false, code: "no_aws_provider" }, { status: 409 });
  }
  const creds = await resolveAwsExecEnv(cp.id);
  if (!creds.ok) {
    return NextResponse.json({ ok: false, code: "aws_auth", message: creds.message }, { status: 502 });
  }

  const res = await runStage({
    command: "aws",
    args: [
      "ec2",
      "describe-subnets",
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
    timeoutMs: 15000,
    maxBufferBytes: 2 * 1024 * 1024,
  });
  if (res.exitCode !== 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "aws_error",
        message: `aws ec2 describe-subnets failed (exit ${res.exitCode}) in ${region}.`,
        stderr: res.stderr.slice(-600),
      },
      { status: 502 },
    );
  }

  let parsed: {
    Subnets?: Array<{
      SubnetId: string;
      CidrBlock?: string;
      AvailabilityZone?: string;
      MapPublicIpOnLaunch?: boolean;
      Tags?: Array<{ Key: string; Value: string }>;
    }>;
  };
  try {
    parsed = JSON.parse(res.stdout || "{}");
  } catch {
    return NextResponse.json({ ok: false, code: "aws_error", message: "AWS returned non-JSON." }, { status: 502 });
  }

  // MapPublicIpOnLaunch is unreliable — many "public" subnets have it off and
  // many "private" subnets have it on. The ground-truth signal for "can this
  // subnet reach the internet" is whether its route table has a 0.0.0.0/0
  // route pointing at an IGW (public) or NAT gateway (private-with-egress).
  // We batch one describe-route-tables call and derive per-subnet.
  const rtRes = await runStage({
    command: "aws",
    args: [
      "ec2",
      "describe-route-tables",
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
    timeoutMs: 15000,
  });

  type RouteTable = {
    RouteTableId?: string;
    Routes?: Array<{ DestinationCidrBlock?: string; GatewayId?: string; NatGatewayId?: string }>;
    Associations?: Array<{ SubnetId?: string; Main?: boolean }>;
  };
  let rts: RouteTable[] = [];
  if (rtRes.exitCode === 0) {
    try {
      rts = (JSON.parse(rtRes.stdout || "{}").RouteTables ?? []) as RouteTable[];
    } catch { /* fall through with empty rts */ }
  }

  // Build per-subnet gateway lookup. AWS's model: a subnet uses its explicit
  // association's RT if present, otherwise the VPC's "main" RT.
  const mainRt = rts.find((rt) => rt.Associations?.some((a) => a.Main));
  function routeInfoFor(subnetId: string): { hasIgwRoute: boolean; hasNatRoute: boolean } {
    const explicit = rts.find((rt) => rt.Associations?.some((a) => a.SubnetId === subnetId));
    const rt = explicit ?? mainRt;
    const defaultRoute = rt?.Routes?.find((r) => r.DestinationCidrBlock === "0.0.0.0/0");
    return {
      hasIgwRoute: !!defaultRoute?.GatewayId?.startsWith("igw-"),
      hasNatRoute: !!defaultRoute?.NatGatewayId?.startsWith("nat-"),
    };
  }

  const subnets = (parsed.Subnets ?? []).map((s) => {
    const info = routeInfoFor(s.SubnetId);
    // "isPublic" for our purposes = the subnet actually has a path to the
    // internet, either via IGW (classic public) or NAT (private-with-egress).
    // Callers that need to distinguish (e.g. "must be an IGW-routed subnet
    // for Client VPN full-tunnel") can check hasIgwRoute directly.
    return {
      subnetId: s.SubnetId,
      cidr: s.CidrBlock ?? "",
      az: s.AvailabilityZone ?? "",
      name: s.Tags?.find((t) => t.Key === "Name")?.Value ?? "",
      isPublic: info.hasIgwRoute || info.hasNatRoute,
      hasIgwRoute: info.hasIgwRoute,
      hasNatRoute: info.hasNatRoute,
      // Kept for callers that still look at the AWS flag directly.
      mapPublicIpOnLaunch: !!s.MapPublicIpOnLaunch,
    };
  });
  return NextResponse.json({ ok: true, region, vpcId, subnets });
}
