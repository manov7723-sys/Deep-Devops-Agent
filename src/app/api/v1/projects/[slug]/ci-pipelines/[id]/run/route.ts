import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { commitFiles, dispatchWorkflow, findRun, workflowFileName } from "@/lib/ci/github-actions";

type FileEntry = { path: string; content: string };

/**
 * Run pipeline: commit the saved files to the repo's DEFAULT branch in one
 * commit, trigger the GitHub Actions run (push trigger + workflow_dispatch
 * fallback), record the run so the status route can mirror it live.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const pipeline = await prisma.ciPipeline.findFirst({
    where: { id, projectId: gate.access.project.id },
    select: { id: true, name: true, branch: true, files: true, workflowPath: true, repoId: true, healAttempts: true },
  });
  if (!pipeline) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const repo = await prisma.repo.findUnique({
    where: { id: pipeline.repoId },
    select: { fullName: true, defaultBranch: true },
  });
  if (!repo) return NextResponse.json({ ok: false, code: "repo_missing" }, { status: 409 });

  const tok = await resolveTokenForRepo(pipeline.repoId);
  if (!tok.ok) return NextResponse.json({ ok: false, code: "github_auth", message: tok.message }, { status: 409 });

  const files = (pipeline.files as FileEntry[]) ?? [];
  if (files.length === 0) return NextResponse.json({ ok: false, code: "no_files" }, { status: 400 });

  const branch = repo.defaultBranch || pipeline.branch || "main";
  const gh = { token: tok.accessToken, repoFullName: repo.fullName };

  await prisma.ciPipeline.update({ where: { id }, data: { status: "committing", lastError: null } });

  // 1 — commit everything in one commit to the default branch.
  const commit = await commitFiles(gh, branch, files, `ci: ${pipeline.name} (via DeepAgent)`);
  if (!commit.ok) {
    await prisma.ciPipeline.update({ where: { id }, data: { status: "error", lastError: commit.error } });
    return NextResponse.json({ ok: false, code: "commit_failed", message: commit.error }, { status: 502 });
  }

  // 2 — trigger. The push to the default branch usually starts the run; also
  // fire workflow_dispatch as a fallback for branch-name mismatches.
  const wfName = workflowFileName(pipeline.workflowPath);
  if (wfName) await dispatchWorkflow(gh, wfName, branch);

  // 3 — locate the run for this commit (give Actions a moment to register it).
  let run = null;
  if (wfName) {
    for (let i = 0; i < 4 && !run; i++) {
      run = await findRun(gh, wfName, branch, commit.sha);
      if (!run) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  await prisma.ciPipeline.update({
    where: { id },
    data: {
      status: "running",
      commitSha: commit.sha,
      branch,
      runId: run ? String(run.id) : null,
      runUrl: run?.url ?? null,
      conclusion: null,
      stages: undefined,
    },
  });

  return NextResponse.json({
    ok: true,
    commitSha: commit.sha,
    runId: run ? String(run.id) : null,
    runUrl: run?.url ?? null,
    message: run
      ? "Pipeline committed and the GitHub Actions run started."
      : "Pipeline committed. The run should appear shortly — the status panel will pick it up.",
  });
}
