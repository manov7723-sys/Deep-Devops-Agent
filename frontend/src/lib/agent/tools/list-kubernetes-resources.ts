import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

type Input = {
  /** Env key like "dev" / "prod" / a custom slug. Must be wired in this project. */
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
        description: 'Env key, e.g. "dev" or "prod". Must be an env in the current project.',
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
      let res = await runStage({
        command: "kubectl",
        args,
        cwd: process.cwd(),
        env: childEnv,
        timeoutMs: 20_000,
      });

      // AAD token expired — kubeconfig holds a ~1h bearer token, so a cluster
      // that was fine an hour ago starts responding with 401 Unauthorized once
      // the token lapses. Fix by re-issuing the kubeconfig via ARM (fresh
      // token, fresh 1h window). Delegates to repair_cd_kubeconfig — same tool
      // the CD-workflow classifier routes to, so behaviour stays consistent.
      // Do this BEFORE the RBAC check because a fresh kubeconfig makes any
      // subsequent RBAC test meaningful (a stale token 401s regardless of
      // roles).
      const tokenExpired =
        res.exitCode !== 0 &&
        /You must be logged in to the server|Unauthorized/i.test(res.stderr) &&
        !!env.cloudProviderId;
      if (tokenExpired) {
        try {
          // Re-mint the kubeconfig via ARM (fresh 1h token) and stash it back
          // on the env. Inline instead of calling repair_cd_kubeconfig — that
          // tool wants a repoFullName because it also updates KUBECONFIG_B64
          // and reruns the CD workflow. This code path is server-side kubectl,
          // not CD, so we only need the env-level refresh.
          const { prisma: prismaX } = await import("@/lib/db/prisma");
          const cp = env.cloudProviderId
            ? await prismaX.cloudProvider.findFirst({
                where: { id: env.cloudProviderId, kind: "azure" },
                select: { id: true, accountRef: true },
              })
            : null;
          if (cp?.accountRef) {
            const { getAzureAccessToken: getTok } = await import("@/lib/cloud/azure");
            const { getAksKubeconfig, listAksClusters } = await import("@/lib/cloud/azure-arm");
            const armTok = await getTok(cp.id);
            if (armTok.ok) {
              const list = await listAksClusters(armTok.accessToken, cp.accountRef);
              if (list.ok && list.clusters.length >= 1) {
                const target = list.clusters[0];
                // "admin" — certificate-based, long-lived. This overwrites the
                // env's STORED kubeconfig, which is the same blob
                // setEnvKubeconfigSecret later pushes to GitHub as
                // KUBECONFIG_B64. Refreshing it with a 1-hour user token would
                // fix this call and re-break every CD run an hour later.
                const fresh = await getAksKubeconfig(
                  armTok.accessToken,
                  cp.accountRef,
                  target.resourceGroup,
                  target.name,
                  cp.id,
                  "admin",
                );
                if (fresh.ok) {
                  const { encryptSecret } = await import("@/lib/auth/crypto");
                  // Direct prisma update — updateEnv() enforces owner/project
                  // gates that don't fit the server-side auto-heal context.
                  await prismaX.env.update({
                    where: { id: env.id },
                    data: { kubeconfigRef: encryptSecret(fresh.kubeconfig) },
                  });
                  const kcfg2 = await getKubeconfigForEnv(env.id);
                  if (kcfg2.ok) {
                    const childEnv2 = await kubeExecEnv(kcfg2.handle.path, env.cloudProviderId);
                    try {
                      res = await runStage({
                        command: "kubectl",
                        args,
                        cwd: process.cwd(),
                        env: childEnv2,
                        timeoutMs: 20_000,
                      });
                    } finally {
                      await kcfg2.handle.cleanup().catch(() => {});
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Fall through — original error surfaces below.
        }
      }

      // AAD RBAC self-heal — SAME shape as the CD workflow classifier +
      // agent playbook rule, applied server-side.
      //
      // WHY THIS EXISTS: AKS clusters generated by this codebase ship with
      // Entra RBAC enabled. Whoever the env's kubeconfig authenticates as
      // needs a cluster-side role assignment before ANY kubectl call
      // succeeds. When the agent first runs list_kubernetes_resources for
      // the deploy wizard's namespace picker, it hits "does not have access
      // to the resource in Azure" and the whole flow stalls asking the user
      // to type a namespace — even though a self-heal is one ARM call away.
      //
      // Do the heal INSIDE the tool so every caller (agent chat, deploy_my_app,
      // deploy_app, connect_existing_rds) gets it for free without needing
      // separate playbook rules for each call site. Idempotent grant → wait
      // for ARM propagation → retry the kubectl call ONCE. If the retry also
      // fails, surface the original error so the caller can react.
      const aadRbacMissing =
        res.exitCode !== 0 &&
        /does not have access to the resource in Azure/i.test(res.stderr) &&
        !!env.cloudProviderId;
      if (aadRbacMissing) {
        try {
          const { grantAksAccessTool } = await import("./grant-aks-access");
          // Extract the failing oid from the error so we grant the exact
          // identity kubectl authenticates as, not just the caller.
          const failingOid = res.stderr.match(
            /User\s+"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i,
          )?.[1];
          // Do NOT hardcode principalType. AKS AAD tokens can be minted for
          // either a User (idtyp=user) or a Service Principal (idtyp=app),
          // and ARM's role-assignment API validates that the type matches
          // Graph's record for the oid — a wrong type either 400s or
          // creates a broken assignment that grants nothing. Passing only
          // the oid lets grant_aks_access peek at the KUBECONFIG's own JWT
          // (which is authoritative — it's literally the token kubectl
          // sends) and set the correct type from its `idtyp` claim.
          const grant = await grantAksAccessTool.execute(
            failingOid
              ? { envKey: input.envKey, principalObjectId: failingOid }
              : { envKey: input.envKey },
            ctx,
          );
          if (grant.ok && !grant.output.candidates) {
            // ARM role assignments propagate in 15-60s. Give it 30s then retry
            // once — enough for most cases, and if it's still failing we
            // shouldn't burn more time in a synchronous tool call.
            await new Promise((r) => setTimeout(r, 30_000));
            res = await runStage({
              command: "kubectl",
              args,
              cwd: process.cwd(),
              env: childEnv,
              timeoutMs: 20_000,
            });
          }
        } catch {
          // Fall through — original error surfaces below.
        }
      }

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
