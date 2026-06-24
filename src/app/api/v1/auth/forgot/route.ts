import { NextResponse } from "next/server";
import { ForgotRequest } from "@/lib/api/schemas/auth";
import { findUserByEmail } from "@/lib/auth/users";
import { issueMagicLink } from "@/lib/auth/magic-link";
import { sendEmail } from "@/lib/email/transport";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Always returns ok regardless of whether the email is registered — leaking
 * "this email exists" via this surface is an enumeration vector.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const parsed = ForgotRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_email", message: "Enter a valid email address." },
      { status: 400 },
    );
  }
  const { email } = parsed.data;
  const meta = extractRequestMeta(req);

  const user = await findUserByEmail(email);
  if (user) {
    const { token, expiresAt } = await issueMagicLink({
      userId: user.id,
      email,
      purpose: "password_reset",
      requestedIp: meta.ipAddress,
    });

    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
    const link = `${origin}/auth/reset?token=${token}`;
    await sendEmail({
      to: email,
      subject: "Reset your DeepAgent password",
      text: [
        "We received a request to reset your DeepAgent password.",
        "",
        "Click the link below to set a new password. It will expire in 30 minutes",
        "and can be used only once.",
        "",
        link,
        "",
        "If you didn't request this, you can ignore this email — your password",
        "won't change.",
      ].join("\n"),
    });

    await audit({
      userId: user.id,
      action: "auth.password_reset_requested",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
  } else {
    // Still write an audit row so we can detect enumeration sweeps later.
    await audit({
      action: "auth.password_reset_requested",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { email, userMatched: false },
    });
  }

  return NextResponse.json({ ok: true });
}
