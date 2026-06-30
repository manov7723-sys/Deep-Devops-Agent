import { NextResponse } from "next/server";
import { CreateAgentRequest } from "@/lib/api/schemas/admin-catalog-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { createAgent, listAgents } from "@/lib/admin/catalog";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Bare array — `useAdminAgents()` consumes the response with `.find`/`.map`
 *  directly, no envelope. */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const agents = await listAgents();
  return NextResponse.json(agents);
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = CreateAgentRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await createAgent(parsed.data);
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: res.code }, { status: 400 });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.agent_created",
    targetType: "agent",
    targetId: res.agent.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: res.agent.name, modelId: res.agent.modelId },
  });
  return NextResponse.json({ ok: true, agent: res.agent });
}
