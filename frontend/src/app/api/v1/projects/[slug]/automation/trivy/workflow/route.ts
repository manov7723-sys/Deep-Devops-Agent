import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { generateTrivyWorkflow } from "@/lib/ci/templates";

/**
 * POST /projects/[slug]/automation/trivy/workflow
 *
 * Returns the vetted Trivy CI workflow file so scanning also runs on every
 * push/PR. No repo analysis needed — the workflow is the same for any stack.
 * The client opens a PR via /infra/push.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const file = generateTrivyWorkflow();
  return NextResponse.json({
    ok: true,
    files: [file],
    notes: [
      "Scans dependencies, secrets and misconfigurations on push/PR.",
      "Fails the build on HIGH/CRITICAL findings that have a fix available (ignore-unfixed).",
    ],
  });
}
