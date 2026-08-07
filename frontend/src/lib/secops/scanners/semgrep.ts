/**
 * semgrep scanner — NOT YET IMPLEMENTED.
 *
 * When adding this, follow the shape of `trivy.ts`:
 *   1. Run the actual scanner (either shell out to the CLI or call its API).
 *   2. For each finding: `upsertFinding({ scanner: "semgrep", … })`.
 *   3. After the loop: `reconcileScanRun` with a scopeTargetPrefix so this
 *      scanner only closes findings it's authoritative over.
 *   4. For freshly-created findings, `notifyIfBreached` catches the
 *      already-past-SLA-at-birth case.
 *
 * See `stub.ts` for why this throws rather than silently returning zero.
 */
import { unimplemented } from "./stub";

export const scanAndPersistSemgrep = unimplemented("semgrep");
