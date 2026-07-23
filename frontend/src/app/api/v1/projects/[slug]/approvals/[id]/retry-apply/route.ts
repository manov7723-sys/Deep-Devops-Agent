import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { canRetryApply } from "@/lib/devops/approvals";
import { applyApprovedChange } from "@/lib/devops/infra-approval";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/approvals/[id]/retry-apply
 *
 * Re-run the apply step for a change that's already approved but never
 * successfully applied (e.g. it failed on a credential-resolution gap that's
 * since been fixed). The DECISION is never touched — approvals stay
 * immutable once decided — this only retries the execution.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const check = await canRetryApply(gate.access.project.id, id);
  if (!check.ok) {
    const status = check.code === "not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, code: check.code }, { status });
  }
  if (check.alreadyApplied) {
    return NextResponse.json({ ok: true, applied: false, message: "Already applied." });
  }

  const r = await applyApprovedChange(gate.access.project.id, gate.access.session.userId, id);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "approval.decided",
    targetType: "approval",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { retryApply: true, applied: r.ok && r.applied },
  });
  if (r.ok && r.applied) {
    await recordActivity({
      projectId: gate.access.project.id,
      actorUserId: gate.access.session.userId,
      action: "applied",
      targetType: "approval",
      targetLabel: "Retried apply",
      icon: "check",
    }).catch(() => {});
    return NextResponse.json({ ok: true, applied: true, runId: r.runId });
  }
  if (!r.ok) return NextResponse.json({ ok: false, code: "apply_failed", message: r.error }, { status: 502 });
  return NextResponse.json({ ok: true, applied: false, message: r.reason });
}
