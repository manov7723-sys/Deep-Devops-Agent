/**
 * Activity feed — display-oriented, per-project. Distinct from AuditLog
 * (which records security-sensitive events for forensics). Activity rows
 * are typically written by route handlers when something user-facing happens.
 */
import type { Activity } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type ActivityRow = {
  id: string;
  envKey: string | null;
  actorName: string;
  actorKind: "user" | "agent" | "system";
  action: string;
  targetLabel: string;
  targetType: string | null;
  icon: string | null;
  createdAt: string;
};

function row(
  a: Activity & {
    env: { key: string } | null;
    actorUser: { name: string } | null;
    actorAgent: { name: string } | null;
  },
): ActivityRow {
  let actorName = a.actorLabel ?? "system";
  let actorKind: "user" | "agent" | "system" = "system";
  if (a.actorUser) { actorName = a.actorUser.name; actorKind = "user"; }
  else if (a.actorAgent) { actorName = a.actorAgent.name; actorKind = "agent"; }
  return {
    id: a.id,
    envKey: a.env?.key ?? null,
    actorName,
    actorKind,
    action: a.action,
    targetLabel: a.targetLabel,
    targetType: a.targetType,
    icon: a.icon,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listActivity(
  projectId: string,
  opts: { envId?: string; limit?: number } = {},
): Promise<ActivityRow[]> {
  const rows = await prisma.activity.findMany({
    where: { projectId, ...(opts.envId ? { envId: opts.envId } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 100, 500),
    include: {
      env: { select: { key: true } },
      actorUser: { select: { name: true } },
      actorAgent: { select: { name: true } },
    },
  });
  return rows.map(row);
}

export type RecordActivityArgs = {
  projectId: string;
  actorUserId?: string;
  actorAgentId?: string;
  actorLabel?: string;
  action: string;
  targetLabel: string;
  targetType?: string;
  icon?: string;
  envId?: string;
};

/** Append a row. Fire-and-forget at call sites; not transactional. */
export async function recordActivity(args: RecordActivityArgs): Promise<ActivityRow> {
  const created = await prisma.activity.create({
    data: {
      projectId: args.projectId,
      actorUserId: args.actorUserId ?? null,
      actorAgentId: args.actorAgentId ?? null,
      actorLabel: args.actorLabel ?? null,
      action: args.action,
      targetLabel: args.targetLabel,
      targetType: args.targetType ?? null,
      icon: args.icon ?? null,
      envId: args.envId ?? null,
    },
    include: {
      env: { select: { key: true } },
      actorUser: { select: { name: true } },
      actorAgent: { select: { name: true } },
    },
  });
  return row(created);
}
