import { prisma } from "@/lib/db/prisma";
import { createScrapeTarget } from "@/lib/observability/cluster-monitoring";
import type { Tool } from "./types";

type Input = {
  envKey?: string;
  kind: "ServiceMonitor" | "PodMonitor";
  name: string;
  namespace: string;
  selectorKey: string;
  selectorValue: string;
  port: string;
  path?: string;
  interval?: string;
};

type Output = { kind: string; name: string; namespace: string; message: string };

/**
 * Create a ServiceMonitor / PodMonitor so the in-cluster Prometheus scrapes the
 * app's own /metrics endpoint. Use ServiceMonitor when the app has a Service
 * exposing metrics, PodMonitor to scrape pods directly. The app must already
 * expose Prometheus-format metrics. Discovery is enabled cluster-wide.
 */
export const createScrapeTargetTool: Tool<Input, Output> = {
  name: "create_scrape_target",
  description:
    "Make the in-cluster Prometheus scrape an application's own /metrics endpoint by creating a ServiceMonitor " +
    "(app has a Service) or PodMonitor (scrape pods directly). Provide the app's namespace, a label selector " +
    "(selectorKey/selectorValue, e.g. app=vote), the metrics port (named like 'metrics' or a number like 8080), " +
    "and path (default /metrics). The app must already expose Prometheus metrics. Requires monitoring installed.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: 'Env key, e.g. "alpha". Omit to use the env with a cluster connected.' },
      kind: { type: "string", enum: ["ServiceMonitor", "PodMonitor"], description: "ServiceMonitor (via Service) or PodMonitor (via pods)." },
      name: { type: "string", description: "Short name for the scrape config, e.g. the app name." },
      namespace: { type: "string", description: "Namespace where the app runs, e.g. 'dev'." },
      selectorKey: { type: "string", description: "Label key that selects the Service/pods, e.g. 'app'." },
      selectorValue: { type: "string", description: "Label value, e.g. 'vote'." },
      port: { type: "string", description: "Metrics port — a named port ('metrics') or a number ('8080')." },
      path: { type: "string", description: "Metrics path. Default /metrics." },
      interval: { type: "string", description: "Scrape interval. Default 30s." },
    },
    required: ["kind", "name", "namespace", "selectorKey", "selectorValue", "port"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = input.envKey
      ? await prisma.env.findFirst({ where: { projectId: ctx.projectId, key: input.envKey }, select: { id: true, key: true, kubeconfigRef: true } })
      : await prisma.env.findFirst({ where: { projectId: ctx.projectId, kubeconfigRef: { not: null } }, orderBy: { promotionRank: "asc" }, select: { id: true, key: true, kubeconfigRef: true } });
    if (!env) return { ok: false, error: input.envKey ? `Env "${input.envKey}" not found.` : "No environment has a cluster connected." };
    if (!env.kubeconfigRef) return { ok: false, error: `Env "${env.key}" has no cluster connected.` };

    const res = await createScrapeTarget(env.id, {
      kind: input.kind,
      name: input.name,
      namespace: input.namespace,
      matchLabels: { [input.selectorKey]: input.selectorValue },
      port: input.port,
      path: input.path || "/metrics",
      interval: input.interval || "30s",
    });
    if (!res.ok) return { ok: false, error: res.message };
    return { ok: true, output: { kind: input.kind, name: input.name, namespace: input.namespace, message: res.message } };
  },
};
