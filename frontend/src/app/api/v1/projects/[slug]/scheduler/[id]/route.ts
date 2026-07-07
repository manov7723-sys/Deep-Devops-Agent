import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { cancelScheduledDeploy } from "@/lib/devops/scheduled-deploy";

/** Cancel a pending scheduled deployment. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const ok = await cancelScheduledDeploy(gate.access.project.id, id);
  if (!ok) return NextResponse.json({ ok: false, message: "Only pending deployments can be cancelled." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
