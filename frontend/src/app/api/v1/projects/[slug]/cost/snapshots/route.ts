import { NextResponse } from "next/server";
import { CreateCostSnapshotRequest } from "@/lib/api/schemas/insights-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { upsertSnapshot } from "@/lib/insights/cost";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = CreateCostSnapshotRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  // Resolve envKey → envId per byEnv row that has one.
  const byEnv: Array<{ envId?: string; label: string; amountCents: number }> = [];
  for (const e of parsed.data.byEnv) {
    if (e.envKey) {
      const env = await envBySlugAndKey(gate.access.project.id, e.envKey);
      if (!env) {
        return NextResponse.json(
          { ok: false, code: "env_not_found", message: `byEnv references unknown env "${e.envKey}"` },
          { status: 400 },
        );
      }
      byEnv.push({ envId: env.id, label: e.label, amountCents: e.amountCents });
    } else {
      byEnv.push({ label: e.label, amountCents: e.amountCents });
    }
  }

  const snapshot = await upsertSnapshot({
    projectId: gate.access.project.id,
    periodStart: new Date(parsed.data.periodStart),
    totalCents: parsed.data.totalCents,
    forecastCents: parsed.data.forecastCents,
    budgetCents: parsed.data.budgetCents,
    savingsCents: parsed.data.savingsCents,
    untaggedCents: parsed.data.untaggedCents,
    byEnv,
    byService: parsed.data.byService,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "cost.snapshot_recorded",
    targetType: "cost_snapshot",
    targetId: snapshot.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { periodStart: parsed.data.periodStart, totalCents: parsed.data.totalCents },
  });
  return NextResponse.json({ ok: true, snapshot });
}
