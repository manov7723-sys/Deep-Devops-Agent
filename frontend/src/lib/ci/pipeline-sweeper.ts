/**
 * Pipeline sweeper — the piece that makes CI/CD healing TRULY autonomous.
 *
 * Watchers (pipeline-watcher.ts) only arm when something in-process starts a
 * run: the Run button, the chat agent, a heal re-dispatch. But real clients
 * trigger runs the app never sees start — a `git push`, a workflow_run chain,
 * a re-run clicked on github.com, or any run that fired while the server was
 * down. Those runs went completely unwatched: failures sat red until a human
 * asked about them.
 *
 * The sweeper closes that hole. Booted once from instrumentation-node.ts, it
 * scans every agentReview pipeline row on an interval, asks GitHub for each
 * repo's recent runs (ONE list call per repo), and:
 *
 *   • a run of a tracked workflow is in progress → adopt it (sync runId) and
 *     arm a watcher — from there the normal watch → heal → chain loop owns it
 *   • a NEW failed run the app hasn't recorded → adopt it and arm a watcher;
 *     the watcher sees completed+failure on its first poll and heals
 *   • a failed run the app already processed (same runId) → leave it alone —
 *     the heal budget for that run was spent; re-arming would loop
 *
 * Restart-proof by construction: state lives in the DB rows + GitHub, so a
 * fresh server picks up exactly where the dead one left off on first sweep.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { MAX_HEAL_ATTEMPTS } from "./auto-heal";
import { watchPipelineRun } from "./pipeline-watcher";

const SWEEP_MS = 90_000;
const GH = "https://api.github.com";

type GhRun = {
  id: number;
  path?: string;
  status?: string;
  conclusion: string | null;
  html_url?: string;
  head_branch?: string;
};

async function sweepOnce(): Promise<void> {
  const rows = await prisma.ciPipeline.findMany({
    where: { agentReview: true, workflowPath: { not: null } },
    select: {
      id: true,
      projectId: true,
      repoId: true,
      workflowPath: true,
      runId: true,
      status: true,
      healAttempts: true,
      repo: { select: { fullName: true, deletedAt: true } },
    },
  });
  if (rows.length === 0) return;

  // One runs-list call per distinct repo, not per row.
  const byRepo = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.repo.deletedAt) continue;
    const list = byRepo.get(r.repoId) ?? [];
    list.push(r);
    byRepo.set(r.repoId, list);
  }

  for (const [repoId, repoRows] of byRepo) {
    const fullName = repoRows[0]!.repo.fullName;
    const tok = await resolveTokenForRepo(repoId).catch(() => null);
    if (!tok || !tok.ok) continue;
    let runs: GhRun[] = [];
    try {
      const res = await fetch(`${GH}/repos/${fullName}/actions/runs?per_page=20`, {
        headers: {
          Authorization: `Bearer ${tok.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      });
      if (!res.ok) continue;
      runs = ((await res.json()) as { workflow_runs?: GhRun[] }).workflow_runs ?? [];
    } catch {
      continue;
    }

    for (const row of repoRows) {
      const wfPath = row.workflowPath!.replace(/^\/+/, "");
      // Newest run of THIS workflow (list is newest-first).
      const latest = runs.find((r) => (r.path ?? "").replace(/^\/+/, "") === wfPath);
      if (!latest) continue;
      const latestId = String(latest.id);

      if (latest.status !== "completed") {
        // In-flight run (client push, github.com re-run, workflow_run chain…)
        // → adopt + watch. The watcher takes over status sync, heal, chain.
        if (row.runId !== latestId || row.status !== "running") {
          await prisma.ciPipeline
            .update({
              where: { id: row.id },
              data: { runId: latestId, status: "running", runUrl: latest.html_url ?? null, conclusion: null },
            })
            .catch(() => {});
        }
        watchPipelineRun(row.id, row.projectId);
        continue;
      }

      if (latest.conclusion === "failure") {
        // Already processed this exact run? Leave it — its heal budget was
        // spent (or is being spent by a live watcher). Re-adopting would
        // re-heal the same failure forever.
        if (row.runId === latestId) continue;
        if (row.healAttempts >= MAX_HEAL_ATTEMPTS) continue;
        await prisma.ciPipeline
          .update({
            where: { id: row.id },
            data: { runId: latestId, status: "failed", runUrl: latest.html_url ?? null, conclusion: "failure" },
          })
          .catch(() => {});
        watchPipelineRun(row.id, row.projectId);
        continue;
      }

      // Success — keep the row honest if it drifted (e.g. server was down
      // when the run finished).
      if (latest.conclusion === "success" && row.runId === latestId && row.status !== "success") {
        await prisma.ciPipeline
          .update({
            where: { id: row.id },
            data: { status: "success", conclusion: "success", lastError: null },
          })
          .catch(() => {});
      }
    }
  }
}

/**
 * Boot the sweeper once per server process. Guarded on globalThis so dev-mode
 * hot reloads don't stack intervals.
 */
export function startPipelineSweeper(): void {
  const g = globalThis as { __ddaPipelineSweeper?: boolean };
  if (g.__ddaPipelineSweeper) return;
  g.__ddaPipelineSweeper = true;
  // First sweep shortly after boot (give the server a beat to settle), then
  // on the interval. Errors are contained per-sweep — the loop never dies.
  setTimeout(() => void sweepOnce().catch(() => {}), 10_000);
  setInterval(() => void sweepOnce().catch(() => {}), SWEEP_MS);
}
