import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { markReadAt } from "@/lib/chat/project-chat";

/**
 * Advance the caller's read cursor. The client calls this on chat open and
 * on new-message receipt so the unread badge clears in near-real time.
 * Idempotent: markReadAt only writes when the new timestamp is STRICTLY
 * newer than what's stored, so a stale client can't rewind someone's cursor.
 */
const Body = z.object({ at: z.string() });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }
  const at = new Date(parsed.data.at);
  if (isNaN(at.getTime())) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }

  await markReadAt({
    projectId: gate.access.project.id,
    userId: gate.access.session.userId,
    at,
  });
  return NextResponse.json({ ok: true });
}
