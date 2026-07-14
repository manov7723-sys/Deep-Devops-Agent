/**
 * Infra topology GRAPH — reads a connected environment's cluster and builds a
 * node/edge graph so the UI can draw an interactive diagram:
 *   Ingress → Service → Deployment → Pods, plus app-to-app dependency edges
 *   (inferred from container env vars that reference another service) with the
 *   port each connection uses.
 * Uses kubectl via the env's stored kubeconfig (same path as node actions).
 */
import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";

export type NodeKind = "ingress" | "service" | "deployment" | "pod";
export type GraphStatus = "ok" | "warn" | "danger" | "default";
export type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  status: GraphStatus;
  namespace: string;
};
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: "wire" | "dependency";
};
export type Topology =
  | { ok: true; namespace: string; namespaces: string[]; nodes: GraphNode[]; edges: GraphEdge[] }
  | { ok: false; error: string };

const SYSTEM_NS = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "gmp-system",
  "gmp-public",
  "gke-managed-system",
  "calico-system",
  "tigera-operator",
  "amazon-cloudwatch",
]);
const MAX_NODES = 200;

type Port = { port?: number; targetPort?: unknown; name?: string };
type Container = {
  name?: string;
  ports?: Array<{ containerPort?: number }>;
  env?: Array<{ name?: string; value?: string }>;
};
type K8sObj = {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    selector?: Record<string, string> | { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: Container[] };
    };
    type?: string;
    ports?: Port[];
    rules?: Array<{
      host?: string;
      http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> };
    }>;
  };
  status?: {
    phase?: string;
    readyReplicas?: number;
    replicas?: number;
    containerStatuses?: Array<{ ready?: boolean }>;
  };
};

function matches(
  selector: Record<string, string> | undefined,
  labels: Record<string, string> | undefined,
): boolean {
  if (!selector || Object.keys(selector).length === 0 || !labels) return false;
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

export async function getTopology(
  projectId: string,
  envKey: string,
  nsFilter?: string,
): Promise<Topology> {
  const env = await prisma.env.findFirst({
    where: { projectId, key: envKey },
    select: { id: true, cloudProviderId: true },
  });
  if (!env) return { ok: false, error: `Env "${envKey}" not found.` };
  const scoped = (nsFilter || "").trim();
  const scopeSpecific = !!scoped && scoped !== "all";

  const kc = await getKubeconfigForEnv(env.id);
  if (!kc.ok) return { ok: false, error: kc.message };

  let items: K8sObj[];
  let allNamespaces: string[] = [];
  try {
    const execEnv = await kubeExecEnv(kc.handle.path, env.cloudProviderId);
    const nsRes = await runStage({
      command: "kubectl",
      args: ["get", "namespaces", "-o", "json"],
      cwd: process.cwd(),
      env: execEnv,
      timeoutMs: 15_000,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    if (nsRes.exitCode === 0) {
      try {
        allNamespaces = ((JSON.parse(nsRes.stdout) as { items?: K8sObj[] }).items ?? [])
          .map((n) => n.metadata?.name ?? "")
          .filter(Boolean);
      } catch {
        /* keep empty */
      }
    }
    const nsArgs = scopeSpecific ? ["-n", scoped] : ["-A"];
    const res = await runStage({
      command: "kubectl",
      args: ["get", "deployments,services,ingresses,pods", ...nsArgs, "-o", "json"],
      cwd: process.cwd(),
      env: execEnv,
      timeoutMs: 30_000,
      maxBufferBytes: 16 * 1024 * 1024,
    });
    if (res.exitCode === -1)
      return { ok: false, error: "`kubectl` isn't installed on the server." };
    if (res.exitCode !== 0)
      return { ok: false, error: (res.stderr.trim() || "kubectl get failed").slice(-300) };
    items = (JSON.parse(res.stdout) as { items?: K8sObj[] }).items ?? [];
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the cluster." };
  } finally {
    await kc.handle.cleanup();
  }

  allNamespaces.sort(
    (a, b) => (SYSTEM_NS.has(a) ? 1 : 0) - (SYSTEM_NS.has(b) ? 1 : 0) || a.localeCompare(b),
  );

  const nsOf = (o: K8sObj) => o.metadata?.namespace ?? "default";
  const inScope = (o: K8sObj) => (scopeSpecific ? nsOf(o) === scoped : !SYSTEM_NS.has(nsOf(o)));
  const deployments = items.filter((i) => i.kind === "Deployment" && inScope(i));
  const services = items.filter(
    (i) => i.kind === "Service" && inScope(i) && i.metadata?.name !== "kubernetes",
  );
  const ingresses = items.filter((i) => i.kind === "Ingress" && inScope(i));
  const pods = items.filter((i) => i.kind === "Pod" && inScope(i));

  const podStatus = (p: K8sObj): GraphStatus => {
    const ph = p.status?.phase;
    if (ph === "Running" || ph === "Succeeded") return "ok";
    if (ph === "Failed") return "danger";
    return "warn";
  };
  const portStr = (p: Port) => `${p.port ?? "?"}${p.targetPort != null ? `→${p.targetPort}` : ""}`;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const idIng = (o: K8sObj) => `ing:${nsOf(o)}/${o.metadata?.name}`;
  const idSvc = (o: K8sObj) => `svc:${nsOf(o)}/${o.metadata?.name}`;
  const idDep = (o: K8sObj) => `dep:${nsOf(o)}/${o.metadata?.name}`;
  const idPod = (o: K8sObj) => `pod:${nsOf(o)}/${o.metadata?.name}`;

  for (const ing of ingresses) {
    const hosts = [
      ...new Set((ing.spec?.rules ?? []).map((r) => r.host).filter(Boolean) as string[]),
    ];
    nodes.push({
      id: idIng(ing),
      kind: "ingress",
      label: ing.metadata?.name ?? "?",
      sub: hosts.join(", ") || "ingress",
      status: "default",
      namespace: nsOf(ing),
    });
  }
  for (const s of services) {
    nodes.push({
      id: idSvc(s),
      kind: "service",
      label: s.metadata?.name ?? "?",
      sub: `${s.spec?.type ?? "ClusterIP"} · :${(s.spec?.ports ?? []).map((p) => p.port).join(",")}`,
      status: "default",
      namespace: nsOf(s),
    });
  }
  for (const dep of deployments) {
    const ready = `${dep.status?.readyReplicas ?? 0}/${dep.status?.replicas ?? 0}`;
    const healthy =
      (dep.status?.readyReplicas ?? 0) >= (dep.status?.replicas ?? 0) &&
      (dep.status?.replicas ?? 0) > 0;
    nodes.push({
      id: idDep(dep),
      kind: "deployment",
      label: dep.metadata?.name ?? "?",
      sub: `Deployment · ${ready}`,
      status: healthy ? "ok" : "warn",
      namespace: nsOf(dep),
    });
  }
  for (const p of pods) {
    if (nodes.length >= MAX_NODES) break;
    const cs = p.status?.containerStatuses ?? [];
    nodes.push({
      id: idPod(p),
      kind: "pod",
      label: p.metadata?.name ?? "?",
      sub: `${p.status?.phase ?? "?"} · ${cs.filter((c) => c.ready).length}/${cs.length}`,
      status: podStatus(p),
      namespace: nsOf(p),
    });
  }
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Ingress → Service (by backend service name, same ns)
  for (const ing of ingresses) {
    for (const r of ing.spec?.rules ?? []) {
      for (const pth of r.http?.paths ?? []) {
        const svc = services.find(
          (s) => nsOf(s) === nsOf(ing) && s.metadata?.name === pth.backend?.service?.name,
        );
        if (svc && nodeIds.has(idSvc(svc)))
          edges.push({
            id: `${idIng(ing)}->${idSvc(svc)}`,
            source: idIng(ing),
            target: idSvc(svc),
            label: r.host,
            kind: "wire",
          });
      }
    }
  }
  // Service → Deployment (selector match) with port label, and Deployment → Pods
  const svcByNameNs = new Map(services.map((s) => [`${nsOf(s)}/${s.metadata?.name}`, s]));
  for (const dep of deployments) {
    const ns = nsOf(dep);
    const matchLabels = (dep.spec?.selector as { matchLabels?: Record<string, string> })
      ?.matchLabels;
    const tmplLabels = dep.spec?.template?.metadata?.labels;
    for (const s of services) {
      if (nsOf(s) !== ns) continue;
      if (
        matches(s.spec?.selector as Record<string, string>, tmplLabels) ||
        matches(s.spec?.selector as Record<string, string>, matchLabels)
      ) {
        const label = (s.spec?.ports ?? []).map(portStr).join(", ");
        edges.push({
          id: `${idSvc(s)}->${idDep(dep)}`,
          source: idSvc(s),
          target: idDep(dep),
          label: label ? `:${label}` : undefined,
          kind: "wire",
        });
      }
    }
    for (const p of pods) {
      if (nsOf(p) === ns && matches(matchLabels, p.metadata?.labels) && nodeIds.has(idPod(p))) {
        edges.push({
          id: `${idDep(dep)}->${idPod(p)}`,
          source: idDep(dep),
          target: idPod(p),
          kind: "wire",
        });
      }
    }
    // App dependency: this deployment's env references another service by name → edge to that service.
    const envs = (dep.spec?.template?.spec?.containers ?? []).flatMap((c) => c.env ?? []);
    const seen = new Set<string>();
    for (const e of envs) {
      const val = (e.value ?? "").toLowerCase();
      if (!val) continue;
      for (const [key, s] of svcByNameNs) {
        if (key.split("/")[0] !== ns) continue;
        const svcName = (s.metadata?.name ?? "").toLowerCase();
        if (
          svcName.length >= 2 &&
          (val === svcName ||
            val.includes(`${svcName}.`) ||
            val.includes(`//${svcName}`) ||
            val.includes(`@${svcName}`) ||
            val === `${svcName}:${(s.spec?.ports ?? [])[0]?.port ?? ""}`)
        ) {
          const eid = `${idDep(dep)}~>${idSvc(s)}`;
          if (!seen.has(eid) && s.metadata?.name !== dep.metadata?.name) {
            seen.add(eid);
            const port = (s.spec?.ports ?? [])[0]?.port;
            edges.push({
              id: eid,
              source: idDep(dep),
              target: idSvc(s),
              label: port ? `:${port}` : "uses",
              kind: "dependency",
            });
          }
        }
      }
    }
  }

  return {
    ok: true,
    namespace: scopeSpecific ? scoped : "all",
    namespaces: allNamespaces,
    nodes,
    edges,
  };
}
