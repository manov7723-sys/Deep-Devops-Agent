import { azureContext, armGet } from "./azure-helpers";
import type { Tool } from "./types";

type Input = Record<string, never>;
type Sub = { subscriptionId: string; displayName: string; state: string };
type Output = { connectedSubscriptionId: string; count: number; subscriptions: Sub[] };

/**
 * List the Azure subscriptions the project's connected account can access, so
 * the agent can ask the user which one to work in (Phase 2 step 1). Read-only.
 */
export const listAzureSubscriptionsTool: Tool<Input, Output> = {
  name: "list_azure_subscriptions",
  description:
    "List the Azure subscriptions available to the project's connected Azure account. Call this BEFORE Azure " +
    "work so you can ask the user which subscription to use. Returns id + name + state.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const c = await azureContext(ctx.projectId);
    if (!c.ok) return { ok: false, error: c.error };
    const res = await armGet(c.ctx.accessToken, "/subscriptions?api-version=2020-01-01");
    if (!res.ok) return { ok: false, error: res.error };
    const data = res.data as {
      value?: Array<{ subscriptionId: string; displayName: string; state: string }>;
    };
    const subscriptions = (data.value ?? []).map((s) => ({
      subscriptionId: s.subscriptionId,
      displayName: s.displayName,
      state: s.state,
    }));
    return {
      ok: true,
      output: {
        connectedSubscriptionId: c.ctx.subscriptionId,
        count: subscriptions.length,
        subscriptions,
      },
    };
  },
};
