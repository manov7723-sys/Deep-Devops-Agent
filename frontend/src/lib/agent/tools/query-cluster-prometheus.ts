import { prisma } from "@/lib/db/prisma";
import { queryClusterPrometheus } from "@/lib/observability/cluster-monitoring";
import type { Tool } from "./types";

type Input = {
  /** A PromQL expression to evaluate now. */
  query: string;
  /** Env key (e.g. "release"). Optional — defaults to the env that has a cluster wired. */
  envKey?: string;
};

type Output = {
  envKey: string;
  query: string;
  resultType: string;
  series: Array<{ labels: Record<string, string>; value: string }>;
};

// Curated PromQL for the in-cluster kube-prometheus-stack. node-exporter +
// kube-state-metrics feed these. Memory/CPU % use node-exporter node metrics.
const PRESETS: Array<{ label: string; query: string }> = [
  {
    label: "Cluster memory % used",
    query: `100 * (1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))`,
  },
  {
    label: "Cluster CPU % used",
    query: `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))`,
  },
  {
    label: "Cluster memory used (GiB)",
    query: `sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / 1024^3`,
  },
  { label: "Running pods", query: `count(kube_pod_status_phase{phase="Running"} == 1)` },
  {
    label: "Pod restarts (1h)",
    query: `sum(increase(kube_pod_container_status_restarts_total[1h]))`,
  },
  {
    label: "Ready nodes",
    query: `count(kube_node_status_condition{condition="Ready",status="true"} == 1)`,
  },
  // Scope to one app by adding a namespace selector, e.g. namespace="myapp-ns":
  {
    label: "App memory used (GiB) in a namespace",
    query: `sum(container_memory_working_set_bytes{namespace="NS",container!=""}) / 1024^3`,
  },
];

/**
 * Run a PromQL query against the env's IN-CLUSTER Prometheus (the one installed
 * via "Install monitoring"), through the Kubernetes API-server proxy. Use this
 * to answer live monitoring questions — memory %, CPU %, pod restarts, etc. —
 * with no external Prometheus endpoint required. Read-only.
 */
export const queryClusterPrometheusTool: Tool<Input, Output> = {
  name: "query_cluster_prometheus",
  description:
    "Answer live cluster monitoring questions by running PromQL against the project's IN-CLUSTER Prometheus " +
    "(installed via the Observability tab's 'Install monitoring'). Use for memory %, CPU %, running pods, restarts, " +
    "node health, and app resource usage. Read-only; no external endpoint needed. " +
    'To scope to one application, add a namespace label selector, e.g. namespace="my-namespace". ' +
    "Handy queries: " +
    PRESETS.map((p) => `${p.label} → \`${p.query}\``).join("; ") +
    ". You can also write any valid PromQL.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A PromQL expression to evaluate now (instant query).",
      },
      envKey: {
        type: "string",
        description:
          'Environment key, e.g. "release". Omit to use the env with a connected cluster.',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // Resolve the env: explicit key, else the first env that has a cluster wired.
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
    if (!env) {
      return {
        ok: false,
        error: input.envKey
          ? `Env "${input.envKey}" not found.`
          : "No environment has a cluster connected.",
      };
    }
    if (!env.kubeconfigRef) {
      return {
        ok: false,
        error: `Env "${env.key}" has no cluster connected. Connect it on the Connection tab first.`,
      };
    }

    const res = await queryClusterPrometheus(env.id, input.query);
    if (!res.ok) return { ok: false, error: res.error };
    const series = res.result
      .slice(0, 50)
      .map((s) => ({ labels: s.metric, value: s.value ? s.value[1] : "" }));
    return {
      ok: true,
      output: { envKey: env.key, query: input.query, resultType: res.resultType, series },
    };
  },
};
