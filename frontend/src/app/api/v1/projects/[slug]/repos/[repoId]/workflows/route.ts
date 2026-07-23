import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { listWorkflows } from "@/lib/ci/github-actions";

/**
 * GET /projects/[slug]/repos/[repoId]/workflows
 *
 * List every GitHub Actions workflow already registered in the repo (i.e.
 * every `.github/workflows/*.yml` GitHub recognizes) — regardless of whether
 * DeepAgent generated it or tracks it in a CiPipeline row. Powers the "Run
 * pipeline" picker so ANY workflow file present in the repo can be triggered,
 * not just ones the app happens to have a saved record of.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; repoId: string }> }) {
  const { slug, repoId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const repo = await prisma.repo.findFirst({
    where: {
      id: repoId,
      deletedAt: null,
      projectRepos: { some: { projectId: gate.access.project.id } },
    },
    select: { id: true, fullName: true, defaultBranch: true },
  });
  if (!repo) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const tok = await resolveTokenForRepo(repo.id);
  if (!tok.ok)
    return NextResponse.json({ ok: false, code: "github_auth", message: tok.message }, { status: 409 });

  const workflows = await listWorkflows({ token: tok.accessToken, repoFullName: repo.fullName });
  return NextResponse.json({
    ok: true,
    defaultBranch: repo.defaultBranch,
    workflows: workflows
      .filter((w) => w.state === "active")
      .map((w) => ({ id: w.id, name: w.name, path: w.path })),
  });
}
