import { prisma } from "@/lib/db/prisma";
import { setupAzureAksAlarms, aksClusterFromEnv, AZURE_METRICS, type AzureMetricKey } from "@/lib/cloud/azure-monitor";
import { getEnvThresholdPercents } from "@/lib/observability/thresholds";
import type { Tool } from "./types";

const METRIC_KEYS: AzureMetricKey[] = ["cpu", "memory", "disk"];

type Input = { envKey?: string; email?: string; metrics?: AzureMetricKey[]; clusterName?: string; resourceGroup?: string };
type Output = { clusterName: string; resourceGroup?: string; alarmsCreated: number; emailWired: boolean; details: Array<{ label: string; ok: boolean; error?: string }> };

/**
 * Set up Azure Monitor metric alerts for an env's AKS cluster (node CPU/memory/
 * disk %), wired to an email action group. Azure/AKS only. ARM REST, no `az`.
 */
export const setupAzureMonitorAlarmsTool: Tool<Input, Output> = {
  name: "setup_azure_monitor_alarms",
  description:
    "Set up Azure Monitor metric alerts for the env's AKS cluster: node CPU %, memory %, and disk % thresholds, " +
    "wired to an email action group (pass email). Azure/AKS only. Auto-detects the cluster name. Defaults to all " +
    "three metrics at 80%.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: 'Env key, e.g. "release". Omit to use the env with an Azure cluster.' },
      email: { type: "string", description: "Email to notify on alert (creates an action group)." },
      metrics: { type: "array", items: { type: "string", enum: METRIC_KEYS }, description: `Subset of: ${METRIC_KEYS.join(", ")}. Default all.` },
      clusterName: { type: "string", description: "AKS cluster name. Auto-detected from the kubeconfig if omitted." },
      resourceGroup: { type: "string", description: "AKS resource group. Auto-resolved if omitted." },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = input.envKey
      ? await prisma.env.findFirst({ where: { projectId: ctx.projectId, key: input.envKey }, select: { id: true, key: true, cloudProviderId: true } })
      : await prisma.env.findFirst({ where: { projectId: ctx.projectId, cloudProviderId: { not: null } }, orderBy: { promotionRank: "asc" }, select: { id: true, key: true, cloudProviderId: true } });
    if (!env?.cloudProviderId) return { ok: false, error: input.envKey ? `Env "${input.envKey}" has no cloud provider.` : "No environment has a cloud provider connected." };

    const cp = await prisma.cloudProvider.findUnique({ where: { id: env.cloudProviderId }, select: { kind: true } });
    if (cp?.kind !== "azure") return { ok: false, error: "Azure Monitor alarms are AKS/Azure only; this env isn't on Azure." };

    const clusterName = input.clusterName || (await aksClusterFromEnv(env.id));
    if (!clusterName) return { ok: false, error: "Couldn't determine the AKS cluster name. Pass clusterName." };

    const metrics = input.metrics?.length ? input.metrics : METRIC_KEYS;
    const thresholdPercents = await getEnvThresholdPercents(env.id);
    const result = await setupAzureAksAlarms({ cloudProviderId: env.cloudProviderId, clusterName, resourceGroup: input.resourceGroup, email: input.email, metrics, thresholdPercents });
    if (!result.ok && result.error) return { ok: false, error: result.error };

    return {
      ok: true,
      output: {
        clusterName: result.clusterName,
        resourceGroup: result.resourceGroup,
        alarmsCreated: result.alarms.filter((a) => a.ok).length,
        emailWired: result.emailWired,
        details: result.alarms.map((a) => ({ label: AZURE_METRICS[a.key].label, ok: a.ok, error: a.error })),
      },
    };
  },
};
