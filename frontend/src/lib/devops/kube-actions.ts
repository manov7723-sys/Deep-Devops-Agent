/**
 * Shared kubectl action helpers — run write-actions (scale, restart, rollout
 * undo) against a project env's connected cluster using its stored kubeconfig.
 * Used by the Workloads console, the Deployments page, and rollback.
 */
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { sanitizeAppName } from "./deploy-manifest";

export type KubeRun = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Resolve the env's kubeconfig, hand a `run(args)` closure to `fn`, then clean up. */
export async function withKubectl<T>(
  projectId: string,
  envKey: string,
  fn: (run: KubeRun, namespace: string) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const env = await prisma.env.findFirst({
    where: { projectId, key: envKey },
    select: { id: true, namespace: true, cloudProviderId: true },
  });
  if (!env) return { ok: false, error: `Env "${envKey}" not found in this project.` };

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) return { ok: false, error: `${kcfg.message} Connect a cluster for env "${envKey}" on the Clusters page first.` };

  try {
    const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
    // Raise the output cap: `kubectl get deployments -A -o json` across all
    // namespaces (incl. kube-system) easily exceeds the small default buffer, and
    // a truncated tail makes the JSON unparseable → "0 deployments" false negative.
    const run: KubeRun = (args) => runStage({ command: "kubectl", args, cwd: tmpdir(), env: execEnv, timeoutMs: 120_000, maxBufferBytes: 8 * 1024 * 1024 });
    const value = await fn(run, (env.namespace || "default").trim());
    return { ok: true, value };
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}

/** Scale a Deployment to `replicas`. */
export async function scaleDeployment(
  projectId: string,
  envKey: string,
  appName: string,
  replicas: number,
  namespace?: string,
): Promise<{ ok: true; app: string; replicas: number } | { ok: false; error: string }> {
  const app = sanitizeAppName(appName);
  const n = Math.max(0, Math.min(50, Math.floor(replicas)));
  const wrapped = await withKubectl(projectId, envKey, async (run, defaultNs) => {
    const ns = (namespace || defaultNs).trim();
    const res = await run(["scale", `deployment/${app}`, `--replicas=${n}`, "-n", ns]);
    if (res.exitCode !== 0) throw new Error(res.stderr.slice(-400) || res.stdout.slice(-400) || "scale failed");
    return n;
  });
  if (!wrapped.ok) return wrapped;
  return { ok: true, app, replicas: wrapped.value };
}

/** Restart a Deployment (rolling restart — recreates all its pods). */
export async function restartDeployment(
  projectId: string,
  envKey: string,
  appName: string,
  namespace?: string,
): Promise<{ ok: true; app: string } | { ok: false; error: string }> {
  const app = sanitizeAppName(appName);
  const wrapped = await withKubectl(projectId, envKey, async (run, defaultNs) => {
    const ns = (namespace || defaultNs).trim();
    const res = await run(["rollout", "restart", `deployment/${app}`, "-n", ns]);
    if (res.exitCode !== 0) throw new Error(res.stderr.slice(-400) || res.stdout.slice(-400) || "restart failed");
    return true;
  });
  if (!wrapped.ok) return wrapped;
  return { ok: true, app };
}
