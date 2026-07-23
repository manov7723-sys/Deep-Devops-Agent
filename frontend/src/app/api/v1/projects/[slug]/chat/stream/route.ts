import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createThread, postUserMessage } from "@/lib/agentops/chat";
import { runAgentTurnStream } from "@/lib/agent/agent";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const PostBody = z.object({
  text: z.string().trim().min(1).max(8000),
  /** Optional target thread. If omitted, uses the most-recent thread (or creates one). */
  threadId: z.string().uuid().optional(),
});

/**
 * POST /projects/[slug]/chat/stream
 *
 * Single endpoint that:
 *   1. Saves the user message synchronously (so it's never lost).
 *   2. Streams Claude's reply token-by-token as SSE.
 *   3. Persists the final assistant message just before the `done` event.
 *
 * SSE event types the client should handle:
 *   user_message  — `{id, text, createdAt}` — the saved user row
 *   delta         — `{text}` — partial assistant text to append
 *   done          — `{id, text, createdAt}` — the saved assistant row
 *   error         — `{code, message}` — upstream / config failure
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) {
    return new Response(JSON.stringify({ ok: false }), {
      status: gate.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(JSON.stringify({ ok: false, code: "empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve target thread. Priority: explicit threadId from the client (must
  // belong to this project) → most-recent thread → create a fresh one.
  // Stale threadIds (thread was deleted, e.g. by a per-thread Clear, but the
  // client tab still has it cached) silently FALL BACK to the "no threadId"
  // path — same behavior as sending without an id in the first place. Hard
  // 404-ing would lock the tab out of sending until the user refreshed; the
  // `thread` SSE event already tells the client the real thread id so the
  // client updates its cache to match on the very next frame.
  let thread: { id: string } | null = null;
  if (parsed.data.threadId) {
    thread = await prisma.chatThread.findFirst({
      where: { id: parsed.data.threadId, projectId: gate.access.project.id },
      select: { id: true },
    });
  }
  if (!thread) {
    thread = await prisma.chatThread.findFirst({
      where: { projectId: gate.access.project.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
  }
  if (!thread) {
    const created = await createThread(gate.access.project.id, gate.access.session.userId, "Chat");
    thread = { id: created.threadId };
  }

  // Save the user's message before streaming starts so it's persisted even
  // if the client disconnects mid-stream.
  const post = await postUserMessage(
    gate.access.project.id,
    thread.id,
    gate.access.session.userId,
    parsed.data.text,
  );
  if (!post.ok) {
    return new Response(JSON.stringify({ ok: false, code: post.code }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "chat.message_posted",
    targetType: "chat_message",
    targetId: post.message.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { threadId: thread.id, streamed: true },
  });

  const projectId = gate.access.project.id;
  const threadId = thread.id;
  const userId = gate.access.session.userId;
  const userMessage = post.message;

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: string,
    data: unknown,
  ) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Tell the client which thread this turn landed in — critical when
      // the client didn't supply a threadId and we picked/created one, so
      // the UI can switch its active thread + refresh the history rail.
      send(controller, "thread", { id: threadId });
      // Then the saved user message so the client can swap its optimistic
      // placeholder for the real DB row.
      send(controller, "user_message", userMessage);

      try {
        for await (const ev of runAgentTurnStream({ projectId, threadId, userId })) {
          switch (ev.type) {
            case "delta":
              send(controller, "delta", { text: ev.text });
              break;
            case "tool_call_start":
              send(controller, "tool_call_start", {
                toolUseId: ev.toolUseId,
                name: ev.name,
              });
              break;
            case "tool_call_input":
              send(controller, "tool_call_input", {
                toolUseId: ev.toolUseId,
                input: ev.input,
              });
              break;
            case "tool_call_result":
              send(controller, "tool_call_result", {
                toolUseId: ev.toolUseId,
                ok: ev.ok,
                summary: ev.summary,
              });
              break;
            case "turn_end":
              send(controller, "turn_end", { reason: ev.reason });
              break;
            case "done":
              send(controller, "done", {
                id: ev.agentMessageId,
                text: ev.text,
                role: "agent",
              });
              break;
            case "error":
              send(controller, "error", { code: ev.code, message: ev.message });
              break;
          }
        }
      } catch (err) {
        send(controller, "error", {
          code: "upstream_error",
          message: err instanceof Error ? err.message : "Unknown error.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Hint to Next/Vercel/Cloudflare not to buffer the response.
      "X-Accel-Buffering": "no",
    },
  });
}
