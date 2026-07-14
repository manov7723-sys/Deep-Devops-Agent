import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";

/**
 * GET /projects/[slug]/cicd/branches?repo=<owner/name>
 * Live list of a repo's branches (for the "Set up CI/CD" box's branch picker),
 * fetched from GitHub with the repo's stored OAuth token. Falls back to just the
 * stored default branch if the token/API is unavailable, so the box still works.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false, branches: [] }, { status: gate.status });

  const repoFullName = new URL(req.url).searchParams.get("repo")?.trim() ?? "";
  if (!repoFullName) return NextResponse.json({ ok: false, branches: [] });

  const repo = await prisma.repo.findFirst({
    where: {
      fullName: repoFullName,
      deletedAt: null,
      projectRepos: { some: { projectId: gate.access.project.id } },
    },
    select: { id: true, defaultBranch: true },
  });
  if (!repo) return NextResponse.json({ ok: false, branches: [] });

  const fallback = repo.defaultBranch ? [repo.defaultBranch] : [];
  const tok = await resolveTokenForRepo(repo.id);
  if (!tok.ok)
    return NextResponse.json({ ok: true, branches: fallback, defaultBranch: repo.defaultBranch });

  const branches: string[] = [];
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/branches?per_page=100`, {
      headers: {
        Authorization: `Bearer ${tok.accessToken}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ name?: string }>;
      for (const b of rows) if (b.name) branches.push(b.name);
    }
  } catch {
    /* fall back below */
  }

  return NextResponse.json({
    ok: true,
    branches: branches.length ? branches : fallback,
    defaultBranch: repo.defaultBranch || branches[0] || "main",
  });
}
