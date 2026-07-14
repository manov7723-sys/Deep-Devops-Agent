/**
 * Deployment rollback — revert a Deployment to its previous (last known-good)
 * revision via `kubectl rollout undo`. Used two ways:
 *   • MANUAL  — the user asks "rollback my-app" (agent tool / UI button).
 *   • AUTO    — runDeploy watches the new rollout; if it doesn't go healthy in
 *               time, it calls this to self-heal, then notifies the team.
 * Kubernetes keeps the Deployment's revision history, so the revert is just
 * `kubectl rollout undo` (optionally to a specific --to-revision).
 */
import { sanitizeAppName } from "./deploy-manifest";
import { withKubectl } from "./kube-actions";

export type RolloutRevision = { revision: number; changeCause: string };

/** List a Deployment's revision history (newest last), so the user can see what they'd revert to. */
export async function rolloutHistory(
  projectId: string,
  envKey: string,
  appName: string,
  namespace?: string,
): Promise<{ ok: true; revisions: RolloutRevision[] } | { ok: false; error: string }> {
  const app = sanitizeAppName(appName);
  const wrapped = await withKubectl(projectId, envKey, async (run, defaultNs) => {
    const ns = (namespace || defaultNs).trim();
    const res = await run(["rollout", "history", `deployment/${app}`, "-n", ns]);
    if (res.exitCode !== 0)
      throw new Error(res.stderr.slice(-500) || res.stdout.slice(-500) || "rollout history failed");
    // Output is a table: "REVISION  CHANGE-CAUSE\n1  <none>\n2  ...".
    const revisions: RolloutRevision[] = [];
    for (const line of res.stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) revisions.push({ revision: Number(m[1]), changeCause: m[2].trim() || "<none>" });
    }
    return revisions;
  });
  if (!wrapped.ok) return wrapped;
  return { ok: true, revisions: wrapped.value };
}

/**
 * Roll a Deployment back to its previous revision (or a specific one).
 * Returns kubectl's confirmation line.
 */
export async function rollbackDeployment(
  projectId: string,
  envKey: string,
  appName: string,
  opts?: { namespace?: string; toRevision?: number },
): Promise<
  { ok: true; message: string; namespace: string; app: string } | { ok: false; error: string }
> {
  const app = sanitizeAppName(appName);
  const wrapped = await withKubectl(projectId, envKey, async (run, defaultNs) => {
    const ns = (opts?.namespace || defaultNs).trim();
    const args = ["rollout", "undo", `deployment/${app}`, "-n", ns];
    if (opts?.toRevision && opts.toRevision > 0) args.push(`--to-revision=${opts.toRevision}`);
    const res = await run(args);
    if (res.exitCode !== 0) {
      const err = res.stderr.slice(-500) || res.stdout.slice(-500) || "rollout undo failed";
      throw new Error(err);
    }
    // Wait for the reverted rollout to settle so callers can trust "rolled back".
    await run(["rollout", "status", `deployment/${app}`, "-n", ns, "--timeout=120s"]);
    return { message: (res.stdout || "rolled back").trim().slice(-300), ns };
  });
  if (!wrapped.ok) return wrapped;
  return { ok: true, message: wrapped.value.message, namespace: wrapped.value.ns, app };
}
