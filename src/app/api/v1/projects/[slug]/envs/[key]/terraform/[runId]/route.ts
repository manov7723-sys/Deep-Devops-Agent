import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getTerraformRun } from "@/lib/devops/terraform-run";

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
