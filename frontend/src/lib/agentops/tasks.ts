/**
 * Scheduled agent tasks. CRUD over the `Task` model — the actual cron runner
 * lives outside this codebase; this layer is just the configuration surface.
 */
import type { Task, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type TaskRow = {
  id: string;
  title: string;
  icon: string;
  agentId: string | null;
  envKey: string | null;
  allEnvs: boolean;
  schedule: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  status: TaskStatus;
  findingsSummary: string | null;
  progressPct: number | null;
};

function row(t: Task & { env: { key: string } | null }): TaskRow {
  return {
    id: t.id,
    title: t.title,
    icon: t.icon,
    agentId: t.agentId,
    envKey: t.env?.key ?? null,
    allEnvs: t.allEnvs,
    schedule: t.schedule,
    lastRunAt: t.lastRunAt?.toISOString() ?? null,
    nextRunAt: t.nextRunAt?.toISOString() ?? null,
    status: t.status,
    findingsSummary: t.findingsSummary,
    progressPct: t.progressPct,
  };
}

export async function listTasks(projectId: string): Promise<TaskRow[]> {
  const rows = await prisma.task.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { env: { select: { key: true } } },
  });
  return rows.map(row);
}

export type CreateTaskArgs = {
  projectId: string;
  title: string;
  icon: string;
  schedule: string;
  envId?: string;
  allEnvs: boolean;
  agentId?: string;
};

export async function createTask(args: CreateTaskArgs): Promise<TaskRow> {
  const created = await prisma.task.create({
    data: {
      projectId: args.projectId,
      title: args.title,
      icon: args.icon,
      schedule: args.schedule,
      envId: args.envId ?? null,
      allEnvs: args.allEnvs,
      agentId: args.agentId ?? null,
      status: "ok",
    },
    include: { env: { select: { key: true } } },
  });
  return row(created);
}

export type PatchTaskArgs = Partial<{
  title: string;
  schedule: string;
  status: TaskStatus;
  findingsSummary: string | null;
  progressPct: number | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
}>;

export type PatchTaskResult = { ok: true; task: TaskRow } | { ok: false; code: "not_found" };

export async function patchTask(
  projectId: string,
  id: string,
  patch: PatchTaskArgs,
): Promise<PatchTaskResult> {
  const existing = await prisma.task.findFirst({ where: { id, projectId }, select: { id: true } });
  if (!existing) return { ok: false, code: "not_found" };
  const updated = await prisma.task.update({
    where: { id },
    data: {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.schedule !== undefined && { schedule: patch.schedule }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.findingsSummary !== undefined && { findingsSummary: patch.findingsSummary }),
      ...(patch.progressPct !== undefined && { progressPct: patch.progressPct }),
      ...(patch.nextRunAt !== undefined && { nextRunAt: patch.nextRunAt }),
      ...(patch.lastRunAt !== undefined && { lastRunAt: patch.lastRunAt }),
    },
    include: { env: { select: { key: true } } },
  });
  return { ok: true, task: row(updated) };
}

export async function deleteTask(projectId: string, id: string): Promise<boolean> {
  const { count } = await prisma.task.deleteMany({ where: { id, projectId } });
  return count > 0;
}
