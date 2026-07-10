/**
 * Pipeline watchdog — the server-side driver for the agent reviewer. Every tick
 * it polls TRACKED pipelines (status running/committing, i.e. started via
 * "Run pipeline"), refreshes their status from GitHub, and — when a run failed
 * and agentReview is on — kicks off one auto-heal cycle (fix the workflow YAML +
 * re-run, bounded to MAX_HEAL_ATTEMPTS).
 *
 * WHY THIS EXISTS: auto-heal only ever ran inside GET /ci-pipelines/[id]/status,
 * which nothing polls on a schedule — so a failed run's status stayed "running"
 * forever and the reviewer never fired. This makes it fire 24/7 without the
 * CI/CD tab open. (The /status route still does the same on demand.)
 *
 * NOTE: auto-heal rewrites the WORKFLOW file. It can't fix a failing Dockerfile
 * or app build — those need the file regenerated with the right inputs.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { findRun, getRunStatus, workflowFileName } from "./github-actions";
import { autoHealPipeline, MAX_HEAL_ATTEMPTS } from "./auto-heal";

/** Poll running tracked pipelines: refresh status + auto-heal failures. Returns #healed. */
export async function runPipelineWatchdog(): Promise<number> {
  const pipelines = await prisma.ciPipeline.findMany({
    where: { status: { in: ["running", "committing"] } },
    select: {
      id: true, repoId: true, runId: true, commitSha: true, branch: true,
      workflowPath: true, agentReview: true, healAttempts: true,
    },
    take: 50,
  });

  let healed = 0;
  for (const p of pipelines) {
    try {
      if (!p.runId && !p.commitSha) continue;
      const repo = await prisma.repo.findUnique({ where: { id: p.repoId }, select: { fullName: true } });
      if (!repo) continue;
      const tok = await resolveTokenForRepo(p.repoId);
      if (!tok.ok) continue;
      const gh = { token: tok.accessToken, repoFullName: repo.fullName };

      // Resolve the run id if the run route hadn't found it yet.
      let runId = p.runId;
      if (!runId) {
        const wfName = workflowFileName(p.workflowPath);
        const run = wfName ? await findRun(gh, wfName, p.branch, p.commitSha ?? undefined) : null;
        if (run) {
          runId = String(run.id);
          await prisma.ciPipeline.update({ where: { id: p.id }, data: { runId, runUrl: run.url } });
        }
      }
      if (!runId) continue;

      const live = await getRunStatus(gh, runId);
      if (!live) continue;
      const done = live.status === "completed";
      const failed = done && live.conclusion !== "success";
      const failedStep = failed
        ? live.stages.flatMap((s) => s.steps).find((s) => s.conclusion === "failure")?.name ?? null
        : null;

      await prisma.ciPipeline.update({
        where: { id: p.id },
        data: {
          status: !done ? "running" : failed ? "failed" : "success",
          conclusion: live.conclusion,
          runUrl: live.url,
          stages: live.stages,
          lastError: failed ? `Failed: ${failedStep ?? live.conclusion ?? "run failed"}` : null,
        },
      });

      if (failed && p.agentReview && p.healAttempts < MAX_HEAL_ATTEMPTS) {
        const heal = await autoHealPipeline(p.id);
        if (heal.ok && heal.healed) healed++;
      }
    } catch {
      /* best-effort per pipeline — one bad token/repo shouldn't stall the tick */
    }
  }
  return healed;
}
