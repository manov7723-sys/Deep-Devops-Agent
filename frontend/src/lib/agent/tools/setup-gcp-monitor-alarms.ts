import { prisma } from "@/lib/db/prisma";
import {
  setupGkeAlarms,
  gkeClusterFromEnv,
  GCP_METRICS,
  type GcpMetricKey,
} from "@/lib/cloud/gcp-monitor";
import { getEnvThresholdPercents } from "@/lib/observability/thresholds";
import type { Tool } from "./types";

const METRIC_KEYS: GcpMetricKey[] = ["cpu", "memory"];

type Input = { envKey?: string; email?: string; metrics?: GcpMetricKey[]; clusterName?: string };
type Output = {
  clusterName: string;
  project?: string;
  alarmsCreated: number;
  emailWired: boolean;
  details: Array<{ label: string; ok: boolean; error?: string }>;
};

/**
 * Set up GCP Cloud Monitoring alert policies for an env's GKE cluster (node
 * CPU/memory/disk %), wired to an email notification channel. GKE/GCP only.
 */
export const setupGcpMonitorAlarmsTool: Tool<Input, Output> = {
  name: "setup_gcp_monitor_alarms",
  description:
    "Set up GCP Cloud Monitoring alert policies for the env's GKE cluster: node CPU %, memory %, and disk % " +
    "thresholds, wired to an email notification channel (pass email). GKE/GCP only. Auto-detects the cluster name. " +
    "Defaults to all three metrics at 80%.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: 'Env key, e.g. "release". Omit to use the env with a GCP cluster.',
      },
      email: {
        type: "string",
        description: "Email to notify on alert (creates a notification channel).",
      },
      metrics: {
        type: "array",
        items: { type: "string", enum: METRIC_KEYS },
        description: `Subset of: ${METRIC_KEYS.join(", ")}. Default all.`,
      },
      clusterName: {
        type: "string",
        description: "GKE cluster name. Auto-detected from the kubeconfig if omitted.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = input.envKey
      ? await prisma.env.findFirst({
          where: { projectId: ctx.projectId, key: input.envKey },
          select: { id: true, key: true, cloudProviderId: true },
        })
      : await prisma.env.findFirst({
          where: { projectId: ctx.projectId, cloudProviderId: { not: null } },
          orderBy: { promotionRank: "asc" },
          select: { id: true, key: true, cloudProviderId: true },
        });
    if (!env?.cloudProviderId)
      return {
        ok: false,
        error: input.envKey
          ? `Env "${input.envKey}" has no cloud provider.`
          : "No environment has a cloud provider connected.",
      };

    const cp = await prisma.cloudProvider.findUnique({
      where: { id: env.cloudProviderId },
      select: { kind: true },
    });
    if (cp?.kind !== "gcp")
      return { ok: false, error: "GCP Monitoring alarms are GKE/GCP only; this env isn't on GCP." };

    const clusterName = input.clusterName || (await gkeClusterFromEnv(env.id));
    if (!clusterName)
      return { ok: false, error: "Couldn't determine the GKE cluster name. Pass clusterName." };

    const metrics = input.metrics?.length ? input.metrics : METRIC_KEYS;
    const thresholdPercents = await getEnvThresholdPercents(env.id);
    const result = await setupGkeAlarms({
      cloudProviderId: env.cloudProviderId,
      clusterName,
      email: input.email,
      metrics,
      thresholdPercents,
    });
    if (!result.ok && result.error) return { ok: false, error: result.error };

    return {
      ok: true,
      output: {
        clusterName: result.clusterName,
        project: result.project,
        alarmsCreated: result.alarms.filter((a) => a.ok).length,
        emailWired: result.emailWired,
        details: result.alarms.map((a) => ({
          label: GCP_METRICS[a.key].label,
          ok: a.ok,
          error: a.error,
        })),
      },
    };
  },
};
