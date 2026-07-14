/**
 * Prisma-backed user lookup and creation.
 *
 * Phase 1 covers register + login. Helpers here mirror what the route handlers
 * need; TOTP setup/verify (Phase 2) still uses the demo `verifyTotp` shim and
 * the deterministic `totpSetupFor` until real `otplib` lands.
 */
import { prisma } from "@/lib/db/prisma";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  twoFactorEnabled: boolean;
};

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const u = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      isSuperAdmin: true,
      twoFactorEnabled: true,
    },
  });
  return u;
}

export async function getPasswordHash(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return u?.passwordHash ?? null;
}

type CreateUserArgs = {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
};

export async function createUser(args: CreateUserArgs): Promise<AuthUser> {
  const email = args.email.trim().toLowerCase();
  const name = `${args.firstName.trim()} ${args.lastName.trim()}`.replace(/\s+/g, " ").trim();

  const created = await prisma.user.create({
    data: {
      email,
      name,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      passwordHash: args.passwordHash,
      termsAcceptedAt: new Date(),
      // Account role default (`AccountRole.owner`) is set by the schema default;
      // project access is governed separately by Membership.role.
    },
    select: {
      id: true,
      email: true,
      name: true,
      isSuperAdmin: true,
      twoFactorEnabled: true,
    },
  });
  return created;
}

// ---------------------------------------------------------------------------
// Phase-2 placeholders (TOTP). Still demo-grade; replace in Phase 2.
// ---------------------------------------------------------------------------
export function verifyTotp(code: string): boolean {
  return /^\d{6}$/.test(code) && code === "123456";
}

export function totpSetupFor(email: string): { secret: string; otpauthUrl: string } {
  const base = Buffer.from(`dda:${email}`)
    .toString("base64")
    .replace(/[^A-Z]/gi, "")
    .toUpperCase();
  const secret = (base + "JBSWY3DPEHPK3PXP")
    .slice(0, 16)
    .match(/.{1,4}/g)!
    .join(" ");
  const otpauthUrl = `otpauth://totp/DeepAgent:${encodeURIComponent(email)}?secret=${secret.replace(/\s/g, "")}&issuer=DeepAgent`;
  return { secret, otpauthUrl };
}
