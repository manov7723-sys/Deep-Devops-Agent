import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { prisma } from "@/lib/db/prisma";
import { setupAzureAksAlarms, listAzureAksAlarms, aksClusterFromEnv, type AzureMetricKey } from "@/lib/cloud/azure-monitor";
import { syncAksAlarmsToAlerts } from "@/lib/cloud/azure-monitor-alerts";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const METRIC_KEYS = ["cpu", "memory", "disk"] as const;

const Body = z.object({
  email: z.string().email().optional(),
  clusterName: z.string().trim().min(1).max(120).optional(),
  resourceGroup: z.string().trim().max(120).optional(),
  metrics: z.array(z.enum(METRIC_KEYS)).min(1).optional(),
});

async function resolveAzureEnv(projectId: string, key: string) {
  const env = await envBySlugAndKey(projectId, key);
  if (!env) return { ok: false as const, code: "env_not_found", status: 404 };
  if (!env.cloudProviderId) return { ok: false as const, code: "no_cloud_provider", status: 400, message: "This environment has no cloud provider connected." };
  const cp = await prisma.cloudProvider.findUnique({ where: { id: env.cloudProviderId }, select: { kind: true } });
  if (cp?.kind !== "azure") return { ok: false as const, code: "not_azure", status: 400, message: "Azure Monitor alarms are AKS/Azure only." };
  return { ok: true as const, env: { ...env, cloudProviderId: env.cloudProviderId } };
}

/** POST — set up Azure Monitor metric alerts (CPU/memory/disk) for the env's AKS cluster. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message }, { status: 400 });

  const r = await resolveAzureEnv(gate.access.project.id, key);
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status });

  const clusterName = parsed.data.clusterName || (await aksClusterFromEnv(r.env.id));
  if (!clusterName) return NextResponse.json({ ok: false, code: "no_cluster", message: "Couldn't determine the AKS cluster name. Pass clusterName." }, { status: 400 });

  const metrics = (parsed.data.metrics ?? [...METRIC_KEYS]) as AzureMetricKey[];
  const result = await setupAzureAksAlarms({
    cloudProviderId: r.env.cloudProviderId,
    clusterName,
    resourceGroup: parsed.data.resourceGroup,
    email: parsed.data.email,
    metrics,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "azure_monitor.alarms_configured",
    targetType: "env",
    targetId: key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { clusterName, metrics, alarms: result.alarms.filter((a) => a.ok).length },
  });

  return NextResponse.json(result);
}

/** GET — list this app's configured AKS metric alerts (persistent UI summary). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const r = await resolveAzureEnv(gate.access.project.id, key);
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.status });

  const sp = new URL(req.url).searchParams;
  const clusterName = sp.get("clusterName") || (await aksClusterFromEnv(r.env.id));
  if (!clusterName) return NextResponse.json({ ok: false, code: "no_cluster", message: "Couldn't determine the AKS cluster name." }, { status: 400 });
  const resourceGroup = sp.get("resourceGroup") || undefined;

  const res = await listAzureAksAlarms(r.env.cloudProviderId, clusterName, resourceGroup);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });

  // Mirror firing alarm state into Alerts (opens/resolves + fires banner/email).
  const sync = await syncAksAlarmsToAlerts({
    projectId: gate.access.project.id,
    envId: r.env.id,
    cloudProviderId: r.env.cloudProviderId,
    clusterName,
    resourceGroup,
  });

  return NextResponse.json({
    ok: true,
    clusterName,
    configured: res.alarms.length,
    firing: sync.ok ? sync.firing : 0,
    opened: sync.ok ? sync.opened : 0,
    resolved: sync.ok ? sync.resolved : 0,
    alarms: sync.ok ? sync.alarms : res.alarms.map((a) => ({ name: a.name, metric: a.metric, state: "OK" as const })),
    syncError: sync.ok ? undefined : sync.error,
  });
}
