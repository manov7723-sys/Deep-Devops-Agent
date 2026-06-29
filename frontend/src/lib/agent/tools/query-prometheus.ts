import { queryPrometheusInstant, PROM_PRESETS } from "@/lib/observability/prometheus";
import type { Tool } from "./types";

type Input = {
  /** A PromQL expression, e.g. 'sum(rate(container_cpu_usage_seconds_total[5m]))'. */
  query: string;
};

type Output = {
  query: string;
  resultType: string;
  series: Array<{ labels: Record<string, string>; value: string }>;
};

/**
 * Run an instant PromQL query against the project's connected Prometheus, so
 * the agent can answer monitoring questions ("what's my CPU usage?", "any pods
 * restarting?"). Read-only. Requires a Prometheus connected on the Observability
 * page. Common queries are listed in the description for the agent to reuse.
 */
export const queryPrometheusTool: Tool<Input, Output> = {
  name: "query_prometheus",
  description:
    "Run a PromQL query against the project's connected Prometheus and return the current value(s). Use this to " +
    "answer monitoring questions about the cluster: CPU/memory usage, running pods, pod restarts, node health, " +
    "request rates. Read-only. Requires a Prometheus connected on the Observability page. " +
    "Handy queries: " +
    PROM_PRESETS.map((p) => `${p.label} → \`${p.query}\``).join("; ") +
    ". You can also write any valid PromQL.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A PromQL expression to evaluate now (instant query).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await queryPrometheusInstant(ctx.projectId, input.query);
    if (!res.ok) return { ok: false, error: res.error };
    const series = res.result.slice(0, 50).map((s) => ({
      labels: s.metric,
      value: s.value ? s.value[1] : "",
    }));
    return { ok: true, output: { query: input.query, resultType: res.resultType, series } };
  },
};
