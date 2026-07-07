/**
 * Workloads console data — list the Deployments in an env's namespace with their
 * pods, so the UI can show ready counts and offer scale / restart / logs. Reuses
 * the read-only k8s tools; scale/restart live in kube-actions.ts.
 */
import { listKubernetesResourcesTool } from "@/lib/agent/tools/list-kubernetes-resources";

export type WorkloadPod = { name: string; status: string; ready: string };
export type Workload = { name: string; ready: number; desired: number; pods: WorkloadPod[] };

export async function listWorkloads(
  projectId: string,
  userId: string,
  envKey: string,
  namespace?: string,
): Promise<{ ok: true; namespace: string; workloads: Workload[] } | { ok: false; error: string }> {
  const ctx = { projectId, userId };
  const depRes = await listKubernetesResourcesTool.execute({ envKey, kind: "deployments", namespace }, ctx);
  if (!depRes.ok) return { ok: false, error: depRes.error };
  const ns = depRes.output.namespace;

  const podRes = await listKubernetesResourcesTool.execute({ envKey, kind: "pods", namespace: ns }, ctx);
  const allPods = podRes.ok ? podRes.output.items : [];

  const workloads: Workload[] = depRes.output.items.map((d) => {
    const [r, t] = (d.ready ?? "0/0").split("/").map((n) => Number(n) || 0);
    const pods = allPods
      .filter((p) => p.name.startsWith(`${d.name}-`))
      .map((p) => ({ name: p.name, status: p.status ?? "—", ready: p.ready ?? "—" }));
    return { name: d.name, ready: r, desired: t, pods };
  });

  return { ok: true, namespace: ns, workloads };
}
