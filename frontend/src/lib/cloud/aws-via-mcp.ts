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
 * Unwrap `call_aws`'s response envelope down to the raw AWS CLI JSON.
 *
 * The tool does NOT return CLI stdout directly — it wraps it:
 *
 *   [{ "cli_command": "aws sts …",
 *      "response": { "error": null, "status_code": 200, "error_code": null,
 *                    "as_json": "{\"Credentials\": …}" },   <- string, not object
 *      "metadata": {...}, "validation_failures": null,
 *      "missing_context_failures": null, "failed_constraints": [] }]
 *
 * Callers parse the same `{"Credentials":…}` shape they'd get from the shell,
 * so the unwrap has to happen here rather than in every call site.
 */
function unwrapCallAws(text: string): { ok: true; json: string } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `MCP returned non-JSON: ${text.slice(0, 200)}` };
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== "object") {
    return { ok: false, error: "MCP returned an empty call_aws envelope." };
  }
  const env = first as {
    response?: { error?: string | null; error_code?: string | null; status_code?: number; as_json?: string };
    validation_failures?: unknown;
    missing_context_failures?: unknown;
    failed_constraints?: unknown[];
  };

  // The server validates commands before running them; a rejected command
  // comes back with these populated and NO response body. Surfacing them is
  // the difference between "your command was malformed" and a silent empty
  // result the caller would misread as "AWS returned nothing".
  const vf = env.validation_failures;
  const mcf = env.missing_context_failures;
  if ((Array.isArray(vf) && vf.length) || (Array.isArray(mcf) && mcf.length)) {
    return { ok: false, error: `MCP rejected the command: ${JSON.stringify(vf ?? mcf).slice(0, 300)}` };
  }

  const r = env.response;
  if (!r) return { ok: false, error: "MCP call_aws envelope had no `response`." };
  if (r.error || r.error_code) {
    return { ok: false, error: `AWS error${r.error_code ? ` (${r.error_code})` : ""}: ${r.error ?? "unknown"}` };
  }
  if (typeof r.as_json !== "string") {
    return { ok: false, error: "MCP call_aws response had no `as_json` payload." };
  }
  return { ok: true, json: r.as_json };
}

/**
 * Run one AWS CLI command through the MCP server. Returns the raw AWS JSON —
 * byte-comparable to what `aws … --output json` prints — so callers parse one
 * shape regardless of which transport served the request.
 *
 * Ephemeral per-call credentials are NOT supported: the MCP subprocess picks
 * up credentials at spawn time from the connector's stored McpCredential rows
 * (or the host's own AWS config). A caller needing to act as an already-
 * assumed session must use the CLI path until callMcpTool can forward env.
 */
export async function runAwsViaMcp(cliCommand: string): Promise<AwsCliResult> {
  const connectorId = await findAwsMcpConnectorId();
  if (!connectorId) return { ok: false, via: "none", code: "unavailable", message: "no AWS MCP connector registered" };

  const res = await callMcpTool({
    connectorId,
    remoteName: "call_aws",
    input: { cli_command: cliCommand },
  });
  if (!res.ok) return { ok: false, via: "mcp", code: "failed", message: res.error };

  const unwrapped = unwrapCallAws(res.text);
  if (!unwrapped.ok) return { ok: false, via: "mcp", code: "failed", message: unwrapped.error };
  return { ok: true, via: "mcp", stdout: unwrapped.json };
}

/** True when a functioning AWS MCP connector is registered — cheap sync check. */
export async function isAwsMcpAvailable(): Promise<boolean> {
  return (await findAwsMcpConnectorId()) !== null;
}
