/**
 * Orchestrate report generation and delivery.
 *
 * Used by two callers with the same code path, which is the point — a "Send
 * now" button that exercises different logic from the scheduler is a button
 * that proves nothing:
 *   • the scheduler, once a day at REPORT_HOUR local time;
 *   • the Reports tab's "Send now", for one namespace on demand.
 */
import { prisma } from "@/lib/db/prisma";
import { discoverDeployedApps } from "./discover-apps";
import { buildNamespaceReport, renderReportEmail } from "./build-report";
import { resolveMailConfig, sendReportEmail } from "./mailer";

/** Local hour the daily report goes out. */
export const REPORT_HOUR = 10;

/** `YYYY-MM-DD` in LOCAL time — the once-per-day key. */
export function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type NamespaceSendResult = {
  namespace: string;
  status: "sent" | "skipped" | "failed";
  recipients: string[];
  detail: string;
};

/**
 * Generate and send reports for every namespace in one project that has at
 * least one enabled recipient.
 *
 * `force` bypasses the once-per-day guard for the "Send now" button; the
 * scheduler always leaves it false so a restart can't re-mail everyone.
 */
export async function runProjectReports(args: {
  projectId: string;
  now: Date;
  /** Limit to one namespace (the "Send now" case). */
  onlyNamespace?: string;
  force?: boolean;
}): Promise<NamespaceSendResult[]> {
  const { projectId, now, onlyNamespace, force } = args;
  const reportDate = localDayKey(now);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  const projectName = project?.name ?? "DeepAgent";

  const recipients = await prisma.reportRecipient.findMany({
    where: {
      projectId,
      enabled: true,
      ...(onlyNamespace ? { namespace: onlyNamespace } : {}),
    },
    select: { namespace: true, email: true },
  });
  if (recipients.length === 0) return [];

  const byNamespace = new Map<string, string[]>();
  for (const r of recipients) {
    byNamespace.set(r.namespace, [...(byNamespace.get(r.namespace) ?? []), r.email]);
  }

  // Discover ONCE for the project — every namespace's data comes from the same
  // cluster sweep, so doing it per namespace would re-read the same clusters N
  // times.
  const discovered = await discoverDeployedApps(projectId);
  const results: NamespaceSendResult[] = [];

  for (const [namespace, emails] of byNamespace) {
    // Idempotency: one report per namespace per local day unless forced.
    if (!force) {
      const existing = await prisma.reportRun.findUnique({
        where: { projectId_namespace_reportDate: { projectId, namespace, reportDate } },
        select: { status: true },
      });
      if (existing?.status === "sent") {
        results.push({
          namespace,
          status: "skipped",
          recipients: [],
          detail: `Already sent today (${reportDate}).`,
        });
        continue;
      }
    }

    const ns = discovered.find((d) => d.namespace === namespace);
    if (!ns) {
      const detail =
        "Namespace not found in any connected cluster — it may have been deleted, or its env lost its kubeconfig.";
      await recordRun({ projectId, namespace, reportDate, status: "failed", recipients: [], detail });
      results.push({ namespace, status: "failed", recipients: [], detail });
      continue;
    }

    const mail = await resolveMailConfig();
    if (!mail.ok) {
      await recordRun({
        projectId,
        namespace,
        reportDate,
        status: "failed",
        recipients: [],
        detail: mail.error,
      });
      results.push({ namespace, status: "failed", recipients: [], detail: mail.error });
      continue;
    }

    const report = await buildNamespaceReport(ns, now);
    const { subject, html } = renderReportEmail(report, projectName);
    const sent = await sendReportEmail({ config: mail.config, to: emails, subject, html });

    if (!sent.ok) {
      await recordRun({
        projectId,
        namespace,
        reportDate,
        status: "failed",
        recipients: [],
        detail: sent.error,
      });
      results.push({ namespace, status: "failed", recipients: [], detail: sent.error });
      continue;
    }

    const detail = `${report.totals.apps} app(s), ${report.totals.healthy} healthy, ${report.totals.degraded} degraded, ${report.totals.restarts} restart(s).`;
    await recordRun({
      projectId,
      namespace,
      reportDate,
      status: "sent",
      recipients: sent.accepted,
      detail,
    });
    results.push({ namespace, status: "sent", recipients: sent.accepted, detail });
  }

  return results;
}

async function recordRun(args: {
  projectId: string;
  namespace: string;
  reportDate: string;
  status: "sent" | "failed" | "skipped";
  recipients: string[];
  detail: string;
}): Promise<void> {
  const { projectId, namespace, reportDate, status, recipients, detail } = args;
  // Upsert, because a forced re-send on a day that already failed must update
  // the row rather than violate the (project, namespace, date) uniqueness.
  await prisma.reportRun
    .upsert({
      where: { projectId_namespace_reportDate: { projectId, namespace, reportDate } },
      create: {
        projectId,
        namespace,
        reportDate,
        status,
        recipients: recipients.join(","),
        detail: detail.slice(0, 1000),
      },
      update: { status, recipients: recipients.join(","), detail: detail.slice(0, 1000) },
    })
    .catch(() => {
      /* audit-style write — must never break the send it records */
    });
}

/**
 * Scheduler entry point. Runs on the existing 60s tick and does nothing until
 * the local hour reaches REPORT_HOUR, then sends any project that hasn't
 * already gone out today.
 *
 * The once-per-day guard lives in the database rather than in memory, so a
 * dev-server restart at 10:05 can't re-mail everyone — a real risk given how
 * often this process restarts.
 */
export async function runDueReports(now: Date): Promise<number> {
  if (now.getHours() < REPORT_HOUR) return 0;

  const reportDate = localDayKey(now);

  // Only projects that actually have recipients — no point sweeping clusters
  // for a project nobody has subscribed to.
  const projects = await prisma.reportRecipient.findMany({
    where: { enabled: true },
    select: { projectId: true },
    distinct: ["projectId"],
  });

  let sent = 0;
  for (const { projectId } of projects) {
    // Cheap pre-check: skip the whole cluster sweep when every namespace in
    // this project already reported today.
    const pending = await prisma.reportRecipient.findMany({
      where: { projectId, enabled: true },
      select: { namespace: true },
      distinct: ["namespace"],
    });
    const done = await prisma.reportRun.findMany({
      where: { projectId, reportDate, status: "sent" },
      select: { namespace: true },
    });
    const doneSet = new Set(done.map((d) => d.namespace));
    if (pending.every((p) => doneSet.has(p.namespace))) continue;

    try {
      const results = await runProjectReports({ projectId, now });
      sent += results.filter((r) => r.status === "sent").length;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[reports] project ${projectId} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return sent;
}
