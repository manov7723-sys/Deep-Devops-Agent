import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { analyzeCostOptimization } from "@/lib/insights/cost-optim";

/**
 * POST /projects/[slug]/cost/optimize
 * Analyze cluster utilization + cost drivers and return savings recommendations.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const report = await analyzeCostOptimization(gate.access.project.id);
  return NextResponse.json(report);
}
