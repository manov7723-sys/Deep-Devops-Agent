/**
 * Adapt MCP server tools to the app's own `Tool` interface.
 *
 * The point of adapting rather than special-casing: once an MCP tool looks
 * like every other tool, it flows through `toAnthropicTools`, the agent loop's
 * dispatch, and the approval/audit paths with no branching. The only thing
 * that marks it as remote is the `mcp__` name prefix.
 */
import type { Tool, ToolContext, ToolExecuteResult } from "@/lib/agent/tools/types";
import { callMcpTool, listMcpTools, MCP_TOOL_PREFIX } from "./client";

export { MCP_TOOL_PREFIX };

/**
 * Build `Tool` objects for every MCP tool available to this project.
 *
 * Returns [] on any failure — MCP is additive, so a registry outage costs the
 * agent its remote tools but never its built-in ones.
 */
export async function mcpToolsForProject(projectId: string): Promise<Tool[]> {
  let refs;
  try {
    refs = await listMcpTools(projectId);
  } catch (err) {
    console.error("[mcp] tool discovery failed:", err);
    return [];
  }

  return refs.map<Tool>((ref) => ({
    name: ref.exposedName,
    // Name the origin in the description. The model picks tools by
    // description, and "(via GitHub MCP server)" is what stops it reaching for
    // a remote tool when a first-class built-in already covers the job.
    description: `${ref.description}\n\n[Provided by the "${ref.connectorName}" MCP server.]`,
    inputSchema: normalizeSchema(ref.inputSchema),
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolExecuteResult<unknown>> {
      const res = await callMcpTool({
        connectorId: ref.connectorId,
        remoteName: ref.remoteName,
        input,
      });
      if (!res.ok) return { ok: false, error: res.error };
      // The loop JSON-stringifies tool output; wrapping the text keeps that
      // readable instead of emitting a bare quoted string.
      return { ok: true, output: { result: res.text } };
    },
  }));
}

/**
 * Anthropic requires `input_schema` to be a JSON-Schema object with
 * `type: "object"`. MCP servers are looser — some omit `type`, some send a
 * bare `{}`. Normalising here means a sloppy server degrades to "tool with no
 * arguments" instead of failing the whole request with a 400.
 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const out = { ...schema };
  if (out.type !== "object") out.type = "object";
  if (!out.properties || typeof out.properties !== "object") out.properties = {};
  return out;
}

/** True when a tool name came from an MCP server rather than the built-ins. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}
