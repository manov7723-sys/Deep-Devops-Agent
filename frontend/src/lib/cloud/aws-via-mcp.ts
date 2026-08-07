/**
 * Route AWS CLI operations through the AWS Labs MCP server when one is
 * registered, falling back to the local `aws` binary otherwise.
 *
 * WHY THIS EXISTS: on the deployed pod the `aws` binary isn't in the image,
 * so every AWS operation surfaced "install the CLI" and blocked the console.
 * A client requirement was to reach AWS through an MCP server instead — this
 * is the seam that lets us migrate call sites one at a time without a
 * flag-day rewrite of 23 files.
 *
 * The MCP server's `call_aws` tool takes a full CLI command string, executes
 * it inside its own process, and returns the CLI's stdout as JSON text — the
 * output SHAPE is identical to what `aws … --output json` produces locally.
 * Callers therefore keep parsing the same JSON either way.
 *
 * CREDENTIAL HANDOFF: the MCP subprocess inherits the connector's stored
 * credentials as env vars (`AWS_ACCESS_KEY_ID` etc.) — set on the Admin →
 * MCP page or injected via IRSA in production. The caller can also supply
 * ephemeral creds (e.g. an already-assumed session), which take precedence.
 *
 * ORDER (fallback logic): MCP first when a connector exists, then CLI. This
 * is deliberate — during migration both paths are valid; the day we drop the
 * CLI dep from the image, `runAwsCli` starts returning `cli_not_installed`
 * and every caller silently keeps working through MCP.
 */
import { prisma } from "@/lib/db/prisma";
import { callMcpTool } from "@/lib/agent/mcp/client";

/** Well-known connector name registered by dda-mcp-setup.mts. */
const AWS_MCP_CONNECTOR_NAME = "aws-labs-cli";

type AwsCliResult =
  | { ok: true; via: "mcp" | "cli"; stdout: string }
  | { ok: false; via: "mcp" | "cli" | "none"; code: "unavailable" | "failed"; message: string };

/**
 * Look up the enabled AWS MCP connector, if any. Cached for 5s so a burst of
 * AWS operations doesn't hammer the DB — the row rarely changes.
 */
let cachedConnectorAt = 0;
let cachedConnectorId: string | null | undefined;
async function findAwsMcpConnectorId(): Promise<string | null> {
  const now = Date.now();
  if (cachedConnectorId !== undefined && now - cachedConnectorAt < 5_000) {
    return cachedConnectorId;
  }
  const row = await prisma.mcpConnector
    .findFirst({
      where: { name: AWS_MCP_CONNECTOR_NAME, enabled: true },
      select: { id: true },
    })
    .catch(() => null);
  cachedConnectorId = row?.id ?? null;
  cachedConnectorAt = now;
  return cachedConnectorId;
}

/**
 * Run one AWS CLI command through the MCP server. Returns the raw stdout so
 * the caller can JSON-parse the same shape it was already parsing.
 *
 * `extraEnv` is not honoured here — the MCP subprocess inherits credentials
 * from the connector at spawn time. If a caller needs to pass ephemeral
 * credentials into a specific call, that requires a per-call MCP connector
 * or extending callMcpTool to forward env; document as a future issue.
 */
export async function runAwsViaMcp(cliCommand: string): Promise<AwsCliResult> {
  const connectorId = await findAwsMcpConnectorId();
  if (!connectorId) return { ok: false, via: "none", code: "unavailable", message: "no AWS MCP connector registered" };

  // `call_aws` returns the CLI JSON as `content[0].text` — callMcpTool
  // already concatenates all text content, so `res.text` is exactly the
  // stdout the shell CLI would have printed.
  const res = await callMcpTool({
    connectorId,
    remoteName: "call_aws",
    input: { cli_command: cliCommand },
  });
  if (!res.ok) return { ok: false, via: "mcp", code: "failed", message: res.error };
  return { ok: true, via: "mcp", stdout: res.text };
}

/** True when a functioning AWS MCP connector is registered — cheap sync check. */
export async function isAwsMcpAvailable(): Promise<boolean> {
  return (await findAwsMcpConnectorId()) !== null;
}
