import { NextResponse } from "next/server";
import { TriggerDeploymentRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { listDeployments, triggerDeployment } from "@/lib/devops/deployments";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const deployments = await listDeployments(env.id);
  return NextResponse.json(deployments);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const parsed = TriggerDeploymentRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await triggerDeployment({
    envId: env.id,
    projectId: gate.access.project.id,
    triggeredById: gate.access.session.userId,
    repos: parsed.data.repos,
    note: parsed.data.note,
    stageLabels: parsed.data.stages,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: res.code }, { status: 400 });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "deployment.triggered",
    targetType: "deployment",
    targetId: res.deploymentId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: key, sequence: res.sequence, pipelineId: res.pipelineId },
  });
  return NextResponse.json({
    ok: true,
    deploymentId: res.deploymentId,
    pipelineId: res.pipelineId,
    sequence: res.sequence,
  });
}
