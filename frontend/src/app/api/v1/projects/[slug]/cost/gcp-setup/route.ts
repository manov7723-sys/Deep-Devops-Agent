import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import { prepareGcpForCost } from "@/lib/cloud/gcp-cost";

/**
 * POST /projects/[slug]/cost/gcp-setup
 *
 * Automates the GCP cost steps that HAVE an API: enables the BigQuery API and
 * creates the export dataset, then stores the dataset id on the GCP provider.
 * The one step with no API — toggling Billing → BigQuery export — stays manual.
 */
const Body = z.object({
  datasetId: z.string().trim().regex(/^[A-Za-z0-9_]{1,1024}$/, "letters, numbers, underscores only"),
  location: z.string().trim().min(1).max(40).default("US"),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message }, { status: 400 });

  const cp = await prisma.cloudProvider.findFirst({ where: { projectId: gate.access.project.id, kind: "gcp" }, select: { id: true } });
  if (!cp) return NextResponse.json({ ok: false, code: "no_gcp", message: "No GCP provider connected to this project." }, { status: 400 });

  const res = await prepareGcpForCost(cp.id, parsed.data.datasetId, parsed.data.location);
  if (!res.ok) return NextResponse.json({ ok: false, code: "gcp_setup_failed", message: res.error }, { status: 400 });

  await prisma.cloudProvider.update({ where: { id: cp.id }, data: { costDatasetId: parsed.data.datasetId } });

  return NextResponse.json({
    ok: true,
    project: res.data.project,
    datasetId: res.data.datasetId,
    nextStep: "Now enable Billing → BigQuery export to this dataset in the GCP console (the one step with no API). Cost appears within a few hours.",
  });
}
