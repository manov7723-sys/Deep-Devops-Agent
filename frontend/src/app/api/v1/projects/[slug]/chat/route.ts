import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createThread, postUserMessage } from "@/lib/agentops/chat";
import { runAgentTurn } from "@/lib/agent/agent";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * GET — return messages of the project's *default* (most recent) thread.
 * The chat page reads this for its single-thread view. Empty array if no
 * thread exists yet.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const thread = await prisma.chatThread.findFirst({
    where: { projectId: gate.access.project.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!thread) return NextResponse.json([]);
  const messages = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, text: true, createdAt: true },
  });
  return NextResponse.json(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
    })),
  );
}

/**
 * DELETE — clear chat threads for the "Clear" button.
 *   ?threadId=<id>  → clear ONLY that thread (its messages + the thread row),
 *                     leaving every OTHER thread in this project intact.
 *                     This is what the chat page uses now — "clear" applies to
 *                     the conversation you're looking at, not the whole project.
 *   (no threadId)   → back-compat: clear every thread in the project.
 * threadId must belong to this project (defense in depth against a wrong id
 * from a stale UI tab).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const threadId = new URL(req.url).searchParams.get("threadId")?.trim() || null;

  let ids: string[] = [];
  if (threadId) {
    const thread = await prisma.chatThread.findFirst({
      where: { id: threadId, projectId: gate.access.project.id },
      select: { id: true },
    });
    if (!thread) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
    ids = [thread.id];
  } else {
    const threads = await prisma.chatThread.findMany({
      where: { projectId: gate.access.project.id },
      select: { id: true },
    });
    ids = threads.map((t) => t.id);
  }

  if (ids.length > 0) {
    await prisma.chatMessage.deleteMany({ where: { threadId: { in: ids } } });
    await prisma.chatThread.deleteMany({ where: { id: { in: ids } } });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "chat.cleared",
    targetType: "chat_thread",
    targetId: threadId ?? gate.access.project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: threadId ? { scope: "thread", threadId } : { scope: "project" },
  });

  return NextResponse.json({ ok: true, clearedThreadIds: ids });
}

const PostBody = z.object({ text: z.string().trim().min(1).max(8000) });

/**
 * POST — single-shot "send message + get agent reply" for the project's
 * default thread. Auto-creates the thread on first use. Returns the FULL
 * updated thread so the optimistic-update hook can swap its cache in one go.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "empty" }, { status: 400 });
  }

  let thread = await prisma.chatThread.findFirst({
    where: { projectId: gate.access.project.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!thread) {
    const created = await createThread(gate.access.project.id, gate.access.session.userId, "Chat");
    thread = { id: created.threadId };
  }

  const post = await postUserMessage(
    gate.access.project.id,
    thread.id,
    gate.access.session.userId,
    parsed.data.text,
  );
  if (!post.ok) {
    return NextResponse.json({ ok: false, code: post.code }, { status: 404 });
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
    metadata: { threadId: thread.id },
  });

  // Best-effort agent reply. If Claude is misconfigured, the user's message
  // is still saved; the UI gets an `agentError` to render inline.
  const agent = await runAgentTurn({
    projectId: gate.access.project.id,
    threadId: thread.id,
  });

  const messages = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, text: true, createdAt: true },
  });
  const threadView = messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
  }));

  return NextResponse.json({
    ok: true,
    thread: threadView,
    agentError: agent.ok ? undefined : { code: agent.code, message: agent.message },
  });
}
