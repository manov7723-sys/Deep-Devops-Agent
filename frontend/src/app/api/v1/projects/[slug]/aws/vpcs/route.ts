import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/vpcs?env=<envKey>&region=<region>
 *
 * Lists the VPCs and subnets in the account behind the chosen env's AWS
 * provider, so the EKS wizard can offer them as dropdowns ("reuse existing
 * VPC") instead of asking the user to paste ids. Read-only — shells the `aws`
 * CLI with the provider's resolved credentials, exactly like the EC2 inventory
 * tool. Returns all subnets in the region; the client filters them by the
 * selected VPC.
 */
type Vpc = { vpcId: string; name: string | null; cidr: string; isDefault: boolean };
type Subnet = { subnetId: string; vpcId: string; name: string | null; cidr: string; az: string };

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const envKey = url.searchParams.get("env")?.trim();
  if (!envKey) {
    return NextResponse.json({
      ok: true,
      connected: false,
      vpcs: [],
      subnets: [],
      note: "Pick an environment first.",
    });
  }

  const env = await envBySlugAndKey(gate.access.project.id, envKey);
  if (!env?.cloudProviderId) {
    return NextResponse.json({
      ok: true,
      connected: false,
      vpcs: [],
      subnets: [],
      note: "This environment has no AWS provider.",
    });
  }

  const resolved = await resolveAwsExecEnv(env.cloudProviderId);
  if (!resolved.ok) {
    return NextResponse.json({
      ok: true,
      connected: false,
      vpcs: [],
      subnets: [],
      note: resolved.message,
    });
  }

  const region = (url.searchParams.get("region")?.trim() || resolved.region).trim();
  const baseEnv = { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };

  async function awsJson(
    args: string[],
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const res = await runStage({
      command: "aws",
      args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
      cwd: process.cwd(),
      env: baseEnv,
      timeoutMs: 30_000,
    });
    if (res.exitCode !== 0) {
      if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
        return { ok: false, error: "The `aws` CLI isn't installed on the server." };
      }
      return { ok: false, error: res.stderr.slice(-400) || "aws CLI failed." };
    }
    try {
      return { ok: true, data: JSON.parse(res.stdout) };
    } catch {
      return { ok: false, error: "aws returned non-JSON output." };
    }
  }

  const tagName = (tags?: Array<{ Key?: string; Value?: string }>) =>
    tags?.find((t) => t.Key === "Name")?.Value ?? null;

  const vpcRes = await awsJson(["ec2", "describe-vpcs"]);
  if (!vpcRes.ok) {
    return NextResponse.json({
      ok: true,
      connected: true,
      region,
      vpcs: [],
      subnets: [],
      note: vpcRes.error,
    });
  }
  const subnetRes = await awsJson(["ec2", "describe-subnets"]);

  const vpcs: Vpc[] = (
    ((vpcRes.data as { Vpcs?: unknown[] }).Vpcs ?? []) as Array<{
      VpcId?: string;
      CidrBlock?: string;
      IsDefault?: boolean;
      Tags?: Array<{ Key?: string; Value?: string }>;
    }>
  ).map((v) => ({
    vpcId: v.VpcId ?? "(unknown)",
    name: tagName(v.Tags),
    cidr: v.CidrBlock ?? "",
    isDefault: !!v.IsDefault,
  }));

  const subnets: Subnet[] = subnetRes.ok
    ? (
        ((subnetRes.data as { Subnets?: unknown[] }).Subnets ?? []) as Array<{
          SubnetId?: string;
          VpcId?: string;
          CidrBlock?: string;
          AvailabilityZone?: string;
          Tags?: Array<{ Key?: string; Value?: string }>;
        }>
      ).map((s) => ({
        subnetId: s.SubnetId ?? "(unknown)",
        vpcId: s.VpcId ?? "",
        name: tagName(s.Tags),
        cidr: s.CidrBlock ?? "",
        az: s.AvailabilityZone ?? "",
      }))
    : [];

  return NextResponse.json({ ok: true, connected: true, region, vpcs, subnets });
}
