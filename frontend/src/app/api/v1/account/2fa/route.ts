import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { disableTotp, getTotpState } from "@/lib/auth/totp";
import { getBackupCodeStatus } from "@/lib/auth/backup-codes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const [totp, codes] = await Promise.all([
    getTotpState(sess.userId),
    getBackupCodeStatus(sess.userId),
  ]);
  return NextResponse.json({
    enabled: sess.user.twoFactorEnabled,
    totp,
    backupCodes: codes,
  });
}

/**
 * Disable two-factor. Per DECISIONS.md TOTP is mandatory at signup; disabling
 * is allowed for an authenticated user but the next login WILL force re-setup
 * via the forcedTotpSetup pathway.
 */
export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  if (body.enabled) {
    return NextResponse.json(
      {
        ok: false,
        code: "enable_via_setup",
        message: "Enable two-factor by completing setup at /account/2fa-manage.",
      },
      { status: 400 },
    );
  }
  await disableTotp(sess.userId);
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "auth.mfa.totp_disabled",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, enabled: false });
}
