/**
 * Shared "Run pipeline" logic: commit the saved files to the repo's default
 * branch (a no-op if nothing changed since the last run — see commitFiles),
 * trigger the GitHub Actions run via workflow_dispatch, then locate the run so
 * the UI/agent can watch it. Used by BOTH the CI/CD tab's "Run" button
 * (api/v1/projects/[slug]/ci-pipelines/[id]/run/route.ts) and the
 * run_ci_pipeline agent tool, so chat and the UI stay in lockstep — one code
 * path, two entry points.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { commitFiles, dispatchWorkflow, findRun, workflowFileName } from "./github-actions";

type FileEntry = { path: string; content: string };

export type RunCiPipelineResult =
  | {
      ok: true;
      commitSha: string;
      runId: string | null;
      runUrl: string | null;
      message: string;
    }
  | { ok: false; code: string; message: string };

export async function runCiPipeline(pipelineId: string, projectId: string): Promise<RunCiPipelineResult> {
  const pipeline = await prisma.ciPipeline.findFirst({
    where: { id: pipelineId, projectId },
    select: {
      id: true,
      name: true,
      branch: true,
      files: true,
      workflowPath: true,
      repoId: true,
    },
  });
  if (!pipeline) return { ok: false, code: "not_found", message: "Pipeline not found." };

  const repo = await prisma.repo.findUnique({
    where: { id: pipeline.repoId },
    select: { fullName: true, defaultBranch: true },
  });
  if (!repo) return { ok: false, code: "repo_missing", message: "The pipeline's repo is missing." };

  const tok = await resolveTokenForRepo(pipeline.repoId);
  if (!tok.ok) return { ok: false, code: "github_auth", message: tok.message };

  const files = (pipeline.files as FileEntry[]) ?? [];
  if (files.length === 0) return { ok: false, code: "no_files", message: "Pipeline has no files." };

  const branch = repo.defaultBranch || pipeline.branch || "main";
  const gh = { token: tok.accessToken, repoFullName: repo.fullName };

  await prisma.ciPipeline.update({ where: { id: pipeline.id }, data: { status: "committing", lastError: null } });

  // 1 — commit everything in one commit to the default branch. A no-op
  // (returns the current tip) when nothing changed since the last run.
  const commit = await commitFiles(gh, branch, files, `ci: ${pipeline.name} (via DeepAgent)`);
  if (!commit.ok) {
    await prisma.ciPipeline.update({ where: { id: pipeline.id }, data: { status: "error", lastError: commit.error } });
    return { ok: false, code: "commit_failed", message: commit.error };
  }

  // 2 — trigger via workflow_dispatch — the ONLY way these workflows run.
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
    where: { id: pipeline.id },
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

  return {
    ok: true,
    commitSha: commit.sha,
    runId: run ? String(run.id) : null,
    runUrl: run?.url ?? null,
    message: run
      ? "Pipeline triggered — the GitHub Actions run started."
      : "Pipeline triggered. The run should appear shortly.",
  };
}
