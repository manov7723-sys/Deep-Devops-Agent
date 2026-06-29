/**
 * Single-use recovery codes. Issued in batches of 10, formatted XXXX-XXXX.
 * The plaintext code is returned to the user EXACTLY ONCE (at generation /
 * regeneration); only the argon2 hash is persisted.
 *
 * Consuming a code marks the row used; verification uses constant-time
 * argon2 compare per unused row (10× a fast hash — fine at sign-in cost).
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "./password";

const BATCH_SIZE = 10;
const CODE_BYTES = 5; // 5 bytes -> 8 chars base32-ish

function generateOneCode(): string {
  // Crockford-friendly alphabet (no 0/O/I/L/1 confusion).
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

/** Generate a fresh batch, revoke any prior batch, return plaintext codes. */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  const batchId = randomBytes(CODE_BYTES).toString("base64url");
  const codes: string[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) codes.push(generateOneCode());
  const rows = await Promise.all(
    codes.map(async (code) => ({
      userId,
      batchId,
      codeHash: await hashPassword(code),
    })),
  );

  await prisma.$transaction([
    // Revoke previous unused codes (older batches).
    prisma.backupCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.backupCode.createMany({ data: rows }),
  ]);

  return codes;
}

/**
 * Try to consume a backup code. Returns true on success (and marks the row used).
 * Verification scans unused rows for the latest batch and tries argon2.verify.
 */
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) return false;

  const candidates = await prisma.backupCode.findMany({
    where: { userId, usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, codeHash: true },
  });

  for (const row of candidates) {
    if (await verifyPassword(row.codeHash, normalized)) {
      await prisma.backupCode.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      });
      return true;
    }
  }
  return false;
}

export async function getBackupCodeStatus(userId: string): Promise<{
  remaining: number;
  total: number;
}> {
  const [remaining, total] = await Promise.all([
    prisma.backupCode.count({ where: { userId, usedAt: null } }),
    prisma.backupCode.count({ where: { userId } }),
  ]);
  return { remaining, total };
}
