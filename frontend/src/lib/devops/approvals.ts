/**
 * Approvals — pre-deployment gate. Created by anyone with developer+, decided
 * by anyone with developer+. Decision is immutable: once approved/rejected
 * the row stays terminal forever (callers re-create a new approval if needed).
 */
import {
  Prisma,
  type Approval,
  type ApprovalDiff,
  type ApprovalRisk,
  type DiffKind,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type ApprovalRow = {
  id: string;
  envKey: string;
  title: string;
  summary: string | null;
  changesSummary: string | null;
  risk: ApprovalRisk;
  status: "pending" | "approved" | "rejected";
  decidedByName: string | null;
  requestedAt: string;
  decidedAt: string | null;
  /** Set once the approved change actually finished applying. Approved-but-null
   *  means the apply step failed or hasn't run yet — see retryApply(). */
  appliedAt: string | null;
  diff: Array<{ kind: DiffKind; text: string; order: number }>;
};

function row(
  a: Approval & {
    env: { key: string };
    decidedBy: { name: string } | null;
    diff: ApprovalDiff[];
  },
): ApprovalRow {
  return {
    id: a.id,
    envKey: a.env.key,
    title: a.title,
    summary: a.summary,
    changesSummary: a.changesSummary,
    risk: a.risk,
    status: a.status,
    decidedByName: a.decidedBy?.name ?? null,
    requestedAt: a.requestedAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    appliedAt: a.appliedAt?.toISOString() ?? null,
    diff: a.diff
      .slice()
      .sort((x, y) => x.order - y.order)
      .map((d) => ({ kind: d.kind, text: d.text, order: d.order })),
  };
}

/**
 * Retry the EXECUTION of an already-approved change whose apply failed (e.g.
 * a transient error, or a since-fixed gap in credential resolution). The
 * DECISION itself stays immutable — this never touches status/decidedAt —
 * it only re-invokes the same apply step applyApprovedChange runs right
 * after a fresh approval, so a stuck "approved but never applied" row isn't
 * a permanent dead end.
 */
export type RetryApplyResult =
  | { ok: true; alreadyApplied: boolean }
  | { ok: false; code: "not_found" | "not_approved" };

export async function canRetryApply(projectId: string, id: string): Promise<RetryApplyResult> {
  const existing = await prisma.approval.findFirst({
    where: { id, projectId },
    select: { status: true, appliedAt: true },
  });
  if (!existing) return { ok: false, code: "not_found" };
  if (existing.status !== "approved") return { ok: false, code: "not_approved" };
  return { ok: true, alreadyApplied: !!existing.appliedAt };
}

export async function listApprovals(
  projectId: string,
  filter?: { status?: "pending" | "approved" | "rejected" },
): Promise<ApprovalRow[]> {
  const rows = await prisma.approval.findMany({
    where: { projectId, ...(filter?.status ? { status: filter.status } : {}) },
    orderBy: { requestedAt: "desc" },
    include: {
      env: { select: { key: true } },
      decidedBy: { select: { name: true } },
      diff: true,
    },
  });
  return rows.map(row);
}

export async function getApproval(projectId: string, id: string): Promise<ApprovalRow | null> {
  const a = await prisma.approval.findFirst({
    where: { id, projectId },
    include: {
      env: { select: { key: true } },
      decidedBy: { select: { name: true } },
      diff: true,
    },
  });
  return a ? row(a) : null;
}

export type CreateApprovalArgs = {
  projectId: string;
  envId: string;
  title: string;
  summary?: string;
  changesSummary?: string;
  risk: ApprovalRisk;
  repoId?: string;
  diff: Array<{ kind: DiffKind; text: string }>;
  // Infra gate: an executable approval (kind="terraform") carries the payload +
  // estimate + policy result so approving it runs the apply.
  kind?: string;
  payloadJson?: Prisma.InputJsonValue;
  costMonthly?: number;
  policyJson?: Prisma.InputJsonValue;
};

export async function createApproval(args: CreateApprovalArgs): Promise<ApprovalRow> {
  const a = await prisma.approval.create({
    data: {
      projectId: args.projectId,
      envId: args.envId,
      title: args.title,
      summary: args.summary ?? null,
      changesSummary: args.changesSummary ?? null,
      risk: args.risk,
      repoId: args.repoId ?? null,
      status: "pending",
      kind: args.kind ?? "generic",
      payloadJson: args.payloadJson,
      costMonthly: args.costMonthly ?? null,
      policyJson: args.policyJson,
      diff: {
        create: args.diff.map((d, idx) => ({ kind: d.kind, text: d.text, order: idx })),
      },
    },
    include: {
      env: { select: { key: true } },
      decidedBy: { select: { name: true } },
      diff: true,
    },
  });
  return row(a);
}

export type DecideResult =
  { ok: true; approval: ApprovalRow } | { ok: false; code: "not_found" | "already_decided" };

export async function decideApproval(
  projectId: string,
  id: string,
  decision: "approve" | "reject",
  decidedById: string,
): Promise<DecideResult> {
  const existing = await prisma.approval.findFirst({
    where: { id, projectId },
    select: { id: true, status: true },
  });
  if (!existing) return { ok: false, code: "not_found" };
  if (existing.status !== "pending") return { ok: false, code: "already_decided" };

  const updated = await prisma.approval.update({
    where: { id },
    data: {
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: new Date(),
      decidedById,
    },
    include: {
      env: { select: { key: true } },
      decidedBy: { select: { name: true } },
      diff: true,
    },
  });
  return { ok: true, approval: row(updated) };
}
