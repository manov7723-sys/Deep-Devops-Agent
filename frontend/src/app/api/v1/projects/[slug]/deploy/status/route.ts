import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { deployStatus } from "@/lib/devops/deploy";

/**
 * GET /projects/[slug]/deploy/status?envKey=&app=&namespace=
 * Poll the rollout health of a deployed app (Deployment ready count + Pods).
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const envKey = (url.searchParams.get("envKey") || "").trim();
  const app = (url.searchParams.get("app") || "").trim();
  const namespace = (url.searchParams.get("namespace") || "default").trim();
  if (!envKey || !app) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: "envKey and app are required." }, { status: 400 });
  }

  const status = await deployStatus(
    { projectId: gate.access.project.id, userId: gate.access.session.userId },
    { envKey },
    app,
    namespace,
  );
  if (!status.ok) return NextResponse.json({ ok: false, message: status.error }, { status: 400 });
  return NextResponse.json(status);
}
