/**
 * Severity math + SLA windows for the secops layer.
 *
 * A finding's SLA deadline is `firstSeenAt + windowFor(severity)`. Once
 * `now() > deadline` AND the finding is still `open`, `notify.ts` alerts on
 * it (once, and marks `slaAlertedAt` so it never re-fires for the same row).
 *
 * The windows below are conservative defaults derived from what most
 * enterprise policies land on (NIST 800-53 CM-7, PCI DSS 6.3.3). They are
 * NOT client-configurable yet — when they need to be, move these into a
 * per-project settings row and read from there. Keeping them as constants
 * for now avoids a schema for a feature no one has asked for.
 */
import type { FindingSeverity } from "@prisma/client";

/** How long an `open` finding may sit before we alert. */
export const SLA_WINDOWS_MS: Record<FindingSeverity, number> = {
  CRITICAL: 24 * 60 * 60 * 1000, // 1 day
  HIGH: 7 * 24 * 60 * 60 * 1000, // 1 week
  MEDIUM: 30 * 24 * 60 * 60 * 1000, // 1 month
  LOW: 90 * 24 * 60 * 60 * 1000, // 1 quarter
  INFO: Number.POSITIVE_INFINITY, // never SLA — surfaced but not alerted
};

/** Numeric rank so callers can compare severities. Higher = worse. */
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 40,
  HIGH: 30,
  MEDIUM: 20,
  LOW: 10,
  INFO: 0,
};

/**
 * Coerce a scanner's severity string into our enum.
 *
 * Trivy emits UPPERCASE ("CRITICAL"), npm-audit emits lowercase ("critical"),
 * some emit "moderate" for MEDIUM. A miss defaults to INFO — the finding
 * still lands in the DB, but nothing SLA-fires for it, which is the safe
 * fallback: better to under-alert on an unknown label than to spam because
 * of it.
 */
export function toSeverity(raw: string | null | undefined): FindingSeverity {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "critical") return "CRITICAL";
  if (s === "high") return "HIGH";
  if (s === "medium" || s === "moderate") return "MEDIUM";
  if (s === "low") return "LOW";
  if (s === "info" || s === "informational" || s === "unknown" || s === "negligible") return "INFO";
  return "INFO";
}

/** Absolute deadline for an open finding. */
export function slaDeadline(firstSeenAt: Date, severity: FindingSeverity): Date {
  const window = SLA_WINDOWS_MS[severity];
  if (!isFinite(window)) return new Date(8_640_000_000_000_000); // far future
  return new Date(firstSeenAt.getTime() + window);
}

/** True when a still-open finding has crossed its window. */
export function isSlaBreached(finding: {
  firstSeenAt: Date;
  severity: FindingSeverity;
  status: "open" | "fixed" | "suppressed";
}): boolean {
  if (finding.status !== "open") return false;
  return Date.now() > slaDeadline(finding.firstSeenAt, finding.severity).getTime();
}
