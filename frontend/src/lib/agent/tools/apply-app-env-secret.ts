import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { applyAppSecret, parseEnvText } from "@/lib/devops/app-secrets";
import { wireSecretToWorkloads } from "@/lib/devops/wire-secret-to-workloads";
import type { Tool } from "./types";

/**
 * apply_app_env_secret — write an app's configuration secrets into a
 * namespace and roll the Deployments that reference them.
 *
 * WHY THIS EXISTS:
 * Most deploys eventually fail their readiness probe because the container
 * starts up with no `APP_SECRET_KEY` / `JWT_SIGNING_KEY` / third-party API
 * key and either crashes or 500s on the first request. The old flow required
 * the user to navigate to the Connections page and paste the `.env` into a
 * UI panel; from the agent's perspective the deploy just "failed rollout"
 * and it had no way to fix it. This tool exposes the same functionality as a
 * callable, so the agent can react to a failed rollout by asking the user
 * once for the `.env` in chat, apply it, and let Kubernetes roll the pods
 * — no leaving the chat.
 *
 * Server-side pipeline (same as /api/v1/projects/[slug]/app-secrets):
 *   1. Parse `.env`-style text (comments, blanks, quoted values, export
 *      prefix all handled by parseEnvText).
 *   2. Apply as an Opaque Kubernetes Secret via `kubectl apply`.
 *   3. Wire the Secret into every Deployment in the namespace via
 *      envFrom.secretRef — idempotent, and rolls pods when a patch is
 *      needed (already-wired Deployments get rolled explicitly, otherwise
 *      new Secret values are never picked up).
 *
 * Every value stays server-side. The .env text is never persisted anywhere
 * but the cluster Secret.
 */
export const applyAppEnvSecretTool: Tool<
  {
    envKey: string;
    namespace: string;
    envText: string;
    secretName?: string;
  },
  {
    secretName: string;
    namespace: string;
    keysWritten: string[];
    skippedLines: string[];
    wired: Array<{ deployment: string; status: "patched" | "already" | "failed"; message?: string }>;
    note: string;
  }
> = {
  name: "apply_app_env_secret",
  description:
    "Write the app's configuration secrets (signing keys, API keys, connection strings) into a namespace as a Kubernetes Secret and roll the namespace's Deployments so running pods pick them up. Call this after a deploy's readiness probe fails on missing environment variables. Ask the user ONCE for their `.env`-style text (KEY=value per line — comments, blanks, quoted values all fine). Never mention Connections page / kubectl / GitHub Settings — this tool IS the fix. Idempotent; a second call with the same text is a no-op that still rolls pods so they get fresh Secret values.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env whose cluster to write the Secret on (from list_deploy_targets).",
      },
      namespace: {
        type: "string",
        description:
          "Namespace to hold the Secret. Use the same namespace deploy_my_app used — the Secret must live where the Deployments live for envFrom to see it.",
      },
      envText: {
        type: "string",
        description:
          "The literal `.env`-style text the user pasted: `KEY=value` per line. Comments (#) and blanks are ignored; matching surrounding quotes are stripped. Multi-line values aren't supported. Pass EXACTLY what the user gave — don't reformat.",
      },
      secretName: {
        type: "string",
        description: "K8s Secret name. Defaults to 'app-env'. Match what your Deployments' envFrom references (that's 'app-env' when deploy_my_app generated them).",
      },
    },
    required: ["envKey", "namespace", "envText"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };

    const { entries, skipped } = parseEnvText(input.envText);
    if (entries.length === 0) {
      return {
        ok: false,
        error:
          "No KEY=value pairs found in the pasted text. Ask the user to paste again — each line must look like KEY=value (comments and blanks are ignored).",
      };
    }

    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) {
      return {
        ok: false,
        error: `${kcfg.message} Connect a Kubernetes cluster to env "${input.envKey}" first.`,
      };
    }
    try {
      const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
      const secretName = (input.secretName || "app-env").trim();
      const namespace = input.namespace.trim();

      const applied = await applyAppSecret({
        kubeconfigPath: kcfg.handle.path,
        execEnv,
        namespace,
        secretName,
        entries,
      });
      if (!applied.ok) return { ok: false, error: applied.error };

      // Wire + roll. If wiring fails, the Secret is still written — surface
      // that partial success rather than treating it as total failure.
      const wire = await wireSecretToWorkloads({
        kubeconfigPath: kcfg.handle.path,
        execEnv,
        namespace,
        secretName,
      });
      const wired = wire.ok ? wire.outcomes : [];
      const wireError = wire.ok ? undefined : wire.error;
      const patched = wired.filter((w) => w.status === "patched").length;
      const already = wired.filter((w) => w.status === "already").length;

      return {
        ok: true,
        output: {
          secretName,
          namespace,
          keysWritten: applied.keys,
          skippedLines: skipped,
          wired,
          note:
            (wireError
              ? `Wrote ${applied.keys.length} key(s) to "${secretName}" in namespace "${namespace}", but wiring the Secret into Deployments failed (${wireError}). Pods may not pick up the new values.`
              : `Wrote ${applied.keys.length} key(s) to "${secretName}" in namespace "${namespace}" and rolled ${patched + already} Deployment(s). Pods restart with the new values in ~30-60s.`) +
            (skipped.length
              ? ` Note: ${skipped.length} line(s) weren't KEY=value (likely a multi-line value) and were skipped — worth asking the user to check.`
              : ""),
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};
