import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { ResetRequest } from "@/lib/api/schemas/auth";
import { hashPassword } from "@/lib/auth/password";
import { consumeMagicLink, lookupMagicLink } from "@/lib/auth/magic-link";
import { revokeAllSessions } from "@/lib/auth/sessions";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Validate the token before showing the reset form. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const res = await lookupMagicLink(token, "password_reset");
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, code: res.reason, message: messageFor(res.reason) },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, email: res.email });
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const parsed = ResetRequest.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const fieldErrors: Record<string, string> = {};
    for (const e of parsed.error.errors) {
      const key = e.path[0]?.toString();
      if (key && !(key in fieldErrors)) fieldErrors[key] = e.message;
    }
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: first?.message ?? "Invalid reset request.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  const { token, password } = parsed.data;
  const meta = extractRequestMeta(req);

  const res = await consumeMagicLink(token, "password_reset");
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, code: res.reason, message: messageFor(res.reason) },
      { status: 400 },
    );
  }
  if (!res.userId) {
    // A reset MagicLink should always point at a real user; if it doesn't,
    // surface a generic error rather than crashing.
    return NextResponse.json(
      { ok: false, code: "not_found", message: "Reset link is no longer valid." },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: res.userId },
    data: { passwordHash, lastPasswordChangedAt: new Date() },
  });

  // Defence-in-depth: a password reset invalidates every existing session.
  const revoked = await revokeAllSessions(res.userId);

  await audit({
    userId: res.userId,
    action: "auth.password_reset_completed",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { revokedSessions: revoked },
  });

  return NextResponse.json({ ok: true });
}

function messageFor(reason: "not_found" | "expired" | "consumed"): string {
  switch (reason) {
    case "expired":
      return "This reset link has expired. Request a new one.";
    case "consumed":
      return "This reset link has already been used.";
    default:
      return "This reset link isn't valid.";
  }
}
