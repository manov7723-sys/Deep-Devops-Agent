/**
 * Account-side session management — list / revoke / revoke-others.
 *
 * "Current" session is identified by hashing the cookie token; only the row
 * whose tokenHash matches is flagged current. Revoke marks the row revoked
 * and stamps revokedAt; the cookie isn't touched here (the next request will
 * 401 because loadByCookie filters revoked).
 */
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import type { SessionStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

const SESS_COOKIE = process.env.SESSION_COOKIE_NAME ?? "ddasess";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export type SessionListItem = {
  id: string;
  current: boolean;
  status: SessionStatus;
  deviceLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export async function listSessionsForUser(userId: string): Promise<SessionListItem[]> {
  const jar = await cookies();
  const currentTokenHash = jar.get(SESS_COOKIE)?.value
    ? hashToken(jar.get(SESS_COOKIE)!.value)
    : null;

  const rows = await prisma.session.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      tokenHash: true,
      status: true,
      deviceLabel: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    current: currentTokenHash !== null && r.tokenHash === currentTokenHash,
    status: r.status,
    deviceLabel: r.deviceLabel,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/** Revoke one session by id. Returns true if a row was actually updated. */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  const { count } = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { status: "revoked", revokedAt: new Date() },
  });
  return count > 0;
}

/**
 * Revoke every active session for this user EXCEPT the one matching the
 * current cookie. Returns the count of rows revoked.
 */
export async function revokeOtherSessions(userId: string): Promise<number> {
  const jar = await cookies();
  const currentToken = jar.get(SESS_COOKIE)?.value;
  const currentTokenHash = currentToken ? hashToken(currentToken) : null;

  const { count } = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {}),
    },
    data: { status: "revoked", revokedAt: new Date() },
  });
  return count;
}

/** Revoke ALL sessions for a user (used after password reset). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { status: "revoked", revokedAt: new Date() },
  });
  return count;
}
