import { NextResponse } from "next/server";
import { getPendingSession, promotePendingToActive } from "@/lib/auth/session";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /auth/totp-skip
 *
 * Allows a new signup to bypass the forced TOTP setup step. The pending
 * session is promoted to active without enrolling a TOTP credential. The
 * user can enable 2FA later from Account → 2FA.
 *
 * Login (where `forcedTotpSetup` is false) cannot skip; that requires the
 * normal verify-or-backup flow.
 */
function safeNext(reqUrl: string): string | null {
  try {
    const n = new URL(reqUrl).searchParams.get("next");
    if (!n || !n.startsWith("/") || n.startsWith("//")) return null;
    if (n.includes("\n") || n.includes("\r")) return null;
    return n;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const sess = await getPendingSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "no_pending_session" }, { status: 401 });
  }
  // Honour caller-supplied ?next=<path> so the wizard resumes after 2FA-skip.
  const redirectTo = safeNext(req.url) ?? "/u/dashboard";
  if (!sess.forcedTotpSetup) {
    return NextResponse.json(
      {
        ok: false,
        code: "not_setup_flow",
        message: "Two-factor verification cannot be skipped — only initial setup can.",
      },
      { status: 403 },
    );
  }

  await promotePendingToActive(sess.id);

  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "auth.totp_skipped",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { method: "skip" },
  });

  return NextResponse.json({ ok: true, redirect: redirectTo, skipped: true });
}
