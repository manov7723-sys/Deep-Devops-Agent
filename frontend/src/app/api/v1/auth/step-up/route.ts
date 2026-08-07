import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import {
  grantStepUp,
  stepUpChallenge,
  isElevated,
  clearElevation,
  ELEVATION_MS,
} from "@/lib/auth/step-up";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * GET  /auth/step-up — current elevation state + which factor to ask for.
 * POST /auth/step-up — verify a factor and elevate for ELEVATION_MS.
 * DELETE /auth/step-up — drop elevation immediately.
 *
 * Step-up gates actions that expose credential material (see lib/auth/step-up).
 * Successes AND failures are audited: repeated failures against a live session
 * are the signal that a cookie has been stolen, and that signal is worthless if
 * only successes are recorded.
 */

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });
  const [elevated, challenge] = await Promise.all([
    isElevated(sess.id),
    stepUpChallenge(sess.userId),
  ]);
  return NextResponse.json({ ok: true, elevated, factor: challenge.factor });
}

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const meta = extractRequestMeta(req);

  const res = await grantStepUp({
    sessionId: sess.id,
    userId: sess.userId,
    code: body.code,
  });

  if (!res.ok) {
    await audit({
      userId: sess.userId,
      action: res.code === "locked" ? "auth.step_up.locked" : "auth.step_up.failure",
      targetType: "session",
      targetId: sess.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { reason: res.code },
    });
    const message =
      res.code === "locked"
        ? `Too many failed attempts. Try again in ${Math.ceil(res.retryAfterSec / 60)} minute(s).`
        : res.code === "setup_required"
          ? "Set up two-factor authentication to reveal secret values."
          : `That code was not correct. ${res.attemptsRemaining} attempt(s) left.`;
    return NextResponse.json(
      { ok: false, code: res.code, message },
      { status: res.code === "locked" ? 429 : res.code === "setup_required" ? 403 : 401 },
    );
  }

  await audit({
    userId: sess.userId,
    action: "auth.step_up.success",
    targetType: "session",
    targetId: sess.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { factor: res.factor },
  });
  return NextResponse.json({
    ok: true,
    elevatedUntil: res.elevatedUntil.toISOString(),
    expiresInSec: Math.floor(ELEVATION_MS / 1000),
    // Returned exactly once. The page holds it in memory and sends it back as
    // X-Reveal-Token; it is never a cookie, so it cannot ride along on a URL
    // someone pastes into a terminal.
    revealToken: res.revealToken,
  });
}

export async function DELETE() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false }, { status: 401 });
  await clearElevation(sess.id);
  return NextResponse.json({ ok: true });
}
