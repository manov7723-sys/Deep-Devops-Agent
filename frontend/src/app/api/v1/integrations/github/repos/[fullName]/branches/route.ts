import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/auth/crypto";

/**
 * GET /integrations/github/repos/{owner}/{repo}/branches
 *
 * List the branches on a GitHub repo the caller can access, using the same
 * user-scoped OAuth resolution as /integrations/github/repos. Used by the
 * create-project wizard's Environments step (v4) to render a real branch
 * dropdown per env instead of a free-text input.
 *
 * The route is nested under `[fullName]` and Next resolves that to a SINGLE
 * segment — the client must URL-encode the slash, e.g.
 *   /integrations/github/repos/owner%2Frepo/branches
 * The old GitHub-repos list route uses this same pattern.
 */
type GitHubBranch = {
  name: string;
  protected?: boolean;
  commit?: { sha: string };
};

export async function GET(
  req: Request,
  ctx: { params: Promise<{ fullName: string }> },
) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const { fullName: raw } = await ctx.params;
  const fullName = decodeURIComponent(raw);
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Expected owner/repo." },
      { status: 400 },
    );
  }

  const accountId = new URL(req.url).searchParams.get("accountId");
  const oauth = accountId
    ? await prisma.oAuthAccount.findFirst({
        where: { id: accountId, userId: sess.userId, provider: "github" },
        select: { accessTokenRef: true },
      })
    : await prisma.oAuthAccount.findFirst({
        where: { userId: sess.userId, provider: "github" },
        orderBy: { createdAt: "desc" },
        select: { accessTokenRef: true },
      });
  if (!oauth?.accessTokenRef) {
    return NextResponse.json(
      { ok: false, code: "github_not_connected", message: "Connect GitHub first." },
      { status: 409 },
    );
  }

  const token = decryptSecret(oauth.accessTokenRef);
  // per_page=100 is the API cap — for a repo with more branches the wizard's
  // autocomplete input still lets the user type an arbitrary name, and the
  // deploy flow validates the branch exists at deploy time. Refresh-cheap is
  // more valuable here than pagination.
  const url = `https://api.github.com/repos/${fullName}/branches?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        code: `github_${res.status}`,
        message: `GitHub returned ${res.status}.`,
        details: text.slice(0, 300),
      },
      { status: 502 },
    );
  }
  const rows = (await res.json()) as GitHubBranch[];

  return NextResponse.json({
    ok: true,
    branches: rows.map((b) => ({
      name: b.name,
      protected: !!b.protected,
      sha: b.commit?.sha ?? null,
    })),
  });
}
