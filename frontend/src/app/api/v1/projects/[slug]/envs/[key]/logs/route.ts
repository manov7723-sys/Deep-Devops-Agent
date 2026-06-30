import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { podLogs } from "@/lib/observability/cluster-logs";

/**
 * GET /projects/[slug]/envs/[key]/logs?namespace=…&pod=…&tail=…&previous=…&container=…
 * Read a pod's logs through the cluster connection (server-side, nothing exposed).
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const sp = new URL(req.url).searchParams;
  const pod = sp.get("pod");
  if (!pod) return NextResponse.json({ ok: false, message: "pod is required." }, { status: 400 });
  const namespace = sp.get("namespace") || env.namespace || "default";
  const tail = Number(sp.get("tail")) || undefined;
  const previous = sp.get("previous") === "true";
  const container = sp.get("container") || undefined;

  const res = await podLogs(env.id, namespace, pod, { tail, previous, container });
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json(res);
}
