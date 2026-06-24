import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/cost/history
 *
 * All CostSnapshot rows for the project, newest first. Each row is the
 * monthly aggregate written either by the synthesize endpoint or by a real
 * billing-API ETL. Used by the Cost tab "Snapshot history" block.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const rows = await prisma.costSnapshot.findMany({
    where: { projectId: gate.access.project.id },
    orderBy: { periodStart: "desc" },
    take: 24,
    select: {
      id: true,
      periodStart: true,
      totalCents: true,
      forecastCents: true,
      budgetCents: true,
      savingsCents: true,
      untaggedCents: true,
      _count: { select: { byEnv: true, byService: true } },
    },
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      periodStart: r.periodStart.toISOString(),
      totalCents: r.totalCents,
      forecastCents: r.forecastCents,
      budgetCents: r.budgetCents,
      savingsCents: r.savingsCents,
      untaggedCents: r.untaggedCents,
      envCount: r._count.byEnv,
      serviceCount: r._count.byService,
    })),
  );
}
