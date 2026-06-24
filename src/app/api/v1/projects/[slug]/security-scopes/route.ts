import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listBindingsForProject } from "@/lib/insights/security-scopes";

/**
 * Project-wide view of every env→scope binding in this project. Useful for
 * the "Security" tab on the project settings page.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const bindings = await listBindingsForProject(gate.access.project.id);
  return NextResponse.json(bindings);
}
