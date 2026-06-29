import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { appHealth } from "@/lib/observability/cluster-monitoring";

/**
 * GET /projects/[slug]/envs/[key]/monitoring/health?namespace=…
 *
 * Plain "is my app up?" per workload — for the non-DevOps view. No PromQL.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const namespace = new URL(req.url).searchParams.get("namespace") || env.namespace || "default";
  const res = await appHealth(env.id, namespace);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, namespace, apps: res.apps });
}
