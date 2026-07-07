import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listDeployTargets } from "@/lib/devops/deploy";
import { listWorkloads } from "@/lib/devops/workloads";
import { scaleDeployment, restartDeployment } from "@/lib/devops/kube-actions";

/**
 * Live cluster workloads console (distinct from the DB-backed /workloads insights).
 *   GET ?envKey&namespace → the env's live Deployments + pods (and deployable envs).
 *   POST { action, envKey, appName, replicas?, namespace? } → scale or restart.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const targets = await listDeployTargets(gate.access.project.id);
  const url = new URL(req.url);
  const envKey = url.searchParams.get("envKey") || targets[0]?.envKey || "";
  const namespace = url.searchParams.get("namespace") || undefined;
  if (!envKey) return NextResponse.json({ ok: true, targets, envKey: "", namespace: "", workloads: [] });

  const res = await listWorkloads(gate.access.project.id, gate.access.session.userId, envKey, namespace);
  if (!res.ok) return NextResponse.json({ ok: true, targets, envKey, namespace: "", workloads: [], error: res.error });
  return NextResponse.json({ ok: true, targets, envKey, namespace: res.namespace, workloads: res.workloads });
}

const Body = z.object({
  action: z.enum(["scale", "restart"]),
  envKey: z.string().trim().min(1),
  appName: z.string().trim().min(1),
  replicas: z.number().int().min(0).max(50).optional(),
  namespace: z.string().trim().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message }, { status: 400 });
  const b = parsed.data;
  const projectId = gate.access.project.id;

  if (b.action === "scale") {
    if (b.replicas == null) return NextResponse.json({ ok: false, message: "replicas is required to scale." }, { status: 400 });
    const res = await scaleDeployment(projectId, b.envKey, b.appName, b.replicas, b.namespace);
    if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
    return NextResponse.json({ ok: true, message: `Scaled ${res.app} to ${res.replicas} replica${res.replicas === 1 ? "" : "s"}.` });
  }

  const res = await restartDeployment(projectId, b.envKey, b.appName, b.namespace);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, message: `Restarting ${res.app}…` });
}
