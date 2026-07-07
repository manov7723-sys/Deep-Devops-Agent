import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { evaluateProjectCost } from "@/lib/insights/cost-eval";

/** POST /projects/[slug]/cost/refresh — fetch live cost, store it, raise/clear
 *  the budget alert, and return account + project spend. */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const res = await evaluateProjectCost(gate.access.project.id, new Date());
  if (!res.ok) return NextResponse.json({ ok: false, code: "cost_fetch_failed", message: res.error }, { status: 400 });
  return NextResponse.json(res);
}
