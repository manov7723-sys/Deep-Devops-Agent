/**
 * Tool primitive for the agent loop.
 *
 * Each Tool defines:
 *   - name         — the Anthropic tool name (matches what Claude emits in `tool_use`)
 *   - description  — short explanation Claude reads to decide when to use this tool
 *   - inputSchema  — JSON Schema for the tool input; Anthropic validates against this
 *   - execute      — server-side implementation called when Claude requests it
 *
 * `ToolContext` carries the per-request scope the executor needs: which
 * project the user is in, who they are, etc. Tools should NEVER reach for
 * anything outside this context — every cross-project lookup goes through it.
 */
export type ToolContext = {
  projectId: string;
  userId: string;
};

export type ToolExecuteOk<TOutput> = { ok: true; output: TOutput };
export type ToolExecuteErr = { ok: false; error: string };
export type ToolExecuteResult<TOutput> = ToolExecuteOk<TOutput> | ToolExecuteErr;

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** A JSON Schema object — Anthropic uses it to enforce the shape of input. */
  inputSchema: Record<string, unknown>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolExecuteResult<TOutput>>;
}
