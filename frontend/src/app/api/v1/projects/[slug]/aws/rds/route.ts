import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/rds?region=<region>
 *
 * Lists RDS DB instances in a given region for the project's connected AWS
 * account. Powers the Connections page's RIGHT column (RDS picker), same
 * pattern as /aws/vpcs powers the peering page. Read-only — shells the
 * `aws` CLI with the resolved credentials.
 *
 * Returns instance identifier + endpoint + engine + port + status + VPC id
 * so the UI can group by VPC and show which ones live inside the peered VPC.
 */
type Rds = {
  identifier: string;
  engine: string;
  endpoint: string | null;
  port: number | null;
  status: string;
  vpcId: string | null;
  database: string | null;
  username: string | null;
};

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "aws" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) {
    return NextResponse.json({
      ok: true,
      connected: false,
      instances: [] as Rds[],
      note: "No AWS account connected to this project.",
    });
  }

  const resolved = await resolveAwsExecEnv(cp.id);
  if (!resolved.ok) {
    return NextResponse.json({
      ok: true,
      connected: false,
      instances: [] as Rds[],
      note: resolved.message,
    });
  }

  const url = new URL(req.url);
  const region = (url.searchParams.get("region")?.trim() || resolved.region).trim();
  const baseEnv = { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };

  const res = await runStage({
    command: "aws",
    args: [
      "rds",
      "describe-db-instances",
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ],
    cwd: process.cwd(),
    env: baseEnv,
    timeoutMs: 30_000,
  });

  if (res.exitCode !== 0) {
    if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
      return NextResponse.json({
        ok: true,
        connected: true,
        region,
        instances: [],
        note: "The `aws` CLI isn't installed on the server.",
      });
    }
    return NextResponse.json({
      ok: true,
      connected: true,
      region,
      instances: [],
      note: res.stderr.slice(-400) || "aws rds describe-db-instances failed.",
    });
  }

  let parsed: { DBInstances?: unknown[] } = {};
  try {
    parsed = JSON.parse(res.stdout) as { DBInstances?: unknown[] };
  } catch {
    return NextResponse.json({
      ok: true,
      connected: true,
      region,
      instances: [],
      note: "aws returned non-JSON output.",
    });
  }

  const instances: Rds[] = ((parsed.DBInstances ?? []) as Array<{
    DBInstanceIdentifier?: string;
    Engine?: string;
    Endpoint?: { Address?: string; Port?: number };
    DBInstanceStatus?: string;
    DBSubnetGroup?: { VpcId?: string };
    DBName?: string;
    MasterUsername?: string;
  }>).map((i) => ({
    identifier: i.DBInstanceIdentifier ?? "(unknown)",
    engine: i.Engine ?? "unknown",
    endpoint: i.Endpoint?.Address ?? null,
    port: i.Endpoint?.Port ?? null,
    status: i.DBInstanceStatus ?? "unknown",
    vpcId: i.DBSubnetGroup?.VpcId ?? null,
    database: i.DBName ?? null,
    username: i.MasterUsername ?? null,
  }));

  return NextResponse.json({ ok: true, connected: true, region, instances });
}
