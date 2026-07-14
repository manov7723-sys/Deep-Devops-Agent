/**
 * Deploy approval gate — EVERY interactive deploy (agent, wizard, redeploy) is
 * submitted as a PENDING approval instead of running immediately. A human
 * approves it on the Approvals page, which then runs the actual deploy (via
 * applyApprovedChange → runDeploy). Automation (scheduler, watchdog rollback)
 * is NOT gated — that's pre-authorized system activity.
 */
import { Prisma, type ApprovalRisk } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { createApproval } from "./approvals";
import { sanitizeAppName, type DeploySpec } from "./deploy-manifest";

export type DeployApprovalTarget = {
  envKey: string;
  envId: string;
  namespace: string;
  isProduction?: boolean;
};

export async function createDeployApproval(
  projectId: string,
  target: DeployApprovalTarget,
  spec: DeploySpec,
  source: "manual" | "agent" = "manual",
): Promise<{ approvalId: string; risk: ApprovalRisk }> {
  const app = sanitizeAppName(spec.appName);
  const risk: ApprovalRisk = target.isProduction ? "high" : "medium";
  const replicaLbl = `${spec.replicas} replica${spec.replicas === 1 ? "" : "s"}`;

  const approval = await createApproval({
    projectId,
    envId: target.envId,
    title: `Deploy ${app} → ${target.envKey}`,
    summary: `Deploy image ${spec.image} to ${target.envKey} (${source})`,
    changesSummary: replicaLbl,
    risk,
    diff: [
      { kind: "add", text: `Deploy ${app} → ${target.envKey} (namespace ${spec.namespace})` },
      { kind: "comment", text: `🖼️ image: ${spec.image}` },
      {
        kind: "comment",
        text: `⚙️ ${replicaLbl} · port ${spec.containerPort}${spec.expose ? ` · exposed${spec.host ? ` (${spec.host})` : ""}` : ""}`,
      },
      ...(target.isProduction
        ? [{ kind: "comment" as const, text: "⚠️ PRODUCTION environment" }]
        : []),
    ],
    kind: "deploy",
    payloadJson: {
      type: "deploy",
      envKey: target.envKey,
      envId: target.envId,
      namespace: spec.namespace,
      spec,
    } as unknown as Prisma.InputJsonValue,
  });

  return { approvalId: approval.id, risk };
}

/**
 * Create the UPFRONT approval for a SCHEDULED deploy. The deploy is stored
 * separately (ScheduledDeploy); this approval just gates whether the scheduler
 * is allowed to run it at its time. Approving sets ScheduledDeploy.approved=true;
 * rejecting cancels it (see syncScheduledApproval).
 */
export async function createScheduledDeployApproval(
  projectId: string,
  target: DeployApprovalTarget,
  spec: DeploySpec,
  runAt: Date,
  scheduledDeployId: string,
): Promise<{ approvalId: string; risk: ApprovalRisk }> {
  const app = sanitizeAppName(spec.appName);
  const risk: ApprovalRisk = target.isProduction ? "high" : "medium";
  const when = runAt.toISOString();

  const approval = await createApproval({
    projectId,
    envId: target.envId,
    title: `Scheduled deploy ${app} → ${target.envKey}`,
    summary: `Deploy ${spec.image} to ${target.envKey}, scheduled for ${when}`,
    changesSummary: `runs ${when}`,
    risk,
    diff: [
      { kind: "add", text: `Deploy ${app} → ${target.envKey} (namespace ${spec.namespace})` },
      { kind: "comment", text: `🕐 scheduled to run at ${when}` },
      { kind: "comment", text: `🖼️ image: ${spec.image}` },
      {
        kind: "comment",
        text: `⚙️ ${spec.replicas} replica${spec.replicas === 1 ? "" : "s"} · port ${spec.containerPort}`,
      },
      ...(target.isProduction
        ? [{ kind: "comment" as const, text: "⚠️ PRODUCTION environment" }]
        : []),
    ],
    kind: "scheduled_deploy",
    payloadJson: {
      type: "scheduled_deploy",
      scheduledDeployId,
      runAt: when,
    } as unknown as Prisma.InputJsonValue,
  });

  return { approvalId: approval.id, risk };
}

/**
 * Reflect an approval decision onto its linked ScheduledDeploy. Approve →
 * approved=true (scheduler may run it at runAt). Reject → cancelled. No-op for
 * non-scheduled approvals. Called from the decision route for BOTH decisions.
 */
export async function syncScheduledApproval(
  projectId: string,
  approvalId: string,
  decision: "approve" | "reject",
): Promise<void> {
  const a = await prisma.approval.findFirst({
    where: { id: approvalId, projectId },
    select: { kind: true, payloadJson: true },
  });
  if (!a || a.kind !== "scheduled_deploy" || !a.payloadJson) return;
  const p = a.payloadJson as unknown as { scheduledDeployId?: string };
  const sid = p.scheduledDeployId;
  if (!sid) return;
  if (decision === "approve") {
    await prisma.scheduledDeploy
      .updateMany({ where: { id: sid, projectId, status: "pending" }, data: { approved: true } })
      .catch(() => {});
  } else {
    await prisma.scheduledDeploy
      .updateMany({
        where: { id: sid, projectId, status: "pending" },
        data: { status: "cancelled" },
      })
      .catch(() => {});
  }
}
