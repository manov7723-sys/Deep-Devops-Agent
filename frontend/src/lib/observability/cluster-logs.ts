/**
 * In-app Kubernetes logs — list namespaces/pods and read pod logs THROUGH the
 * cluster connection (server-side kubectl with the env's stored kubeconfig).
 * Nothing is exposed publicly and the user never touches a terminal.
 *
 * Listing uses compact jsonpath projections (NOT `-o json`) because the runner
 * caps captured stdout at 32KB — full JSON would truncate to garbage. Log output
 * naturally keeps the most-recent 32KB, which is exactly what a log view wants.
 */
import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";

type Run =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string };

async function runKubectl(envId: string, args: string[], timeoutMs = 20_000): Promise<Run> {
  const env = await prisma.env.findUnique({ where: { id: envId }, select: { cloudProviderId: true } });
  const kcfg = await getKubeconfigForEnv(envId);
  if (!kcfg.ok) return { ok: false, error: kcfg.message };
  try {
    const childEnv = await kubeExecEnv(kcfg.handle.path, env?.cloudProviderId ?? null);
    const res = await runStage({ command: "kubectl", args, cwd: process.cwd(), env: childEnv, timeoutMs });
    if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
      return { ok: false, error: "`kubectl` isn't installed on the server." };
    }
    return { ok: true, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  } finally {
    await kcfg.handle.cleanup();
  }
}

export type NamespaceList = { ok: true; namespaces: string[] } | { ok: false; error: string };

/** List namespaces in the env's cluster (for the namespace picker). */
export async function listNamespaces(envId: string): Promise<NamespaceList> {
  const res = await runKubectl(envId, ["get", "namespaces", "-o", 'jsonpath={range .items[*]}{.metadata.name}{";"}{end}']);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.exitCode !== 0) return { ok: false, error: res.stderr.slice(-300) || "Could not list namespaces." };
  const namespaces = res.stdout.split(";").map((s) => s.trim()).filter(Boolean).sort();
  return { ok: true, namespaces };
}

export type PodInfo = { name: string; phase: string; ready: boolean; restarts: number };
export type PodList = { ok: true; pods: PodInfo[] } | { ok: false; error: string };

/** List pods in a namespace with phase + readiness + restart count. */
export async function listPods(envId: string, namespace: string): Promise<PodList> {
  const tmpl =
    '{range .items[*]}{.metadata.name}{"~"}{.status.phase}{"~"}' +
    '{range .status.containerStatuses[*]}{.ready}{","}{end}{"~"}' +
    '{range .status.containerStatuses[*]}{.restartCount}{","}{end}{";"}{end}';
  const res = await runKubectl(envId, ["get", "pods", "-n", namespace, "-o", `jsonpath=${tmpl}`]);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.exitCode !== 0) return { ok: false, error: res.stderr.slice(-300) || "Could not list pods." };

  const pods: PodInfo[] = res.stdout
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [name = rec, phase = "", readyCsv = "", restartCsv = ""] = rec.split("~");
      const readies = readyCsv.split(",").filter(Boolean);
      const ready = readies.length > 0 && readies.every((r) => r === "true");
      const restarts = restartCsv.split(",").filter(Boolean).reduce((a, n) => a + (Number(n) || 0), 0);
      return { name, phase, ready, restarts };
    });
  return { ok: true, pods };
}

export type PodLogs = { ok: true; logs: string; truncated: boolean } | { ok: false; error: string };

/** Read a pod's logs. runStage keeps the most-recent 32KB, so output is the tail. */
export async function podLogs(
  envId: string,
  namespace: string,
  pod: string,
  opts?: { container?: string; tail?: number; previous?: boolean },
): Promise<PodLogs> {
  const tail = Math.min(Math.max(opts?.tail ?? 500, 1), 5000);
  const args = ["logs", pod, "-n", namespace, `--tail=${tail}`, "--timestamps"];
  if (opts?.container) args.push("-c", opts.container);
  if (opts?.previous) args.push("--previous");

  const res = await runKubectl(envId, args, 25_000);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.exitCode !== 0) return { ok: false, error: res.stderr.slice(-400) || "kubectl logs failed." };
  // 32KB cap in runStage means very chatty pods are truncated to the latest tail.
  const truncated = res.stdout.length >= 32 * 1024 - 1;
  return { ok: true, logs: res.stdout, truncated };
}
