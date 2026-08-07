/**
 * Route Azure operations through the @azure/mcp server when one is registered.
 *
 * Companion to aws-via-mcp.ts — see that file for the design rationale. The
 * shape is identical (5s connector-id cache, per-call callMcpTool, structured
 * result envelope) so future Azure call sites can migrate with the same shape
 * of edit their AWS peers get.
 *
 * NOTE: unlike the AWS path (which today calls the CLI everywhere), most of
 * this app's Azure code already talks to ARM over `node:https` directly (see
 * `azure-arm.ts`). So this router doesn't unblock a live incident — it's the
 * seam for the client's "everything cloud-related through MCP" requirement,
 * ready for Phase 2 migration work.
 */
import { prisma } from "@/lib/db/prisma";
import { callMcpTool } from "@/lib/agent/mcp/client";

const AZURE_MCP_CONNECTOR_NAME = "azure-mcp";

type AzureMcpResult =
  | { ok: true; text: string }
  | { ok: false; code: "unavailable" | "failed"; message: string };

let cachedConnectorAt = 0;
let cachedConnectorId: string | null | undefined;
async function findAzureMcpConnectorId(): Promise<string | null> {
  const now = Date.now();
  if (cachedConnectorId !== undefined && now - cachedConnectorAt < 5_000) {
    return cachedConnectorId;
  }
  const row = await prisma.mcpConnector
    .findFirst({
      where: { name: AZURE_MCP_CONNECTOR_NAME, enabled: true },
      select: { id: true },
    })
    .catch(() => null);
  cachedConnectorId = row?.id ?? null;
  cachedConnectorAt = now;
  return cachedConnectorId;
}

/**
 * Call one @azure/mcp tool by name. Tool names are per-service (e.g.
 * `azmcp-subscription-list`, `azmcp-group-list`, `azmcp-aks-cluster-list`) —
 * the caller must know which one they want. Passing a bad name surfaces the
 * server's own "unknown tool" error rather than being silently swallowed.
 */
export async function callAzureMcp(
  remoteName: string,
  input: Record<string, unknown> = {},
): Promise<AzureMcpResult> {
  const connectorId = await findAzureMcpConnectorId();
  if (!connectorId) return { ok: false, code: "unavailable", message: "no Azure MCP connector registered" };
  const res = await callMcpTool({ connectorId, remoteName, input });
  return res.ok ? { ok: true, text: res.text } : { ok: false, code: "failed", message: res.error };
}

/** True when a functioning Azure MCP connector is registered. */
export async function isAzureMcpAvailable(): Promise<boolean> {
  return (await findAzureMcpConnectorId()) !== null;
}
