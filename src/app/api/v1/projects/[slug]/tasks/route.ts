import { NextResponse } from "next/server";
import { CreateTaskRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createTask, listTasks } from "@/lib/agentops/tasks";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const tasks = await listTasks(gate.access.project.id);
  return NextResponse.json(tasks);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateTaskRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  let envId: string | undefined;
  if (parsed.data.envKey && !parsed.data.allEnvs) {
    const env = await envBySlugAndKey(gate.access.project.id, parsed.data.envKey);
    if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
    envId = env.id;
  }
  const task = await createTask({
    projectId: gate.access.project.id,
    title: parsed.data.title,
    icon: parsed.data.icon,
    schedule: parsed.data.schedule,
    envId,
    allEnvs: parsed.data.allEnvs,
    agentId: parsed.data.agentId,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "task.created",
    targetType: "task",
    targetId: task.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { title: task.title, schedule: task.schedule },
  });
  return NextResponse.json({ ok: true, task });
}
