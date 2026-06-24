import { NextResponse } from "next/server";
import { getPendingSession } from "@/lib/auth/session";
import { startTotpSetup } from "@/lib/auth/totp";

export async function GET() {
  const sess = await getPendingSession();
  if (!sess) {
    return NextResponse.json(
      { ok: false, code: "no_temp_session", message: "Sign in again to set up two-factor." },
      { status: 401 },
    );
  }
  if (!sess.forcedTotpSetup) {
    return NextResponse.json(
      { ok: false, code: "not_setup_flow", message: "Two-factor is already configured." },
      { status: 400 },
    );
  }
  const payload = await startTotpSetup(sess.userId, sess.user.email);
  if (!payload) {
    return NextResponse.json(
      { ok: false, code: "already_enrolled", message: "Two-factor is already configured." },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, ...payload });
}
