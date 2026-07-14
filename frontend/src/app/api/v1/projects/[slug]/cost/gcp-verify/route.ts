import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import { verifyGcpCost } from "@/lib/cloud/gcp-cost";

/**
 * POST /projects/[slug]/cost/gcp-verify
 *
 * Diagnose the GCP cost setup and report the exact stage: auth / no_dataset /
 * no_export / ok (with month-to-date spend). Lets the user confirm whether the
 * BigQuery billing export is live without guessing.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "gcp" },
    select: { id: true, costDatasetId: true },
  });
  if (!cp)
    return NextResponse.json(
      { ok: false, code: "no_gcp", message: "No GCP provider connected to this project." },
      { status: 400 },
    );
  if (!cp.costDatasetId) {
    return NextResponse.json({
      ok: true,
      stage: "no_dataset",
      message: 'GCP cost isn\'t set up yet. Click "Prepare GCP for cost" first.',
    });
  }

  const diag = await verifyGcpCost(cp.id, cp.costDatasetId, new Date());
  return NextResponse.json({ ok: true, ...diag });
}
