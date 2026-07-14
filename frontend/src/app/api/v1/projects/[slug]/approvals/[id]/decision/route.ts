import { NextResponse } from "next/server";
import { ApprovalDecisionRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { decideApproval } from "@/lib/devops/approvals";
import { applyApprovedChange } from "@/lib/devops/infra-approval";
import { syncScheduledApproval } from "@/lib/devops/deploy-approval";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = ApprovalDecisionRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "bad_decision" }, { status: 400 });
  }
  const res = await decideApproval(
    gate.access.project.id,
    id,
    parsed.data.decision,
    gate.access.session.userId,
  );
  if (!res.ok) {
    const status = res.code === "not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "approval.decided",
    targetType: "approval",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { decision: parsed.data.decision },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: parsed.data.decision === "approve" ? "approved" : "rejected",
    targetType: "approval",
    targetLabel: res.approval.title,
    icon: parsed.data.decision === "approve" ? "check" : "x",
  }).catch(() => {});

  // Scheduled-deploy approvals: approve → the scheduler may run it at its time;
  // reject → cancel it. (Runs for BOTH decisions; no-op for other kinds.)
  await syncScheduledApproval(gate.access.project.id, id, parsed.data.decision);

  // Apply gate: approving an executable change (terraform / immediate deploy)
  // runs it now. Rejecting runs nothing. Scheduled/generic approvals don't run here.
  let apply: { applied: boolean; runId?: string; error?: string } | undefined;
  if (parsed.data.decision === "approve") {
    const r = await applyApprovedChange(gate.access.project.id, gate.access.session.userId, id);
    if (r.ok && r.applied) apply = { applied: true, runId: r.runId };
    else if (!r.ok) apply = { applied: false, error: r.error };
  }
  return NextResponse.json({ ok: true, approval: res.approval, apply });
}
