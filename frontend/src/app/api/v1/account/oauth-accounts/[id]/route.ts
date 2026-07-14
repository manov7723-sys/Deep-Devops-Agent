import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Disconnect a single OAuth account. Refuses to remove the row if it's the
 * user's *only* authentication method — i.e. they signed up via OAuth and
 * never set a password — because that would lock them out.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const row = await prisma.oAuthAccount.findFirst({
    where: { id, userId: sess.userId },
    select: { id: true, provider: true, login: true, providerAccountId: true },
  });
  if (!row) {
    return NextResponse.json(
      { ok: false, code: "not_found", message: "Connected account not found." },
      { status: 404 },
    );
  }

  // Lockout guard: if this is the only OAuth row AND the user has no password,
  // refuse so they don't lose access to their account.
  const [siblingCount, userAuth] = await Promise.all([
    prisma.oAuthAccount.count({
      where: { userId: sess.userId, id: { not: id } },
    }),
    prisma.user.findUnique({
      where: { id: sess.userId },
      select: { passwordHash: true },
    }),
  ]);
  if (siblingCount === 0 && !userAuth?.passwordHash) {
    return NextResponse.json(
      {
        ok: false,
        code: "last_auth_method",
        message: "This is your only sign-in method. Set a password first, then disconnect.",
      },
      { status: 409 },
    );
  }

  await prisma.oAuthAccount.delete({ where: { id: row.id } });

  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "auth.oauth.unlinked",
    targetType: "oauth_account",
    targetId: row.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      provider: row.provider,
      login: row.login,
      providerAccountId: row.providerAccountId,
    },
  });
  return NextResponse.json({ ok: true });
}
