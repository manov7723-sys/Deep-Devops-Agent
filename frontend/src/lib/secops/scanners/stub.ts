/**
 * Shared stub for scanners that haven't been implemented yet.
 *
 * Each unimplemented scanner (`gitleaks.ts`, `semgrep.ts`, `npm-audit.ts`,
 * `checkov.ts`, `kube-bench.ts`, `prowler.ts`) re-exports `unimplemented()`
 * under its expected function name. The signature intentionally matches
 * `scanAndPersistTrivy` so a real implementation drops in as a straight
 * substitution — no caller changes.
 *
 * Throwing (rather than returning `{ ok: false }`) is deliberate: a caller
 * that hasn't checked for the "not implemented" case sees the error at test
 * time, not silently when a scan reports zero findings.
 */
export type ScannerScope = {
  projectId: string;
  projectSlug: string;
  /** repo full name (repo-scoped scanners) — omit for env-scoped ones */
  repoFullName?: string;
  /** env key (env-scoped scanners like kube-bench, prowler) */
  envKey?: string | null;
};

export type ScannerResult =
  | {
      ok: true;
      total: number;
      newlySeen: number;
      breachedAtBirth: number;
      closed: number;
    }
  | { ok: false; error: string };

export function unimplemented(name: string): (scope: ScannerScope) => Promise<ScannerResult> {
  return async () => {
    throw new Error(
      `secops scanner "${name}" is not implemented yet. Add its scanner file under lib/secops/scanners/ following the trivy.ts shape.`,
    );
  };
}
