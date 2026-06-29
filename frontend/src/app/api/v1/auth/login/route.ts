import { NextResponse } from "next/server";
import { LoginRequest } from "@/lib/api/schemas/auth";
import { createPendingSession } from "@/lib/auth/session";
import { findUserByEmail, getPasswordHash } from "@/lib/auth/users";
import { verifyPassword } from "@/lib/auth/password";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { audit } from "@/lib/audit/log";

const INVALID_CREDS = {
  ok: false as const,
  code: "invalid_credentials",
  message: "Email or password is incorrect.",
};

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const parsed = LoginRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(INVALID_CREDS, { status: 401 });
  }
  const { email, password, remember } = parsed.data;

  const user = await findUserByEmail(email);
  // Constant-ish work even when user missing — don't leak existence via timing.
  const hash = user ? await getPasswordHash(user.id) : null;
  const ok = hash ? await verifyPassword(hash, password) : false;
  const meta = extractRequestMeta(req);
  if (!user || !ok) {
    await audit({
      userId: user?.id ?? null,
      action: "auth.login.failure",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { email, reason: user ? "wrong_password" : "unknown_email" },
    });
    return NextResponse.json(INVALID_CREDS, { status: 401 });
  }

  await createPendingSession({
    userId: user.id,
    rememberMe: remember,
    forcedTotpSetup: !user.twoFactorEnabled, // first login after signup may still need setup
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  await audit({
    userId: user.id,
    action: "auth.login.success",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { rememberMe: remember, mfaPending: true },
  });

  return NextResponse.json({
    ok: true,
    needsTotp: true,
    setup: !user.twoFactorEnabled,
  });
}
