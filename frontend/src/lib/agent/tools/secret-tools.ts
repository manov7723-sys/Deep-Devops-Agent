/**
 * Agent tools for the app secrets manager — set / list / sync secrets so the
 * agent can wire an app's secrets from chat. Values are never read back.
 */
import type { Tool } from "./types";
import {
  listSecretKeys,
  setSecret,
  syncSecretsToCluster,
  SECRET_KEY_RE,
  type SecretKeyInfo,
} from "@/lib/integrations/secrets-store";

export const listAppSecretsTool: Tool<Record<string, never>, { keys: SecretKeyInfo[] }> = {
  name: "list_app_secrets",
  description:
    "List the KEYS of the app secrets stored for this project (values are never returned). Use before setting or syncing secrets.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    return { ok: true, output: { keys: await listSecretKeys(ctx.projectId) } };
  },
};

export const setAppSecretTool: Tool<{ key: string; value: string }, { key: string; saved: true }> =
  {
    name: "set_app_secret",
    description:
      "Store (or overwrite) an app secret for this project — e.g. DATABASE_URL or an API key. Stored encrypted; " +
      "never shown again. Sync it to a cluster with sync_app_secrets so the app can read it. Confirm the key with the user.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Secret key (e.g. DATABASE_URL). Letters, digits, _, . or -; starts with a letter/underscore.",
        },
        value: { type: "string", description: "The secret value." },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      if (!SECRET_KEY_RE.test(input.key))
        return {
          ok: false,
          error: "Invalid key. Use letters, digits, _, . or - (starting with a letter/underscore).",
        };
      await setSecret(ctx.projectId, input.key, input.value);
      return { ok: true, output: { key: input.key, saved: true } };
    },
  };

export const syncAppSecretsTool: Tool<{ envKey: string }, { count: number; namespace: string }> = {
  name: "sync_app_secrets",
  description:
    "Push all the project's secrets to an environment's cluster as a Kubernetes Secret named 'deepagent-app-secrets'. " +
    "Apps read them via envFrom.secretRef. Use after setting secrets so the deployed app can access them.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose cluster to sync the secrets to." },
    },
    required: ["envKey"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await syncSecretsToCluster(
      { projectId: ctx.projectId, userId: ctx.userId },
      input.envKey,
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { count: res.count, namespace: res.namespace } };
  },
};
