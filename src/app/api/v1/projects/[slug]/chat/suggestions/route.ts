import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listSuggestions } from "@/lib/agentops/chat";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const suggestions = await listSuggestions(gate.access.project.id);
  return NextResponse.json(suggestions);
}
