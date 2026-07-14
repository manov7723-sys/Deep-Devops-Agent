import { prisma } from "@/lib/db/prisma";
import type { Tool } from "./types";

type Input = {
  /** Active subscription the user chose. */
  subscriptionId?: string;
  /** Active resource group (empty string clears it). */
  resourceGroup?: string;
  /** Active region. */
  region?: string;
};

type Output = {
  saved: true;
  subscriptionId: string;
  resourceGroup: string | null;
  region: string;
};

/**
 * Persist the user's chosen Azure context (subscription / resource group /
 * region) onto the project's Azure provider, so the agent remembers it across
 * the conversation AND future chats (Phase 3 — "agent must always know"). Call
 * this once the user has picked, then reuse it instead of re-asking.
 */
export const setAzureContextTool: Tool<Input, Output> = {
  name: "set_azure_context",
  description:
    "Save the user's chosen Azure subscription, resource group, and/or region for THIS project so you remember " +
    "it across chats. Call this right after the user picks them (Phase 2). Pass only the fields that were " +
    "chosen. The saved context is shown to you at the top of each conversation.",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionId: { type: "string", description: "Chosen subscription id." },
      resourceGroup: {
        type: "string",
        description: "Chosen resource group (empty string to clear).",
      },
      region: { type: "string", description: "Chosen region, e.g. eastus." },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "azure" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No Azure account is connected to this project." };

    const data: Record<string, string | null> = {};
    if (input.subscriptionId?.trim()) data.accountRef = input.subscriptionId.trim();
    if (input.resourceGroup !== undefined) data.resourceGroup = input.resourceGroup.trim() || null;
    if (input.region?.trim()) data.region = input.region.trim();
    if (Object.keys(data).length === 0) {
      return {
        ok: false,
        error: "Nothing to save — pass subscriptionId, resourceGroup, and/or region.",
      };
    }

    const updated = await prisma.cloudProvider.update({
      where: { id: cp.id },
      data,
      select: { accountRef: true, resourceGroup: true, region: true },
    });
    return {
      ok: true,
      output: {
        saved: true,
        subscriptionId: updated.accountRef,
        resourceGroup: updated.resourceGroup,
        region: updated.region,
      },
    };
  },
};
