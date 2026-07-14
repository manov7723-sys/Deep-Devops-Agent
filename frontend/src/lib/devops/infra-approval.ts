/**
 * Infra approval gate — the "Plan → policy → approval → apply" pipeline.
 *
 *   createInfraApproval — runs the deterministic policy checks; if they pass,
 *     creates a PENDING Approval that carries the terraform payload + the cost
 *     estimate + the policy result (so nothing is applied yet).
 *   applyApprovedChange — called after a human approves: runs terraform apply
 *     from the stored payload. Nothing runs unless status === "approved".
 *
 * This generalizes the fmt→validate→plan→OPA→apply idea to EVERY blueprint: the
 * agent never applies directly — it proposes, we gate, a human approves, we apply.
 */
import { prisma } from "@/lib/db/prisma";
import { Prisma, type ApprovalRisk, type DiffKind } from "@prisma/client";
import { createApproval } from "./approvals";
import { checkInfraPolicy, type Cloud, type PolicyResult } from "@/lib/policy/infra-policy";
import { runTerraformTool } from "@/lib/agent/tools/run-terraform";
import { runDeploy } from "./deploy";
import type { DeploySpec } from "./deploy-manifest";

export type TerraformFile = { path: string; content: string };

export type InfraApprovalInput = {
  projectId: string;
  envId: string;
  envKey: string;
  title: string;
  summary?: string;
  cloud: Cloud;
  region?: string;
  instanceType?: string;
  publicBucket?: boolean;
  /** Terraform run label + stable stack name + the HCL files to apply on approval. */
  name: string;
  stack?: string;
  files: TerraformFile[];
  costMonthly?: number;
  /** Human-readable plan lines shown on the approval card. */
  planSummary?: Array<{ change: "add" | "remove" | "info"; text: string }>;
};

export type InfraApprovalResult =
  | { ok: true; approvalId: string; risk: ApprovalRisk; policy: PolicyResult }
  | { ok: false; blocked: true; policy: PolicyResult };

const CHANGE_KIND: Record<"add" | "remove" | "info", DiffKind> = {
  add: "add",
  remove: "remove",
  info: "comment",
};

export async function createInfraApproval(input: InfraApprovalInput): Promise<InfraApprovalResult> {
  const hcl = input.files.map((f) => f.content).join("\n\n");
  const policy = checkInfraPolicy({
    cloud: input.cloud,
    region: input.region,
    instanceType: input.instanceType,
    publicBucket: input.publicBucket,
    hcl,
  });

  // HIGH violations block outright — no approval is even created.
  if (!policy.ok) return { ok: false, blocked: true, policy };

  const risk: ApprovalRisk =
    (input.costMonthly ?? 0) >= 500 ? "high" : policy.violations.length > 0 ? "medium" : "low";

  const diff: Array<{ kind: DiffKind; text: string }> = [];
  for (const p of input.planSummary ?? []) diff.push({ kind: CHANGE_KIND[p.change], text: p.text });
  if (input.costMonthly != null)
    diff.push({
      kind: "comment",
      text: `💵 Estimated cost: ~$${input.costMonthly.toLocaleString()}/month`,
    });
  diff.push({ kind: "comment", text: `🛡️ Policy: passed (${policy.checked.join(", ")})` });
  for (const v of policy.violations)
    diff.push({ kind: "comment", text: `⚠️ ${v.rule}: ${v.message}` });

  const approval = await createApproval({
    projectId: input.projectId,
    envId: input.envId,
    title: input.title,
    summary: input.summary,
    changesSummary:
      input.costMonthly != null ? `~$${input.costMonthly.toLocaleString()}/mo` : undefined,
    risk,
    diff,
    kind: "terraform",
    payloadJson: {
      type: "terraform",
      envKey: input.envKey,
      name: input.name,
      stack: input.stack ?? null,
      files: input.files,
    } as unknown as Prisma.InputJsonValue,
    costMonthly: input.costMonthly,
    policyJson: policy as unknown as Prisma.InputJsonValue,
  });

  return { ok: true, approvalId: approval.id, risk, policy };
}

type TerraformPayload = {
  type: "terraform";
  envKey: string;
  name: string;
  stack: string | null;
  files: TerraformFile[];
};
type DeployPayload = {
  type: "deploy";
  envKey: string;
  envId: string;
  namespace: string;
  spec: DeploySpec;
};

export type ApplyResult =
  | { ok: true; applied: true; runId: string }
  | { ok: true; applied: false; reason: string }
  | { ok: false; error: string };

/** Run the approved change (terraform apply OR deploy). Called from the decision route AFTER approve. Idempotent. */
export async function applyApprovedChange(
  projectId: string,
  userId: string,
  approvalId: string,
): Promise<ApplyResult> {
  const a = await prisma.approval.findFirst({
    where: { id: approvalId, projectId },
    select: {
      id: true,
      status: true,
      kind: true,
      payloadJson: true,
      appliedAt: true,
      env: { select: { key: true } },
    },
  });
  if (!a) return { ok: false, error: "Approval not found." };
  if (a.status !== "approved") return { ok: true, applied: false, reason: "Not approved." };
  if (!a.payloadJson) return { ok: true, applied: false, reason: "Nothing executable to apply." };
  if (a.appliedAt) return { ok: true, applied: false, reason: "Already applied." };

  // Scheduled-deploy approval → do NOT run now; the scheduler runs it at its
  // scheduled time. The approve just flips ScheduledDeploy.approved (handled by
  // syncScheduledApproval in the decision route).
  if (a.kind === "scheduled_deploy") {
    return {
      ok: true,
      applied: false,
      reason: "Scheduled — it will run at its scheduled time now that it's approved.",
    };
  }

  // Deploy approval → run the deploy now (runDeploy is the executor; it is NOT gated).
  if (a.kind === "deploy") {
    const p = a.payloadJson as unknown as DeployPayload;
    const res = await runDeploy(
      { projectId, userId },
      { envKey: p.envKey, envId: p.envId, namespace: p.namespace },
      p.spec,
      { source: "manual" },
    );
    if (!res.ok) return { ok: false, error: res.error };
    await prisma.approval
      .update({ where: { id: a.id }, data: { appliedAt: new Date() } })
      .catch(() => {});
    return { ok: true, applied: true, runId: "deploy" };
  }

  // Terraform approval → apply the stored plan.
  if (a.kind === "terraform") {
    const p = a.payloadJson as unknown as TerraformPayload;
    const envKey = (p.envKey || a.env.key || "").trim();
    const filesMap = Object.fromEntries((p.files ?? []).map((f) => [f.path, f.content]));
    const res = await runTerraformTool.execute(
      {
        envKey,
        name: p.name || "approved-apply",
        action: "apply",
        files: filesMap,
        stack: p.stack ?? undefined,
      },
      { projectId, userId },
    );
    if (!res.ok) return { ok: false, error: res.error };
    await prisma.approval
      .update({
        where: { id: a.id },
        data: { appliedAt: new Date(), applyRunId: res.output.runId },
      })
      .catch(() => {});
    return { ok: true, applied: true, runId: res.output.runId };
  }

  return { ok: true, applied: false, reason: "Nothing executable to apply." };
}
