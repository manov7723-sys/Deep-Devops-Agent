import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { prisma } from "@/lib/db/prisma";
import { setupEksCloudWatchAlarms, eksClusterFromEnv, type MetricKey } from "@/lib/cloud/cloudwatch";
import { syncEksAlarmsToAlerts } from "@/lib/cloud/cloudwatch-alerts";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const METRIC_KEYS = ["cpu", "status", "memory", "disk"] as const;

const Body = z.object({
  email: z.string().email().optional(),
  clusterName: z.string().trim().min(1).max(120).optional(),
  region: z.string().trim().max(40).optional(),
  metrics: z.array(z.enum(METRIC_KEYS)).min(1).optional(),
});

type AwsEnvResolved =
  | { ok: false; code: string; status: number; message?: string }
  | { ok: true; env: NonNullable<Awaited<ReturnType<typeof envBySlugAndKey>>> & { cloudProviderId: string }; providerRegion: string };

/** Resolve the env's AWS cloud provider, or return an error response shape. */
async function resolveAwsEnv(projectId: string, key: string): Promise<AwsEnvResolved> {
  const env = await envBySlugAndKey(projectId, key);
  if (!env) return { ok: false, code: "env_not_found", status: 404 };
  if (!env.cloudProviderId) return { ok: false, code: "no_cloud_provider", status: 400, message: "This environment has no cloud provider connected." };
  const cp = await prisma.cloudProvider.findUnique({ where: { id: env.cloudProviderId }, select: { kind: true, region: true } });
  if (cp?.kind !== "aws") return { ok: false, code: "not_aws", status: 400, message: "CloudWatch alarms are AWS/EKS only." };
  return { ok: true, env: { ...env, cloudProviderId: env.cloudProviderId }, providerRegion: cp.region };
}

/**
 * POST — set up CloudWatch alarms (CPU, status check, memory, disk) for the
 * env's EKS cluster, wire them to an SNS email topic, and (for memory/disk)
 * enable Container Insights. Then mirror firing alarms into Alerts.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message }, { status: 400 });

  const r = await resolveAwsEnv(gate.access.project.id, key);
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status });
  const { env, providerRegion } = r;

  const clusterName = parsed.data.clusterName || (await eksClusterFromEnv(env.id));
  if (!clusterName) {
    return NextResponse.json({ ok: false, code: "no_cluster", message: "Couldn't determine the EKS cluster name. Pass clusterName." }, { status: 400 });
  }
  const metrics = (parsed.data.metrics ?? [...METRIC_KEYS]) as MetricKey[];

  const result = await setupEksCloudWatchAlarms({
    cloudProviderId: env.cloudProviderId!,
    clusterName,
    region: parsed.data.region || env.region || providerRegion || undefined,
    email: parsed.data.email,
    metrics,
  });

  // Log the full result (UI only shows a summary) + persist for diagnostics.
  if (!result.ok) {
    console.error("[cloudwatch] setup failed", JSON.stringify(result));
    try {
      const { writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      await writeFile(join(tmpdir(), `dda-cw-setup-${env.id.replace(/[^a-z0-9-]/gi, "")}.json`), JSON.stringify(result, null, 2));
    } catch {
      /* best-effort */
    }
  }

  // Mirror any already-firing alarms into Alerts immediately.
  if (result.ok) {
    await syncEksAlarmsToAlerts({
      projectId: gate.access.project.id,
      envId: env.id,
      cloudProviderId: env.cloudProviderId!,
      clusterName,
      region: result.region,
    }).catch(() => {});
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "cloudwatch.alarms_configured",
    targetType: "env",
    targetId: key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { clusterName, metrics, alarms: result.alarms.filter((a) => a.ok).length },
  });

  // Always 200 — the structured result (result.ok + per-alarm errors) is what
  // the UI renders; a 400 would make the client throw and lose the detail.
  return NextResponse.json(result);
}

/** GET — sync alarm states into Alerts and report current firing count. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const r = await resolveAwsEnv(gate.access.project.id, key);
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status });
  const { env } = r;

  const clusterName = new URL(req.url).searchParams.get("clusterName") || (await eksClusterFromEnv(env.id));
  if (!clusterName) return NextResponse.json({ ok: false, code: "no_cluster", message: "Couldn't determine the EKS cluster name." }, { status: 400 });

  const sync = await syncEksAlarmsToAlerts({
    projectId: gate.access.project.id,
    envId: env.id,
    cloudProviderId: env.cloudProviderId!,
    clusterName,
  });
  if (!sync.ok) return NextResponse.json({ ok: false, message: sync.error }, { status: 400 });
  return NextResponse.json({
    ok: true,
    clusterName,
    firing: sync.firing,
    opened: sync.opened,
    resolved: sync.resolved,
    configured: sync.alarms.length,
    alarms: sync.alarms,
  });
}
