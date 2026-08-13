/**
 * Discover every application the agent has deployed, across AWS, Azure and GCP.
 *
 * "Deployed app" here means a Kubernetes Deployment carrying the label this
 * codebase stamps on everything it generates (`app.kubernetes.io/managed-by:
 * deepagent`). That label is the only reliable marker: workload names, image
 * registries and namespaces all vary per cloud, and a name-based heuristic
 * would either miss apps or claim ones a human deployed by hand.
 *
 * Grouped by NAMESPACE rather than by cluster or project, because a namespace
 * is the unit the user recognises — it's what the deploy wizard asks them to
 * pick, and what the Reports tab titles each section with.
 *
 * Cloud-agnostic by construction: every cluster is reached through its stored
 * kubeconfig, so AWS/Azure/GCP need no per-cloud branches here. The cloud is
 * recorded only so the report can say where a namespace lives.
 */
import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";

export type DiscoveredApp = {
  name: string;
  /** Desired replica count from the spec. */
  replicas: number;
  /** Replicas actually serving traffic. */
  readyReplicas: number;
  /** Container images, deduped — usually one. */
  images: string[];
  /** Total restarts across the namespace's pods for this app. */
  restarts: number;
  /** ISO timestamp of the most recent rollout. */
  lastRolloutAt?: string;
  /** "healthy" when every desired replica is ready, else "degraded". */
  health: "healthy" | "degraded";
};

export type DiscoveredNamespace = {
  /** The section title on the Reports tab. */
  namespace: string;
  envKey: string;
  envId: string;
  cloud: "aws" | "azure" | "gcp" | "unknown";
  clusterReachable: boolean;
  /** Why the cluster couldn't be read, when clusterReachable is false. */
  note?: string;
  apps: DiscoveredApp[];
};

/**
 * Enumerate deployed apps for one project.
 *
 * Best-effort per environment: one unreachable cluster (expired credentials,
 * deleted cluster, network) must not blank the whole report, so failures are
 * recorded on that namespace and the others still resolve.
 */
export async function discoverDeployedApps(projectId: string): Promise<DiscoveredNamespace[]> {
  const envs = await prisma.env.findMany({
    where: { projectId, kubeconfigRef: { not: null } },
    select: {
      id: true,
      key: true,
      namespace: true,
      cloudProviderId: true,
      cloudProvider: { select: { kind: true } },
    },
  });

  const out: DiscoveredNamespace[] = [];

  for (const env of envs) {
    const cloudKind = env.cloudProvider?.kind;
    const cloud: DiscoveredNamespace["cloud"] =
      cloudKind === "aws" || cloudKind === "azure" || cloudKind === "gcp" ? cloudKind : "unknown";

    const kcfg = await getKubeconfigForEnv(env.id).catch(() => null);
    if (!kcfg || !kcfg.ok) {
      out.push({
        namespace: env.namespace || "default",
        envKey: env.key,
        envId: env.id,
        cloud,
        clusterReachable: false,
        note: kcfg && !kcfg.ok ? kcfg.message : "Could not load the env's kubeconfig.",
        apps: [],
      });
      continue;
    }

    try {
      const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
      const kexec = { ...execEnv, KUBECONFIG: kcfg.handle.path };

      // Every managed Deployment in the cluster, ACROSS namespaces — an env's
      // configured namespace is only its default; deploy_my_app lets the user
      // pick a different one per app, so scoping to env.namespace would miss
      // most of them.
      const deps = await runStage({
        command: "kubectl",
        args: [
          "get",
          "deployments",
          "--all-namespaces",
          "-l",
          "app.kubernetes.io/managed-by=deepagent",
          "-o",
          "json",
        ],
        cwd: process.cwd(),
        env: kexec,
        timeoutMs: 45_000,
        // Cluster-wide deployment JSON runs to tens/hundreds of KB — annotations,
        // pod-template specs and imagePullSecrets add up fast. runStage's default
        // 32 KB cap truncated mid-string on an ECR image URL like
        // `…dkr.ecr.us-east-1.amazonaws.com/dynamic-app:latest`, so JSON.parse
        // failed with "Unexpected token 'a', \"aws.com/dy\"... is not valid JSON"
        // and every namespace in the daily report showed "Cluster unreachable".
        // Same 4 MB cap the Prometheus report call already uses.
        maxBufferBytes: 4 * 1024 * 1024,
      });

      if (deps.exitCode !== 0) {
        out.push({
          namespace: env.namespace || "default",
          envKey: env.key,
          envId: env.id,
          cloud,
          clusterReachable: false,
          note: `kubectl failed: ${deps.stderr.slice(-200)}`,
          apps: [],
        });
        continue;
      }

      type Dep = {
        metadata?: { name?: string; namespace?: string };
        spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } };
        status?: {
          readyReplicas?: number;
          conditions?: Array<{ type?: string; lastUpdateTime?: string }>;
        };
      };
      const parsed = JSON.parse(deps.stdout) as { items?: Dep[] };

      // Pod restart counts, fetched once for the whole cluster rather than per
      // app — one API call instead of N.
      const restartsByNs = new Map<string, number>();
      const pods = await runStage({
        command: "kubectl",
        args: [
          "get",
          "pods",
          "--all-namespaces",
          "-l",
          "app.kubernetes.io/managed-by=deepagent",
          "-o",
          "json",
        ],
        cwd: process.cwd(),
        env: kexec,
        timeoutMs: 45_000,
        // Same reason as the deployments query above — pod JSON is even
        // bigger (containerStatuses per replica). Without this cap, the
        // report degraded to "Cluster unreachable" via a JSON.parse failure
        // mid-string on a truncated image URL.
        maxBufferBytes: 4 * 1024 * 1024,
      });
      if (pods.exitCode === 0) {
        type Pod = {
          metadata?: { namespace?: string; labels?: Record<string, string> };
          status?: { containerStatuses?: Array<{ restartCount?: number }> };
        };
        const podList = JSON.parse(pods.stdout) as { items?: Pod[] };
        for (const pod of podList.items ?? []) {
          const key = `${pod.metadata?.namespace}/${pod.metadata?.labels?.["app.kubernetes.io/name"] ?? ""}`;
          const n = (pod.status?.containerStatuses ?? []).reduce(
            (a, c) => a + (c.restartCount ?? 0),
            0,
          );
          restartsByNs.set(key, (restartsByNs.get(key) ?? 0) + n);
        }
      }

      // Group Deployments by their own namespace.
      const byNamespace = new Map<string, DiscoveredApp[]>();
      for (const d of parsed.items ?? []) {
        const name = d.metadata?.name;
        const ns = d.metadata?.namespace;
        if (!name || !ns) continue;
        const replicas = d.spec?.replicas ?? 0;
        const ready = d.status?.readyReplicas ?? 0;
        const images = [
          ...new Set((d.spec?.template?.spec?.containers ?? []).map((c) => c.image ?? "").filter(Boolean)),
        ];
        const lastRolloutAt = (d.status?.conditions ?? [])
          .map((c) => c.lastUpdateTime)
          .filter(Boolean)
          .sort()
          .pop();
        const app: DiscoveredApp = {
          name,
          replicas,
          readyReplicas: ready,
          images,
          restarts: restartsByNs.get(`${ns}/${name}`) ?? 0,
          lastRolloutAt,
          health: replicas > 0 && ready >= replicas ? "healthy" : "degraded",
        };
        byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), app]);
      }

      for (const [ns, apps] of byNamespace) {
        out.push({
          namespace: ns,
          envKey: env.key,
          envId: env.id,
          cloud,
          clusterReachable: true,
          apps: apps.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
    } catch (e) {
      out.push({
        namespace: env.namespace || "default",
        envKey: env.key,
        envId: env.id,
        cloud,
        clusterReachable: false,
        note: e instanceof Error ? e.message : "Unexpected error reading the cluster.",
        apps: [],
      });
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  }

  return out.sort((a, b) => a.namespace.localeCompare(b.namespace));
}
