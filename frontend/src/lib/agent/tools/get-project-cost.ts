import { getLatestSnapshot } from "@/lib/insights/cost";
import type { Tool } from "./types";

type Output = {
  monthToDateDollars: number;
  forecastDollars: number | null;
  budgetDollars: number | null;
  percentOfBudget: number | null;
  savingsDollars: number | null;
  overBudget: boolean;
};

/**
 * Read the project's latest cost snapshot. The agent uses this together with
 * list_kubernetes_resources + query_cluster_prometheus to analyse cost
 * optimizations (idle pods, oversized nodes, unused volumes) and propose
 * savings — especially when a budget alert fires.
 */
export const getProjectCostTool: Tool<Record<string, never>, Output> = {
  name: "get_project_cost",
  description:
    "Get this project's current cloud spend: month-to-date, forecast, budget and % of budget used. Use this when the user asks " +
    "about cost, a budget alert fired, or they want cost optimization — then inspect cluster resources (list_kubernetes_resources, " +
    "query_cluster_prometheus for actual CPU/mem usage) to find idle/oversized/unused resources and propose concrete savings.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const snap = await getLatestSnapshot(ctx.projectId);
    if (!snap) return { ok: false, error: "No cost data yet — run a cost refresh first." };
    const d = (c: number | null | undefined) => (c == null ? null : Math.round(c) / 100);
    const total = d(snap.totalCents) ?? 0;
    const budget = d(snap.budgetCents);
    return {
      ok: true,
      output: {
        monthToDateDollars: total,
        forecastDollars: d(snap.forecastCents),
        budgetDollars: budget,
        percentOfBudget: budget && budget > 0 ? Math.round((total / budget) * 100) : null,
        savingsDollars: d(snap.savingsCents),
        overBudget: budget != null && budget > 0 && total >= budget,
      },
    };
  },
};
