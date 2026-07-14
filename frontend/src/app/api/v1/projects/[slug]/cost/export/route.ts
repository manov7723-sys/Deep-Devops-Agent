import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getLatestSnapshot, listTrend } from "@/lib/insights/cost";

/**
 * GET /projects/[slug]/cost/export?format=csv
 *
 * Streams a CSV file of the project's cost data. Three sections, each
 * preceded by a one-line title row so a human reading the CSV can tell
 * them apart:
 *
 *   # Monthly trend                            (one row per CostTrendPoint)
 *   # Latest snapshot — by environment         (rows from snapshot.byEnv)
 *   # Latest snapshot — by service             (rows from snapshot.byService)
 *   # Snapshot history                         (each persisted CostSnapshot)
 *
 * `Content-Disposition: attachment` triggers a save dialog so the existing
 * "Export CSV" button can just navigate to this URL without an SPA download
 * shim.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) {
    return new Response("Forbidden", { status: gate.status });
  }
  const [snapshot, trend, history] = await Promise.all([
    getLatestSnapshot(gate.access.project.id),
    listTrend(gate.access.project.id),
    prisma.costSnapshot.findMany({
      where: { projectId: gate.access.project.id },
      orderBy: { periodStart: "desc" },
      take: 24,
      select: {
        periodStart: true,
        totalCents: true,
        forecastCents: true,
        budgetCents: true,
        _count: { select: { byEnv: true, byService: true } },
      },
    }),
  ]);

  const filename = `${slug}-cost-${new Date().toISOString().slice(0, 10)}.csv`;

  const sb: string[] = [];

  sb.push("# Monthly trend");
  sb.push("month,amount_dollars");
  for (const p of trend) {
    sb.push(
      [new Date(p.monthStart).toISOString().slice(0, 7), (p.amountCents / 100).toFixed(2)].join(
        ",",
      ),
    );
  }
  sb.push("");

  sb.push("# Latest snapshot — by environment");
  sb.push("env,amount_dollars,pct");
  if (snapshot) {
    const total = snapshot.byEnv.reduce((sum, r) => sum + r.amountCents, 0) || 1;
    for (const r of snapshot.byEnv) {
      sb.push(
        [
          csvField(r.label),
          (r.amountCents / 100).toFixed(2),
          Math.round((r.amountCents / total) * 100),
        ].join(","),
      );
    }
  }
  sb.push("");

  sb.push("# Latest snapshot — by service");
  sb.push("service,amount_dollars,pct");
  if (snapshot) {
    const total = snapshot.byService.reduce((sum, r) => sum + r.amountCents, 0) || 1;
    for (const r of snapshot.byService) {
      sb.push(
        [
          csvField(r.service),
          (r.amountCents / 100).toFixed(2),
          r.pct ?? Math.round((r.amountCents / total) * 100),
        ].join(","),
      );
    }
  }
  sb.push("");

  sb.push("# Snapshot history");
  sb.push("period_start,total_dollars,forecast_dollars,budget_dollars,env_count,service_count");
  for (const s of history) {
    sb.push(
      [
        new Date(s.periodStart).toISOString().slice(0, 10),
        (s.totalCents / 100).toFixed(2),
        s.forecastCents != null ? (s.forecastCents / 100).toFixed(2) : "",
        s.budgetCents != null ? (s.budgetCents / 100).toFixed(2) : "",
        s._count.byEnv,
        s._count.byService,
      ].join(","),
    );
  }

  return new Response(sb.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** RFC 4180 — quote fields that contain commas, quotes, or newlines. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
