/**
 * One-time emailed tokens. The plaintext token goes into the link in the email;
 * only its SHA-256 hash is persisted in `MagicLink.tokenHash`.
 *
 * Single-use: redeem stamps `consumedAt`, preventing replay. Expired or
 * already-consumed tokens are rejected.
 */
import { randomBytes, createHash } from "node:crypto";
import type { MagicLinkPurpose } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

const TOKEN_BYTES = 32;

/** PASSWORD_RESET_TTL_MINUTES overrides the default 30-minute reset window.
 *  Other purposes (invite) pass an explicit ttlMs and ignore this default. */
const RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? "30") * 60 * 1000;

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

type IssueArgs = {
  userId: string | null;
  email: string;
  purpose: MagicLinkPurpose;
  ttlMs?: number;
  requestedIp?: string | null;
};

export async function issueMagicLink(args: IssueArgs): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + (args.ttlMs ?? RESET_TTL_MS));
  await prisma.magicLink.create({
    data: {
      userId: args.userId,
      email: args.email,
      tokenHash: hashToken(token),
      purpose: args.purpose,
      expiresAt,
      requestedIp: args.requestedIp ?? null,
    },
  });
  return { token, expiresAt };
}

export type RedeemResult =
  | { ok: false; reason: "not_found" | "expired" | "consumed" }
  | {
      ok: true;
      id: string;
      userId: string | null;
      email: string;
      purpose: MagicLinkPurpose;
    };

/**
 * Look up a token (without consuming it). Use for the "validate before showing
 * the reset form" GET request.
 */
export async function lookupMagicLink(
  token: string,
  purpose: MagicLinkPurpose,
): Promise<RedeemResult> {
  if (!token) return { ok: false, reason: "not_found" };
  const row = await prisma.magicLink.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.purpose !== purpose) return { ok: false, reason: "not_found" };
  if (row.consumedAt) return { ok: false, reason: "consumed" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, id: row.id, userId: row.userId, email: row.email, purpose: row.purpose };
}

/**
 * Atomically consume a token. Used by the actual reset POST. Returns the
 * user payload on success, or a reason on failure.
 */
export async function consumeMagicLink(
  token: string,
  purpose: MagicLinkPurpose,
): Promise<RedeemResult> {
  if (!token) return { ok: false, reason: "not_found" };
  const tokenHash = hashToken(token);

  const { count } = await prisma.magicLink.updateMany({
    where: {
      tokenHash,
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  if (count === 0) {
    // Distinguish reasons so callers can show the right message.
    const row = await prisma.magicLink.findUnique({ where: { tokenHash } });
    if (!row || row.purpose !== purpose) return { ok: false, reason: "not_found" };
    if (row.consumedAt) return { ok: false, reason: "consumed" };
    return { ok: false, reason: "expired" };
  }
  const row = await prisma.magicLink.findUnique({ where: { tokenHash } });
  if (!row) return { ok: false, reason: "not_found" };
  return { ok: true, id: row.id, userId: row.userId, email: row.email, purpose: row.purpose };
}
