import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getTopology } from "@/lib/observability/topology";

/**
 * GET /projects/[slug]/topology?envKey=
 * The env's cluster wiring grouped by app (Ingress → Service → Deployment → Pods).
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const sp = new URL(req.url).searchParams;
  const envKey = (sp.get("envKey") || "").trim();
  const namespace = (sp.get("namespace") || "").trim();
  if (!envKey)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "envKey is required." },
      { status: 400 },
    );
  const topo = await getTopology(gate.access.project.id, envKey, namespace || undefined);
  if (!topo.ok) return NextResponse.json({ ok: false, message: topo.error }, { status: 400 });
  return NextResponse.json(topo);
}
