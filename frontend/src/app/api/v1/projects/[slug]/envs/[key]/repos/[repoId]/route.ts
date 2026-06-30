import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey, unwireRepoFromEnv } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string; repoId: string }> },
) {
  const { slug, key, repoId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const ok = await unwireRepoFromEnv(env.id, repoId);
  if (!ok) {
    return NextResponse.json({ ok: false, code: "not_wired" }, { status: 404 });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.repo_unwired",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { repoId },
  });
  return NextResponse.json({ ok: true });
}
