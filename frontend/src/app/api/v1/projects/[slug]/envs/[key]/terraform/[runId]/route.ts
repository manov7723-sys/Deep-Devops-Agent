import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { prisma } from "@/lib/db/prisma";
import { deleteTerraformRun, getTerraformRun } from "@/lib/devops/terraform-run";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Poll a single Terraform run's status + per-stage logs. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; key: string; runId: string }> },
) {
  const { slug, key, runId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const run = getTerraformRun(runId);
  // Scope the run to this env so one project can't read another's runs.
  if (!run || run.envId !== env.id) {
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, run });
}

/**
 * DELETE a terraform run from the pipeline list. Only removes the run record
 * (in-memory + DB row); it does NOT touch the underlying cloud infrastructure
 * or the state file — that's the whole point of state being remote.
 *
 * Guardrail: can't delete a run that's still queued/running (avoid dangling
 * background work + confusing polling loops on other tabs).
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string; runId: string }> },
) {
  const { slug, key, runId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  // Verify the run actually belongs to this env before deleting — same scoping
  // guard as the GET handler above, applied against either the in-memory ring
  // or the DB (in case the run was already evicted from memory).
  const inMem = getTerraformRun(runId);
  if (inMem) {
    if (inMem.envId !== env.id) {
      return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
    }
  } else {
    const row = await prisma.tfRun.findUnique({ where: { id: runId }, select: { envId: true } });
    if (!row || row.envId !== env.id) {
      return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
    }
  }

  const res = await deleteTerraformRun(runId);
  if (!res.deleted) {
    return NextResponse.json(
      { ok: false, code: "conflict", message: res.reason ?? "Could not delete run." },
      { status: 409 },
    );
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "terraform.run_deleted",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { runId },
  });

  return NextResponse.json({ ok: true });
}
