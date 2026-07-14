import { prisma } from "@/lib/db/prisma";
import { detectScrapeCandidates } from "@/lib/observability/cluster-monitoring";
import type { Tool } from "./types";

type Input = { envKey?: string; namespace: string };
type Output = {
  namespace: string;
  candidates: Array<{
    kind: string;
    target: string;
    selectorKey: string;
    selectorValue: string;
    port: string;
    path: string;
    hint: string;
  }>;
};

/**
 * Auto-detect which Services in a namespace expose Prometheus metrics (by
 * prometheus.io annotations or a metrics-named port), returning ready-to-use
 * selector/port/path. Pair with create_scrape_target to wire the scrape.
 */
export const detectAppMetricsTool: Tool<Input, Output> = {
  name: "detect_app_metrics",
  description:
    "Inspect a namespace's Services and suggest scrape configs (label selector, metrics port, path) for the app's " +
    "/metrics endpoint — so you don't have to look them up. Returns candidates ranked by confidence. Then call " +
    "create_scrape_target with the chosen candidate's values.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: 'Env key, e.g. "alpha". Omit to use the env with a cluster connected.',
      },
      namespace: { type: "string", description: "Namespace to inspect, e.g. 'dev'." },
    },
    required: ["namespace"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = input.envKey
      ? await prisma.env.findFirst({
          where: { projectId: ctx.projectId, key: input.envKey },
          select: { id: true, key: true, kubeconfigRef: true },
        })
      : await prisma.env.findFirst({
          where: { projectId: ctx.projectId, kubeconfigRef: { not: null } },
          orderBy: { promotionRank: "asc" },
          select: { id: true, key: true, kubeconfigRef: true },
        });
    if (!env)
      return {
        ok: false,
        error: input.envKey
          ? `Env "${input.envKey}" not found.`
          : "No environment has a cluster connected.",
      };
    if (!env.kubeconfigRef)
      return { ok: false, error: `Env "${env.key}" has no cluster connected.` };

    const res = await detectScrapeCandidates(env.id, input.namespace);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { namespace: input.namespace, candidates: res.candidates } };
  },
};
