import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/auth/crypto";

/**
 * GET /integrations/github/me
 *
 * Returns the GitHub identity the caller is currently authenticated as
 * — i.e. who the wizard's "Connected as <login>" banner should show.
 *
 * Codes:
 *   github_not_connected      — no OAuthAccount for this user
 *   github_<status>           — upstream GitHub error
 */
export async function GET(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  // Multi-account: ?accountId selects which connected GitHub identity to
  // hydrate. Default = most recently connected, matching the wizard's
  // default account dropdown selection.
  const accountId = new URL(req.url).searchParams.get("accountId");
  const oauth = accountId
    ? await prisma.oAuthAccount.findFirst({
        where: { id: accountId, userId: sess.userId, provider: "github" },
        select: { id: true, accessTokenRef: true, providerAccountId: true },
      })
    : await prisma.oAuthAccount.findFirst({
        where: { userId: sess.userId, provider: "github" },
        orderBy: { createdAt: "desc" },
        select: { id: true, accessTokenRef: true, providerAccountId: true },
      });
  if (!oauth?.accessTokenRef) {
    return NextResponse.json({ ok: false, code: "github_not_connected" }, { status: 409 });
  }

  const token = decryptSecret(oauth.accessTokenRef);
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: `github_${res.status}` }, { status: 502 });
  }
  const user = (await res.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    html_url: string | null;
  };

  return NextResponse.json({
    ok: true,
    accountId: oauth.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    profileUrl: user.html_url,
    providerAccountId: oauth.providerAccountId,
  });
}
