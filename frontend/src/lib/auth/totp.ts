/**
 * TOTP enrolment + verification. Built on otplib v13 (RFC 6238, SHA1/6 digits/30s).
 *
 * Lifecycle on TotpCredential:
 *   - Setup begins → row created with encrypted secretRef and confirmedAt=null.
 *   - First correct code → confirmedAt set, User.twoFactorEnabled flips true.
 *   - Re-issuing during setup REUSES the pending row (idempotent QR refresh).
 *
 * Disable flow stamps disabledAt and clears twoFactorEnabled; the row is kept
 * for audit, not deleted.
 */
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "./crypto";

const ISSUER = "DeepAgent";

export type SetupPayload = {
  secret: string; // plaintext base32 — shown ONCE in the manual-entry box
  otpauthUrl: string;
  qrDataUrl: string; // PNG data: URL for the QR <img src>
};

/**
 * Idempotently get/create a pending TotpCredential for a user. If a confirmed
 * one already exists, this returns null — caller should treat that as "already
 * enrolled, no further setup needed".
 */
export async function startTotpSetup(userId: string, email: string): Promise<SetupPayload | null> {
  const existing = await prisma.totpCredential.findUnique({ where: { userId } });
  if (existing?.confirmedAt && !existing.disabledAt) return null;

  let plaintextSecret: string;
  if (existing && !existing.confirmedAt) {
    // Reuse the pending secret — re-rendering the QR should be deterministic.
    plaintextSecret = decryptSecret(existing.secretRef, "totp");
  } else {
    plaintextSecret = generateSecret();
    const secretRef = encryptSecret(plaintextSecret, "totp");
    if (existing?.disabledAt) {
      await prisma.totpCredential.update({
        where: { userId },
        data: {
          secretRef,
          confirmedAt: null,
          disabledAt: null,
          enrolledAt: new Date(),
        },
      });
    } else {
      await prisma.totpCredential.create({
        data: { userId, secretRef, label: "Authenticator app" },
      });
    }
  }

  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret: plaintextSecret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 180, margin: 1 });
  return { secret: plaintextSecret, otpauthUrl, qrDataUrl };
}

/** True if the code matches the user's stored TOTP secret (±1 30-second step). */
export async function verifyTotpForUser(userId: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const cred = await prisma.totpCredential.findUnique({ where: { userId } });
  if (!cred || cred.disabledAt) return false;
  const secret = decryptSecret(cred.secretRef, "totp");
  // 30s tolerance = ±1 30-second step. Matches Google Authenticator UX.
  const res = await verify({ secret, token: code, epochTolerance: 30 });
  return res.valid;
}

/**
 * Confirm a pending TOTP enrolment. Returns true on success; caller should
 * also flip User.twoFactorEnabled and generate backup codes.
 */
export async function confirmTotpSetup(userId: string, code: string): Promise<boolean> {
  const cred = await prisma.totpCredential.findUnique({ where: { userId } });
  if (!cred || cred.confirmedAt || cred.disabledAt) return false;
  const secret = decryptSecret(cred.secretRef, "totp");
  const res = await verify({ secret, token: code, epochTolerance: 30 });
  if (!res.valid) return false;
  await prisma.totpCredential.update({
    where: { userId },
    data: { confirmedAt: new Date() },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: true },
  });
  return true;
}

/** Disable TOTP for a user (account screen). Keeps the row for audit. */
export async function disableTotp(userId: string): Promise<void> {
  await prisma.totpCredential.updateMany({
    where: { userId, disabledAt: null },
    data: { disabledAt: new Date() },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: false },
  });
}

export async function getTotpState(userId: string): Promise<{
  enrolled: boolean;
  confirmed: boolean;
  enrolledAt: Date | null;
  confirmedAt: Date | null;
}> {
  const cred = await prisma.totpCredential.findUnique({ where: { userId } });
  if (!cred || cred.disabledAt) {
    return { enrolled: false, confirmed: false, enrolledAt: null, confirmedAt: null };
  }
  return {
    enrolled: true,
    confirmed: !!cred.confirmedAt,
    enrolledAt: cred.enrolledAt,
    confirmedAt: cred.confirmedAt,
  };
}
