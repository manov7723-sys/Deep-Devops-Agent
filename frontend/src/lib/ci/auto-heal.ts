/**
 * Agent reviewer / auto-heal. When a pipeline run fails and `agentReview` is on,
 * the agent reads the failed job's log, rewrites the workflow YAML to fix it,
 * re-commits to the default branch, and re-triggers the run. Bounded by
 * MAX_HEAL_ATTEMPTS so a persistently-broken pipeline can't loop forever (and
 * burn tokens).
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { completeText } from "@/lib/agent/agent";
import {
  commitFiles,
  dispatchWorkflow,
  findRun,
  getFailedJobLog,
  workflowFileName,
} from "./github-actions";

export const MAX_HEAL_ATTEMPTS = 3;

type FileEntry = { path: string; content: string };

const SYSTEM =
  "You are a CI/CD expert fixing a GitHub Actions workflow. You are given the current workflow YAML " +
  "and the tail of the failed job log. Return ONLY the corrected, complete workflow YAML — no prose, no " +
  "markdown fences. Keep the same intent (build the image and push to ECR via OIDC). Fix the actual cause " +
  "shown in the log (e.g. wrong action version, bad step, missing permission, syntax).";

/** Strip accidental ```yaml fences the model might add. */
function cleanYaml(s: string): string {
  return s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

export type HealResult =
  | { ok: true; healed: true; attempt: number; runId: string | null; runUrl: string | null }
  | { ok: true; healed: false; reason: string }
  | { ok: false; error: string };

/**
 * Attempt one auto-heal cycle for a failed pipeline. Caller should have already
 * confirmed the run failed. No-op (healed:false) when agentReview is off or the
 * attempt budget is spent.
 */
export async function autoHealPipeline(pipelineId: string): Promise<HealResult> {
  const p = await prisma.ciPipeline.findUnique({
    where: { id: pipelineId },
    select: {
      id: true, projectId: true, repoId: true, name: true, branch: true,
      files: true, workflowPath: true, agentReview: true, healAttempts: true, runId: true,
    },
  });
  if (!p) return { ok: false, error: "pipeline not found" };
  if (!p.agentReview) return { ok: true, healed: false, reason: "agent review off" };
  if (p.healAttempts >= MAX_HEAL_ATTEMPTS) {
    return { ok: true, healed: false, reason: `max ${MAX_HEAL_ATTEMPTS} heal attempts reached` };
  }
  if (!p.workflowPath) return { ok: true, healed: false, reason: "no workflow file to fix" };

  const repo = await prisma.repo.findUnique({ where: { id: p.repoId }, select: { fullName: true, defaultBranch: true } });
  if (!repo) return { ok: false, error: "repo missing" };
  const tok = await resolveTokenForRepo(p.repoId);
  if (!tok.ok) return { ok: false, error: tok.message };
  const gh = { token: tok.accessToken, repoFullName: repo.fullName };

  const files = (p.files as FileEntry[]) ?? [];
  const wfFile = files.find((f) => f.path === p.workflowPath);
  if (!wfFile) return { ok: true, healed: false, reason: "workflow file not in saved files" };

  // 1 — read the failure log.
  const log = (p.runId ? await getFailedJobLog(gh, p.runId) : null) ?? "(no job log available)";

  // 2 — ask the model to fix the workflow.
  const fix = await completeText({
    projectId: p.projectId,
    system: SYSTEM,
    prompt: `Current workflow (${p.workflowPath}):\n\n${wfFile.content}\n\n--- Failed job log (tail) ---\n${log.slice(-4000)}`,
    maxTokens: 2000,
  });
  if (!fix.ok) return { ok: false, error: `reviewer failed: ${fix.error}` };
  const fixedYaml = cleanYaml(fix.text);
  if (!fixedYaml || fixedYaml === wfFile.content.trim()) {
    return { ok: true, healed: false, reason: "reviewer produced no change" };
  }

  // 3 — update saved files with the fix.
  const newFiles = files.map((f) => (f.path === p.workflowPath ? { ...f, content: fixedYaml } : f));
  const attempt = p.healAttempts + 1;
  await prisma.ciPipeline.update({
    where: { id: p.id },
    data: { files: newFiles, healAttempts: attempt, status: "committing" },
  });

  // 4 — re-commit + re-trigger.
  const branch = repo.defaultBranch || p.branch || "main";
  const commit = await commitFiles(gh, branch, newFiles, `ci: auto-heal ${p.name} (attempt ${attempt})`);
  if (!commit.ok) {
    await prisma.ciPipeline.update({ where: { id: p.id }, data: { status: "error", lastError: commit.error } });
    return { ok: false, error: commit.error };
  }
  const wfName = workflowFileName(p.workflowPath);
  if (wfName) await dispatchWorkflow(gh, wfName, branch);

  let run = null;
  if (wfName) {
    for (let i = 0; i < 4 && !run; i++) {
      run = await findRun(gh, wfName, branch, commit.sha);
      if (!run) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await prisma.ciPipeline.update({
    where: { id: p.id },
    data: {
      status: "running",
      commitSha: commit.sha,
      runId: run ? String(run.id) : null,
      runUrl: run?.url ?? null,
      conclusion: null,
      stages: undefined,
    },
  });

  return { ok: true, healed: true, attempt, runId: run ? String(run.id) : null, runUrl: run?.url ?? null };
}
