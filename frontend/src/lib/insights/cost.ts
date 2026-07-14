/**
 * Cost snapshots. Each snapshot is the monthly slice for a project; the
 * 12-month trend is stored as a separate per-month series. Integer cents only.
 */
import type { CostByEnv, CostByService, CostSnapshot } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type CostSnapshotRow = {
  id: string;
  periodStart: string;
  totalCents: number;
  forecastCents: number | null;
  budgetCents: number | null;
  savingsCents: number | null;
  untaggedCents: number | null;
  byEnv: Array<{ envKey: string | null; label: string; amountCents: number }>;
  byService: Array<{ service: string; amountCents: number; pct: number | null }>;
  createdAt: string;
};

function row(
  s: CostSnapshot & {
    byEnv: Array<CostByEnv & { env: { key: string } | null }>;
    byService: CostByService[];
  },
): CostSnapshotRow {
  return {
    id: s.id,
    periodStart: s.periodStart.toISOString(),
    totalCents: s.totalCents,
    forecastCents: s.forecastCents,
    budgetCents: s.budgetCents,
    savingsCents: s.savingsCents,
    untaggedCents: s.untaggedCents,
    byEnv: s.byEnv.map((e) => ({
      envKey: e.env?.key ?? null,
      label: e.label,
      amountCents: e.amountCents,
    })),
    byService: s.byService.map((sv) => ({
      service: sv.service,
      amountCents: sv.amountCents,
      pct: sv.pct,
    })),
    createdAt: s.createdAt.toISOString(),
  };
}

export async function getLatestSnapshot(projectId: string): Promise<CostSnapshotRow | null> {
  const s = await prisma.costSnapshot.findFirst({
    where: { projectId },
    orderBy: { periodStart: "desc" },
    include: {
      byEnv: { include: { env: { select: { key: true } } } },
      byService: true,
    },
  });
  return s ? row(s) : null;
}

export async function listTrend(
  projectId: string,
): Promise<Array<{ monthStart: string; amountCents: number }>> {
  const rows = await prisma.costTrendPoint.findMany({
    where: { projectId },
    orderBy: { monthStart: "asc" },
  });
  return rows.map((p) => ({
    monthStart: p.monthStart.toISOString(),
    amountCents: p.amountCents,
  }));
}

export type CreateSnapshotArgs = {
  projectId: string;
  periodStart: Date;
  totalCents: number;
  forecastCents?: number;
  budgetCents?: number;
  savingsCents?: number;
  untaggedCents?: number;
  byEnv: Array<{ envId?: string; label: string; amountCents: number }>;
  byService: Array<{ service: string; amountCents: number; pct?: number }>;
};

export async function upsertSnapshot(args: CreateSnapshotArgs): Promise<CostSnapshotRow> {
  // The schema has @@unique([projectId, periodStart]); replace any existing
  // snapshot for that month so callers can re-run an ETL safely.
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.costSnapshot.findUnique({
      where: {
        projectId_periodStart: { projectId: args.projectId, periodStart: args.periodStart },
      },
      select: { id: true },
    });
    if (existing) {
      await tx.costByEnv.deleteMany({ where: { snapshotId: existing.id } });
      await tx.costByService.deleteMany({ where: { snapshotId: existing.id } });
      await tx.costSnapshot.delete({ where: { id: existing.id } });
    }
    const created = await tx.costSnapshot.create({
      data: {
        projectId: args.projectId,
        periodStart: args.periodStart,
        totalCents: args.totalCents,
        forecastCents: args.forecastCents ?? null,
        budgetCents: args.budgetCents ?? null,
        savingsCents: args.savingsCents ?? null,
        untaggedCents: args.untaggedCents ?? null,
        byEnv: {
          create: args.byEnv.map((e) => ({
            envId: e.envId ?? null,
            label: e.label,
            amountCents: e.amountCents,
          })),
        },
        byService: {
          create: args.byService.map((sv) => ({
            service: sv.service,
            amountCents: sv.amountCents,
            pct: sv.pct ?? null,
          })),
        },
      },
      include: {
        byEnv: { include: { env: { select: { key: true } } } },
        byService: true,
      },
    });

    // Roll the 12-month trend point for this month forward as well.
    await tx.costTrendPoint.upsert({
      where: {
        projectId_monthStart: { projectId: args.projectId, monthStart: args.periodStart },
      },
      create: {
        projectId: args.projectId,
        monthStart: args.periodStart,
        amountCents: args.totalCents,
      },
      update: { amountCents: args.totalCents },
    });

    return created;
  });
  return row(result);
}
