/**
 * Phase 1 — DB-backed sessions on the `Session` table.
 *
 * Cookie carries an opaque 32-byte token (base64url). DB stores the SHA-256
 * hash, never the raw token. One row per session; status drives MFA gating:
 *
 *   pending_mfa  → password verified or signup completed; awaiting TOTP.
 *   active       → TOTP satisfied; full app access.
 *
 * The legacy `ddatemp` / `ddasess` cookie names are kept so existing routes
 * (`/auth/totp`, `/auth/me`, `/auth/logout`) don't need to change in this phase.
 * `ddatemp` and `ddasess` now point at the SAME Session row at different
 * lifecycle stages — we move the cookie name when status flips.
 */
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import type { SessionStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/**
 * Cookie names are env-configurable so deployments can rename their auth
 * cookies without a code change. Defaults preserve the Phase-1 names so
 * existing rolling sessions don't break.
 *
 *   SESSION_COOKIE_NAME       — active session cookie (default "ddasess")
 *   <name>_pending            — derived; carries the pending_mfa cookie
 */
const SESS_COOKIE = process.env.SESSION_COOKIE_NAME ?? "ddasess";
const TEMP_COOKIE = `${SESS_COOKIE}_pending`;

const PENDING_TTL_SEC = 60 * 10; // 10 min to enter TOTP

/**
 * SESSION_TTL_DAYS overrides the default 7-day remember-me window. Non-remember
 * sessions stay at 12h regardless — short-lived by design.
 */
const ACTIVE_TTL_SEC = Number(process.env.SESSION_TTL_DAYS ?? "7") * 24 * 60 * 60;
const ACTIVE_NO_REMEMBER_TTL_SEC = 60 * 60 * 12; // 12 hours

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

type CreatePendingArgs = {
  userId: string;
  rememberMe?: boolean;
  forcedTotpSetup?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Create a session row in `pending_mfa` and set the `ddatemp` cookie.
 * Used by signup (forcedTotpSetup=true) and login (forcedTotpSetup=false).
 */
export async function createPendingSession(args: CreatePendingArgs): Promise<void> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + PENDING_TTL_SEC * 1000);

  await prisma.session.create({
    data: {
      userId: args.userId,
      tokenHash,
      status: "pending_mfa",
      forcedTotpSetup: args.forcedTotpSetup ?? false,
      rememberMe: args.rememberMe ?? false,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      expiresAt,
    },
  });

  const jar = await cookies();
  jar.set(TEMP_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PENDING_TTL_SEC,
  });
}

export type LoadedSession = {
  id: string;
  userId: string;
  status: SessionStatus;
  forcedTotpSetup: boolean;
  rememberMe: boolean;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    isSuperAdmin: boolean;
    twoFactorEnabled: boolean;
  };
};

async function loadByCookie(cookieName: string): Promise<LoadedSession | null> {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: { id: true, email: true, name: true, isSuperAdmin: true, twoFactorEnabled: true },
      },
    },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    forcedTotpSetup: row.forcedTotpSetup,
    rememberMe: row.rememberMe,
    expiresAt: row.expiresAt,
    user: row.user,
  };
}

/** Read a pending_mfa session (set by signup/login, awaiting TOTP). */
export async function getPendingSession(): Promise<LoadedSession | null> {
  const sess = await loadByCookie(TEMP_COOKIE);
  if (!sess || sess.status !== "pending_mfa") return null;
  return sess;
}

/** Read the active session (used by `/me`, gated routes). */
export async function getActiveSession(): Promise<LoadedSession | null> {
  const sess = await loadByCookie(SESS_COOKIE);
  if (!sess || sess.status !== "active") return null;
  return sess;
}

/**
 * Promote a pending_mfa session to active. Called by `/auth/totp` after a
 * successful code. Rotates the opaque token at the MFA boundary, reissues
 * under the active cookie name, and extends TTL based on rememberMe.
 */
export async function promotePendingToActive(sessionId: string): Promise<void> {
  const row = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!row) throw new Error("session_not_found");

  const newToken = generateToken();
  const newTokenHash = hashToken(newToken);
  const ttl = row.rememberMe ? ACTIVE_TTL_SEC : ACTIVE_NO_REMEMBER_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: "active",
      tokenHash: newTokenHash,
      mfaSatisfiedAt: new Date(),
      forcedTotpSetup: false,
      expiresAt,
      lastSeenAt: new Date(),
    },
  });

  const jar = await cookies();
  jar.delete(TEMP_COOKIE);
  jar.set(SESS_COOKIE, newToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttl,
  });
}

/**
 * Revoke the active session (logout). Also clears the temp cookie defensively.
 */
export async function revokeActiveSession(): Promise<void> {
  const jar = await cookies();
  for (const name of [SESS_COOKIE, TEMP_COOKIE]) {
    const token = jar.get(name)?.value;
    if (token) {
      const tokenHash = hashToken(token);
      await prisma.session
        .updateMany({ where: { tokenHash }, data: { status: "revoked", revokedAt: new Date() } })
        .catch(() => undefined);
      jar.delete(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Back-compat shims — the existing TOTP/me/logout routes import these names.
// They forward to the DB-backed implementations above.
// ---------------------------------------------------------------------------

/** @deprecated Use `getPendingSession` / `getActiveSession` directly. */
export async function getTempSession(): Promise<{
  userId: string;
  email: string;
  setup: boolean;
} | null> {
  const sess = await getPendingSession();
  if (!sess) return null;
  return { userId: sess.userId, email: sess.user.email, setup: sess.forcedTotpSetup };
}

/** @deprecated The temp cookie is cleared by `promotePendingToActive` / `revokeActiveSession`. */
export async function clearTempSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(TEMP_COOKIE)?.value;
  if (token) {
    const tokenHash = hashToken(token);
    await prisma.session
      .updateMany({ where: { tokenHash, status: "pending_mfa" }, data: { revokedAt: new Date(), status: "revoked" } })
      .catch(() => undefined);
    jar.delete(TEMP_COOKIE);
  }
}

/** @deprecated Use `getActiveSession`. */
export async function getSession(): Promise<{
  userId: string;
  email: string;
  isSuperAdmin: boolean;
} | null> {
  const sess = await getActiveSession();
  if (!sess) return null;
  return { userId: sess.userId, email: sess.user.email, isSuperAdmin: sess.user.isSuperAdmin };
}

/** @deprecated Use `revokeActiveSession`. */
export async function clearSession(): Promise<void> {
  await revokeActiveSession();
}
