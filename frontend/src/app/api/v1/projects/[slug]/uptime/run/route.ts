import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { runAllNow } from "@/lib/observability/uptime";

/** POST /projects/[slug]/uptime/run — check all enabled monitors right now. */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const ran = await runAllNow(gate.access.project.id);
  return NextResponse.json({ ok: true, ran });
}
