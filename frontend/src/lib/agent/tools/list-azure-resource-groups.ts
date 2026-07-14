import { azureContext, armGet } from "./azure-helpers";
import type { Tool } from "./types";

type Input = {
  /** Subscription to list within. Defaults to the connected subscription. */
  subscriptionId?: string;
};
type Rg = { name: string; location: string };
type Output = { subscriptionId: string; count: number; resourceGroups: Rg[] };

/**
 * List resource groups in an Azure subscription, so the agent can ask the user
 * which resource group to scope work to (Phase 2 step 2). Read-only.
 */
export const listAzureResourceGroupsTool: Tool<Input, Output> = {
  name: "list_azure_resource_groups",
  description:
    "List resource groups in the project's Azure subscription. Call this after the subscription is chosen so " +
    "you can ask the user which resource group to use. Optionally pass subscriptionId; defaults to the " +
    "connected one. Returns name + location.",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionId: {
        type: "string",
        description: "Subscription id. Defaults to the connected subscription.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const c = await azureContext(ctx.projectId);
    if (!c.ok) return { ok: false, error: c.error };
    const sub = input.subscriptionId?.trim() || c.ctx.subscriptionId;
    const res = await armGet(
      c.ctx.accessToken,
      `/subscriptions/${encodeURIComponent(sub)}/resourcegroups?api-version=2021-04-01`,
    );
    if (!res.ok) return { ok: false, error: res.error };
    const data = res.data as { value?: Array<{ name: string; location: string }> };
    const resourceGroups = (data.value ?? []).map((r) => ({ name: r.name, location: r.location }));
    return {
      ok: true,
      output: { subscriptionId: sub, count: resourceGroups.length, resourceGroups },
    };
  },
};
