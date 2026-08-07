/**
 * Trivy scanner — thin wrap of the existing `lib/automation/trivy.ts`.
 *
 * The scan itself already lives in `scanRepoWithTrivy` (called by the agent
 * tool and by chat playbooks). This wrapper adds two things on top:
 *   1. Persist each Trivy finding as a `Finding` row via `upsertFinding`.
 *   2. Close previously-open findings from the same repo scope that this
 *      scan didn't surface — otherwise a fix would look like it never
 *      happened.
 *
 * Kept deliberately narrow — no reformatting of severities, no summarising.
 * That's what the shared `severity.ts` and `notify.ts` are for; a scanner
 * wrapper should only translate scanner output into Finding rows.
 */
import { scanRepoWithTrivy, type TrivyFinding } from "@/lib/automation/trivy";
import { upsertFinding, reconcileScanRun } from "../findings";
import { notifyIfBreached } from "../notify";
import { toSeverity } from "../severity";

export type TrivyScanScope = {
  projectId: string;
  projectSlug: string;
  repoFullName: string;
  envKey?: string | null;
};

export type TrivyPersistResult =
  | {
      ok: true;
      total: number;
      newlySeen: number;
      breachedAtBirth: number;
      closed: number;
    }
  | { ok: false; error: string };

/**
 * Run a Trivy scan on a repo AND persist the results to the Finding table.
 *
 * `breachedAtBirth` is unusual but real: a scan can surface a finding whose
 * age is already past its SLA on the FIRST sighting — happens when a CVE was
 * published months ago and the app is scanning the repo for the first time.
 * `notifyIfBreached` handles that case; the scheduled sweep handles findings
 * that age INTO breach over time.
 */
export async function scanAndPersistTrivy(
  scope: TrivyScanScope,
): Promise<TrivyPersistResult> {
  const scan = await scanRepoWithTrivy(scope.projectId, scope.repoFullName);
  if (!scan.ok) return { ok: false, error: scan.error };

  // Prefix every target with the repo full-name so reconcileScanRun can
  // scope closes to THIS repo. Otherwise a Trivy scan of repo A would close
  // findings from repo B whose (ruleId, target) happened to overlap.
  const scopePrefix = `${scope.repoFullName}::`;
  const seen: Array<{ ruleId: string; target: string }> = [];
  let breachedAtBirth = 0;
  let newlySeen = 0;

  for (const f of scan.findings as TrivyFinding[]) {
    const target = `${scopePrefix}${f.target}::${f.pkgName || ""}`;
    seen.push({ ruleId: f.vulnerabilityId, target });

    const { finding, firstSeen } = await upsertFinding({
      projectId: scope.projectId,
      envKey: scope.envKey ?? null,
      scanner: "trivy",
      ruleId: f.vulnerabilityId,
      target,
      severity: toSeverity(f.severity),
      title: f.title || `${f.class}: ${f.vulnerabilityId}`,
      description: f.description || null,
      fixedVersion: f.fixedVersion || null,
      metadata: {
        class: f.class,
        pkgName: f.pkgName,
        rawSeverity: f.severity,
        rawTarget: f.target,
      },
    });
    if (firstSeen) newlySeen++;
    // Fire only for freshly-created findings that were ALREADY overdue —
    // repeated upserts of an existing finding don't re-fire, since the
    // scheduled sweep + `slaAlertedAt` guard handle ongoing state.
    if (firstSeen) {
      const before = { breached: false };
      await notifyIfBreached(finding, scope.projectSlug).then(() => {
        before.breached = !!finding.slaAlertedAt;
      });
      if (before.breached) breachedAtBirth++;
    }
  }

  const { closed } = await reconcileScanRun({
    projectId: scope.projectId,
    scanner: "trivy",
    scopeTargetPrefix: scopePrefix,
    seen,
  });

  return { ok: true, total: seen.length, newlySeen, breachedAtBirth, closed };
}
