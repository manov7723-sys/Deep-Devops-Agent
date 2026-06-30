import { NextResponse } from "next/server";
import { CreateScopeRequest } from "@/lib/api/schemas/insights-api";
import { getActiveSession } from "@/lib/auth/session";
import { createScope, listScopesForProvider } from "@/lib/insights/security-scopes";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const scopes = await listScopesForProvider(sess.userId, id);
  if (scopes === null) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({ scopes });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = CreateScopeRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await createScope({
    userId: sess.userId,
    cloudProviderId: id,
    kind: parsed.data.kind,
    name: parsed.data.name,
    ref: parsed.data.ref,
  });
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "security_scope.created",
    targetType: "security_scope",
    targetId: res.scope.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { kind: parsed.data.kind, providerId: id },
  });
  return NextResponse.json({ ok: true, scope: res.scope });
}
