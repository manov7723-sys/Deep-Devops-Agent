import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { nodeAction } from "@/lib/observability/node-ops";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/cloud/node-action
 * Cordon / uncordon / drain a Kubernetes node for maintenance.
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  node: z.string().trim().min(1),
  action: z.enum(["cordon", "uncordon", "drain"]),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const { envKey, node, action } = parsed.data;

  const res = await nodeAction(gate.access.project.id, envKey, node, action);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "deployment.applied",
    targetType: "node",
    targetId: `${node}@${envKey}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { nodeAction: action },
  });

  return NextResponse.json(res);
}
