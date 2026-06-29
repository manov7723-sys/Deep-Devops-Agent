import { NextResponse } from "next/server";
import { getActiveSession, revokeActiveSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request) {
  // Capture the session BEFORE revoking so the audit row has the user id.
  const sess = await getActiveSession();
  await revokeActiveSession();
  if (sess) {
    const meta = extractRequestMeta(req);
    await audit({
      userId: sess.userId,
      action: "auth.logout",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      targetType: "session",
      targetId: sess.id,
    });
  }
  return NextResponse.json({ ok: true });
}
