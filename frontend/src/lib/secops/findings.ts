/**
 * Persistence + lifecycle for security findings.
 *
 * All scanners route through `upsertFinding` — the dedupe key is
 * `(projectId, scanner, ruleId, target)`, matching the unique index on the
 * schema. A rescan hits the same row and updates `lastSeenAt` + severity;
 * the row's `firstSeenAt` is preserved because that's what the SLA clock
 * counts against.
 *
 * `reconcileScanRun` closes findings a later scan didn't surface: they flip
 * from `open` → `fixed`. Without this, once-open-always-open would leave
 * fixed CVEs in the list forever, and dashboards would only ever grow.
 *
 * `setStatus` handles user-initiated status changes (suppress a false
 * positive, manually mark fixed). The audit trail lives in AuditLog — not
 * duplicated here — so `who muted this and why` stays queryable across the
 * app rather than being a Finding-only concept.
 */
import { prisma } from "@/lib/db/prisma";
import type { FindingSeverity, FindingStatus, Finding } from "@prisma/client";
import type { Prisma } from "@prisma/client";

export type ScannerName =
  | "trivy"
  | "gitleaks"
  | "semgrep"
  | "npm-audit"
  | "checkov"
  | "kube-bench"
  | "prowler";

export type UpsertFindingArgs = {
  projectId: string;
  envKey?: string | null;
  scanner: ScannerName;
  ruleId: string;
  target: string;
  severity: FindingSeverity;
  title: string;
  description?: string | null;
  fixedVersion?: string | null;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Insert or update a finding, deduped by (scanner, ruleId, target). Returns
 * the row plus `firstSeen: true` when this was the first time we saw it —
 * callers use that flag to decide "is this new enough to matter" without
 * having to compare timestamps themselves.
 *
 * A rescan of an already-existing finding does NOT reopen it if the row was
 * previously marked `fixed` or `suppressed` — that would silently override
 * a user decision. Suppression stays; reappearance is captured in
 * `lastSeenAt` so a report can show "suppressed but still present".
 */
export async function upsertFinding(
  args: UpsertFindingArgs,
): Promise<{ finding: Finding; firstSeen: boolean }> {
  const now = new Date();
  const existing = await prisma.finding.findUnique({
    where: {
      finding_dedupe: {
        projectId: args.projectId,
        scanner: args.scanner,
        ruleId: args.ruleId,
        target: args.target,
      },
    },
  });

  if (!existing) {
    const finding = await prisma.finding.create({
      data: {
        projectId: args.projectId,
        envKey: args.envKey ?? null,
        scanner: args.scanner,
        ruleId: args.ruleId,
        target: args.target,
        severity: args.severity,
        title: args.title,
        description: args.description ?? null,
        fixedVersion: args.fixedVersion ?? null,
        metadata: args.metadata,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    return { finding, firstSeen: true };
  }

  // Preserve user decisions: don't reopen a suppressed or fixed row from a
  // rescan. We DO update lastSeenAt so "still present" queries work.
  const preserveStatus = existing.status !== "open";
  const finding = await prisma.finding.update({
    where: { id: existing.id },
    data: {
      lastSeenAt: now,
      // Severity CAN change between scans (Trivy re-scores CVEs); trust the
      // latest scan. The SLA deadline uses firstSeenAt + latest severity's
      // window, which is the honest math — if a MEDIUM later becomes CRITICAL,
      // its clock effectively speeds up, which is what we want.
      severity: args.severity,
      title: args.title,
      description: args.description ?? existing.description,
      fixedVersion: args.fixedVersion ?? existing.fixedVersion,
      metadata: args.metadata ?? existing.metadata ?? undefined,
      status: preserveStatus ? existing.status : "open",
    },
  });
  return { finding, firstSeen: false };
}

/**
 * Close findings a later scan didn't surface.
 *
 * Called once per scan run with the (scanner, target-scope, and the exact set
 * of dedupe keys the scan emitted). Anything currently `open` for that scanner
 * within the scope but NOT in the seen set flips to `fixed`. Targets outside
 * the scope aren't touched — a repo-scoped Trivy run must not close a
 * cluster-scoped kube-bench finding.
 */
export async function reconcileScanRun(args: {
  projectId: string;
  scanner: ScannerName;
  /** Restrict which existing findings this run is authoritative over.
   *  For a repo scan this is typically the repo path prefix; for a namespace
   *  scan it's the namespace. Falsy = scanner-wide (rare — use with care). */
  scopeTargetPrefix?: string;
  seen: Array<{ ruleId: string; target: string }>;
}): Promise<{ closed: number }> {
  const seenKeys = new Set(args.seen.map((s) => `${s.ruleId}${s.target}`));
  const openRows = await prisma.finding.findMany({
    where: {
      projectId: args.projectId,
      scanner: args.scanner,
      status: "open",
      ...(args.scopeTargetPrefix ? { target: { startsWith: args.scopeTargetPrefix } } : {}),
    },
    select: { id: true, ruleId: true, target: true },
  });
  const toClose = openRows
    .filter((r) => !seenKeys.has(`${r.ruleId}${r.target}`))
    .map((r) => r.id);
  if (toClose.length === 0) return { closed: 0 };
  const now = new Date();
  await prisma.finding.updateMany({
    where: { id: { in: toClose } },
    data: { status: "fixed", fixedAt: now },
  });
  return { closed: toClose.length };
}

export type ListFindingsFilter = {
  projectId: string;
  status?: FindingStatus | FindingStatus[];
  minSeverity?: FindingSeverity;
  scanner?: ScannerName;
  limit?: number;
};

const SEV_ORDER: FindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export async function listFindings(f: ListFindingsFilter): Promise<Finding[]> {
  const sevSlice = f.minSeverity
    ? SEV_ORDER.slice(0, SEV_ORDER.indexOf(f.minSeverity) + 1)
    : undefined;
  return prisma.finding.findMany({
    where: {
      projectId: f.projectId,
      ...(f.status
        ? { status: Array.isArray(f.status) ? { in: f.status } : f.status }
        : {}),
      ...(sevSlice ? { severity: { in: sevSlice } } : {}),
      ...(f.scanner ? { scanner: f.scanner } : {}),
    },
    // Worst-and-oldest first — the review queue anyone would actually work.
    orderBy: [{ severity: "asc" }, { firstSeenAt: "asc" }],
    take: f.limit ?? 200,
  });
}

/**
 * User-initiated status change. Callers should also write an AuditLog row so
 * the "who muted this and why" is queryable app-wide — not doing it here
 * because the audit needs the request meta the caller already has.
 */
export async function setStatus(args: {
  findingId: string;
  status: FindingStatus;
  suppressedBy?: string | null;
}): Promise<Finding> {
  const now = new Date();
  return prisma.finding.update({
    where: { id: args.findingId },
    data: {
      status: args.status,
      fixedAt: args.status === "fixed" ? now : null,
      suppressedAt: args.status === "suppressed" ? now : null,
      suppressedBy: args.status === "suppressed" ? args.suppressedBy ?? null : null,
    },
  });
}
