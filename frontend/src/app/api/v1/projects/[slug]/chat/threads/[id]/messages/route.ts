import { NextResponse } from "next/server";
import { PostMessageRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { postUserMessage } from "@/lib/agentops/chat";
import { runAgentTurn } from "@/lib/agent/agent";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Post a user message AND let the agent reply in the same round-trip.
 * The agent call is best-effort: if Claude is misconfigured or slow, we
 * still return the user's message so the UI doesn't lose it; the failure
 * just shows up as an `agentError` field the client can render inline.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PostMessageRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "empty" }, { status: 400 });
  }
  const res = await postUserMessage(
    gate.access.project.id,
    id,
    gate.access.session.userId,
    parsed.data.text,
  );
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "chat.message_posted",
    targetType: "chat_message",
    targetId: res.message.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { threadId: id },
  });

  // Run the agent turn synchronously. v1 — no streaming. If Anthropic is
  // misconfigured/slow we return the user message + an inline error so the
  // UI can render a "the agent couldn't reply" hint.
  const agent = await runAgentTurn({
    projectId: gate.access.project.id,
    threadId: id,
  });

  if (!agent.ok) {
    return NextResponse.json({
      ok: true,
      message: res.message,
      agentError: { code: agent.code, message: agent.message },
    });
  }

  return NextResponse.json({
    ok: true,
    message: res.message,
    agentMessage: { id: agent.agentMessageId, text: agent.text },
  });
}
