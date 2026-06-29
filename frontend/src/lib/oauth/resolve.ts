/**
 * Take a verified provider profile and produce a User + OAuthAccount pair.
 *
 * Three resolution paths:
 *   - `sign_in`: OAuthAccount(provider, providerAccountId) already exists.
 *   - `linked`:  No OAuthAccount, but a User with the verified email exists →
 *                attach a new OAuthAccount and sign them in.
 *   - `signup`:  Neither — auto-create User (no password) and OAuthAccount.
 *
 * Auto-created users do NOT yet have TOTP enrolled, so the caller (route
 * handler) opens a pending_mfa session with `forcedTotpSetup=true`, exactly
 * like the email/password signup flow.
 *
 * Token storage: accessTokenRef / refreshTokenRef are AES-GCM ciphertext via
 * the shared crypto helper; never plaintext.
 */
import type { OAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";
import type { ProviderProfile } from "./exchange";

export type ResolveOutcome = "sign_in" | "linked" | "signup";

export type ResolvedIdentity = {
  outcome: ResolveOutcome;
  user: {
    id: string;
    email: string;
    name: string;
    twoFactorEnabled: boolean;
    isSuperAdmin: boolean;
  };
};

export type ResolveError =
  | { ok: false; code: "email_unverified" };

export type ResolveResult = { ok: true; identity: ResolvedIdentity } | ResolveError;

export async function resolveIdentity(
  provider: OAuthProvider,
  profile: ProviderProfile,
): Promise<ResolveResult> {
  if (!profile.emailVerified) {
    return { ok: false, code: "email_unverified" };
  }

  const tokenRef = encryptSecret(profile.accessToken);
  const refreshRef = profile.refreshToken ? encryptSecret(profile.refreshToken) : null;

  // Path A — existing OAuthAccount.
  const existingOAuth = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId },
    },
    select: {
      userId: true,
      user: {
        select: { id: true, email: true, name: true, twoFactorEnabled: true, isSuperAdmin: true },
      },
    },
  });
  if (existingOAuth) {
    await prisma.oAuthAccount.update({
      where: {
        provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId },
      },
      data: {
        accessTokenRef: tokenRef,
        refreshTokenRef: refreshRef,
        tokenExpiresAt: profile.expiresAt ?? null,
        scope: profile.scope ?? null,
      },
    });
    return { ok: true, identity: { outcome: "sign_in", user: existingOAuth.user } };
  }

  // Path B — existing User w/ same verified email → link.
  const existingUser = await prisma.user.findUnique({
    where: { email: profile.email.toLowerCase() },
    select: { id: true, email: true, name: true, twoFactorEnabled: true, isSuperAdmin: true },
  });
  if (existingUser) {
    await prisma.oAuthAccount.create({
      data: {
        userId: existingUser.id,
        provider,
        providerAccountId: profile.providerAccountId,
        login: profile.login || null,
        avatarUrl: profile.avatarUrl ?? null,
        accessTokenRef: tokenRef,
        refreshTokenRef: refreshRef,
        tokenExpiresAt: profile.expiresAt ?? null,
        scope: profile.scope ?? null,
      },
    });
    return { ok: true, identity: { outcome: "linked", user: existingUser } };
  }

  // Path C — auto-signup.
  const { firstName, lastName, display } = splitName(profile.name, profile.email);
  const created = await prisma.user.create({
    data: {
      email: profile.email.toLowerCase(),
      name: display,
      firstName,
      lastName,
      passwordHash: null, // no local password until they set one
      emailVerifiedAt: new Date(), // provider already verified the email
      termsAcceptedAt: new Date(), // OAuth click-through counts as accept
      oauthAccounts: {
        create: {
          provider,
          providerAccountId: profile.providerAccountId,
          login: profile.login || null,
          avatarUrl: profile.avatarUrl ?? null,
          accessTokenRef: tokenRef,
          refreshTokenRef: refreshRef,
          tokenExpiresAt: profile.expiresAt ?? null,
          scope: profile.scope ?? null,
        },
      },
    },
    select: { id: true, email: true, name: true, twoFactorEnabled: true, isSuperAdmin: true },
  });
  return { ok: true, identity: { outcome: "signup", user: created } };
}

function splitName(name: string, emailFallback: string): {
  firstName: string;
  lastName: string;
  display: string;
} {
  const display = (name && name.trim()) || emailFallback.split("@")[0]!;
  const parts = display.split(/\s+/);
  const firstName = parts[0]!;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return { firstName, lastName, display };
}
