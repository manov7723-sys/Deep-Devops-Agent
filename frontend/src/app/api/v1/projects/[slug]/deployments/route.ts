import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listDeploymentRecords } from "@/lib/devops/deploy-history";

/** Deployment history for a project (GET → most-recent-first). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const deployments = await listDeploymentRecords(gate.access.project.id);
  return NextResponse.json({ ok: true, deployments });
}
