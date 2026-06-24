import { NextResponse } from "next/server";
import { CreateIntegrationRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createIntegration, listIntegrationsForProject } from "@/lib/integrations/integrations";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const integrations = await listIntegrationsForProject(gate.access.project.id);
  return NextResponse.json(integrations);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateIntegrationRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid integration.",
      },
      { status: 400 },
    );
  }
  const res = await createIntegration({
    projectId: gate.access.project.id,
    connectedById: gate.access.session.userId,
    provider: parsed.data.provider,
    name: parsed.data.name,
    icon: parsed.data.icon,
    description: parsed.data.description,
    credentials: parsed.data.credentials,
  });
  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: res.code,
        message: "An integration for this provider is already connected.",
      },
      { status: 409 },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "integration.connected",
    targetType: "integration",
    targetId: res.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { provider: parsed.data.provider },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "connected",
    targetType: "integration",
    targetLabel: parsed.data.name,
    icon: (parsed.data.icon as string) ?? "plug",
  }).catch(() => {});
  return NextResponse.json({ ok: true, id: res.id });
}
