/**
 * Cost-optimization engine — proactive "you could save here" recommendations,
 * computed DETERMINISTICALLY from real signals (no LLM needed):
 *   • Cluster right-sizing — from live Prometheus node utilization (idle capacity).
 *   • Idle nodes — per-node utilization, drain/remove candidates.
 *   • Cost drivers — the biggest services from the cloud cost breakdown, with a
 *     tailored tip per service type.
 */
import { prisma } from "@/lib/db/prisma";
import { queryClusterPrometheus } from "@/lib/observability/cluster-monitoring";
import { getAwsCostByService } from "@/lib/cloud/aws-cost";
import { getAzureCostByService } from "@/lib/cloud/azure-cost";

export type Recommendation = { id: string; severity: "high" | "medium" | "low"; title: string; detail: string; estimate?: string };
export type Driver = { service: string; cents: number; pct: number };
export type CostOptimReport =
  | { ok: true; recommendations: Recommendation[]; drivers: Driver[]; currency: string }
  | { ok: false; error: string };

const CPU_UTIL_Q = '100 * sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) / sum(kube_node_status_capacity{resource="cpu"})';
const MEM_UTIL_Q = '100 * sum(container_memory_working_set_bytes{container!=""}) / sum(kube_node_status_capacity{resource="memory"})';
const NODE_COUNT_Q = 'count(kube_node_status_capacity{resource="cpu"})';
const PER_NODE_CPU_Q =
  '100 * sum by (node) (rate(container_cpu_usage_seconds_total{container!=""}[5m])) / on(node) group_left sum by (node) (kube_node_status_capacity{resource="cpu"})';

async function scalar(envId: string, q: string): Promise<number | null> {
  try {
    const res = await queryClusterPrometheus(envId, q);
    if (!res.ok || !res.result.length) return null;
    const v = Number(res.result[0].value?.[1]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function driverTip(service: string): string {
  const s = service.toLowerCase();
  if (/ec2|compute|virtual machine|gce|instance/.test(s)) return "Right-size instances to their real usage, or use Spot/Savings Plans for steady workloads.";
  if (/ebs|disk|volume|storage|blob|bucket|s3/.test(s)) return "Delete unattached volumes and old snapshots; move cold data to cheaper storage tiers.";
  if (/rds|sql|database|cosmos|cloud sql/.test(s)) return "Right-size the DB tier, and use reserved capacity if usage is steady.";
  if (/load balancer|elb|gateway/.test(s)) return "Consolidate load balancers and remove unused ones.";
  if (/nat|data transfer|egress|bandwidth/.test(s)) return "Review cross-AZ/egress traffic — it's often avoidable data-transfer cost.";
  if (/kubernetes|eks|aks|gke|container/.test(s)) return "Right-size the node pool to actual utilization (see the cluster recommendation).";
  return "Review this service's usage — it's your largest cost driver.";
}

export async function analyzeCostOptimization(projectId: string): Promise<CostOptimReport> {
  const cp = await prisma.cloudProvider.findFirst({ where: { projectId, kind: { in: ["aws", "azure", "gcp"] } }, select: { id: true, kind: true } });
  const recommendations: Recommendation[] = [];
  let drivers: Driver[] = [];
  const currency = "USD";

  // 1 — Cost drivers (by service).
  if (cp) {
    try {
      const bd = cp.kind === "aws" ? await getAwsCostByService(cp.id, new Date()) : cp.kind === "azure" ? await getAzureCostByService(cp.id) : null;
      if (bd?.ok && bd.services.length) {
        const total = bd.services.reduce((sum, x) => sum + x.cents, 0) || 1;
        drivers = bd.services.slice(0, 5).map((x) => ({ service: x.service, cents: x.cents, pct: Math.round((x.cents / total) * 100) }));
        const top = drivers[0];
        if (top && top.pct >= 25) {
          recommendations.push({
            id: "top-driver",
            severity: "medium",
            title: `Biggest cost: ${top.service} — ${top.pct}% of spend`,
            detail: `${top.service} is your largest cost driver ($${(top.cents / 100).toFixed(2)} this month). ${driverTip(top.service)}`,
            estimate: "Focus here first",
          });
        }
      }
    } catch {
      /* cost breakdown optional */
    }
  }

  // 2 — Cluster right-sizing + idle nodes (from live Prometheus utilization).
  const clusterEnvs = await prisma.env.findMany({ where: { projectId, kubeconfigRef: { not: null } }, select: { id: true, key: true } });
  for (const env of clusterEnvs) {
    const cpu = await scalar(env.id, CPU_UTIL_Q);
    const mem = await scalar(env.id, MEM_UTIL_Q);
    const nodes = await scalar(env.id, NODE_COUNT_Q);
    if (cpu == null && mem == null) continue; // monitoring not installed — skip
    const cpuP = cpu ?? 0;
    const memP = mem ?? 0;
    const nodeN = Math.round(nodes ?? 0);
    const peak = Math.max(cpuP, memP);

    if (peak < 45 && nodeN > 1) {
      recommendations.push({
        id: `rightsize-${env.key}`,
        severity: "high",
        title: `Right-size the ${env.key} cluster — only ~${Math.round(peak)}% used`,
        detail: `The ${env.key} cluster runs at ~${Math.round(cpuP)}% CPU / ${Math.round(memP)}% memory across ${nodeN} nodes — a lot of idle capacity. Reduce the node pool or use smaller nodes to cut this cluster's compute cost.`,
        estimate: `~${Math.round(100 - peak)}% headroom`,
      });
    }

    // Idle individual nodes.
    try {
      const res = await queryClusterPrometheus(env.id, PER_NODE_CPU_Q);
      if (res.ok) {
        for (const s of res.result) {
          const v = Number(s.value?.[1]);
          const node = s.metric.node;
          if (Number.isFinite(v) && v < 10 && node) {
            recommendations.push({
              id: `idle-${env.key}-${node}`,
              severity: "medium",
              title: `Node ${node} is nearly idle (${Math.round(v)}% CPU)`,
              detail: `Node ${node} in ${env.key} is barely used. Drain it (Cloud stats → the node → Drain) and remove it from the pool to save its cost.`,
              estimate: "1 node",
            });
          }
        }
      }
    } catch {
      /* per-node optional */
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      id: "none",
      severity: "low",
      title: "No obvious savings found",
      detail: "Your clusters look reasonably utilised and no single service dominates your spend. Re-run this after usage changes, or once GCP/Azure cost is fully wired.",
    });
  }

  return { ok: true, recommendations, drivers, currency };
}
