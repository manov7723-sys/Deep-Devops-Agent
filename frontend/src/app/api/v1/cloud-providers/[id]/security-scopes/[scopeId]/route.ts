import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { deleteScope } from "@/lib/insights/security-scopes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; scopeId: string }> },
) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { scopeId } = await ctx.params;
  const ok = await deleteScope(sess.userId, scopeId);
  if (!ok) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "security_scope.deleted",
    targetType: "security_scope",
    targetId: scopeId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
