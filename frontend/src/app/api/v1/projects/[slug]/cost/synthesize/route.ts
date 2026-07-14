import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { upsertSnapshot } from "@/lib/insights/cost";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/cost/synthesize
 *
 * Derives a cost snapshot from the project's *current* state — ManagedResource
 * rows grouped by env + category, with a simple price model per resource
 * category. This is the stand-in for a real CUR / Cost Explorer ETL until
 * that infra is wired; the shape (CostSnapshot + CostByEnv + CostByService)
 * is identical so the downstream cards work either way.
 *
 * Body:
 *   { periodStart?: ISO date (defaults: 1st of current UTC month),
 *     budgetCents?:  number   (defaults: max(synthesized, current budget) * 1.2) }
 */
const RESOURCE_PRICE_CENTS: Record<string, number> = {
  compute: 18_000, // ~$180/mo per compute resource (small EC2/EKS node)
  storage: 4_500,
  network: 2_200,
  data: 25_000, // RDS-class — biggest single line item
  cache: 6_500,
  security: 1_500,
  other: 1_000,
};
const SECURITY_DIRECT_COST_CENTS = 12_000; // per CloudSecurityScope baseline

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const projectId = gate.access.project.id;
  const body = (await req.json().catch(() => ({}))) as {
    periodStart?: string;
    budgetCents?: number;
  };

  // Default to the first of the current UTC month.
  const now = new Date();
  const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = body.periodStart ? new Date(body.periodStart) : defaultStart;
  if (Number.isNaN(periodStart.getTime())) {
    return NextResponse.json(
      { ok: false, code: "invalid_period", message: "periodStart must be an ISO date." },
      { status: 400 },
    );
  }

  // Pull the current state we'll derive cost from.
  const [resources, envs, scopes] = await Promise.all([
    prisma.managedResource.findMany({
      where: { projectId, enabled: true },
      select: { id: true, category: true, envId: true, type: true },
    }),
    prisma.env.findMany({
      where: { projectId },
      select: { id: true, key: true, name: true },
    }),
    prisma.cloudSecurityScope.findMany({
      where: { cloudProvider: { environments: { some: { projectId } } } },
      select: { id: true },
    }),
  ]);

  // Aggregate by env and by category.
  const byEnvAcc = new Map<string, number>(); // envId → cents
  const byServiceAcc = new Map<string, number>(); // serviceLabel → cents
  let total = 0;

  for (const r of resources) {
    const price = RESOURCE_PRICE_CENTS[r.category] ?? RESOURCE_PRICE_CENTS.other;
    total += price;
    byEnvAcc.set(r.envId, (byEnvAcc.get(r.envId) ?? 0) + price);
    // Use the resource's `type` ("EKS · 6 nodes", "RDS Postgres · db.r6g.xlarge")
    // as the service label, falling back to the category title-cased.
    const serviceLabel = r.type ?? r.category.charAt(0).toUpperCase() + r.category.slice(1);
    byServiceAcc.set(serviceLabel, (byServiceAcc.get(serviceLabel) ?? 0) + price);
  }

  // Add a flat baseline for each security scope bound to the project envs.
  const scopeCost = scopes.length * SECURITY_DIRECT_COST_CENTS;
  if (scopeCost > 0) {
    total += scopeCost;
    byServiceAcc.set("Security baselines", scopeCost);
  }

  // If a project has no resources yet, still write a zero snapshot so the
  // Cost tab renders past entries instead of an empty state forever.
  const envById = new Map(envs.map((e) => [e.id, e]));
  const byEnv: Array<{ envId?: string; label: string; amountCents: number }> = envs.map((e) => ({
    envId: e.id,
    label: e.name,
    amountCents: byEnvAcc.get(e.id) ?? 0,
  }));
  // Include any orphaned envIds we didn't recognize (deleted envs etc.) as
  // a "Shared" bucket — small belt-and-suspenders so we never lose dollars.
  for (const [envId, cents] of byEnvAcc) {
    if (!envById.has(envId)) {
      byEnv.push({ label: "Shared (unknown env)", amountCents: cents });
    }
  }

  const byService = [...byServiceAcc.entries()]
    .map(([service, amountCents]) => ({ service, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents);

  const projection = projectFullMonth(total, periodStart, now);
  const previousBudget = (
    await prisma.costSnapshot.findFirst({
      where: { projectId },
      orderBy: { periodStart: "desc" },
      select: { budgetCents: true },
    })
  )?.budgetCents;
  const budgetCents =
    body.budgetCents ??
    (previousBudget && previousBudget > total ? previousBudget : Math.round(projection * 1.2));

  const snapshot = await upsertSnapshot({
    projectId,
    periodStart,
    totalCents: total,
    forecastCents: projection,
    budgetCents,
    savingsCents: 0,
    untaggedCents: 0,
    byEnv,
    byService,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId,
    action: "cost.snapshot_recorded",
    targetType: "cost_snapshot",
    targetId: snapshot.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      synthesized: true,
      totalCents: total,
      forecastCents: projection,
      resources: resources.length,
    },
  });
  await recordActivity({
    projectId,
    actorUserId: gate.access.session.userId,
    action: "recorded",
    targetType: "cost_snapshot",
    targetLabel: `${formatMoney(total)} for ${periodStart.toISOString().slice(0, 7)}`,
    icon: "dollar",
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    snapshot,
    summary: {
      resources: resources.length,
      envs: envs.length,
      services: byService.length,
      totalCents: total,
      forecastCents: projection,
      budgetCents,
    },
  });
}

/**
 * Linearly extrapolate the current month-to-date spend to a full-month
 * forecast. If we're called on the 1st, just return the actual.
 */
function projectFullMonth(mtdCents: number, periodStart: Date, now: Date): number {
  const monthEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
  );
  const daysInMonth = (monthEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000);
  const daysElapsed = Math.max(
    1,
    Math.min(daysInMonth, (now.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000)),
  );
  return Math.round((mtdCents / daysElapsed) * daysInMonth);
}

function formatMoney(cents: number): string {
  if (cents >= 100 * 1000) return `$${Math.round(cents / 100 / 1000)}k`;
  return `$${Math.round(cents / 100)}`;
}
