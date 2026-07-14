/**
 * Agent tools to manage custom alarm thresholds per environment. Setting a
 * threshold drives BOTH the live in-cluster alerts and (next time they're set
 * up) the cloud alarms (AWS/Azure/GCP).
 */
import type { Tool } from "./types";
import { prisma } from "@/lib/db/prisma";
import {
  listEnvThresholds,
  upsertThreshold,
  resetThreshold,
  METRIC_KEYS,
  type MetricKey,
  type ResolvedThreshold,
} from "@/lib/observability/thresholds";

async function resolveEnv(
  projectId: string,
  envKey?: string,
): Promise<{ id: string; key: string } | null> {
  return envKey
    ? prisma.env.findFirst({ where: { projectId, key: envKey }, select: { id: true, key: true } })
    : prisma.env.findFirst({
        where: { projectId },
        orderBy: { promotionRank: "asc" },
        select: { id: true, key: true },
      });
}

export const listAlertThresholdsTool: Tool<
  { envKey?: string },
  { envKey: string; thresholds: ResolvedThreshold[] }
> = {
  name: "list_alert_thresholds",
  description:
    "List the alarm thresholds (CPU / memory / disk, as a percent) for an environment, showing which are user-set vs default. " +
    "Use before changing a threshold so you know the current values.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key (e.g. 'release'). Omit for the first env." },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await resolveEnv(ctx.projectId, input.envKey);
    if (!env)
      return {
        ok: false,
        error: input.envKey
          ? `Env "${input.envKey}" not found.`
          : "This project has no environments.",
      };
    return { ok: true, output: { envKey: env.key, thresholds: await listEnvThresholds(env.id) } };
  },
};

export const setAlertThresholdTool: Tool<
  {
    envKey?: string;
    metric: MetricKey;
    percent: number;
    severity?: "low" | "medium" | "high";
    enabled?: boolean;
  },
  { envKey: string; metric: string; percent: number; severity: string; enabled: boolean }
> = {
  name: "set_alert_threshold",
  description:
    "Set a custom alarm threshold for an environment: the percent (1–100) at which a CPU/memory/disk alert fires. " +
    "Applies immediately to the live in-cluster alerts and to the cloud alarms next time they're set up. " +
    "Set enabled=false to turn a metric's alerting off. Confirm the value with the user before setting it.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key (e.g. 'release'). Omit for the first env." },
      metric: {
        type: "string",
        enum: METRIC_KEYS,
        description: "Which metric: cpu, memory, or disk.",
      },
      percent: {
        type: "number",
        description: "Threshold percent (1–100), e.g. 75 = alert when usage exceeds 75%.",
      },
      severity: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Alert severity. Default high.",
      },
      enabled: {
        type: "boolean",
        description: "Whether this metric's alerting is on. Default true.",
      },
    },
    required: ["metric", "percent"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await resolveEnv(ctx.projectId, input.envKey);
    if (!env)
      return {
        ok: false,
        error: input.envKey
          ? `Env "${input.envKey}" not found.`
          : "This project has no environments.",
      };
    const row = await upsertThreshold(
      ctx.projectId,
      env.id,
      input.metric,
      input.percent,
      input.severity ?? "high",
      input.enabled ?? true,
    );
    return {
      ok: true,
      output: {
        envKey: env.key,
        metric: row.metric,
        percent: row.percent,
        severity: row.severity,
        enabled: row.enabled,
      },
    };
  },
};

export const resetAlertThresholdTool: Tool<
  { envKey?: string; metric: MetricKey },
  { envKey: string; metric: string }
> = {
  name: "reset_alert_threshold",
  description: "Reset a metric's alarm threshold for an environment back to the default value.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key. Omit for the first env." },
      metric: { type: "string", enum: METRIC_KEYS, description: "cpu, memory, or disk." },
    },
    required: ["metric"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await resolveEnv(ctx.projectId, input.envKey);
    if (!env)
      return {
        ok: false,
        error: input.envKey
          ? `Env "${input.envKey}" not found.`
          : "This project has no environments.",
      };
    await resetThreshold(env.id, input.metric);
    return { ok: true, output: { envKey: env.key, metric: input.metric } };
  },
};
