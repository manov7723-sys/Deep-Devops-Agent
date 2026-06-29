import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { disconnectRepo } from "@/lib/repos/repos";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const res = await disconnectRepo(sess.userId, id);
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "repo.disconnected",
    targetType: "repo",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
