import { NextResponse } from "next/server";
import { CreateKnowledgeRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createKnowledge, listKnowledge } from "@/lib/agentops/knowledge";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const docs = await listKnowledge(gate.access.project.id);
  return NextResponse.json(docs);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateKnowledgeRequest.safeParse(await req.json().catch(() => ({})));
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
  const doc = await createKnowledge({
    projectId: gate.access.project.id,
    authorUserId: gate.access.session.userId,
    envId,
    title: parsed.data.title,
    body: parsed.data.body,
    type: parsed.data.type,
    tags: parsed.data.tags,
    excerpt: parsed.data.excerpt,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "knowledge.created",
    targetType: "knowledge",
    targetId: doc.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { title: doc.title, type: doc.type },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "added",
    targetType: "knowledge",
    targetLabel: doc.title,
    envId,
    icon: "book",
  }).catch(() => {});
  return NextResponse.json({ ok: true, doc });
}
