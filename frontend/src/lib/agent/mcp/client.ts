/**
 * MCP client — connects the agent to Model Context Protocol servers.
 *
 * WHY THIS EXISTS:
 * The McpConnector / McpCredential / ProjectMcpConnection tables and the admin
 * UI shipped as a registry: an operator could add a connector and store its
 * credentials, but nothing ever dialled it. Every tool the agent could call
 * was a hand-written TypeScript function, most of which shell out to `aws` or
 * `kubectl` — which works on a laptop with Homebrew and fails in a container
 * with "AWS CLI is not installed on the server" (2026-08 incident).
 *
 * This module closes that gap: it reads the connectors enabled for a project,
 * connects over the configured transport, lists each server's tools, and
 * adapts them to the same `Tool` shape the built-in tools use — so they flow
 * through `toAnthropicTools` and the agent loop with no special-casing.
 *
 * TRANSPORTS
 *   http / sse → remote server reached over the network. Nothing extra is
 *     required in the container image; this is the transport that makes MCP
 *     usable from a deployed pod.
 *   stdio → spawns `command args...` as a subprocess. The binary must exist
 *     wherever the app runs, so it suits local development or a purpose-built
 *     image, not a stock node container.
 *
 * FAILURE POLICY
 * A broken connector must never take the agent down. Every connect/list is
 * wrapped: on failure we log, skip that server, and continue with whatever
 * else answered. An agent with fewer tools still works; an agent that throws
 * during tool assembly does not.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";

/** How long to wait for a server to connect + list its tools before skipping it. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Prefix on every MCP-sourced tool name, so they can never collide with a
 *  built-in tool and so the dispatcher can tell where a call should go. */
export const MCP_TOOL_PREFIX = "mcp__";

export type McpToolRef = {
  /** Name exposed to the model: `mcp__<connectorSlug>__<remoteToolName>`. */
  exposedName: string;
  /** The tool's real name on the server — what we call back with. */
  remoteName: string;
  connectorId: string;
  connectorName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Connector row plus its decrypted credentials, ready to dial. */
type ResolvedConnector = {
  id: string;
  name: string;
  description: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  /** key → plaintext value, decrypted from McpCredential. */
  credentials: Record<string, string>;
  /** Bearer token from McpOAuth, when authType=oauth. */
  bearerToken?: string;
};

/**
 * Slug used in the exposed tool name. Anthropic tool names must match
 * ^[a-zA-Z0-9_-]{1,64}$, so anything else is collapsed to underscores.
 */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}

/**
 * Build the model-facing tool name. Kept under Anthropic's 64-char limit by
 * truncating the remote name rather than the connector slug — the slug is what
 * makes the name unique across servers.
 */
export function exposedToolName(connectorName: string, remoteName: string): string {
  const slug = slugify(connectorName).slice(0, 24);
  const rest = slugify(remoteName);
  const budget = 64 - MCP_TOOL_PREFIX.length - slug.length - 2;
  return `${MCP_TOOL_PREFIX}${slug}__${rest.slice(0, Math.max(1, budget))}`;
}

/** Load every enabled connector wired to this project, with secrets decrypted. */
async function resolveConnectorsForProject(projectId: string): Promise<ResolvedConnector[]> {
  const links = await prisma.projectMcpConnection.findMany({
    where: { projectId, enabled: true, connector: { enabled: true } },
    select: {
      connector: {
        select: {
          id: true,
          name: true,
          description: true,
          transport: true,
          url: true,
          command: true,
          args: true,
          authType: true,
          credentials: { select: { key: true, valueRef: true } },
          oauth: { select: { accessTokenRef: true, expiresAt: true } },
        },
      },
    },
  });

  const out: ResolvedConnector[] = [];
  for (const { connector: c } of links) {
    // Decrypt per-credential rather than in bulk: one unreadable secret (key
    // rotated, row corrupted) should cost that credential, not the connector.
    const credentials: Record<string, string> = {};
    for (const cred of c.credentials) {
      try {
        credentials[cred.key] = decryptSecret(cred.valueRef);
      } catch {
        console.error(`[mcp] connector "${c.name}": credential "${cred.key}" could not be decrypted — skipping it.`);
      }
    }

    let bearerToken: string | undefined;
    if (c.oauth?.accessTokenRef) {
      // An expired token still gets sent: the server's 401 is a far clearer
      // signal than us silently dropping auth and reporting "tool not found".
      if (c.oauth.expiresAt && c.oauth.expiresAt.getTime() < Date.now()) {
        console.warn(`[mcp] connector "${c.name}": OAuth token expired at ${c.oauth.expiresAt.toISOString()} — sending anyway; refresh not implemented.`);
      }
      try {
        bearerToken = decryptSecret(c.oauth.accessTokenRef);
      } catch {
        console.error(`[mcp] connector "${c.name}": OAuth access token could not be decrypted.`);
      }
    }

    out.push({
      id: c.id,
      name: c.name,
      description: c.description,
      transport: c.transport,
      url: c.url,
      command: c.command,
      args: c.args,
      credentials,
      bearerToken,
    });
  }
  return out;
}

/**
 * Open a client for one connector. Caller owns the returned client and MUST
 * close it. Returns null when the connector is misconfigured or unreachable —
 * never throws, so one bad server can't abort tool assembly.
 */
async function openClient(c: ResolvedConnector): Promise<Client | null> {
  try {
    const client = new Client(
      { name: "deepagent", version: "1.0.0" },
      { capabilities: {} },
    );

    // Credentials ride as headers on network transports. `api_key` / `pat` /
    // `token` are the conventional keys the admin UI writes; anything else is
    // passed through as an X-<Key> header so bespoke servers still work.
    const headers: Record<string, string> = {};
    if (c.bearerToken) headers.Authorization = `Bearer ${c.bearerToken}`;
    for (const [k, v] of Object.entries(c.credentials)) {
      const key = k.toLowerCase();
      if (key === "api_key" || key === "apikey") headers["X-API-Key"] = v;
      else if (key === "pat" || key === "token") headers.Authorization = `Bearer ${v}`;
      else headers[`X-${k}`] = v;
    }

    if (c.transport === "stdio") {
      if (!c.command) {
        console.error(`[mcp] connector "${c.name}": transport=stdio but no command configured.`);
        return null;
      }
      // Credentials become env vars for a subprocess — the conventional way
      // MCP stdio servers take config (e.g. GITHUB_TOKEN, AWS_PROFILE).
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
      for (const [k, v] of Object.entries(c.credentials)) env[k.toUpperCase()] = v;
      await client.connect(
        new StdioClientTransport({ command: c.command, args: c.args, env }),
      );
    } else {
      if (!c.url) {
        console.error(`[mcp] connector "${c.name}": transport=${c.transport} but no url configured.`);
        return null;
      }
      const url = new URL(c.url);
      const transport =
        c.transport === "sse"
          ? new SSEClientTransport(url, { requestInit: { headers } })
          : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      await client.connect(transport);
    }
    return client;
  } catch (err) {
    console.error(
      `[mcp] connector "${c.name}" (${c.transport}) failed to connect: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Reject a hung connect/list instead of stalling the whole agent turn. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Discover every tool offered by the project's enabled MCP connectors.
 *
 * Connectors are dialled in PARALLEL and each is closed as soon as its tool
 * list is read — we hold no long-lived connections, because a Next.js server
 * can be replaced at any time and a leaked stdio subprocess would outlive it.
 * The per-call cost is one short-lived connection, which is the right trade
 * for correctness here.
 */
export async function listMcpTools(projectId: string): Promise<McpToolRef[]> {
  const connectors = await resolveConnectorsForProject(projectId).catch((err) => {
    console.error("[mcp] could not load connectors:", err);
    return [] as ResolvedConnector[];
  });
  if (connectors.length === 0) return [];

  const perConnector = await Promise.all(
    connectors.map(async (c): Promise<McpToolRef[]> => {
      const client = await withTimeout(openClient(c), CONNECT_TIMEOUT_MS, `[mcp] ${c.name} connect`).catch(
        (err) => {
          console.error(`[mcp] ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        },
      );
      if (!client) return [];
      try {
        const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[mcp] ${c.name} listTools`);
        return res.tools.map((t) => ({
          exposedName: exposedToolName(c.name, t.name),
          remoteName: t.name,
          connectorId: c.id,
          connectorName: c.name,
          description: t.description ?? `${t.name} (via ${c.name} MCP server)`,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
        }));
      } catch (err) {
        console.error(`[mcp] ${c.name}: listTools failed — ${err instanceof Error ? err.message : String(err)}`);
        return [];
      } finally {
        await client.close().catch(() => {});
      }
    }),
  );

  // Guard against two connectors producing the same exposed name (same server
  // registered twice, or names colliding after slug truncation). First wins;
  // the loser is dropped with a log rather than silently shadowing.
  const seen = new Set<string>();
  const flat: McpToolRef[] = [];
  for (const t of perConnector.flat()) {
    if (seen.has(t.exposedName)) {
      console.warn(`[mcp] duplicate tool name "${t.exposedName}" from connector "${t.connectorName}" — skipped.`);
      continue;
    }
    seen.add(t.exposedName);
    flat.push(t);
  }
  return flat;
}

/**
 * Invoke one MCP tool. Opens a connection, calls, closes.
 *
 * The MCP content array is flattened to text for the agent loop, which sends
 * tool results back to the model as a string. Non-text content (images,
 * embedded resources) is summarised rather than dropped, so the model knows
 * something came back it can't see.
 */
export async function callMcpTool(args: {
  connectorId: string;
  remoteName: string;
  input: unknown;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const row = await prisma.mcpConnector.findUnique({
    where: { id: args.connectorId },
    select: {
      id: true,
      name: true,
      description: true,
      transport: true,
      url: true,
      command: true,
      args: true,
      enabled: true,
      credentials: { select: { key: true, valueRef: true } },
      oauth: { select: { accessTokenRef: true, expiresAt: true } },
    },
  });
  if (!row) return { ok: false, error: `MCP connector ${args.connectorId} no longer exists.` };
  if (!row.enabled) return { ok: false, error: `MCP connector "${row.name}" is disabled.` };

  const credentials: Record<string, string> = {};
  for (const cred of row.credentials) {
    try {
      credentials[cred.key] = decryptSecret(cred.valueRef);
    } catch {
      /* reported at discovery time; calling without it yields the server's own auth error */
    }
  }
  let bearerToken: string | undefined;
  if (row.oauth?.accessTokenRef) {
    try {
      bearerToken = decryptSecret(row.oauth.accessTokenRef);
    } catch {
      /* same as above */
    }
  }

  const client = await openClient({
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    credentials,
    bearerToken,
  });
  if (!client) {
    return { ok: false, error: `Could not connect to MCP server "${row.name}". Check its URL/command and credentials on the Admin → MCP page.` };
  }

  try {
    const res = await withTimeout(
      client.callTool({ name: args.remoteName, arguments: (args.input ?? {}) as Record<string, unknown> }),
      60_000,
      `[mcp] ${row.name}.${args.remoteName}`,
    );

    const content = (res.content ?? []) as Array<Record<string, unknown>>;
    const text = content
      .map((c) => {
        if (c.type === "text" && typeof c.text === "string") return c.text;
        if (c.type === "image") return "[image returned by MCP tool — not renderable here]";
        if (c.type === "resource") {
          const uri = (c.resource as { uri?: string } | undefined)?.uri;
          return `[resource: ${uri ?? "unknown"}]`;
        }
        return `[${String(c.type ?? "unknown")} content]`;
      })
      .join("\n")
      .trim();

    // MCP signals tool-level failure via isError, not a thrown exception.
    if (res.isError) {
      return { ok: false, error: text || `MCP tool "${args.remoteName}" reported an error.` };
    }
    return { ok: true, text: text || "(tool returned no content)" };
  } catch (err) {
    return {
      ok: false,
      error: `MCP tool "${args.remoteName}" on "${row.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
