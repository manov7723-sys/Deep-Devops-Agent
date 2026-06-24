import { NextResponse } from "next/server";
import { CreateThreadRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createThread, listThreads } from "@/lib/agentops/chat";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const threads = await listThreads(gate.access.project.id);
  return NextResponse.json(threads);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateThreadRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await createThread(
    gate.access.project.id,
    gate.access.session.userId,
    parsed.data.title,
    parsed.data.firstMessage,
  );
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "chat.thread_created",
    targetType: "chat_thread",
    targetId: res.threadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, threadId: res.threadId, firstMessageId: res.firstMessageId });
}
