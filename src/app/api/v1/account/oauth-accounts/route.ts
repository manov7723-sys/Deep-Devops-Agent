import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";

/**
 * List the current user's connected OAuth identities (GitHub, Google, …).
 * Used by the account page to render the multi-account picker. Bare array
 * so the hook can `.map()` directly.
 *
 * Never returns the access/refresh tokens — only display metadata and
 * whether tokens are present for that row.
 */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const rows = await prisma.oAuthAccount.findMany({
    where: { userId: sess.userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      login: true,
      avatarUrl: true,
      scope: true,
      tokenExpiresAt: true,
      createdAt: true,
      accessTokenRef: true,
    },
  });
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerAccountId: r.providerAccountId,
      login: r.login,
      avatarUrl: r.avatarUrl,
      scope: r.scope,
      hasToken: !!r.accessTokenRef,
      tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}
