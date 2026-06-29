import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { revokeSessionById } from "@/lib/auth/sessions";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ok = await revokeSessionById(sess.userId, id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, code: "not_found", message: "Session not found or already revoked." },
      { status: 404 },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "auth.session_revoked",
    targetType: "session",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
