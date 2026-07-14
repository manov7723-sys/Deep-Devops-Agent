import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { prisma } from "@/lib/db/prisma";
import {
  setupGkeAlarms,
  listGkeAlarms,
  gkeClusterFromEnv,
  type GcpMetricKey,
} from "@/lib/cloud/gcp-monitor";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const METRIC_KEYS = ["cpu", "memory"] as const;

const Body = z.object({
  email: z.string().email().optional(),
  clusterName: z.string().trim().min(1).max(120).optional(),
  metrics: z.array(z.enum(METRIC_KEYS)).min(1).optional(),
});

async function resolveGcpEnv(projectId: string, key: string) {
  const env = await envBySlugAndKey(projectId, key);
  if (!env) return { ok: false as const, code: "env_not_found", status: 404 };
  if (!env.cloudProviderId)
    return {
      ok: false as const,
      code: "no_cloud_provider",
      status: 400,
      message: "This environment has no cloud provider connected.",
    };
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: env.cloudProviderId },
    select: { kind: true },
  });
  if (cp?.kind !== "gcp")
    return {
      ok: false as const,
      code: "not_gcp",
      status: 400,
      message: "GCP Monitoring alarms are GKE/GCP only.",
    };
  return { ok: true as const, env: { ...env, cloudProviderId: env.cloudProviderId } };
}

/** POST — set up GCP Cloud Monitoring alert policies (CPU/memory/disk) for the env's GKE cluster. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );

  const r = await resolveGcpEnv(gate.access.project.id, key);
  if (!r.ok)
    return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status });

  const clusterName = parsed.data.clusterName || (await gkeClusterFromEnv(r.env.id));
  if (!clusterName)
    return NextResponse.json(
      {
        ok: false,
        code: "no_cluster",
        message: "Couldn't determine the GKE cluster name. Pass clusterName.",
      },
      { status: 400 },
    );

  const metrics = (parsed.data.metrics ?? [...METRIC_KEYS]) as GcpMetricKey[];
  const result = await setupGkeAlarms({
    cloudProviderId: r.env.cloudProviderId,
    clusterName,
    email: parsed.data.email,
    metrics,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "gcp_monitor.alarms_configured",
    targetType: "env",
    targetId: key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { clusterName, metrics, alarms: result.alarms.filter((a) => a.ok).length },
  });

  return NextResponse.json(result);
}

/** GET — list this app's GKE alert policies (persistent UI summary). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const r = await resolveGcpEnv(gate.access.project.id, key);
  if (!r.ok)
    return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status });

  const clusterName =
    new URL(req.url).searchParams.get("clusterName") || (await gkeClusterFromEnv(r.env.id));
  if (!clusterName)
    return NextResponse.json(
      { ok: false, code: "no_cluster", message: "Couldn't determine the GKE cluster name." },
      { status: 400 },
    );

  const res = await listGkeAlarms(r.env.cloudProviderId, clusterName);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({
    ok: true,
    clusterName,
    configured: res.alarms.length,
    alarms: res.alarms,
  });
}
