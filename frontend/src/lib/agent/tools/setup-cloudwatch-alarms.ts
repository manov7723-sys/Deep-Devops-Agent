import { prisma } from "@/lib/db/prisma";
import { setupEksCloudWatchAlarms, eksClusterFromEnv, METRICS, type MetricKey } from "@/lib/cloud/cloudwatch";
import { syncEksAlarmsToAlerts } from "@/lib/cloud/cloudwatch-alerts";
import { getEnvThresholdPercents } from "@/lib/observability/thresholds";
import type { Tool } from "./types";

const METRIC_KEYS: MetricKey[] = ["cpu", "status", "memory", "disk"];

type Input = {
  envKey?: string;
  /** SNS email to notify on ALARM (you'll confirm the subscription email). */
  email?: string;
  /** Which metrics to alarm on. Defaults to all four. */
  metrics?: MetricKey[];
  /** EKS cluster name. Auto-detected from the env's kubeconfig if omitted. */
  clusterName?: string;
  region?: string;
};

type Output = {
  clusterName: string;
  region: string;
  nodeCount: number;
  alarmsCreated: number;
  topicArn?: string;
  containerInsights?: string;
  details: Array<{ label: string; target: string; ok: boolean; error?: string }>;
};

/**
 * Set up CloudWatch alarms for an EKS cluster from chat. CPU + status-check are
 * native EC2 metrics; memory + disk need Container Insights, which this enables.
 * Wires alarms to an SNS email topic and mirrors firing alarms into Alerts.
 */
export const setupCloudWatchAlarmsTool: Tool<Input, Output> = {
  name: "setup_cloudwatch_alarms",
  description:
    "Set up AWS CloudWatch alarms for the env's EKS cluster: CPU Utilization, Status Check Failed (native EC2), " +
    "and Memory + Disk utilization (enables Container Insights / the CloudWatch agent automatically). Optionally " +
    "wires alarms to an SNS email topic (pass email; the user must confirm the SNS subscription email AWS sends) " +
    "and mirrors any firing alarm into the project's Alerts. Discovers the cluster's worker nodes automatically. " +
    "Defaults to all four metrics with an 80% threshold. AWS/EKS only.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: 'Env key, e.g. "release". Omit to use the env with an AWS cluster connected.' },
      email: { type: "string", description: "Email to notify on ALARM (creates an SNS topic + subscription)." },
      metrics: { type: "array", items: { type: "string", enum: METRIC_KEYS }, description: `Subset of: ${METRIC_KEYS.join(", ")}. Default all.` },
      clusterName: { type: "string", description: "EKS cluster name. Auto-detected from the kubeconfig if omitted." },
      region: { type: "string", description: "AWS region. Defaults to the env/provider region." },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = input.envKey
      ? await prisma.env.findFirst({ where: { projectId: ctx.projectId, key: input.envKey }, select: { id: true, key: true, region: true, cloudProviderId: true } })
      : await prisma.env.findFirst({ where: { projectId: ctx.projectId, cloudProviderId: { not: null } }, orderBy: { promotionRank: "asc" }, select: { id: true, key: true, region: true, cloudProviderId: true } });
    if (!env) return { ok: false, error: input.envKey ? `Env "${input.envKey}" not found.` : "No environment has a cloud provider connected." };
    if (!env.cloudProviderId) return { ok: false, error: "This environment has no cloud provider connected." };

    const cp = await prisma.cloudProvider.findUnique({ where: { id: env.cloudProviderId }, select: { kind: true, region: true } });
    if (cp?.kind !== "aws") return { ok: false, error: "CloudWatch alarms are AWS/EKS only; this env isn't on AWS." };

    const clusterName = input.clusterName || (await eksClusterFromEnv(env.id));
    if (!clusterName) return { ok: false, error: "Couldn't determine the EKS cluster name from the kubeconfig. Pass clusterName." };

    const metrics = input.metrics?.length ? input.metrics : METRIC_KEYS;
    const thresholdPercents = await getEnvThresholdPercents(env.id);
    const result = await setupEksCloudWatchAlarms({
      cloudProviderId: env.cloudProviderId,
      clusterName,
      region: input.region || env.region || cp.region || undefined,
      email: input.email,
      metrics,
      thresholdPercents,
    });
    if (!result.ok && result.error) return { ok: false, error: result.error };

    await syncEksAlarmsToAlerts({ projectId: ctx.projectId, envId: env.id, cloudProviderId: env.cloudProviderId, clusterName, region: result.region }).catch(() => {});

    return {
      ok: true,
      output: {
        clusterName: result.clusterName,
        region: result.region,
        nodeCount: result.nodeCount,
        alarmsCreated: result.alarms.filter((a) => a.ok).length,
        topicArn: result.topicArn,
        containerInsights: result.containerInsights,
        details: result.alarms.map((a) => ({ label: `${METRICS[a.metric].label}`, target: a.target, ok: a.ok, error: a.error })),
      },
    };
  },
};
