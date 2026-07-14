import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { getFreshAccessTokenForAccount, accountTokenSelect } from "@/lib/oauth/token";
import { gitlabBaseUrl } from "@/lib/oauth/providers";

/**
 * GET /integrations/gitlab/me
 *
 * The GitLab identity the caller is connected as — the "Connected as <username>"
 * banner on the Source-control page. Mirrors integrations/github/me, but reads
 * from OAuthAccount(provider=gitlab), transparently refreshes the (2h) token,
 * and talks to the account's instance (gitlab.com or self-hosted).
 */
export async function GET(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const accountId = new URL(req.url).searchParams.get("accountId");
  const oauth = accountId
    ? await prisma.oAuthAccount.findFirst({
        where: { id: accountId, userId: sess.userId, provider: "gitlab" },
        select: { ...accountTokenSelect, login: true, providerAccountId: true },
      })
    : await prisma.oAuthAccount.findFirst({
        where: { userId: sess.userId, provider: "gitlab" },
        orderBy: { createdAt: "desc" },
        select: { ...accountTokenSelect, login: true, providerAccountId: true },
      });
  if (!oauth) {
    return NextResponse.json({ ok: false, code: "gitlab_not_connected" }, { status: 409 });
  }

  const tok = await getFreshAccessTokenForAccount(oauth);
  if (!tok.ok) {
    return NextResponse.json(
      { ok: false, code: "gitlab_not_connected", message: tok.message },
      { status: 409 },
    );
  }

  const base = (oauth.providerBaseUrl || gitlabBaseUrl()).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/v4/user`, {
    headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: `gitlab_${res.status}` }, { status: 502 });
  }
  const user = (await res.json()) as {
    id: number;
    username: string;
    name: string | null;
    avatar_url: string | null;
    web_url: string | null;
  };

  return NextResponse.json({
    ok: true,
    accountId: oauth.id,
    login: user.username,
    name: user.name,
    avatarUrl: user.avatar_url,
    profileUrl: user.web_url,
    providerAccountId: oauth.providerAccountId,
  });
}
