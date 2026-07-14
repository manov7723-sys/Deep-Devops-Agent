/**
 * Immediate, in-app threshold alerts evaluated straight from the cluster's
 * in-cluster Prometheus — NOT the cloud provider's alarm engine.
 *
 * WHY: CloudWatch / Azure Monitor / GCP Monitor all carry minutes of metric
 * ingestion + evaluation latency, so a "node crossed 80%" alert lands several
 * minutes late. Prometheus scrapes the cluster every ~30s with no cloud lag, so
 * evaluating the threshold here (on the /alerts/live poll, ~60s) surfaces the
 * alert almost the moment the metric crosses — and createAlert fires the banner
 * + email. The cloud alarms stay as a slower, independent backup path.
 *
 * Alerts are keyed by sourceLabel `live:<rule>:<entity>` so they de-dupe and
 * auto-resolve when the metric drops back under threshold.
 */
import { queryClusterPrometheus } from "./cluster-monitoring";
import { createAlert, patchAlertStatus } from "@/lib/agentops/alerts";
import { getEnvThresholds, type MetricKey } from "./thresholds";
import { prisma } from "@/lib/db/prisma";
import type { AlertCategory, AlertSeverity } from "@prisma/client";

type Rule = {
  key: string;
  /** Which configurable metric this rule maps to (cpu/memory/disk). */
  metric: MetricKey;
  /** PromQL returning one sample per entity (per-node etc.). */
  query: string;
  /** Fallback threshold if no user/default value applies. */
  threshold: number;
  /** Metric label identifying the entity (e.g. "node"); omit for a cluster scalar. */
  labelKey?: string;
  resource: string;
  category: AlertCategory;
  /** Fallback severity; overridden by the configured threshold's severity. */
  severity: AlertSeverity;
  title: (entity: string, v: number) => string;
  detail: (entity: string, v: number, threshold: number) => string;
  recommendation: string;
};

const RULES: Rule[] = [
  {
    key: "node-cpu",
    metric: "cpu",
    // Per-node CPU% = used cores / capacity × 100 (cadvisor + kube-state-metrics).
    query:
      '100 * sum by (node) (rate(container_cpu_usage_seconds_total{container!=""}[1m])) / on(node) group_left sum by (node) (kube_node_status_capacity{resource="cpu"})',
    threshold: 80,
    labelKey: "node",
    resource: "Kubernetes node",
    category: "Performance",
    severity: "high",
    title: (n, v) => `High CPU on node ${n} — ${v.toFixed(0)}%`,
    detail: (n, v, t) =>
      `Node ${n} CPU is ${v.toFixed(1)}% (threshold ${t}%), live from in-cluster Prometheus.`,
    recommendation:
      "Scale the node pool or the workload — sustained CPU saturation throttles your apps.",
  },
  {
    key: "node-mem",
    metric: "memory",
    query:
      '100 * sum by (node) (container_memory_working_set_bytes{container!=""}) / on(node) group_left sum by (node) (kube_node_status_capacity{resource="memory"})',
    threshold: 85,
    labelKey: "node",
    resource: "Kubernetes node",
    category: "Performance",
    severity: "high",
    title: (n, v) => `High memory on node ${n} — ${v.toFixed(0)}%`,
    detail: (n, v, t) =>
      `Node ${n} memory is ${v.toFixed(1)}% (threshold ${t}%), live from in-cluster Prometheus.`,
    recommendation:
      "Scale the node pool or reduce memory requests — nodes near capacity risk OOM evictions.",
  },
];

/**
 * Evaluate the live threshold rules for one env's in-cluster Prometheus and
 * open/resolve in-app Alerts accordingly. Best-effort: if monitoring isn't
 * installed/reachable the rule is skipped silently (never throws).
 */
export async function evaluateLiveMetricAlerts(projectId: string, envId: string): Promise<void> {
  const existing = await prisma.alert.findMany({
    where: { projectId, envId, sourceLabel: { startsWith: "live:" }, status: { not: "resolved" } },
    select: { id: true, sourceLabel: true },
  });

  // User-configurable thresholds for this env (defaults where unset).
  const thresholds = await getEnvThresholds(envId);

  for (const rule of RULES) {
    const conf = thresholds[rule.metric];
    // Disabled metric → skip evaluating (and resolve any lingering alerts below).
    const threshold = conf.enabled ? conf.percent : rule.threshold;
    const severity = conf.enabled ? conf.severity : rule.severity;

    let res;
    try {
      res = await queryClusterPrometheus(envId, rule.query);
    } catch {
      return; // proxy/network error — skip this env entirely
    }
    if (!res.ok) return; // monitoring not installed / unreachable — skip

    const breaching = new Map<string, number>();
    if (conf.enabled) {
      for (const s of res.result) {
        const v = Number(s.value?.[1]);
        if (!Number.isFinite(v)) continue;
        const entity = rule.labelKey ? (s.metric[rule.labelKey] ?? "cluster") : "cluster";
        if (v > threshold) breaching.set(entity, v);
      }
    }

    const prefix = `live:${rule.key}:`;
    // Open alerts for new breaches.
    for (const [entity, v] of breaching) {
      const sourceLabel = `${prefix}${entity}`;
      if (existing.some((e) => e.sourceLabel === sourceLabel)) continue;
      await createAlert({
        projectId,
        envId,
        title: rule.title(entity, v),
        detail: rule.detail(entity, v, threshold),
        resource: rule.resource,
        sourceLabel,
        category: rule.category,
        severity,
        recommendation: rule.recommendation,
      });
    }
    // Resolve alerts whose entity is no longer breaching.
    for (const e of existing) {
      if (!e.sourceLabel?.startsWith(prefix)) continue;
      const entity = e.sourceLabel.slice(prefix.length);
      if (!breaching.has(entity)) await patchAlertStatus(projectId, e.id, "resolved");
    }
  }
}
