import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/auth/crypto";

/**
 * GET /integrations/github/repos
 *
 * Live list of the caller's GitHub repositories via the GitHub REST API.
 * Reads the access token from OAuthAccount(provider=github) for this user,
 * decrypts it, and proxies `GET /user/repos?sort=updated&per_page=100`.
 *
 * The wizard uses this instead of `/repos` (which is the local catalog of
 * already-attached repositories) so users can pick any of their actual
 * GitHub repos to attach to a new project.
 */
type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  language: string | null;
  html_url: string;
  pushed_at: string | null;
};

export async function GET(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  // Multi-account: caller can pick which connected GitHub identity to list
  // repos under. Without ?accountId we pick the most recently connected one.
  const accountId = new URL(req.url).searchParams.get("accountId");
  const oauth = accountId
    ? await prisma.oAuthAccount.findFirst({
        where: { id: accountId, userId: sess.userId, provider: "github" },
        select: { id: true, accessTokenRef: true, scope: true, login: true },
      })
    : await prisma.oAuthAccount.findFirst({
        where: { userId: sess.userId, provider: "github" },
        orderBy: { createdAt: "desc" },
        select: { id: true, accessTokenRef: true, scope: true, login: true },
      });
  if (!oauth?.accessTokenRef) {
    return NextResponse.json(
      {
        ok: false,
        code: "github_not_connected",
        message: "Sign in with GitHub first to list your repositories.",
      },
      { status: 409 },
    );
  }

  // Old sign-ins were `read:user user:email` only — they can't list private
  // repos. Surface this so the wizard can ask the user to reconnect.
  const scope = oauth.scope ?? "";
  const hasRepoScope = scope.includes("repo") || scope.includes("public_repo");
  if (!hasRepoScope) {
    return NextResponse.json(
      {
        ok: false,
        code: "github_scope_insufficient",
        message:
          "Your GitHub sign-in doesn't include repo access. Reconnect GitHub to grant the `repo` scope.",
        scope,
      },
      { status: 403 },
    );
  }

  const token = decryptSecret(oauth.accessTokenRef);
  const url = new URL("https://api.github.com/user/repos");
  url.searchParams.set("sort", "pushed");
  url.searchParams.set("per_page", "100");
  // Caller can override visibility from the client (`all` | `public` | `private`).
  const visibility = new URL(req.url).searchParams.get("visibility");
  if (visibility) url.searchParams.set("visibility", visibility);

  const res = await fetch(url.toString(), {
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
  const rows = (await res.json()) as GitHubRepo[];

  // Shape matches the wizard's existing `SeedRepo`-ish row: id/name/lang/kind.
  return NextResponse.json(
    rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      fullName: r.full_name,
      lang: r.language ?? "—",
      kind: r.private ? "private" : "public",
      defaultBranch: r.default_branch,
      htmlUrl: r.html_url,
      pushedAt: r.pushed_at,
    })),
  );
}
