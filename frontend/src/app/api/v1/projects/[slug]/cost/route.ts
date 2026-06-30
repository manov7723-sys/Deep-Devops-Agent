import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getLatestSnapshot, listTrend } from "@/lib/insights/cost";

/**
 * Returns both display strings AND raw numbers so the client can do math
 * (% of budget, chart heights, budget line) AND render currency labels.
 *
 * Display strings:
 *   monthTotal / forecast / savings / untagged   — "$2.4k" formatted
 *
 * Raw numbers — dollars:
 *   monthTotalDollars / forecastDollars / budget / monthly[] / trend[]
 *
 * Trend / monthly: the most recent N months of spend (oldest → newest).
 * Both names point at the same array — `trend` for the spark line on the
 * Stat card, `monthly` for the bar chart on the cost page.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const [snapshot, trendRows] = await Promise.all([
    getLatestSnapshot(gate.access.project.id),
    listTrend(gate.access.project.id),
  ]);

  const monthCents = snapshot?.totalCents ?? 0;
  const forecastCents = snapshot?.forecastCents ?? 0;
  const budgetCents = snapshot?.budgetCents ?? 0;
  const savingsCents = snapshot?.savingsCents ?? 0;
  const untaggedCents = snapshot?.untaggedCents ?? 0;
  const byEnvRaw = snapshot?.byEnv ?? [];
  const byServiceRaw = snapshot?.byService ?? [];
  const totalForPct = byEnvRaw.reduce((sum, r) => sum + r.amountCents, 0) || 1;

  const monthlyDollars = trendRows.map((p) => Math.round(p.amountCents / 100));

  return NextResponse.json({
    snapshot,
    // Display strings — what the StatCard / Badge components show as-is.
    monthTotal: formatMoneyK(monthCents),
    forecast: formatMoneyK(forecastCents),
    savings: formatMoneyK(savingsCents),
    untagged: formatMoneyK(untaggedCents),

    // Raw dollar amounts — for math: % of budget, chart heights, budget line.
    monthTotalDollars: Math.round(monthCents / 100),
    forecastDollars: Math.round(forecastCents / 100),
    budget: Math.round(budgetCents / 100),
    savingsDollars: Math.round(savingsCents / 100),
    untaggedDollars: Math.round(untaggedCents / 100),

    // The same series under two names: `trend` for the Stat spark line,
    // `monthly` for the Bars chart on the cost page.
    monthly: monthlyDollars,
    trend: monthlyDollars,

    // Raw rows so consumers can build their own representations.
    trendRows,

    byEnv: byEnvRaw.map((row, i) => ({
      name: row.label,
      value: Math.round(row.amountCents / 100),
      color: PALETTE[i % PALETTE.length],
    })),
    byService: byServiceRaw.map((row) => ({
      name: row.service,
      value: Math.round(row.amountCents / 100),
      total: formatMoneyK(row.amountCents),
      pct: row.pct ?? Math.round((row.amountCents / totalForPct) * 100),
    })),
  });
}

const PALETTE = ["#7c3aed", "#2779ff", "#16a34a", "#ea580c", "#0ea5e9"];

function formatMoneyK(cents: number): string {
  if (cents === 0) return "$0";
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${Math.round(dollars)}`;
}
