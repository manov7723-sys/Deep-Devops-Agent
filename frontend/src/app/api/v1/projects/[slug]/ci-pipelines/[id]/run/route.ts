import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { runCiPipeline } from "@/lib/ci/run-pipeline";

/**
 * Run pipeline: commit the saved files to the repo's DEFAULT branch (a no-op
 * if unchanged), trigger the GitHub Actions run (workflow_dispatch), record
 * the run so the status route can mirror it live. Shared with the
 * run_ci_pipeline agent tool via lib/ci/run-pipeline.ts.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const result = await runCiPipeline(id, gate.access.project.id);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : result.code === "repo_missing" || result.code === "github_auth" ? 409 : result.code === "no_files" ? 400 : 502;
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status });
  }
  return NextResponse.json({
    ok: true,
    commitSha: result.commitSha,
    runId: result.runId,
    runUrl: result.runUrl,
    message: result.message,
  });
}
