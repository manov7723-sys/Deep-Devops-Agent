import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getTerraformRunAsync, rerunTerraformRun } from "@/lib/devops/terraform-run";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const RerunBody = z
  .object({
    /** Override the run's original action. Default: same as the source run. */
    action: z.enum(["plan", "apply"]).optional(),
  })
  .default({});

/**
 * Rerun a Terraform run — replays the exact same file set, stack, and backend
 * from the in-memory run store. Fails with 410 (gone) if the source has been
 * evicted from the ring buffer (i.e. > MAX_RUNS newer runs since).
 *
 * `apply` requires developer role; `plan` also since we conservatively re-use
 * the same gate for both.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string; runId: string }> },
) {
  const { slug, key, runId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const source = await getTerraformRunAsync(runId);
  if (!source) {
    return NextResponse.json({ ok: false, code: "run_not_found" }, { status: 404 });
  }
  if (source.projectId !== gate.access.project.id || source.envKey !== key) {
    return NextResponse.json({ ok: false, code: "wrong_project_or_env" }, { status: 404 });
  }

  const parsed = RerunBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const run = await rerunTerraformRun(runId, { action: parsed.data.action });
  if (!run) {
    return NextResponse.json(
      {
        ok: false,
        code: "source_evicted",
        message:
          "The source run's spec is no longer available (evicted from memory AND not found in the DB). Start a new run from the create form instead.",
      },
      { status: 410 },
    );
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "terraform.run_rerun",
    targetType: "env",
    targetId: source.envId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fromRunId: runId, newRunId: run.id, action: run.action, name: run.name },
  });

  return NextResponse.json({ ok: true, run });
}
