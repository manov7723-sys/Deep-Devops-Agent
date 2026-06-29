import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { SignupRequest } from "@/lib/api/schemas/auth";
import { createPendingSession } from "@/lib/auth/session";
import { createUser, findUserByEmail } from "@/lib/auth/users";
import { hashPassword } from "@/lib/auth/password";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { audit } from "@/lib/audit/log";

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const parsed = SignupRequest.safeParse(raw);
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
        message: first?.message ?? "Invalid sign-up details.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  const { firstName, lastName, email, password } = parsed.data;

  // Pre-check for a clearer error than the unique-constraint catch below.
  const existing = await findUserByEmail(email);
  if (existing) {
    return NextResponse.json(
      {
        ok: false,
        code: "email_taken",
        message: "An account with this email already exists. Log in instead.",
      },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await createUser({ firstName, lastName, email, passwordHash });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        {
          ok: false,
          code: "email_taken",
          message: "An account with this email already exists. Log in instead.",
        },
        { status: 409 },
      );
    }
    throw err;
  }

  // Signup forces TOTP setup before issuing an active session.
  const meta = extractRequestMeta(req);
  await createPendingSession({
    userId: user.id,
    forcedTotpSetup: true,
    rememberMe: false,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  await audit({
    userId: user.id,
    action: "auth.signup",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ ok: true, needsTotp: true, setup: true });
}
