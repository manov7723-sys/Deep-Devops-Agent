import { prisma } from "@/lib/db/prisma";
import { verifyTotpForUser } from "@/lib/auth/totp";
import { consumeBackupCode } from "@/lib/auth/backup-codes";

/**
 * Step-up authentication ("sudo mode").
 *
 * A session cookie here lives for up to 30 days, so passing the login gate
 * says nothing about who is at the keyboard *now*. Actions that expose
 * credential material — currently: revealing a namespace's Secret values in
 * the Env viewer — require a fresh re-auth that grants a short elevation
 * window recorded on the session row.
 *
 * The ONLY accepted factor is the authenticator — the same TOTP code used at
 * login — with backup codes as the authenticator-lost escape hatch. Password
 * is deliberately NOT accepted: a password is the credential most likely to be
 * phished, reused, or already sitting in a browser's password manager on the
 * very machine an attacker is using, so re-typing it proves close to nothing
 * about who is present. Requiring possession of the authenticator is the whole
 * point of the gate.
 *
 * A user without TOTP therefore cannot reveal secrets at all; the API reports
 * `setup_required` so the UI can send them to enrolment instead of failing.
 */

/** How long one successful step-up stays valid. */
export const ELEVATION_MS = 5 * 60 * 1000;

/** Consecutive failures before the session is locked out of step-up. */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type StepUpFactor = "totp" | "backup_code";

export type StepUpResult =
  | { ok: true; factor: StepUpFactor; elevatedUntil: Date }
  | { ok: false; code: "locked"; retryAfterSec: number }
  | { ok: false; code: "invalid"; attemptsRemaining: number }
  | { ok: false; code: "setup_required" };

/**
 * True when the session currently holds a valid elevation. Read straight from
 * the row rather than the cached session object — elevation changes mid-session
 * and a stale in-memory copy would either over- or under-grant.
 */
export async function isElevated(sessionId: string): Promise<boolean> {
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { elevatedUntil: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return false;
  return !!row.elevatedUntil && row.elevatedUntil.getTime() > Date.now();
}

/**
 * Guard for routes behind step-up. Returns a discriminated result so callers
 * can answer with `code: "step_up_required"` and let the UI prompt inline
 * instead of bouncing the user to a login page mid-task.
 */
export async function requireStepUp(
  sessionId: string,
): Promise<{ ok: true } | { ok: false; code: "step_up_required" }> {
  return (await isElevated(sessionId))
    ? { ok: true }
    : { ok: false, code: "step_up_required" };
}

/**
 * Verify one factor and, on success, elevate the session.
 *
 * Every failure increments a counter on the session row; MAX_FAILURES
 * consecutive failures lock step-up for LOCKOUT_MS. Counting on the row (not
 * in memory) means the throttle survives a server restart and holds across
 * instances — an in-memory map would reset to zero on every deploy, which is
 * exactly when an attacker retries.
 */
export async function grantStepUp(args: {
  sessionId: string;
  userId: string;
  code?: string;
}): Promise<StepUpResult> {
  const session = await prisma.session.findUnique({
    where: { id: args.sessionId },
    select: { stepUpFailures: true, stepUpLockedUntil: true },
  });
  if (!session) return { ok: false, code: "setup_required" };

  // No authenticator enrolled → nothing to verify against. Report it as its
  // own case so the UI offers enrolment rather than an endless "wrong code".
  if ((await stepUpChallenge(args.userId)).factor === "setup_required") {
    return { ok: false, code: "setup_required" };
  }

  const now = Date.now();
  if (session.stepUpLockedUntil && session.stepUpLockedUntil.getTime() > now) {
    return {
      ok: false,
      code: "locked",
      retryAfterSec: Math.ceil((session.stepUpLockedUntil.getTime() - now) / 1000),
    };
  }

  const factor = await verifyFactor(args);
  if (factor === null) {
    const failures = session.stepUpFailures + 1;
    const locked = failures >= MAX_FAILURES;
    await prisma.session.update({
      where: { id: args.sessionId },
      data: {
        stepUpFailures: locked ? 0 : failures,
        stepUpLockedUntil: locked ? new Date(now + LOCKOUT_MS) : null,
      },
    });
    return locked
      ? { ok: false, code: "locked", retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) }
      : { ok: false, code: "invalid", attemptsRemaining: MAX_FAILURES - failures };
  }

  const elevatedUntil = new Date(now + ELEVATION_MS);
  await prisma.session.update({
    where: { id: args.sessionId },
    data: { elevatedUntil, stepUpFailures: 0, stepUpLockedUntil: null },
  });
  return { ok: true, factor, elevatedUntil };
}

/** Returns the factor that verified, or null if none did. */
async function verifyFactor(args: { userId: string; code?: string }): Promise<StepUpFactor | null> {
  const code = args.code?.trim();
  if (!code) return null;
  if (await verifyTotpForUser(args.userId, code)) return "totp";
  // A 6-digit TOTP and an XXXX-XXXX backup code are unambiguous, so trying
  // both costs nothing and saves the user from picking the right input box.
  if (await consumeBackupCode(args.userId, code)) return "backup_code";
  return null;
}

/**
 * Which factor the UI should ask for. `setup_required` means the account has
 * no authenticator yet — the modal links to enrolment instead of rendering an
 * input nothing could ever satisfy.
 */
export async function stepUpChallenge(
  userId: string,
): Promise<{ factor: "totp" | "setup_required" }> {
  // The CREDENTIAL is the authority, not User.twoFactorEnabled.
  //
  // Those two disagree in practice: an account can hold a confirmed, active
  // TOTP credential while the boolean reads false (enrolment paths that never
  // flip it, or 2FA toggled off at login without revoking the credential).
  // verifyTotpForUser() checks only the credential, so gating the prompt on
  // the flag told users with a working authenticator to "set up 2FA" — for an
  // authenticator they were already holding. Ask whatever a code could
  // actually verify against.
  const cred = await prisma.totpCredential.findUnique({
    where: { userId },
    select: { confirmedAt: true, disabledAt: true },
  });
  return cred?.confirmedAt && !cred.disabledAt ? { factor: "totp" } : { factor: "setup_required" };
}

/** Drop elevation early — used when the user hits "Hide values". */
export async function clearElevation(sessionId: string): Promise<void> {
  await prisma.session
    .update({ where: { id: sessionId }, data: { elevatedUntil: null } })
    .catch(() => {});
}
