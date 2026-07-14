/**
 * Agent tool — analyze cost optimization. Returns deterministic savings
 * recommendations (cluster right-sizing, idle nodes, top cost drivers) so the
 * agent can answer "analyse cost optimization" without extra reasoning.
 */
import type { Tool } from "./types";
import {
  analyzeCostOptimization,
  type Recommendation,
  type Driver,
} from "@/lib/insights/cost-optim";

export const analyzeCostOptimizationTool: Tool<
  Record<string, never>,
  { recommendations: Recommendation[]; drivers: Driver[] }
> = {
  name: "analyze_cost_optimization",
  description:
    "Analyse this project's cost and cluster utilization and return concrete savings recommendations " +
    "(right-size an underused cluster, drain idle nodes, tackle the biggest cost driver). Use when the user " +
    "asks how to reduce cost / save money / optimize spend.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const r = await analyzeCostOptimization(ctx.projectId);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, output: { recommendations: r.recommendations, drivers: r.drivers } };
  },
};
