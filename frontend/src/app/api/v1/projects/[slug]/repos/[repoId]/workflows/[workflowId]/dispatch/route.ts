import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { dispatchWorkflowChecked, findRun } from "@/lib/ci/github-actions";

/**
 * POST /projects/[slug]/repos/[repoId]/workflows/[workflowId]/dispatch
 *
 * Trigger any workflow GitHub already knows about for this repo — no commit,
 * no CiPipeline row required. This is the "watch the repo, run whatever
 * workflow file is there" path, distinct from the CiPipeline-based run route
 * which also (re-)commits saved files first.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; repoId: string; workflowId: string }> },
) {
  const { slug, repoId, workflowId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const repo = await prisma.repo.findFirst({
    where: {
      id: repoId,
      deletedAt: null,
      projectRepos: { some: { projectId: gate.access.project.id } },
    },
    select: { fullName: true, defaultBranch: true },
  });
  if (!repo) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const tok = await resolveTokenForRepo(repoId);
  if (!tok.ok)
    return NextResponse.json({ ok: false, code: "github_auth", message: tok.message }, { status: 409 });

  const body = await req.json().catch(() => ({}));
  const ref = (typeof body?.ref === "string" && body.ref.trim()) || repo.defaultBranch || "main";
  const gh = { token: tok.accessToken, repoFullName: repo.fullName };

  const dispatch = await dispatchWorkflowChecked(gh, workflowId, ref);
  if (!dispatch.ok) {
    return NextResponse.json({ ok: false, code: "dispatch_failed", message: dispatch.error }, { status: 502 });
  }

  // Best-effort: give Actions a moment to register the run, then report it.
  let run = null;
  for (let i = 0; i < 4 && !run; i++) {
    run = await findRun(gh, workflowId, ref);
    if (!run) await new Promise((r) => setTimeout(r, 1200));
  }

  return NextResponse.json({
    ok: true,
    runId: run ? String(run.id) : null,
    runUrl: run?.url ?? null,
    message: run
      ? "Workflow triggered — the GitHub Actions run started."
      : "Workflow triggered. The run should appear shortly on GitHub.",
  });
}
