import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { triageAndPropose } from "@/lib/agentops/sre-agent";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/alerts/[id]/triage
 *
 * Runs the SRE incident-triage agent on one alert: it investigates with
 * read-only tools (pods/logs/metrics) and returns a diagnosis + proposed
 * remediation. Nothing is changed — remediation is proposed for approval.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const res = await triageAndPropose(gate.access.project.id, id);
  if (!res.ok)
    return NextResponse.json(
      { ok: false, code: "triage_failed", message: res.error },
      { status: 400 },
    );

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.scanned",
    targetType: "alert",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      agent: "sre-triage",
      toolsUsed: res.toolsUsed,
      confidence: res.diagnosis.confidence,
      approvalsCreated: res.approvalsCreated,
    },
  });

  return NextResponse.json({
    ok: true,
    diagnosis: res.diagnosis,
    toolsUsed: res.toolsUsed,
    approvalsCreated: res.approvalsCreated,
  });
}
