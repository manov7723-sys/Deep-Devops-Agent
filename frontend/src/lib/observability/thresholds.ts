/**
 * User-configurable alarm thresholds (per environment + metric). One uniform
 * source of truth for BOTH the live in-cluster evaluation and the cloud alarms
 * (AWS/Azure/GCP). Stored as a percent (0–100); callers convert as needed.
 */
import { prisma } from "@/lib/db/prisma";
import type { AlertSeverity } from "@prisma/client";

export type MetricKey = "cpu" | "memory" | "disk";
export const METRIC_KEYS: MetricKey[] = ["cpu", "memory", "disk"];

export const METRIC_LABELS: Record<MetricKey, string> = {
  cpu: "CPU utilization",
  memory: "Memory utilization",
  disk: "Disk utilization",
};

/** Defaults match the previously-hardcoded thresholds. */
export const DEFAULT_THRESHOLDS: Record<MetricKey, { percent: number; severity: AlertSeverity }> = {
  cpu: { percent: 80, severity: "high" },
  memory: { percent: 85, severity: "high" },
  disk: { percent: 80, severity: "high" },
};

export type ResolvedThreshold = {
  metric: MetricKey;
  percent: number;
  severity: AlertSeverity;
  enabled: boolean;
  isDefault: boolean;
};

function isMetric(m: string): m is MetricKey {
  return (METRIC_KEYS as string[]).includes(m);
}

/** Effective thresholds for an env = defaults overlaid with any user rows. */
export async function getEnvThresholds(envId: string): Promise<Record<MetricKey, ResolvedThreshold>> {
  const rows = await prisma.alertThreshold.findMany({ where: { envId } });
  const byMetric = new Map(rows.filter((r) => isMetric(r.metric)).map((r) => [r.metric, r]));
  const out = {} as Record<MetricKey, ResolvedThreshold>;
  for (const m of METRIC_KEYS) {
    const r = byMetric.get(m);
    out[m] = r
      ? { metric: m, percent: r.percent, severity: r.severity, enabled: r.enabled, isDefault: false }
      : { metric: m, percent: DEFAULT_THRESHOLDS[m].percent, severity: DEFAULT_THRESHOLDS[m].severity, enabled: true, isDefault: true };
  }
  return out;
}

/** Just the percent overrides (enabled only) — convenient for cloud alarm setup. */
export async function getEnvThresholdPercents(envId: string): Promise<Partial<Record<MetricKey, number>>> {
  const all = await getEnvThresholds(envId);
  const out: Partial<Record<MetricKey, number>> = {};
  for (const m of METRIC_KEYS) if (all[m].enabled) out[m] = all[m].percent;
  return out;
}

/** List for the UI (array form, defaults flagged). */
export async function listEnvThresholds(envId: string): Promise<ResolvedThreshold[]> {
  const map = await getEnvThresholds(envId);
  return METRIC_KEYS.map((m) => map[m]);
}

/** Create/update a threshold rule. percent clamped 1–100. */
export async function upsertThreshold(
  projectId: string,
  envId: string,
  metric: MetricKey,
  percent: number,
  severity: AlertSeverity,
  enabled: boolean,
): Promise<ResolvedThreshold> {
  const p = Math.min(100, Math.max(1, Math.round(percent)));
  const row = await prisma.alertThreshold.upsert({
    where: { envId_metric: { envId, metric } },
    create: { projectId, envId, metric, percent: p, severity, enabled },
    update: { percent: p, severity, enabled },
  });
  return { metric, percent: row.percent, severity: row.severity, enabled: row.enabled, isDefault: false };
}

/** Remove a rule → the metric reverts to its default. */
export async function resetThreshold(envId: string, metric: MetricKey): Promise<void> {
  await prisma.alertThreshold.deleteMany({ where: { envId, metric } });
}
