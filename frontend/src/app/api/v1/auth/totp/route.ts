import { NextResponse } from "next/server";
import { getPendingSession, promotePendingToActive } from "@/lib/auth/session";
import { confirmTotpSetup, verifyTotpForUser } from "@/lib/auth/totp";
import { regenerateBackupCodes } from "@/lib/auth/backup-codes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Verifies a TOTP code against the pending_mfa session and promotes it.
 *
 * Two branches share this endpoint:
 *   - Setup confirm: forcedTotpSetup=true → confirm enrolment, mint backup
 *     codes, return them ONCE in `backupCodes`.
 *   - Login confirm: forcedTotpSetup=false → verify against confirmed secret.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code ?? "").trim();

  const sess = await getPendingSession();
  if (!sess) {
    return NextResponse.json(
      { ok: false, code: "no_temp_session", message: "Your session expired. Sign in again." },
      { status: 401 },
    );
  }

  const meta = extractRequestMeta(req);

  if (sess.forcedTotpSetup) {
    const ok = await confirmTotpSetup(sess.userId, code);
    if (!ok) {
      await audit({
        userId: sess.userId,
        action: "auth.mfa.totp_failed",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { phase: "setup" },
      });
      return NextResponse.json(
        { ok: false, code: "invalid_code", message: "That code is incorrect." },
        { status: 400 },
      );
    }
    const backupCodes = await regenerateBackupCodes(sess.userId);
    await promotePendingToActive(sess.id);
    await audit({
      userId: sess.userId,
      action: "auth.mfa.totp_enrolled",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { backupCodesIssued: backupCodes.length },
    });
    return NextResponse.json({
      ok: true,
      redirect: "/u/dashboard",
      backupCodes, // shown ONCE on the success screen
    });
  }

  const ok = await verifyTotpForUser(sess.userId, code);
  if (!ok) {
    await audit({
      userId: sess.userId,
      action: "auth.mfa.totp_failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { phase: "login" },
    });
    return NextResponse.json(
      { ok: false, code: "invalid_code", message: "That code is incorrect." },
      { status: 400 },
    );
  }
  await promotePendingToActive(sess.id);
  await audit({
    userId: sess.userId,
    action: "auth.mfa.totp_verified",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, redirect: "/u/dashboard" });
}
