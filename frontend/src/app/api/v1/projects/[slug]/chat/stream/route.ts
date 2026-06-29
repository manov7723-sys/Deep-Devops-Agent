import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createThread, postUserMessage } from "@/lib/agentops/chat";
import { runAgentTurnStream } from "@/lib/agent/agent";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const PostBody = z.object({ text: z.string().trim().min(1).max(8000) });

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

  // Find or create the default thread for this project.
  let thread = await prisma.chatThread.findFirst({
    where: { projectId: gate.access.project.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!thread) {
    const created = await createThread(
      gate.access.project.id,
      gate.access.session.userId,
      "Chat",
    );
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
  const userMessage = post.message;

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: string,
    data: unknown,
  ) => {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // First event: the saved user message so the client can swap its
      // optimistic placeholder for the real DB row.
      send(controller, "user_message", userMessage);

      try {
        for await (const ev of runAgentTurnStream({ projectId, threadId })) {
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
