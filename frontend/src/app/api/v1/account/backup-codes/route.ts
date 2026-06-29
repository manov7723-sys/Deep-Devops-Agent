import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { getBackupCodeStatus, regenerateBackupCodes } from "@/lib/auth/backup-codes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const status = await getBackupCodeStatus(sess.userId);
  return NextResponse.json(status);
}

/**
 * Regenerate the full batch. Previous unused codes are invalidated. The
 * plaintext codes are returned ONCE — the client must display them now.
 */
export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const codes = await regenerateBackupCodes(sess.userId);
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "auth.backup_codes_regenerated",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { issued: codes.length },
  });
  return NextResponse.json({ ok: true, codes });
}
