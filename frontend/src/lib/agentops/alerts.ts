/**
 * Alerts — usually agent-emitted, displayed in the project Alerts screen.
 * Lifecycle: open → ack → resolved. Resolve stamps resolvedAt.
 */
import type { Alert, AlertCategory, AlertSeverity, AlertStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sendEmail } from "@/lib/email/transport";

const APP_URL = (process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * Email the project's members when a new alert fires. Best-effort: never throws,
 * so a mail failure can't break alert creation. One email per new alert (callers
 * dedupe, so repeats don't re-notify).
 */
async function emailAlertToMembers(projectId: string, a: Alert): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, slug: true, memberships: { select: { user: { select: { email: true } } } } },
    });
    if (!project) return;
    // Project members + any always-notify addresses from ALERT_NOTIFY_EMAIL
    // (comma-separated) so alerts can reach an inbox that isn't a member.
    const extra = (process.env.ALERT_NOTIFY_EMAIL || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const emails = [...new Set([...project.memberships.map((m) => m.user.email), ...extra].filter(Boolean))];
    if (emails.length === 0) return;

    const subject = `🚨 [${project.name}] ${a.severity.toUpperCase()} alert: ${a.title}`;
    const text =
      `A new ${a.severity} alert fired in your project "${project.name}".\n\n` +
      `${a.title}\n${a.detail}\n\n` +
      `Resource:  ${a.resource}\n` +
      `Category:  ${a.category}\n` +
      `Severity:  ${a.severity}\n\n` +
      `What to do:\n${a.recommendation}\n\n` +
      `View it: ${APP_URL}/p/${project.slug}/alerts\n`;

    await Promise.allSettled(emails.map((to) => sendEmail({ to, subject, text })));
  } catch {
    /* email is best-effort — alert creation must not depend on it */
  }
}

export type AlertRow = {
  id: string;
  envKey: string;
  title: string;
  detail: string;
  resource: string;
  source: string;
  category: AlertCategory;
  severity: AlertSeverity;
  recommendation: string;
  status: AlertStatus;
  detectedAt: string;
  resolvedAt: string | null;
};

function row(a: Alert & { env: { key: string }; sourceAgent: { name: string } | null }): AlertRow {
  return {
    id: a.id,
    envKey: a.env.key,
    title: a.title,
    detail: a.detail,
    resource: a.resource,
    source: a.sourceAgent?.name ?? a.sourceLabel ?? "system",
    category: a.category,
    severity: a.severity,
    recommendation: a.recommendation,
    status: a.status,
    detectedAt: a.detectedAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

export type AlertFilter = {
  category?: AlertCategory;
  severity?: AlertSeverity;
  status?: AlertStatus;
  envId?: string;
};

export async function listAlerts(projectId: string, filter: AlertFilter = {}): Promise<AlertRow[]> {
  const rows = await prisma.alert.findMany({
    where: {
      projectId,
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.envId ? { envId: filter.envId } : {}),
    },
    orderBy: { detectedAt: "desc" },
    include: { env: { select: { key: true } }, sourceAgent: { select: { name: true } } },
    take: 200,
  });
  return rows.map(row);
}

export type CreateAlertArgs = {
  projectId: string;
  envId: string;
  title: string;
  detail: string;
  resource: string;
  sourceLabel?: string;
  category: AlertCategory;
  severity: AlertSeverity;
  recommendation: string;
};

export async function createAlert(args: CreateAlertArgs): Promise<AlertRow> {
  const created = await prisma.alert.create({
    data: {
      projectId: args.projectId,
      envId: args.envId,
      title: args.title,
      detail: args.detail,
      resource: args.resource,
      sourceLabel: args.sourceLabel ?? null,
      category: args.category,
      severity: args.severity,
      recommendation: args.recommendation,
      status: "open",
    },
    include: { env: { select: { key: true } }, sourceAgent: { select: { name: true } } },
  });
  await emailAlertToMembers(args.projectId, created);
  // Autonomous trigger (gated by SRE_AUTO_TRIAGE). Dynamic import breaks the
  // alerts → sre-agent → tools → list-alerts → alerts import cycle. Fire-and-
  // forget; never blocks alert creation.
  if (created.severity === "high") {
    void import("./sre-agent")
      .then((m) => m.maybeAutoTriage(args.projectId, created.id, created.severity))
      .catch(() => {});
  }
  return row(created);
}

export type PatchAlertResult =
  | { ok: true; alert: AlertRow }
  | { ok: false; code: "not_found" | "already_resolved" };

export async function patchAlertStatus(
  projectId: string,
  id: string,
  status: "ack" | "resolved",
): Promise<PatchAlertResult> {
  const existing = await prisma.alert.findFirst({
    where: { id, projectId },
    select: { id: true, status: true },
  });
  if (!existing) return { ok: false, code: "not_found" };
  if (existing.status === "resolved") return { ok: false, code: "already_resolved" };

  const updated = await prisma.alert.update({
    where: { id },
    data: {
      status,
      ...(status === "resolved" ? { resolvedAt: new Date() } : {}),
    },
    include: { env: { select: { key: true } }, sourceAgent: { select: { name: true } } },
  });
  return { ok: true, alert: row(updated) };
}
