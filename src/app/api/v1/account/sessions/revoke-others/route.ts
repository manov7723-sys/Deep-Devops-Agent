import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { revokeOtherSessions } from "@/lib/auth/sessions";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const revoked = await revokeOtherSessions(sess.userId);
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "auth.session_revoked_others",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { revoked },
  });
  return NextResponse.json({ ok: true, revoked });
}
