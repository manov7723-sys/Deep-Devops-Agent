import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { unbindScopeFromEnv } from "@/lib/insights/security-scopes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string; scopeId: string }> },
) {
  const { slug, key, scopeId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  const ok = await unbindScopeFromEnv(env.id, scopeId);
  if (!ok) return NextResponse.json({ ok: false, code: "not_bound" }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "security_scope.unbound",
    targetType: "env_security_binding",
    targetId: scopeId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: key },
  });
  return NextResponse.json({ ok: true });
}
