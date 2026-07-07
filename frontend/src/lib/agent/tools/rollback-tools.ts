/**
 * Rollback agent tools — the MANUAL side of deployment rollback (the automatic
 * side lives in runDeploy). Let the user say "rollback my-app" in chat, or check
 * what revisions they can revert to.
 */
import type { Tool } from "./types";
import { listDeployTargets } from "@/lib/devops/deploy";
import { rollbackDeployment, rolloutHistory, type RolloutRevision } from "@/lib/devops/rollback";
import { emailProjectMembers } from "@/lib/agentops/alerts";
import { postEventToChatOps } from "@/lib/integrations/chatops";

// ── list_rollout_history ──────────────────────────────────────────────────────
export const listRolloutHistoryTool: Tool<
  { envKey: string; appName: string; namespace?: string },
  { app: string; revisions: RolloutRevision[] }
> = {
  name: "list_rollout_history",
  description:
    "List a deployed app's Kubernetes revision history (the versions you can roll back to). Use this before " +
    "rollback_deployment to show the user what's available, or to pick a specific revision to revert to.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key the app is deployed to (from list_deploy_targets)." },
      appName: { type: "string", description: "The deployed app / Deployment name." },
      namespace: { type: "string", description: "Namespace. Defaults to the env's namespace." },
    },
    required: ["envKey", "appName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await rolloutHistory(ctx.projectId, input.envKey, input.appName, input.namespace);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { app: input.appName, revisions: res.revisions } };
  },
};

// ── rollback_deployment ───────────────────────────────────────────────────────
export const rollbackDeploymentTool: Tool<
  { envKey: string; appName: string; namespace?: string; toRevision?: number },
  { rolledBack: boolean; app: string; namespace: string; message: string }
> = {
  name: "rollback_deployment",
  description:
    "Roll a deployed app back to its PREVIOUS version (or a specific revision from list_rollout_history). Use this " +
    "when the user asks to 'rollback', 'revert', or 'undo' a deploy — e.g. the new version deployed but is " +
    "misbehaving. Reverts via `kubectl rollout undo` and waits for the rollout to settle. Confirm with the user " +
    "before rolling back a production env.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key the app is deployed to (from list_deploy_targets)." },
      appName: { type: "string", description: "The deployed app / Deployment name to roll back." },
      namespace: { type: "string", description: "Namespace. Defaults to the env's namespace." },
      toRevision: { type: "number", description: "Optional specific revision to revert to (from list_rollout_history). Omit to go to the immediately previous version." },
    },
    required: ["envKey", "appName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const targets = await listDeployTargets(ctx.projectId);
    const target = targets.find((t) => t.envKey === input.envKey);
    if (!target) {
      const avail = targets.map((t) => t.envKey).join(", ") || "none";
      return { ok: false, error: `No deployable env "${input.envKey}". Available: ${avail}.` };
    }

    const res = await rollbackDeployment(ctx.projectId, input.envKey, input.appName, {
      namespace: input.namespace,
      toRevision: input.toRevision,
    });
    if (!res.ok) return { ok: false, error: res.error };

    const where = `${res.app} → ${input.envKey}`;
    const detail = input.toRevision ? `Rolled back to revision ${input.toRevision}.` : "Rolled back to the previous version.";
    await postEventToChatOps(ctx.projectId, "↩️", `Rolled back ${where}`, detail).catch(() => {});
    await emailProjectMembers(ctx.projectId, `↩️ Rolled back — ${where}`, `"${res.app}" in ${input.envKey} was rolled back.\n\n${detail}`).catch(() => {});

    return { ok: true, output: { rolledBack: true, app: res.app, namespace: res.namespace, message: res.message } };
  },
};
