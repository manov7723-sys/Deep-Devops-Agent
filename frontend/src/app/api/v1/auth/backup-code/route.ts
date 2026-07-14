import { NextResponse } from "next/server";
import { getPendingSession, promotePendingToActive } from "@/lib/auth/session";
import { consumeBackupCode } from "@/lib/auth/backup-codes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Fallback login when the user has lost their authenticator. Accepts a
 * single-use XXXX-XXXX backup code, marks it used, promotes the session.
 *
 * Only valid when a confirmed TOTP exists — for the forced-setup path the
 * normal `/auth/totp` confirm flow is the only way out.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const sess = await getPendingSession();
  if (!sess) {
    return NextResponse.json(
      { ok: false, code: "no_temp_session", message: "Your session expired. Sign in again." },
      { status: 401 },
    );
  }
  if (sess.forcedTotpSetup) {
    return NextResponse.json(
      {
        ok: false,
        code: "setup_required",
        message: "Finish two-factor setup before using a backup code.",
      },
      { status: 400 },
    );
  }
  const meta = extractRequestMeta(req);
  const ok = await consumeBackupCode(sess.userId, body.code ?? "");
  if (!ok) {
    await audit({
      userId: sess.userId,
      action: "auth.mfa.totp_failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { method: "backup_code" },
    });
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_code",
        message: "That backup code isn't valid or has already been used.",
      },
      { status: 400 },
    );
  }
  await promotePendingToActive(sess.id);
  await audit({
    userId: sess.userId,
    action: "auth.mfa.backup_used",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, redirect: "/u/dashboard" });
}
