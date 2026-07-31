/**
 * Wire a Kubernetes Secret into the Deployments that need it.
 *
 * WHY THIS EXISTS (2026-07 incident):
 * The Connections page (and the chat's connect_existing_rds flow) used to stop
 * after `kubectl apply`-ing the Secret, then print "Patch your Deployment with
 * envFrom.secretRef and roll pods to pick up the DB." Users reasonably read
 * "Connected — Secret written to the cluster" as done, and the app kept failing
 * with no DATABASE_URL in the pod. Creating a Secret nothing consumes is a
 * no-op from the app's point of view — so we finish the job here.
 *
 * What it does, per Deployment in the namespace:
 *   1. Skip if it already references this Secret (idempotent, safe to re-run).
 *   2. Append `envFrom: [{ secretRef: { name } }]` to container[0].
 *      `add` on `/envFrom/-` when the array exists, otherwise create it.
 *   3. The patch itself changes the pod template, so Kubernetes rolls the pods
 *      automatically — Secret values are read at container start, not hot-
 *      reloaded, so a roll is mandatory for the env vars to appear.
 *
 * Failure of one Deployment never blocks the others; every outcome is reported
 * so the caller can surface exactly what happened.
 */
import { runStage } from "@/lib/runner/exec";

export type WireOutcome = {
  deployment: string;
  /** "patched" = envFrom added + rollout triggered. "already" = no change needed. */
  status: "patched" | "already" | "failed";
  message?: string;
};

type ContainerEnvFrom = { secretRef?: { name?: string }; configMapRef?: { name?: string } };
type DeploymentItem = {
  metadata?: { name?: string };
  spec?: { template?: { spec?: { containers?: Array<{ envFrom?: ContainerEnvFrom[] }> } } };
};

/**
 * @param kubeconfigPath path to a kubeconfig with write access to the namespace
 * @param execEnv        env vars the kubeconfig's exec plugin needs (AWS creds etc.)
 * @param namespace      namespace holding both the Secret and the Deployments
 * @param secretName     the Secret to inject
 * @param only           optional allow-list of Deployment names; default = all
 */
export async function wireSecretToWorkloads(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  secretName: string;
  only?: string[];
}): Promise<{ ok: true; outcomes: WireOutcome[] } | { ok: false; error: string }> {
  const { kubeconfigPath, execEnv, namespace, secretName, only } = args;
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };

  // 1 — List Deployments WITH their existing envFrom so we can be idempotent.
  const list = await runStage({
    command: "kubectl",
    args: ["get", "deployments", "-n", namespace, "-o", "json"],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 8 * 1024 * 1024,
  });
  if (list.exitCode !== 0) {
    return { ok: false, error: `Could not list Deployments: ${list.stderr.slice(-300)}` };
  }

  let items: DeploymentItem[] = [];
  try {
    items = (JSON.parse(list.stdout) as { items?: DeploymentItem[] }).items ?? [];
  } catch {
    return { ok: false, error: "Could not parse the Deployment list returned by kubectl." };
  }

  const targets = items.filter((d) => {
    const name = d.metadata?.name;
    if (!name) return false;
    return !only || only.includes(name);
  });
  if (targets.length === 0) {
    return {
      ok: false,
      error:
        `No Deployments found in namespace "${namespace}"` +
        (only ? ` matching ${only.join(", ")}.` : ". Deploy the app first, then connect the database."),
    };
  }

  const outcomes: WireOutcome[] = [];
  for (const d of targets) {
    const name = d.metadata!.name!;
    const existing = d.spec?.template?.spec?.containers?.[0]?.envFrom;

    // Already references the Secret — no patch needed, but the pods may still
    // predate it.
    //
    // WHY A RESTART IS STILL REQUIRED: generated manifests now declare
    // `envFrom: [app-db, app-env]` up front (both optional), so a Deployment
    // references the Secret from its very first apply — BEFORE the Secret
    // exists. Kubernetes reads Secret values at container START and never
    // hot-reloads them, so those pods run without the values and stay that way.
    // Skipping the restart here meant the panel reported "already set /
    // nothing to change" while DATABASE_URL was absent from the container —
    // the most misleading state possible.
    //
    // A patch implicitly rolls pods; "already wired" has no patch, so roll
    // explicitly.
    if (existing?.some((e) => e.secretRef?.name === secretName)) {
      const restart = await runStage({
        command: "kubectl",
        args: ["rollout", "restart", "deployment", name, "-n", namespace],
        cwd: process.cwd(),
        env,
        timeoutMs: 30_000,
      });
      outcomes.push({
        deployment: name,
        status: "already",
        message:
          restart.exitCode === 0
            ? `already references ${secretName} — rolled pods to pick up its current values`
            : `already references ${secretName}, but the restart failed: ${restart.stderr.slice(-200)}`,
      });
      continue;
    }

    // `add` to `/envFrom/-` appends when the array exists; when it does not,
    // the whole array must be created instead — JSON Patch has no upsert.
    const patch = existing
      ? [
          {
            op: "add",
            path: "/spec/template/spec/containers/0/envFrom/-",
            value: { secretRef: { name: secretName } },
          },
        ]
      : [
          {
            op: "add",
            path: "/spec/template/spec/containers/0/envFrom",
            value: [{ secretRef: { name: secretName } }],
          },
        ];

    const res = await runStage({
      command: "kubectl",
      args: ["patch", "deployment", name, "-n", namespace, "--type=json", "-p", JSON.stringify(patch)],
      cwd: process.cwd(),
      env,
      timeoutMs: 30_000,
    });
    outcomes.push(
      res.exitCode === 0
        ? { deployment: name, status: "patched", message: `envFrom += secretRef/${secretName}` }
        : { deployment: name, status: "failed", message: res.stderr.slice(-300) },
    );
  }

  return { ok: true, outcomes };
}
