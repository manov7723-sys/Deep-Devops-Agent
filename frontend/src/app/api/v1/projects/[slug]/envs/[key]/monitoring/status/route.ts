import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { monitoringStatus, appDashboardUid, installPhaseView } from "@/lib/observability/cluster-monitoring";

/**
 * GET /projects/[slug]/envs/[key]/monitoring/status
 *
 * Report whether the in-cluster monitoring stack (Model B) is installed and how
 * many pods are ready, so the UI can show "Install", "Provisioning…" or "Live".
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const status = await monitoringStatus(env.id);
  // namespace is where THIS app's workloads run — the client scopes every query
  // to it so the panel shows only this application, not the whole cluster.
  // grafanaUid identifies the auto-provisioned app dashboard for the embed.
  // installing/installError reflect the background helm run (see install route).
  return NextResponse.json({
    ok: true,
    namespace: env.namespace,
    grafanaUid: appDashboardUid(env.id),
    ...(await installPhaseView(env.id)),
    ...status,
  });
}
