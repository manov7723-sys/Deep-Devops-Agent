/**
 * Scheduled-deployment agent tools — the "deploy later" side of Deploy-My-App.
 * When the user asks to deploy at a specific time (or "in N hours"), the agent
 * saves a ScheduledDeploy instead of deploying now; the background scheduler runs
 * it at runAt via the same runDeploy path (which emails + posts to ChatOps).
 */
import type { Tool } from "./types";
import { listDeployTargets } from "@/lib/devops/deploy";
import { sanitizeAppName } from "@/lib/devops/deploy-manifest";
import {
  scheduleDeploy,
  listScheduledDeploys,
  cancelScheduledDeploy,
} from "@/lib/devops/scheduled-deploy";

/** Resolve the requested run time from either an ISO timestamp or a relative delay. Must be in the future. */
function resolveRunAt(
  runAtISO?: string,
  delayMinutes?: number,
): { runAt: Date } | { error: string } {
  const now = Date.now();
  if (typeof delayMinutes === "number" && delayMinutes > 0) {
    return { runAt: new Date(now + delayMinutes * 60_000) };
  }
  if (runAtISO?.trim()) {
    const t = new Date(runAtISO.trim());
    if (Number.isNaN(t.getTime()))
      return {
        error: `Couldn't parse the time "${runAtISO}". Use an ISO 8601 timestamp or delayMinutes.`,
      };
    if (t.getTime() <= now + 30_000) return { error: "The scheduled time must be in the future." };
    return { runAt: t };
  }
  return {
    error: "Provide either runAtISO (an ISO 8601 timestamp) or delayMinutes (minutes from now).",
  };
}

// ── schedule_deployment ───────────────────────────────────────────────────────
type ScheduleInput = {
  envKey: string;
  appName: string;
  image: string;
  runAtISO?: string;
  delayMinutes?: number;
  containerPort?: number;
  replicas?: number;
  env?: Array<{ key: string; value: string }>;
  expose?: boolean;
  host?: string;
  namespace?: string;
};

export const scheduleDeploymentTool: Tool<
  ScheduleInput,
  {
    id: string;
    appName: string;
    envKey: string;
    runAt: string;
    message: string;
  }
> = {
  name: "schedule_deployment",
  description:
    "Schedule a deployment to run LATER instead of now. Use this when the user answers 'schedule' (not 'deploy now') " +
    "and gives a time. Saves the full deploy spec; the background scheduler runs it at the given time via the same " +
    "deploy path as deploy_app, and emails + notifies the team on success/failure. Provide the time as EITHER " +
    "runAtISO (ISO 8601, e.g. '2026-07-02T21:00:00') OR delayMinutes (e.g. 120 for two hours from now). Pass the " +
    "same envKey/appName/image/port/env you'd pass to deploy_app. List targets with list_deploy_targets and pick " +
    "the image with list_registry_images first.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env key whose cluster to deploy to (from list_deploy_targets).",
      },
      appName: {
        type: "string",
        description: "App / resource name (lowercase DNS label, e.g. 'my-app').",
      },
      image: {
        type: "string",
        description:
          "Full image reference, e.g. 'registry/my-app:tag' (from list_registry_images).",
      },
      runAtISO: {
        type: "string",
        description:
          "When to run, as an ISO 8601 timestamp (e.g. '2026-07-02T21:00:00'). Use this OR delayMinutes.",
      },
      delayMinutes: {
        type: "number",
        description: "Minutes from now to run (e.g. 120 = in two hours). Use this OR runAtISO.",
      },
      containerPort: { type: "number", description: "Port the app listens on. Default 8080." },
      replicas: { type: "number", description: "Number of replicas. Default 1." },
      env: {
        type: "array",
        description: "Environment variables for the container.",
        items: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      expose: { type: "boolean", description: "Expose publicly via an Ingress (requires host)." },
      host: { type: "string", description: "Public host for the Ingress, e.g. 'app.example.com'." },
      namespace: {
        type: "string",
        description: "Target namespace. Defaults to the env's namespace.",
      },
    },
    required: ["envKey", "appName", "image"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!input.image?.trim()) return { ok: false, error: "An image reference is required." };
    if (input.expose && !(input.host || "").trim())
      return { ok: false, error: "A host is required to expose the app publicly." };

    const targets = await listDeployTargets(ctx.projectId);
    const target = targets.find((t) => t.envKey === input.envKey);
    if (!target) {
      const avail = targets.map((t) => t.envKey).join(", ") || "none";
      return {
        ok: false,
        error: `No deployable env "${input.envKey}". Connect a cluster first. Available: ${avail}.`,
      };
    }

    const when = resolveRunAt(input.runAtISO, input.delayMinutes);
    if ("error" in when) return { ok: false, error: when.error };

    const sd = await scheduleDeploy(
      ctx.projectId,
      ctx.userId,
      {
        envKey: target.envKey,
        appName: input.appName,
        image: input.image,
        containerPort: input.containerPort,
        replicas: input.replicas,
        env: input.env,
        expose: input.expose,
        host: input.host,
        namespace: (input.namespace || "").trim() || target.namespace,
      },
      when.runAt,
    );

    return {
      ok: true,
      output: {
        id: sd.id,
        appName: sanitizeAppName(input.appName),
        envKey: target.envKey,
        runAt: sd.runAt.toISOString(),
        message: `Scheduled for ${sd.runAt.toISOString()} and submitted for APPROVAL. It will run at that time ONLY after a human approves it on the Approvals page (a rejection cancels it). Tell the user it's pending approval — don't say it's confirmed to run yet.`,
      },
    };
  },
};

// ── list_scheduled_deployments ────────────────────────────────────────────────
export const listScheduledDeploymentsTool: Tool<
  Record<string, never>,
  {
    scheduled: Array<{
      id: string;
      appName: string;
      envKey: string;
      image: string;
      runAt: string;
      status: string;
      result: string | null;
    }>;
  }
> = {
  name: "list_scheduled_deployments",
  description:
    "List this project's scheduled deployments (pending, running, done, failed, or cancelled) with their run times. " +
    "Use this to show the user what's queued, or to find the id to cancel.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const rows = await listScheduledDeploys(ctx.projectId);
    return {
      ok: true,
      output: {
        scheduled: rows.map((r) => ({
          id: r.id,
          appName: r.appName,
          envKey: r.envKey,
          image: r.image,
          runAt: r.runAt.toISOString(),
          status: r.status,
          result: r.result,
        })),
      },
    };
  },
};

// ── cancel_scheduled_deployment ───────────────────────────────────────────────
export const cancelScheduledDeploymentTool: Tool<{ id: string }, { cancelled: boolean }> = {
  name: "cancel_scheduled_deployment",
  description:
    "Cancel a pending scheduled deployment by its id (from list_scheduled_deployments). Only works while it's still " +
    "pending — a deploy that already started or finished can't be cancelled.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The scheduled deployment id to cancel." } },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const ok = await cancelScheduledDeploy(ctx.projectId, input.id);
    if (!ok)
      return {
        ok: false,
        error:
          "No pending scheduled deployment with that id (it may have already run or been cancelled).",
      };
    return { ok: true, output: { cancelled: true } };
  },
};
