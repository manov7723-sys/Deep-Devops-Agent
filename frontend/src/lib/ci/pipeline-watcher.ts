/**
 * Background pipeline watcher — the always-on half of the review agent.
 *
 * Before this, a failed run only got auto-healed when someone had the CI/CD
 * tab open (the panel's status polling is what invoked autoHealPipeline). If
 * the user triggered a run from chat and walked away, the failure just sat
 * there. This watcher makes monitoring server-side: runCiPipeline starts one
 * after every dispatch, and it:
 *
 *   1. Polls the GitHub Actions run every POLL_MS
 *   2. Mirrors status/conclusion/stages onto the CiPipeline row (same shape
 *      the status route writes, so the UI stays live too)
 *   3. On failure: invokes autoHealPipeline (LLM review → fix DevOps files →
 *      commit → re-dispatch), then KEEPS WATCHING the new run
 *   4. Stops on success, on heal-budget exhaustion, or at the deadline
 *
 * In-process fire-and-forget (same pattern as startTerraformRun): a dev-server
 * restart drops active watchers, but the status-route polling path still
 * exists as a fallback, and re-running the pipeline re-arms the watcher.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { findRun, getRunStatus, workflowFileName, type GH } from "./github-actions";
import { autoHealPipeline, MAX_HEAL_ATTEMPTS } from "./auto-heal";

const POLL_MS = 20_000;
const DEADLINE_MS = 45 * 60_000;

/** One watcher per pipeline — re-triggers while active are no-ops. */
const active = new Set<string>();

export function watchPipelineRun(pipelineId: string, projectId: string): void {
  if (active.has(pipelineId)) return;
  active.add(pipelineId);
  void (async () => {
    const deadline = Date.now() + DEADLINE_MS;
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));

        const p = await prisma.ciPipeline.findFirst({
          where: { id: pipelineId, projectId },
          select: {
            id: true,
            runId: true,
            agentReview: true,
            healAttempts: true,
            repoId: true,
            status: true,
            branch: true,
            commitSha: true,
            workflowPath: true,
          },
        });
        if (!p) return; // pipeline deleted
        if (!p.runId) continue; // run not located yet — keep waiting

        const repo = await prisma.repo.findUnique({
          where: { id: p.repoId },
          select: { fullName: true },
        });
        const tok = await resolveTokenForRepo(p.repoId);
        if (!repo || !tok.ok) return; // token gone — the UI path can pick it up later
        const gh = { token: tok.accessToken, repoFullName: repo.fullName };

        const live = await getRunStatus(gh, p.runId);
        if (!live) continue;

        const done = live.status === "completed";
        const failed = done && live.conclusion !== "success";
        const failedStep = failed
          ? (live.stages.flatMap((s) => s.steps).find((s) => s.conclusion === "failure")?.name ??
            null)
          : null;
        await prisma.ciPipeline.update({
          where: { id: pipelineId },
          data: {
            status: !done ? "running" : failed ? "failed" : "success",
            conclusion: live.conclusion,
            runUrl: live.url,
            stages: live.stages,
            lastError: failed ? `Failed: ${failedStep ?? live.conclusion ?? "run failed"}` : null,
          },
        });

        if (!done) continue;
        if (!failed) {
          // ✅ success. Before finishing: a green CI usually TRIGGERS the CD
          // workflow via workflow_run. Chain onto the sibling CD pipeline row
          // (same project+repo, a different workflow that looks like a
          // deploy) so the CD run is monitored + auto-healed too — no chat,
          // no tab. Without this, CD failures (dead kubeconfig, RBAC) went
          // completely unwatched unless the user asked in chat.
          await chainOntoCdRun(gh, p, projectId).catch(() => {});
          return;
        }

        // ❌ failed — hand to the review agent if there's budget left. The
        // outcome is written to lastError either way: a silent bail-out here
        // is indistinguishable from "the agent never looked", which is how a
        // real no-op heal went unnoticed for a full afternoon.
        if (p.agentReview && p.healAttempts < MAX_HEAL_ATTEMPTS) {
          const heal = await autoHealPipeline(pipelineId);
          if (heal.ok && heal.healed) continue; // new run dispatched — keep watching it
          const note = heal.ok ? `Agent reviewer: ${heal.reason}.` : `Agent reviewer error: ${heal.error}`;
          await prisma.ciPipeline
            .update({
              where: { id: pipelineId },
              data: { lastError: `Failed: ${failedStep ?? live.conclusion ?? "run failed"} — ${note}` },
            })
            .catch(() => {});
        }
        return; // failure without (further) healing — a human takes it from here
      }
    } catch {
      // Watcher must never crash the server; the polling UI remains the fallback.
    } finally {
      active.delete(pipelineId);
    }
  })();
}

/**
 * After a CI success, locate the sibling CD pipeline row + the CD run the
 * green CI just triggered (workflow_run fires within seconds, same head sha),
 * point the row at it and arm a watcher — completing the unattended
 * CI → CD → heal chain.
 */
async function chainOntoCdRun(
  gh: GH,
  ci: { id: string; repoId: string; branch: string | null; commitSha: string | null; workflowPath: string | null },
  projectId: string,
): Promise<void> {
  const cdRow = await prisma.ciPipeline.findFirst({
    where: {
      projectId,
      repoId: ci.repoId,
      id: { not: ci.id },
      OR: [
        { workflowPath: { contains: "cd", mode: "insensitive" } },
        { workflowPath: { contains: "deploy", mode: "insensitive" } },
        { name: { contains: "CD", mode: "insensitive" } },
        { name: { contains: "deploy", mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, workflowPath: true },
  });
  if (!cdRow?.workflowPath || cdRow.workflowPath === ci.workflowPath) return;
  const wfName = workflowFileName(cdRow.workflowPath);
  if (!wfName) return;
  const branch = ci.branch ?? "main";
  // The CD run's head sha equals the commit CI built. Give GitHub a few
  // seconds to register the workflow_run-triggered run.
  let run = null;
  for (let i = 0; i < 6 && !run; i++) {
    run = await findRun(gh, wfName, branch, ci.commitSha ?? undefined);
    if (!run) await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!run) return;
  await prisma.ciPipeline.update({
    where: { id: cdRow.id },
    data: { status: "running", runId: String(run.id), runUrl: run.url, conclusion: null },
  });
  watchPipelineRun(cdRow.id, projectId);
}
