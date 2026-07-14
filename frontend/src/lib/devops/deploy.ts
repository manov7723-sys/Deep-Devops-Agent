/**
 * Deploy-My-App orchestration (server-side).
 *
 * Composes existing building blocks to take a container image → running on a
 * connected cluster:
 *   • listDeployTargets — the project's envs that have a cluster wired.
 *   • prefillFromRepo   — detect the repo's stack to suggest app name + port.
 *   • runDeploy         — build the manifest and apply it to the env's cluster.
 *   • deployStatus      — poll the Deployment/Pods to report rollout health.
 *
 * NOTE: image build+push is NOT done here — images come from the CI→registry
 * flow (Automation → Push to registry). This takes an image reference and runs
 * it on the cluster.
 */
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db/prisma";
import { listEnvs } from "@/lib/devops/envs";
import { detectRepoStack, resolveAttachedRepo } from "@/lib/automation/repo-analyze";
import { applyK8sManifestTool } from "@/lib/agent/tools/apply-k8s-manifest";
import { listKubernetesResourcesTool } from "@/lib/agent/tools/list-kubernetes-resources";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import { setRepoActionsSecret } from "@/lib/github/secrets";
import { recordActivity } from "@/lib/agentops/activity";
import { emailProjectMembers } from "@/lib/agentops/alerts";
import { postEventToChatOps } from "@/lib/integrations/chatops";
import { buildDeployManifest, sanitizeAppName, type DeploySpec } from "./deploy-manifest";
import { rollbackDeployment } from "./rollback";
import { recordDeployment } from "./deploy-history";
import { registerWatch } from "./deploy-watch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DeployTarget = {
  envId: string;
  envKey: string;
  name: string;
  namespace: string;
  cloudKind: string | null;
  isProduction: boolean;
};

/** Envs with a stored kubeconfig — the ones we can actually deploy to. */
export async function listDeployTargets(projectId: string): Promise<DeployTarget[]> {
  const envs = await listEnvs(projectId);
  return envs
    .filter((e) => e.hasKubeconfig)
    .map((e) => ({
      envId: e.id,
      envKey: e.key,
      name: e.name,
      namespace: e.namespace,
      cloudKind: e.cloudKind,
      isProduction: e.isProduction,
    }));
}

export type DeployPrefill = {
  appName: string;
  containerPort: number;
  stackTitle: string | null;
  reasoning: string | null;
  hasDockerfile: boolean;
};

/**
 * Best-effort suggestions from the repo. Uses stack detection (LLM) but never
 * fails the flow — if detection is unavailable, returns sensible defaults so the
 * wizard still works.
 */
export async function prefillFromRepo(
  projectId: string,
  repoFullName: string,
): Promise<DeployPrefill> {
  const appName = sanitizeAppName(repoFullName.split("/")[1] || repoFullName);
  const fallback: DeployPrefill = {
    appName,
    containerPort: 8080,
    stackTitle: null,
    reasoning: null,
    hasDockerfile: false,
  };
  try {
    const d = await detectRepoStack(projectId, repoFullName);
    if (!d.ok) return fallback;
    const rawPort = (d.params as { port?: unknown }).port;
    const port = typeof rawPort === "number" ? rawPort : Number(rawPort);
    return {
      appName,
      containerPort: Number.isFinite(port) && port > 0 ? port : 8080,
      stackTitle: d.stackTitle ?? null,
      reasoning: d.reasoning ?? null,
      hasDockerfile: !!d.existingDockerfile,
    };
  } catch {
    return fallback;
  }
}

export type DeployResult =
  | {
      ok: true;
      applied: boolean;
      dryRun: boolean;
      resources: string[];
      command: string;
      stdout: string;
      stderr: string;
      healthy?: boolean;
    }
  | { ok: false; error: string; rolledBack?: boolean };

/** Poll the rollout until healthy or the timeout elapses. Returns whether it went healthy. */
async function waitForHealthy(
  ctx: { projectId: string; userId: string },
  envKey: string,
  appName: string,
  namespace: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(6_000);
    const st = await deployStatus(ctx, { envKey }, appName, namespace);
    if (st.ok && st.found && st.healthy) return true;
  }
  return false;
}

/** Build the manifest and apply it to the target env's cluster. */
export async function runDeploy(
  ctx: { projectId: string; userId: string },
  target: { envKey: string; envId: string; namespace: string },
  spec: DeploySpec,
  opts?: {
    dryRun?: boolean;
    autoRollback?: boolean;
    healthTimeoutMs?: number;
    source?: "manual" | "scheduled" | "agent";
  },
): Promise<DeployResult> {
  const source = opts?.source ?? "manual";
  const { yaml, resources } = buildDeployManifest(spec);
  const res = await applyK8sManifestTool.execute(
    { envKey: target.envKey, manifest: yaml, namespace: spec.namespace, dryRun: !!opts?.dryRun },
    { projectId: ctx.projectId, userId: ctx.userId },
  );
  const app = sanitizeAppName(spec.appName);
  if (!res.ok) return { ok: false, error: res.error };
  const out = res.output;
  if (out.exitCode !== 0) {
    const errText = (out.stderr || out.stdout || "kubectl apply failed").slice(-500);
    // Notify on failure too (email + ChatOps), unless it was a dry-run.
    if (!opts?.dryRun) {
      await postEventToChatOps(
        ctx.projectId,
        "❌",
        `Deploy failed — ${app} → ${target.envKey}`,
        errText,
      ).catch(() => {});
      await emailProjectMembers(
        ctx.projectId,
        `❌ Deploy failed — ${app} → ${target.envKey}`,
        `The deploy of "${app}" to ${target.envKey} failed:\n\n${errText}`,
      ).catch(() => {});
      await recordDeployment(ctx.projectId, ctx.userId, target, spec, "failed", errText, source);
    }
    return { ok: false, error: errText };
  }

  if (opts?.dryRun) {
    return {
      ok: true,
      applied: out.applied,
      dryRun: out.dryRun,
      resources,
      command: out.command,
      stdout: out.stdout,
      stderr: out.stderr,
    };
  }

  await recordActivity({
    projectId: ctx.projectId,
    actorUserId: ctx.userId,
    action: "deployed",
    targetType: "deployment",
    targetLabel: `${app} → ${target.envKey}`,
    icon: "rocket",
    envId: target.envId,
  }).catch(() => {});
  const summary = `image: ${spec.image} · ${spec.replicas} replica${spec.replicas === 1 ? "" : "s"} · ${resources.join(" + ")}`;

  // AUTO-ROLLBACK (on by default): watch the new rollout; if it doesn't become
  // healthy in time, revert to the last known-good revision and notify — so a bad
  // deploy self-heals instead of leaving the app down.
  if (opts?.autoRollback !== false) {
    const healthy = await waitForHealthy(
      ctx,
      target.envKey,
      app,
      spec.namespace,
      opts?.healthTimeoutMs ?? 120_000,
    );
    if (!healthy) {
      const rb = await rollbackDeployment(ctx.projectId, target.envKey, app, {
        namespace: spec.namespace,
      });
      if (rb.ok) {
        const note = `The deploy of "${app}" to ${target.envKey} didn't become healthy in time, so it was AUTOMATICALLY ROLLED BACK to the previous version. Image attempted: ${spec.image}.`;
        await postEventToChatOps(
          ctx.projectId,
          "↩️",
          `Auto-rolled back ${app} → ${target.envKey}`,
          note,
        ).catch(() => {});
        await emailProjectMembers(
          ctx.projectId,
          `↩️ Auto-rolled back — ${app} → ${target.envKey}`,
          note,
        ).catch(() => {});
        await recordDeployment(
          ctx.projectId,
          ctx.userId,
          target,
          spec,
          "rolled_back",
          note,
          source,
        );
        return {
          ok: false,
          error: `"${app}" failed to become healthy and was automatically rolled back to the previous version.`,
          rolledBack: true,
        };
      }
      // Couldn't roll back — most likely the FIRST deploy (no previous revision).
      const note = `The deploy of "${app}" to ${target.envKey} didn't become healthy and could NOT be auto-rolled back (${rb.error}). The app has no previous good version to revert to — check the pod logs (image pull, wrong port, or a missing env var).`;
      await postEventToChatOps(
        ctx.projectId,
        "⚠️",
        `Deploy unhealthy — ${app} → ${target.envKey}`,
        note,
      ).catch(() => {});
      await emailProjectMembers(
        ctx.projectId,
        `⚠️ Deploy unhealthy — ${app} → ${target.envKey}`,
        note,
      ).catch(() => {});
      await recordDeployment(ctx.projectId, ctx.userId, target, spec, "failed", note, source);
      return { ok: false, error: note, rolledBack: false };
    }
  }

  // Healthy (or auto-rollback disabled) → report success to the team's channel.
  await postEventToChatOps(
    ctx.projectId,
    "🚀",
    `Deployed ${app} → ${target.envKey}`,
    summary,
  ).catch(() => {});
  await emailProjectMembers(
    ctx.projectId,
    `✅ Deployed ${app} → ${target.envKey}`,
    `"${app}" was deployed to ${target.envKey}.\n\n${summary}\n\nNamespace: ${spec.namespace}`,
  ).catch(() => {});
  await recordDeployment(ctx.projectId, ctx.userId, target, spec, "succeeded", summary, source);
  // Keep watching this app — the watchdog auto-rolls-back if it fails LATER.
  await registerWatch(ctx.projectId, ctx.userId, target.envKey, spec.appName, spec.namespace);

  return {
    ok: true,
    applied: out.applied,
    dryRun: out.dryRun,
    resources,
    command: out.command,
    stdout: out.stdout,
    stderr: out.stderr,
    healthy: true,
  };
}

/**
 * Push the env's kubeconfig to the repo as the `KUBECONFIG_B64` Actions secret,
 * so the generated CD workflow can reach the cluster with no manual setup.
 * The kubeconfig is base64 of the same config the app uses server-side (GKE
 * tokens are refreshed first). Note: for exec-plugin kubeconfigs (GKE/EKS) the
 * embedded token can expire — re-run to refresh, or use server-side deploy_app.
 */
export async function setEnvKubeconfigSecret(
  projectId: string,
  repoFullName: string,
  envKey: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const repo = await resolveAttachedRepo(projectId, repoFullName);
  if (!repo.ok) return { ok: false, error: repo.error };

  const env = await prisma.env.findFirst({
    where: { projectId, key: envKey },
    select: { id: true },
  });
  if (!env) return { ok: false, error: `Env "${envKey}" not found in this project.` };

  const kc = await getKubeconfigForEnv(env.id);
  if (!kc.ok) return { ok: false, error: kc.message };
  try {
    const content = await readFile(kc.handle.path, "utf8");
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const res = await setRepoActionsSecret(
      repo.repo.accessToken,
      repoFullName,
      "KUBECONFIG_B64",
      b64,
    );
    return res.ok ? { ok: true, secret: "KUBECONFIG_B64" } : { ok: false, error: res.error };
  } finally {
    await kc.handle.cleanup();
  }
}

export type RolloutStatus =
  | {
      ok: true;
      found: boolean;
      ready: string; // "X/Y"
      healthy: boolean;
      pods: Array<{ name: string; status: string; ready: string }>;
    }
  | { ok: false; error: string };

/** Poll the Deployment + its Pods to report rollout health. */
export async function deployStatus(
  ctx: { projectId: string; userId: string },
  target: { envKey: string },
  appName: string,
  namespace: string,
): Promise<RolloutStatus> {
  const app = sanitizeAppName(appName);
  const depRes = await listKubernetesResourcesTool.execute(
    { envKey: target.envKey, kind: "deployments", namespace },
    { projectId: ctx.projectId, userId: ctx.userId },
  );
  if (!depRes.ok) return { ok: false, error: depRes.error };
  const dep = depRes.output.items.find((i) => i.name === app);

  const podRes = await listKubernetesResourcesTool.execute(
    { envKey: target.envKey, kind: "pods", namespace },
    { projectId: ctx.projectId, userId: ctx.userId },
  );
  const pods = (podRes.ok ? podRes.output.items : [])
    .filter((p) => p.name.startsWith(`${app}-`))
    .map((p) => ({ name: p.name, status: p.status ?? "—", ready: p.ready ?? "—" }));

  if (!dep) return { ok: true, found: false, ready: "0/0", healthy: false, pods };

  const ready = dep.ready ?? "0/0";
  const [r, t] = ready.split("/").map((n) => Number(n) || 0);
  const healthy = t > 0 && r >= t;
  return { ok: true, found: true, ready, healthy, pods };
}
