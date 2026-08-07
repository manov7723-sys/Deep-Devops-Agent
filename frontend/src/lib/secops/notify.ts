/**
 * SLA-breach notifications for security findings.
 *
 * `notifySlaBreaches` sweeps `open` findings whose SLA window has passed and
 * fires ONE alert per finding: ChatOps first (Slack/Teams webhook via the
 * existing chatops integration), then an email to the project owner as a
 * fallback for anyone not in the channel. `slaAlertedAt` is stamped so a
 * subsequent sweep doesn't re-fire for the same row — which would be the
 * default and would fatigue users out of ever reading the alerts.
 *
 * A user can re-arm a finding by fixing or suppressing it; both reset the
 * finding's lifecycle. Explicit re-alerting on the same open row is not a
 * feature — if you want louder escalation, add a second SLA window ("if
 * still open at 2× window, alert again") rather than removing this guard.
 *
 * NOT called on every scan — a scan calls `notifyIfBreached` for freshly
 * upserted findings that already exceeded the window at first sighting.
 * The sweep is meant to be driven by a scheduled job (a cron / Task /
 * Scheduler entry — none wired yet; add one when this leaves stub state).
 */
import { prisma } from "@/lib/db/prisma";
import { postEventToChatOps } from "@/lib/integrations/chatops";
import { sendEmail } from "@/lib/email/transport";
import { isSlaBreached, slaDeadline, SLA_WINDOWS_MS } from "./severity";
import type { Finding } from "@prisma/client";

/**
 * Fire the alert for a single finding.
 *
 * Idempotent per finding: if `slaAlertedAt` is already set, this is a no-op.
 * The ChatOps post is fire-and-forget (that helper already swallows errors);
 * the email failure is logged but doesn't block the DB update — otherwise
 * transient SMTP flakiness would keep re-alerting on every sweep.
 */
export async function alertOnce(finding: Finding, projectSlug: string): Promise<{ alerted: boolean }> {
  if (finding.slaAlertedAt) return { alerted: false };
  if (finding.status !== "open") return { alerted: false };

  const deadline = slaDeadline(finding.firstSeenAt, finding.severity);
  const overdueMs = Date.now() - deadline.getTime();
  const overdueDays = Math.max(0, Math.floor(overdueMs / (24 * 60 * 60 * 1000)));

  const emoji = finding.severity === "CRITICAL" ? "🚨" : finding.severity === "HIGH" ? "⚠️" : "🔔";
  const title = `${finding.severity} finding past SLA: ${finding.title}`;
  const detail = [
    `Scanner: ${finding.scanner}`,
    `Rule: ${finding.ruleId}`,
    `Target: ${finding.target}`,
    `First seen: ${finding.firstSeenAt.toISOString().slice(0, 10)}` +
      (overdueDays > 0 ? ` (${overdueDays}d overdue)` : ""),
    finding.fixedVersion ? `Fix: upgrade to ${finding.fixedVersion}` : "",
    `Project: /p/${projectSlug}/security/findings/${finding.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  await postEventToChatOps(finding.projectId, emoji, title, detail);

  // Best-effort email to the project owner. Fetch inline so notify.ts stays
  // self-contained — a caller iterating a batch would prefer a bulk-fetch
  // wrapper, but that's a future optimisation once real volume shows up.
  try {
    const owner = await prisma.project.findUnique({
      where: { id: finding.projectId },
      select: { name: true, owner: { select: { email: true } } },
    });
    if (owner?.owner.email) {
      await sendEmail({
        to: owner.owner.email,
        subject: `[${owner.name}] ${finding.severity} finding past SLA — ${finding.title}`,
        text: detail,
      });
    }
  } catch (e) {
    console.error(`[secops.notify] email send failed: ${e instanceof Error ? e.message : e}`);
  }

  await prisma.finding.update({
    where: { id: finding.id },
    data: { slaAlertedAt: new Date() },
  });
  return { alerted: true };
}

/**
 * Check ONE freshly-upserted finding — call this from a scanner right after
 * `upsertFinding`. Skips anything not yet breached; the scheduled sweep
 * (`notifySlaBreaches` below) handles findings that AGE into breach later.
 */
export async function notifyIfBreached(finding: Finding, projectSlug: string): Promise<void> {
  if (!isSlaBreached(finding)) return;
  await alertOnce(finding, projectSlug);
}

/**
 * Scheduled-job entry point: sweep the whole `Finding` table for open rows
 * whose SLA has passed and that haven't been alerted yet.
 *
 * Batches by project because the ChatOps post is per-project (each project
 * has its own webhook). Uses the schema's `[status, severity, firstSeenAt]`
 * index; the WHERE clause is deliberately over-broad (all severities) so a
 * change to SLA_WINDOWS_MS doesn't require an index change.
 */
export async function notifySlaBreaches(): Promise<{ scanned: number; alerted: number }> {
  const worstAllowedFirstSeen = new Date(Date.now() - SLA_WINDOWS_MS.CRITICAL);
  const candidates = await prisma.finding.findMany({
    where: {
      status: "open",
      slaAlertedAt: null,
      // Anything older than CRITICAL's window is at least a candidate;
      // isSlaBreached below filters per-severity precisely.
      firstSeenAt: { lte: worstAllowedFirstSeen },
    },
    orderBy: { firstSeenAt: "asc" },
    take: 500, // batch cap — a follow-up run picks up the tail
    include: { project: { select: { slug: true } } },
  });

  let alerted = 0;
  for (const f of candidates) {
    if (!isSlaBreached(f)) continue;
    const res = await alertOnce(f, f.project.slug);
    if (res.alerted) alerted++;
  }
  return { scanned: candidates.length, alerted };
}
