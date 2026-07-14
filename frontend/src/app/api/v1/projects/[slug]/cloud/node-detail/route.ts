import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getNodeDetail } from "@/lib/observability/node-ops";

/**
 * GET /projects/[slug]/cloud/node-detail?envKey=&node=
 * Live CPU/memory + the pods running on a Kubernetes node.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const sp = new URL(req.url).searchParams;
  const envKey = (sp.get("envKey") || "").trim();
  const node = (sp.get("node") || "").trim();
  if (!envKey || !node)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "envKey and node are required." },
      { status: 400 },
    );
  const res = await getNodeDetail(gate.access.project.id, envKey, node);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json(res);
}
