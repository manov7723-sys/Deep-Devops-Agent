import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getApproval } from "@/lib/devops/approvals";

/**
 * Bare object — `useApprovalDetail()` consumes the response directly (no
 * envelope), mirroring the list endpoint at `/approvals` which returns a bare
 * array.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const approval = await getApproval(gate.access.project.id, id);
  if (!approval) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json(approval);
}
