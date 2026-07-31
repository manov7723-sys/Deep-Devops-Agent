/**
 * Shape returned by GET /projects/[slug]/provisioned-stacks — one row per
 * unique stack the agent has applied, annotated with what the cloud says
 * about it right now.
 *
 * `cloudStatus` semantics:
 *   • "exists"   — the primary resource this stack owns is present in the
 *                  cloud. State is trustworthy; a Delete runs destroy first.
 *   • "gone"     — the primary resource is NOT in the cloud. Someone likely
 *                  deleted it outside the app (Portal, CLI, another team).
 *                  A Delete can skip destroy and just clean up state.
 *   • "unknown"  — cloud lookup failed (auth, quota, transient). Show as-is
 *                  and let the user retry; don't lie in either direction.
 *   • "unsupported" — we don't have a reconciler for this stack's cloud yet
 *                  (currently: everything non-Azure). Show as-is; delete
 *                  still runs destroy + state-delete without cloud-truth.
 */
export type ProvisionedStack = {
  envKey: string;
  stack: string;
  runId: string;
  appliedAt: string;
  cloud: "aws" | "azure" | "gcp" | "unknown";
  /** Primary resource this stack owns, if identifiable from its Terraform. */
  primaryResource: { kind: string; name: string } | null;
  cloudStatus: "exists" | "gone" | "unknown" | "unsupported";
  cloudNote?: string;
};
