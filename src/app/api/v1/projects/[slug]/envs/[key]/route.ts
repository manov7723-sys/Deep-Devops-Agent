import { NextResponse } from "next/server";
import { UpdateEnvRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { deleteEnv, envBySlugAndKey, updateEnv } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({
    env: {
      id: env.id,
      key: env.key,
      name: env.name,
      url: env.url,
      isProduction: env.isProduction,
      autoDeploy: env.autoDeploy,
      region: env.region,
      terraformWorkspace: env.terraformWorkspace,
      promotionRank: env.promotionRank,
      cloudProviderId: env.cloudProviderId,
      currentDeploymentId: env.currentDeploymentId,
      createdAt: env.createdAt.toISOString(),
      updatedAt: env.updatedAt.toISOString(),
    },
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = UpdateEnvRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await updateEnv(
    gate.access.project.id,
    gate.access.project.ownerId,
    key,
    parsed.data,
  );
  if (!res.ok) {
    const status = res.code === "not_found" ? 404 : 400;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.updated",
    targetType: "env",
    targetId: res.env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true, env: res.env });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const res = await deleteEnv(gate.access.project.id, key);
  if (!res.ok) {
    const status = res.code === "has_deployments" ? 409 : 404;
    const message =
      res.code === "has_deployments"
        ? "Delete the deployment history before removing this env."
        : "Env not found.";
    return NextResponse.json({ ok: false, code: res.code, message }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.deleted",
    targetType: "env",
    targetId: key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
