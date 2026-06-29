import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getThreadDetail } from "@/lib/agentops/chat";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const detail = await getThreadDetail(gate.access.project.id, id);
  if (!detail) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}
