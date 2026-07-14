import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { syncCloudInventory } from "@/lib/cloud/inventory-sync";

/**
 * POST /projects/[slug]/cloud/sync
 * Pull live compute resources from the connected cloud(s) into ManagedResource
 * so the Cloud Stats dashboard shows real inventory. Replaces the compute rows.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const res = await syncCloudInventory(gate.access.project.id, gate.access.session.userId);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json(res);
}
