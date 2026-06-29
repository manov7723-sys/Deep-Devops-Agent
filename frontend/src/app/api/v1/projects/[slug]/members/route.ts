import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listMembers } from "@/lib/projects/projects";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const members = await listMembers(gate.access.project.id);
  return NextResponse.json(members);
}
