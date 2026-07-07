/**
 * Node operations for the Cloud Stats dashboard — make the node cards actionable
 * (not just informational): live CPU/memory, the pods running on a node, and
 * cordon / drain / uncordon for maintenance. All via `kubectl` against the env's
 * connected cluster (same creds path as apply_k8s_manifest).
 */
import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";

type NodePod = { name: string; namespace: string; status: string };
export type NodeDetail =
  | { ok: true; cpuPct?: number; memPct?: number; pods: NodePod[]; schedulable: boolean }
  | { ok: false; error: string };
export type NodeActionResult = { ok: true; message: string } | { ok: false; error: string };

/** Resolve the env's kubeconfig, run `fn` with the kubectl exec env, then clean up. */
async function withKube<T>(
  projectId: string,
  envKey: string,
  fn: (execEnv: Record<string, string>) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const env = await prisma.env.findFirst({ where: { projectId, key: envKey }, select: { id: true, cloudProviderId: true } });
  if (!env) return { ok: false, error: `Env "${envKey}" not found.` };
  const kc = await getKubeconfigForEnv(env.id);
  if (!kc.ok) return { ok: false, error: kc.message };
  try {
    const execEnv = await kubeExecEnv(kc.handle.path, env.cloudProviderId);
    return await fn(execEnv);
  } finally {
    await kc.handle.cleanup();
  }
}

export async function getNodeDetail(projectId: string, envKey: string, node: string): Promise<NodeDetail> {
  return withKube(projectId, envKey, async (execEnv): Promise<NodeDetail> => {
    // Pods scheduled on this node (all namespaces).
    const podsRes = await runStage({
      command: "kubectl",
      args: ["get", "pods", "-A", "--field-selector", `spec.nodeName=${node}`, "-o", "json"],
      cwd: process.cwd(),
      env: execEnv,
      timeoutMs: 30_000,
      maxBufferBytes: 8 * 1024 * 1024,
    });
    if (podsRes.exitCode === -1) return { ok: false, error: "`kubectl` isn't installed on the server." };
    let pods: NodePod[] = [];
    if (podsRes.exitCode === 0) {
      try {
        const d = JSON.parse(podsRes.stdout) as { items?: Array<{ metadata?: { name?: string; namespace?: string }; status?: { phase?: string } }> };
        pods = (d.items ?? []).map((p) => ({ name: p.metadata?.name ?? "?", namespace: p.metadata?.namespace ?? "?", status: p.status?.phase ?? "?" }));
      } catch {
        /* leave empty */
      }
    }

    // Schedulable? (cordoned nodes have spec.unschedulable = true)
    let schedulable = true;
    const getNode = await runStage({
      command: "kubectl",
      args: ["get", "node", node, "-o", "jsonpath={.spec.unschedulable}"],
      cwd: process.cwd(),
      env: execEnv,
      timeoutMs: 15_000,
    });
    if (getNode.exitCode === 0 && getNode.stdout.trim() === "true") schedulable = false;

    // Live CPU/memory via metrics-server (best-effort; undefined if not installed).
    let cpuPct: number | undefined;
    let memPct: number | undefined;
    const top = await runStage({
      command: "kubectl",
      args: ["top", "node", node, "--no-headers"],
      cwd: process.cwd(),
      env: execEnv,
      timeoutMs: 20_000,
    });
    if (top.exitCode === 0) {
      const pcts = top.stdout.match(/(\d+)%/g);
      if (pcts && pcts.length >= 2) {
        cpuPct = Number(pcts[0].replace("%", ""));
        memPct = Number(pcts[1].replace("%", ""));
      }
    }

    return { ok: true, cpuPct, memPct, pods, schedulable };
  });
}

export async function nodeAction(projectId: string, envKey: string, node: string, action: "cordon" | "uncordon" | "drain"): Promise<NodeActionResult> {
  const args =
    action === "cordon"
      ? ["cordon", node]
      : action === "uncordon"
        ? ["uncordon", node]
        : ["drain", node, "--ignore-daemonsets", "--delete-emptydir-data", "--force", "--timeout=120s"];

  return withKube(projectId, envKey, async (execEnv): Promise<NodeActionResult> => {
    const r = await runStage({
      command: "kubectl",
      args,
      cwd: process.cwd(),
      env: execEnv,
      timeoutMs: action === "drain" ? 180_000 : 30_000,
      maxBufferBytes: 2 * 1024 * 1024,
    });
    if (r.exitCode === -1) return { ok: false, error: "`kubectl` isn't installed on the server." };
    if (r.exitCode !== 0) return { ok: false, error: (r.stderr.trim() || r.stdout.trim() || "kubectl failed").slice(-400) };
    return { ok: true, message: (r.stdout.trim() || `${action} complete`).slice(-400) };
  });
}
