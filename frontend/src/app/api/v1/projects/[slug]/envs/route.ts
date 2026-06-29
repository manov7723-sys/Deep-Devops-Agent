import { NextResponse } from "next/server";
import { CreateEnvRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createEnv, listEnvs } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Bare array — `useProjectEnvs()` iterates `.filter` directly (no envelope). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const envs = await listEnvs(gate.access.project.id);
  return NextResponse.json(envs);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = CreateEnvRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await createEnv({
    projectId: gate.access.project.id,
    ownerId: gate.access.project.ownerId,
    ...parsed.data,
  });
  if (!res.ok) {
    const status = res.code === "duplicate_key" ? 409 : 400;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.created",
    targetType: "env",
    targetId: res.env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { key: res.env.key, name: res.env.name },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "created",
    targetType: "env",
    targetLabel: res.env.name,
    envId: res.env.id,
    icon: "branch",
  }).catch(() => {});
  return NextResponse.json({ ok: true, env: res.env });
}
