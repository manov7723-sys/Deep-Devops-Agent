import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { findRun, getRunStatus, workflowFileName } from "@/lib/ci/github-actions";
import { autoHealPipeline, MAX_HEAL_ATTEMPTS } from "@/lib/ci/auto-heal";

/**
 * Live status of a pipeline's GitHub Actions run: jobs/steps with pass/fail,
 * the run link, and the failed step. When the run failed and `agentReview` is
 * on, kick off one auto-heal cycle (fix + re-run) and report it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const p = await prisma.ciPipeline.findFirst({
    where: { id, projectId: gate.access.project.id },
    select: {
      id: true, status: true, agentReview: true, healAttempts: true, branch: true,
      runId: true, runUrl: true, conclusion: true, stages: true, lastError: true,
      workflowPath: true, commitSha: true, repoId: true,
    },
  });
  if (!p) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  // Not running / never run — return the cached snapshot.
  if (p.status === "draft" || (!p.runId && !p.commitSha)) {
    return NextResponse.json(snapshot(p, { healing: false }));
  }

  const repo = await prisma.repo.findUnique({ where: { id: p.repoId }, select: { fullName: true } });
  const tok = await resolveTokenForRepo(p.repoId);
  if (!repo || !tok.ok) return NextResponse.json(snapshot(p, { healing: false }));
  const gh = { token: tok.accessToken, repoFullName: repo.fullName };

  // Resolve runId if the run route couldn't find it yet.
  let runId = p.runId;
  if (!runId) {
    const wfName = workflowFileName(p.workflowPath);
    const run = wfName ? await findRun(gh, wfName, p.branch, p.commitSha ?? undefined) : null;
    if (run) {
      runId = String(run.id);
      await prisma.ciPipeline.update({ where: { id }, data: { runId, runUrl: run.url } });
    }
  }
  if (!runId) return NextResponse.json(snapshot(p, { healing: false }));

  const live = await getRunStatus(gh, runId);
  if (!live) return NextResponse.json(snapshot(p, { healing: false }));

  const done = live.status === "completed";
  const failed = done && live.conclusion !== "success";
  const newStatus = !done ? "running" : failed ? "failed" : "success";
  const failedStep = failed
    ? live.stages.flatMap((s) => s.steps).find((s) => s.conclusion === "failure")?.name ?? null
    : null;
  const lastError = failed ? `Failed: ${failedStep ?? live.conclusion ?? "run failed"}` : null;

  await prisma.ciPipeline.update({
    where: { id },
    data: { status: newStatus, conclusion: live.conclusion, runUrl: live.url, stages: live.stages, lastError },
  });

  // Agent reviewer: on failure, auto-heal once (fix + re-run), if budget left.
  let healing = false;
  let healNote: string | null = null;
  if (failed && p.agentReview && p.healAttempts < MAX_HEAL_ATTEMPTS) {
    const heal = await autoHealPipeline(id);
    if (heal.ok && heal.healed) {
      healing = true;
      healNote = `Agent reviewer fixed the workflow and re-ran it (attempt ${heal.attempt}/${MAX_HEAL_ATTEMPTS}).`;
    } else if (heal.ok) {
      healNote = `Agent reviewer: ${heal.reason}.`;
    } else {
      healNote = `Agent reviewer error: ${heal.error}`;
    }
  } else if (failed && p.agentReview) {
    healNote = `Agent reviewer stopped after ${MAX_HEAL_ATTEMPTS} attempts — needs a human.`;
  }

  const fresh = await prisma.ciPipeline.findUnique({
    where: { id },
    select: {
      status: true, agentReview: true, healAttempts: true, runUrl: true,
      conclusion: true, stages: true, lastError: true,
    },
  });
  return NextResponse.json({ ...snapshot(fresh ?? p, { healing }), healNote });
}

function snapshot(
  p: {
    status: string; agentReview: boolean; healAttempts: number; runUrl: string | null;
    conclusion: string | null; stages: unknown; lastError: string | null;
  },
  extra: { healing: boolean },
) {
  return {
    status: p.status,
    agentReview: p.agentReview,
    healAttempts: p.healAttempts,
    maxHealAttempts: MAX_HEAL_ATTEMPTS,
    runUrl: p.runUrl,
    conclusion: p.conclusion,
    stages: p.stages ?? [],
    lastError: p.lastError,
    healing: extra.healing,
  };
}
