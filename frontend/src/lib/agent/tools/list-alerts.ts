import { listAlerts, type AlertFilter } from "@/lib/agentops/alerts";
import type { Tool } from "./types";

type Input = { status?: "open" | "ack" | "resolved"; severity?: "low" | "medium" | "high" };
type Output = {
  count: number;
  alerts: Array<{ id: string; title: string; detail: string; severity: string; category: string; resource: string; status: string; envKey: string; detectedAt: string; recommendation: string }>;
};

/**
 * List this project's alerts (CPU/memory/reliability incidents from the cluster
 * + cloud monitors). Use this to see what's currently firing before
 * investigating or remediating — it's the entry point for incident triage.
 */
export const listAlertsTool: Tool<Input, Output> = {
  name: "list_alerts",
  description:
    "List this project's monitoring alerts (high CPU/memory on nodes, pod restarts, cloud-alarm incidents). " +
    "Default to status='open' to see what's currently firing. Use this first when the user asks 'what's wrong', " +
    "to investigate an incident, or before proposing a fix. Each alert includes a resource, severity and recommendation.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "ack", "resolved"], description: "Filter by status. Usually 'open'." },
      severity: { type: "string", enum: ["low", "medium", "high"], description: "Filter by severity." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const filter: AlertFilter = {};
    if (input.status) filter.status = input.status;
    if (input.severity) filter.severity = input.severity;
    const rows = await listAlerts(ctx.projectId, filter);
    return {
      ok: true,
      output: {
        count: rows.length,
        alerts: rows.slice(0, 40).map((a) => ({
          id: a.id,
          title: a.title,
          detail: a.detail,
          severity: a.severity,
          category: a.category,
          resource: a.resource,
          status: a.status,
          envKey: a.envKey,
          detectedAt: a.detectedAt,
          recommendation: a.recommendation,
        })),
      },
    };
  },
};
