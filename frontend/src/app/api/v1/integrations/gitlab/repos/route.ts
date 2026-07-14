import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { getFreshAccessTokenForAccount, accountTokenSelect } from "@/lib/oauth/token";
import { gitlabBaseUrl } from "@/lib/oauth/providers";

/**
 * GET /integrations/gitlab/repos
 *
 * Live list of the caller's GitLab projects via the GitLab API, so the attach
 * modal can pick any of them. Mirrors integrations/github/repos: reads the
 * gitlab OAuthAccount, refreshes the token if needed, and lists projects the
 * user is a member of.
 *
 * Shape matches the GitHub route so AttachReposModal can render either provider:
 * { id, name, fullName, lang, kind, defaultBranch, htmlUrl, pushedAt } — plus
 * `providerRepoId` (GitLab numeric id, used for stable API access) and
 * `provider: "gitlab"`.
 */
type GitlabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch: string | null;
  visibility: "private" | "internal" | "public";
  web_url: string;
  last_activity_at: string | null;
};

export async function GET(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const accountId = new URL(req.url).searchParams.get("accountId");
  const oauth = accountId
    ? await prisma.oAuthAccount.findFirst({
        where: { id: accountId, userId: sess.userId, provider: "gitlab" },
        select: accountTokenSelect,
      })
    : await prisma.oAuthAccount.findFirst({
        where: { userId: sess.userId, provider: "gitlab" },
        orderBy: { createdAt: "desc" },
        select: accountTokenSelect,
      });
  if (!oauth) {
    return NextResponse.json(
      {
        ok: false,
        code: "gitlab_not_connected",
        message: "Connect GitLab first to list your projects.",
      },
      { status: 409 },
    );
  }

  const tok = await getFreshAccessTokenForAccount(oauth);
  if (!tok.ok) {
    return NextResponse.json(
      { ok: false, code: "gitlab_not_connected", message: tok.message },
      { status: 409 },
    );
  }

  const base = (oauth.providerBaseUrl || gitlabBaseUrl()).replace(/\/+$/, "");
  const url = new URL(`${base}/api/v4/projects`);
  url.searchParams.set("membership", "true");
  url.searchParams.set("order_by", "last_activity_at");
  url.searchParams.set("simple", "true");
  url.searchParams.set("per_page", "100");
  // Only projects the user can push to are useful for CI/commits/MRs.
  url.searchParams.set("min_access_level", "30"); // 30 = Developer

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        code: `gitlab_${res.status}`,
        message: `GitLab returned ${res.status}.`,
        details: text.slice(0, 300),
      },
      { status: 502 },
    );
  }
  const rows = (await res.json()) as GitlabProject[];

  return NextResponse.json(
    rows.map((r) => ({
      id: String(r.id),
      providerRepoId: String(r.id),
      provider: "gitlab" as const,
      name: r.name,
      fullName: r.path_with_namespace,
      lang: "—", // GitLab's project list doesn't include a primary language
      kind: r.visibility === "public" ? "public" : "private",
      defaultBranch: r.default_branch ?? "main",
      htmlUrl: r.web_url,
      pushedAt: r.last_activity_at,
    })),
  );
}
