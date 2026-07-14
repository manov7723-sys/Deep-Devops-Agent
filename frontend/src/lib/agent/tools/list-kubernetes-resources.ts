import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

type Input = {
  /** Env key like "alpha" / "release" / a custom slug. Must be wired in this project. */
  envKey: string;
  /** Kubernetes resource kind: pods, deployments, services, ingresses, nodes, configmaps, secrets... */
  kind: string;
  /** Namespace to look in. Defaults to the env's configured namespace. */
  namespace?: string;
};

type ResourceItem = {
  name: string;
  namespace?: string;
  status?: string;
  ready?: string;
  age?: string;
  /** Catch-all for kind-specific fields (image, podIP, etc.). */
  extra?: Record<string, string>;
};

type Output = {
  envKey: string;
  kind: string;
  namespace: string;
  count: number;
  items: ResourceItem[];
};

const ALLOWED_KINDS = new Set([
  "pods",
  "pod",
  "po",
  "deployments",
  "deployment",
  "deploy",
  "services",
  "service",
  "svc",
  "ingresses",
  "ingress",
  "ing",
  "nodes",
  "node",
  "no",
  "configmaps",
  "configmap",
  "cm",
  "secrets",
  "secret",
  "namespaces",
  "namespace",
  "ns",
  "replicasets",
  "replicaset",
  "rs",
  "statefulsets",
  "statefulset",
  "sts",
  "daemonsets",
  "daemonset",
  "ds",
  "jobs",
  "job",
  "cronjobs",
  "cronjob",
  "cj",
  "persistentvolumeclaims",
  "pvc",
  "persistentvolumes",
  "pv",
]);

/**
 * Read-only kubectl tool. Lists resources of a given kind in a namespace
 * using the env's stored kubeconfig. Never mutates the cluster. Output is
 * normalized so Claude can reason about it without seeing raw YAML.
 *
 * Refuses kinds outside `ALLOWED_KINDS` so a prompt-injection can't pivot
 * to obscure CRDs like `clusterroles` or `customresourcedefinitions`.
 */
export const listKubernetesResourcesTool: Tool<Input, Output> = {
  name: "list_kubernetes_resources",
  description:
    "List Kubernetes resources of a given kind in a project env's cluster. " +
    "Use this to answer questions like 'what pods are running?', 'what's deployed in alpha?', " +
    "'show me the services'. Read-only — won't change cluster state. " +
    "Common kinds: pods, deployments, services, ingresses, nodes, namespaces, configmaps, " +
    "cronjobs, jobs, statefulsets, daemonsets, pvc. Aliases like 'po', 'svc' also work.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: 'Env key, e.g. "alpha" or "release". Must be an env in the current project.',
      },
      kind: {
        type: "string",
        description: "Resource kind (pods, deployments, services, etc.).",
      },
      namespace: {
        type: "string",
        description: "Namespace to scope the list to. Defaults to the env's configured namespace.",
      },
    },
    required: ["envKey", "kind"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const kind = input.kind.toLowerCase().trim();
    if (!ALLOWED_KINDS.has(kind)) {
      return {
        ok: false,
        error: `Unsupported resource kind "${input.kind}". Allowed: pods, deployments, services, ingresses, nodes, namespaces, configmaps, cronjobs, jobs, statefulsets, daemonsets, pvc.`,
      };
    }

    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, namespace: true, cloudProviderId: true },
    });
    if (!env) {
      return {
        ok: false,
        error: `Env "${input.envKey}" not found in this project. Available envs: query list_project_repos or check the env tab.`,
      };
    }

    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) {
      return { ok: false, error: kcfg.message };
    }
    const childEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

    const namespace = input.namespace ?? env.namespace ?? "default";
    const args =
      kind === "nodes" ||
      kind === "node" ||
      kind === "no" ||
      kind === "namespaces" ||
      kind === "namespace" ||
      kind === "ns" ||
      kind === "pv" ||
      kind === "persistentvolumes"
        ? ["get", kind, "-o", "json"] // cluster-scoped
        : ["get", kind, "-n", namespace, "-o", "json"]; // namespaced

    try {
      const res = await runStage({
        command: "kubectl",
        args,
        cwd: process.cwd(),
        env: childEnv,
        timeoutMs: 20_000,
      });

      if (res.exitCode !== 0) {
        return {
          ok: false,
          error: `kubectl get ${kind} failed: ${res.stderr.slice(-500)}`,
        };
      }

      let parsed: { items?: unknown[] };
      try {
        parsed = JSON.parse(res.stdout) as { items?: unknown[] };
      } catch {
        return { ok: false, error: "kubectl returned non-JSON output." };
      }
      const items = (parsed.items ?? []).map(normaliseItem).slice(0, 100);
      return {
        ok: true,
        output: {
          envKey: input.envKey,
          kind,
          namespace: kind === "nodes" || kind === "namespaces" ? "(cluster-scoped)" : namespace,
          count: items.length,
          items,
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};

function normaliseItem(raw: unknown): ResourceItem {
  const r = raw as {
    kind?: string;
    metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
    status?: Record<string, unknown>;
    spec?: Record<string, unknown>;
  };
  const name = r.metadata?.name ?? "(unknown)";
  const namespace = r.metadata?.namespace;
  const extra: Record<string, string> = {};

  // Try to pull commonly-asked-about fields per kind.
  if (r.kind === "Pod") {
    const phase = (r.status as { phase?: string })?.phase;
    const containerStatuses =
      (
        r.status as {
          containerStatuses?: Array<{ ready?: boolean; restartCount?: number; image?: string }>;
        }
      )?.containerStatuses ?? [];
    const readyN = containerStatuses.filter((c) => c.ready).length;
    const total = containerStatuses.length;
    const restarts = containerStatuses.reduce((s, c) => s + (c.restartCount ?? 0), 0);
    if (containerStatuses[0]?.image) extra.image = containerStatuses[0].image;
    extra.restarts = String(restarts);
    return {
      name,
      namespace,
      status: phase,
      ready: `${readyN}/${total}`,
      age: ageOf(r.metadata?.creationTimestamp),
      extra,
    };
  }
  if (r.kind === "Deployment") {
    const s = r.status as { readyReplicas?: number; replicas?: number; updatedReplicas?: number };
    return {
      name,
      namespace,
      status: `${s.updatedReplicas ?? 0} updated`,
      ready: `${s.readyReplicas ?? 0}/${s.replicas ?? 0}`,
      age: ageOf(r.metadata?.creationTimestamp),
    };
  }
  if (r.kind === "Service") {
    const sp = r.spec as {
      type?: string;
      clusterIP?: string;
      ports?: Array<{ port?: number; targetPort?: unknown }>;
    };
    extra.type = sp.type ?? "ClusterIP";
    if (sp.clusterIP) extra.clusterIP = sp.clusterIP;
    if (sp.ports?.[0]?.port) extra.port = String(sp.ports[0].port);
    return { name, namespace, status: sp.type, age: ageOf(r.metadata?.creationTimestamp), extra };
  }
  if (r.kind === "Node") {
    const cs =
      (r.status as { conditions?: Array<{ type?: string; status?: string }> })?.conditions ?? [];
    const ready = cs.find((c) => c.type === "Ready")?.status === "True" ? "Ready" : "NotReady";
    const ver = (r.status as { nodeInfo?: { kubeletVersion?: string } })?.nodeInfo?.kubeletVersion;
    if (ver) extra.version = ver;
    return { name, namespace, status: ready, age: ageOf(r.metadata?.creationTimestamp), extra };
  }
  return { name, namespace, age: ageOf(r.metadata?.creationTimestamp) };
}

function ageOf(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
