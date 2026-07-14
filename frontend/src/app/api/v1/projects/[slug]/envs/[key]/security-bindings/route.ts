import { NextResponse } from "next/server";
import { BindScopeRequest } from "@/lib/api/schemas/insights-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { bindScopeToEnv } from "@/lib/insights/security-scopes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const parsed = BindScopeRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }

  const res = await bindScopeToEnv(gate.access.project.ownerId, env.id, parsed.data.scopeId);
  if (!res.ok) {
    const status = res.code === "scope_not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "security_scope.bound",
    targetType: "env_security_binding",
    targetId: res.binding.bindingId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: key, scopeId: parsed.data.scopeId },
  });
  return NextResponse.json({ ok: true, binding: res.binding });
}
