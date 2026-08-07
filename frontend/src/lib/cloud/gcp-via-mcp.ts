/**
 * Route GCP operations through the gcp-mcp-server when one is registered.
 *
 * Companion to aws-via-mcp.ts — see that file for the design rationale.
 *
 * Unlike @azure/mcp (per-service tools) and awslabs.aws-api-mcp-server (a
 * `call_aws` CLI wrapper), `gcp-mcp-server` exposes a single tool named
 * `run-gcp-code`: the caller supplies TypeScript that uses the Google Cloud
 * client libraries, and the server evaluates it. So `runGcpCode()` below is
 * both the primary entry point AND the whole surface — there is no per-
 * service equivalent to call.
 *
 * NOTE: gcp-mcp-server is community-maintained (startupmanch/gcp-mcp) and
 * pre-1.0 in behaviour. When a first-party GCP MCP server ships, swap
 * `run-gcp-code` for whatever it exposes here and every call site benefits.
 */
import { prisma } from "@/lib/db/prisma";
import { callMcpTool } from "@/lib/agent/mcp/client";

const GCP_MCP_CONNECTOR_NAME = "gcp-mcp";

type GcpMcpResult =
  | { ok: true; text: string }
  | { ok: false; code: "unavailable" | "failed"; message: string };

let cachedConnectorAt = 0;
let cachedConnectorId: string | null | undefined;
async function findGcpMcpConnectorId(): Promise<string | null> {
  const now = Date.now();
  if (cachedConnectorId !== undefined && now - cachedConnectorAt < 5_000) {
    return cachedConnectorId;
  }
  const row = await prisma.mcpConnector
    .findFirst({
      where: { name: GCP_MCP_CONNECTOR_NAME, enabled: true },
      select: { id: true },
    })
    .catch(() => null);
  cachedConnectorId = row?.id ?? null;
  cachedConnectorAt = now;
  return cachedConnectorId;
}

/**
 * Run TypeScript against the Google Cloud client libraries through the MCP
 * server. `reasoning` is required by the server — it's how the tool captures
 * WHY this snippet is being run, and it shows up in server logs.
 */
export async function runGcpCode(args: {
  reasoning: string;
  code: string;
}): Promise<GcpMcpResult> {
  const connectorId = await findGcpMcpConnectorId();
  if (!connectorId) return { ok: false, code: "unavailable", message: "no GCP MCP connector registered" };
  const res = await callMcpTool({
    connectorId,
    remoteName: "run-gcp-code",
    input: { reasoning: args.reasoning, code: args.code },
  });
  return res.ok ? { ok: true, text: res.text } : { ok: false, code: "failed", message: res.error };
}

/** True when a functioning GCP MCP connector is registered. */
export async function isGcpMcpAvailable(): Promise<boolean> {
  return (await findGcpMcpConnectorId()) !== null;
}
