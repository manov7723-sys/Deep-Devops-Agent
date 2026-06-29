import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { findUserByEmail } from "@/lib/auth/users";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * DEV-ONLY shortcut for headless screenshot scripts. Mints an active session
 * for an existing seeded user — no password, no TOTP. 404 in production.
 */
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, code: "disabled_in_prod" }, { status: 404 });
  }
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  let next = url.searchParams.get("next") ?? "/u/dashboard";
  const theme = url.searchParams.get("theme");

  const user = await findUserByEmail(email);
  if (!user) {
    return NextResponse.json({ ok: false, code: "unknown_email" }, { status: 400 });
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const meta = extractRequestMeta(req);

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash,
      status: "active",
      rememberMe: true,
      mfaSatisfiedAt: new Date(),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    },
  });

  const jar = await cookies();
  jar.set(process.env.SESSION_COOKIE_NAME ?? "ddasess", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  if (theme === "light" || theme === "dark") {
    const sep = next.includes("?") ? "&" : "?";
    next = `${next}${sep}theme=${theme}`;
  }
  return NextResponse.redirect(new URL(next, req.url));
}
