import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { eksClusterFromEnv } from "@/lib/cloud/cloudwatch";
import { syncEksAlarmsToAlerts } from "@/lib/cloud/cloudwatch-alerts";
import { aksClusterFromEnv } from "@/lib/cloud/azure-monitor";
import { syncAksAlarmsToAlerts } from "@/lib/cloud/azure-monitor-alerts";
import { evaluateLiveMetricAlerts } from "@/lib/observability/live-metric-alerts";

/**
 * GET /alerts/live
 *
 * Powers the global alert banner. Polled by the client every ~60s. It:
 *   1. Re-syncs CloudWatch alarm state for the user's AWS/EKS envs (so a metric
 *      crossing its threshold surfaces an Alert without anyone opening a page).
 *   2. Returns the user's currently-open alerts for the banner to display.
 *
 * Bounded: caps how many envs it syncs per poll, and each sync is best-effort
 * so one slow/erroring cluster never blocks the banner.
 */
const MAX_ENVS_PER_POLL = 15;

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });

  // Projects the user belongs to.
  const memberships = await prisma.membership.findMany({
    where: { userId: sess.userId },
    select: { projectId: true },
  });
  const projectIds = memberships.map((m) => m.projectId);
  if (projectIds.length === 0) {
    return NextResponse.json({ ok: true, alerts: [] });
  }

  // Cloud envs in those projects that can carry alarms / in-cluster metrics
  // (AWS/EKS, Azure/AKS, GCP/GKE).
  const cloudEnvs = await prisma.env.findMany({
    where: {
      projectId: { in: projectIds },
      cloudProvider: { is: { kind: { in: ["aws", "azure", "gcp"] } } },
    },
    select: { id: true, projectId: true, region: true, cloudProviderId: true, cloudProvider: { select: { kind: true } } },
    take: MAX_ENVS_PER_POLL,
  });

  // Refresh alarm state -> Alerts per cloud. Best-effort and parallel; never throws.
  await Promise.allSettled(
    cloudEnvs.map(async (env) => {
      if (!env.cloudProviderId) return;
      // Immediate path: evaluate thresholds straight from in-cluster Prometheus
      // (near-real-time) so an alert fires this poll, not minutes later via the
      // cloud alarm engine. Skips silently if monitoring isn't installed.
      await evaluateLiveMetricAlerts(env.projectId, env.id).catch(() => {});
      if (env.cloudProvider?.kind === "aws") {
        const clusterName = await eksClusterFromEnv(env.id);
        if (!clusterName) return;
        await syncEksAlarmsToAlerts({
          projectId: env.projectId,
          envId: env.id,
          cloudProviderId: env.cloudProviderId,
          clusterName,
          region: env.region ?? undefined,
        });
      } else if (env.cloudProvider?.kind === "azure") {
        const clusterName = await aksClusterFromEnv(env.id);
        if (!clusterName) return;
        await syncAksAlarmsToAlerts({
          projectId: env.projectId,
          envId: env.id,
          cloudProviderId: env.cloudProviderId,
          clusterName,
        });
      }
    }),
  );

  // Return the user's currently-open alerts for the banner.
  const rows = await prisma.alert.findMany({
    where: { projectId: { in: projectIds }, status: "open" },
    orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
    take: 50,
    select: {
      id: true,
      title: true,
      detail: true,
      severity: true,
      category: true,
      resource: true,
      detectedAt: true,
      project: { select: { slug: true, name: true } },
      env: { select: { key: true } },
    },
  });

  const alerts = rows.map((a) => ({
    id: a.id,
    title: a.title,
    detail: a.detail,
    severity: a.severity,
    category: a.category,
    resource: a.resource,
    detectedAt: a.detectedAt,
    projectSlug: a.project.slug,
    projectName: a.project.name,
    envKey: a.env?.key ?? null,
  }));

  return NextResponse.json({ ok: true, alerts });
}
