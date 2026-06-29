import { NextResponse } from "next/server";
import { CreateActivityRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { listActivity, recordActivity } from "@/lib/agentops/activity";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const sp = new URL(req.url).searchParams;
  const envKey = sp.get("env");
  const limit = Number(sp.get("limit") ?? "100");

  let envId: string | undefined;
  if (envKey && envKey !== "all") {
    const env = await envBySlugAndKey(gate.access.project.id, envKey);
    if (!env) return NextResponse.json([]);
    envId = env.id;
  }
  const activity = await listActivity(gate.access.project.id, { envId, limit });
  return NextResponse.json(activity);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateActivityRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  let envId: string | undefined;
  if (parsed.data.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, parsed.data.envKey);
    if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
    envId = env.id;
  }
  const row = await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: parsed.data.action,
    targetLabel: parsed.data.targetLabel,
    targetType: parsed.data.targetType,
    icon: parsed.data.icon,
    envId,
  });
  return NextResponse.json({ ok: true, activity: row });
}
