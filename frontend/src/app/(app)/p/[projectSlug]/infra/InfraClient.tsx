"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Icon, PageHead, Select } from "@/components/ui";
import { CloudCredentialsModal } from "@/components/modals/CloudCredentialsModal";
import { api } from "@/lib/api/client";
import {
  useDeleteGkeCluster,
  useRerunTerraformRun,
  useDestroyTerraformRun,
  useDeleteTerraformState,
  useDeleteTerraformRun,
  useTerraformRuns,
  type TfRun,
  type TfStageStatus,
} from "@/hooks/queries/connectivity";

type AwsProvider = {
  providerId: string;
  kind: "aws" | "gcp" | "azure";
  name: string;
  region: string;
  hasAwsKeysStored: boolean;
};
type EnvRow = { id: string; key: string; name: string };

export function ProjectInfraClient({ slug }: { slug: string }) {
  return (
    <div className="col gap-5">
      <PageHead
        title="Infrastructure"
        sub="AWS credentials and the recent Terraform runs generated from chat. Configure the state backend on the Connection tab (per-environment)."
      />
      <CredentialsSection slug={slug} />
      <TerraformPipelineSection slug={slug} />
    </div>
  );
}

/* ── Shared: render a Terraform run's stages + logs ─────────────────────────── */
const STAGE_TONE: Record<TfStageStatus, "ok" | "warn" | "danger" | "info" | "default"> = {
  succeeded: "ok",
  running: "info",
  failed: "danger",
  pending: "default",
  skipped: "default",
};

/**
 * "1m 47s" / "42s" / "1h 3m" — human-friendly duration between two ISO
 * strings. When `end` is undefined (a still-running stage) the caller passes
 * `Date.now()` from the live ticker so the label counts up in real time.
 */
function formatDuration(startIso?: string, endMs?: number): string | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endMs ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem === 0 ? `${hours}h` : `${hours}h ${minRem}m`;
}

/**
 * Live-updating clock. Returns Date.now() and re-triggers a render every
 * second — but only while `enabled` is true, so completed runs don't waste
 * a timer. Multiple RunCards each get their own ticker; that's fine at the
 * scale this page ever renders (dozens of rows, not thousands).
 */
function useNowTick(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);
  return now;
}

/**
 * Detect the "409 alreadyExists" error a failed GKE apply produces when a
 * prior run created the cluster but couldn't record it to state (e.g. because
 * the apply was killed at the runner timeout). Parses the resource path so
 * the "Delete existing cluster" button knows what to nuke.
 *
 * Example line the regex matches:
 *   Error: googleapi: Error 409: Already exists:
 *     projects/new-project-495604/locations/us-central1/clusters/dev.
 */
function findOrphanedGkeCluster(
  run: TfRun,
): { project: string; location: string; name: string } | null {
  if (run.status !== "failed") return null;
  for (const stage of run.stages) {
    // Only look at the stages that talk to Google — plan/apply.
    if (!stage.logs) continue;
    const m = stage.logs.match(
      /projects\/([A-Za-z0-9-]{1,64})\/locations\/([A-Za-z0-9-]{1,40})\/clusters\/([a-z][a-z0-9-]{0,39})/,
    );
    if (m && /already exists|alreadyExists|Error 409/i.test(stage.logs)) {
      return { project: m[1]!, location: m[2]!, name: m[3]! };
    }
  }
  return null;
}

function RunCard({ slug, run }: { slug: string; run: TfRun }) {
  const runningTone =
    run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "info";
  const rerun = useRerunTerraformRun(slug, run.envKey);
  const destroy = useDestroyTerraformRun(slug, run.envKey);
  const deleteState = useDeleteTerraformState(slug, run.envKey);
  const deleteRun = useDeleteTerraformRun(slug, run.envKey);
  const deleteGke = useDeleteGkeCluster(slug, run.envKey);
  const isTerminal = run.status === "succeeded" || run.status === "failed";
  const errText =
    rerun.error instanceof Error
      ? rerun.error.message
      : rerun.error
        ? "Rerun failed."
        : deleteRun.error instanceof Error
          ? deleteRun.error.message
          : deleteRun.error
            ? "Delete failed."
            : null;
  const rerunLabel = `Rerun (${run.action})`;

  // If this run failed because a prior apply orphaned a cluster in GCP, offer
  // an in-app delete button so the user never touches gcloud (matches the
  // "self-contained" invariant this app is built to).
  const orphan = findOrphanedGkeCluster(run);
  const deleteResult = deleteGke.data;
  const deleteMsg = deleteResult?.alreadyGone
    ? `The cluster "${orphan?.name}" was already gone. Rerun should succeed now.`
    : deleteResult?.deleted
      ? `Deleted "${orphan?.name}". Hit Rerun to apply again.`
      : deleteGke.error instanceof Error
        ? deleteGke.error.message
        : null;

  // Live clock while the run is still going. Ends the moment the badge
  // flips to succeeded/failed. Also drives per-stage "still running" counters.
  const nowMs = useNowTick(!isTerminal);
  const runEnd = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
  const runDuration = formatDuration(run.createdAt, runEnd);
  const runTimeLabel = isTerminal
    ? runDuration
      ? `took ${runDuration}`
      : null
    : runDuration
      ? `${runDuration} elapsed`
      : null;

  return (
    <Block>
      <Block.Header>
        <div
          className="row gap-2"
          style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}
        >
          <Block.Title sub={`${run.action} · ${run.envKey}`}>
            <span className="row gap-2" style={{ alignItems: "center" }}>
              {run.name}
              <Badge tone={runningTone} withDot>
                {run.status}
              </Badge>
              {runTimeLabel && (
                <span
                  className="row gap-1 muted"
                  style={{ fontSize: 12, alignItems: "center" }}
                  title={`Started ${new Date(run.createdAt).toLocaleString()}${run.finishedAt ? ` · Finished ${new Date(run.finishedAt).toLocaleString()}` : ""}`}
                >
                  <Icon name="clock" size={12} />
                  {runTimeLabel}
                </span>
              )}
            </span>
          </Block.Title>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {orphan && (
              <Btn
                size="sm"
                variant="outline"
                icon="trash"
                loading={deleteGke.isPending}
                disabled={
                  deleteGke.isPending || !!deleteResult?.deleted || !!deleteResult?.alreadyGone
                }
                title={`Delete the orphaned cluster ${orphan.project}/${orphan.location}/${orphan.name} in GCP via stored env creds (5-8 min).`}
                onClick={() => deleteGke.mutate(orphan)}
              >
                Delete existing cluster
              </Btn>
            )}
            <Btn
              size="sm"
              variant="outline"
              icon="refresh"
              loading={rerun.isPending}
              disabled={!isTerminal || rerun.isPending || deleteGke.isPending || deleteRun.isPending || destroy.isPending || deleteState.isPending}
              title={
                isTerminal
                  ? `Replay this run with the same files + backend.`
                  : "Wait for the run to finish before rerunning."
              }
              onClick={() => rerun.mutate({ runId: run.id })}
            >
              {rerunLabel}
            </Btn>
            {/*
              Destroy — runs `terraform destroy -auto-approve` against the same
              files + backend. Only shown for runs whose original action was
              apply (destroying a plan-only run makes no sense). Guarded with a
              confirm because it wipes real cloud resources.
            */}
            {run.action === "apply" && (
              <Btn
                size="sm"
                variant="outline"
                icon="trash"
                loading={destroy.isPending}
                disabled={!isTerminal || rerun.isPending || destroy.isPending || deleteState.isPending || deleteRun.isPending}
                title={
                  isTerminal
                    ? "Run terraform destroy against the same stack — wipes every resource this apply created (~5-15 min for AKS/EKS)."
                    : "Wait for the run to finish before destroying."
                }
                onClick={() => {
                  if (window.confirm(`terraform destroy for "${run.name}"?\nThis wipes every cloud resource this apply created. Not reversible.`)) {
                    destroy.mutate({ runId: run.id });
                  }
                }}
              >
                Destroy
              </Btn>
            )}
            {/*
              Delete state — removes the tfstate blob from the env's remote
              backend. Recovery path for a partial apply whose state upload
              failed (network drop mid-apply): after destroy, the state is
              often stale; delete it so the next apply starts clean.
              Also useful when the cluster was manually deleted in the cloud
              console and state now references non-existent resources.
            */}
            <Btn
              size="sm"
              variant="outline"
              icon="trash"
              loading={deleteState.isPending}
              disabled={!isTerminal || rerun.isPending || destroy.isPending || deleteState.isPending || deleteRun.isPending}
              title={
                isTerminal
                  ? "Delete this stack's terraform state blob. Use AFTER destroy (or when state is orphaned) so the next apply starts fresh. Cloud resources are NOT touched."
                  : "Wait for the run to finish before deleting state."
              }
              onClick={() => {
                if (window.confirm(`Delete terraform state for stack "${run.name}"?\nDoes NOT touch cloud resources — run Destroy first if you want them gone.`)) {
                  deleteState.mutate({ stack: run.name });
                }
              }}
            >
              Delete state
            </Btn>
            <Btn
              size="sm"
              variant="outline"
              icon="trash"
              loading={deleteRun.isPending}
              disabled={!isTerminal || rerun.isPending || deleteGke.isPending || deleteRun.isPending}
              title={
                isTerminal
                  ? "Remove this run from the pipeline list. Does NOT touch cloud resources or terraform state."
                  : "Wait for the run to finish before deleting."
              }
              onClick={() => {
                // Cheap confirm — deletion is safe (state stays) but the row
                // vanishes, and users hitting it accidentally is easy to prevent.
                if (window.confirm(`Delete run "${run.name}" from the pipeline list? Cloud resources + terraform state are untouched.`)) {
                  deleteRun.mutate({ runId: run.id });
                }
              }}
            >
              Delete
            </Btn>
          </div>
        </div>
      </Block.Header>
      <Block.Body>
        <div className="col gap-2">
          {run.stages.map((s) => {
            const stageEnd = s.finishedAt ? new Date(s.finishedAt).getTime() : nowMs;
            const stageDuration = formatDuration(s.startedAt, stageEnd);
            return (
              <div key={s.name} className="col gap-1">
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <Badge tone={STAGE_TONE[s.status]} withDot>
                    {s.name}
                  </Badge>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {s.status}
                    {typeof s.exitCode === "number" ? ` · exit ${s.exitCode}` : ""}
                  </span>
                  {stageDuration && s.status !== "pending" && s.status !== "skipped" && (
                    <span
                      className="row gap-1 muted"
                      style={{ fontSize: 12, alignItems: "center" }}
                    >
                      <span aria-hidden>·</span>
                      <Icon name="clock" size={11} />
                      {stageDuration}
                    </span>
                  )}
                </div>
                {s.logs.trim() && (
                  <pre
                    style={{
                      fontSize: 11.5,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      margin: 0,
                      maxHeight: 220,
                      background: "var(--surface-2, #0000000a)",
                      padding: 8,
                      borderRadius: 6,
                    }}
                  >
                    {s.logs.slice(-4000)}
                  </pre>
                )}
              </div>
            );
          })}
          {run.error && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>{run.error}</span>
          )}
          {errText && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>
              {errText.includes("source_evicted") || errText.includes("410")
                ? "Can't rerun — this run's source spec is no longer in memory (older than the last 100 runs). Start a fresh run from the create form."
                : errText}
            </span>
          )}
          {orphan && !deleteGke.isPending && !deleteResult && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              A cluster with this name already exists in GCP (likely from an earlier apply that lost
              state). Use
              <b> Delete existing cluster</b> to wipe it, then Rerun.
            </span>
          )}
          {deleteMsg && (
            <span
              style={{
                fontSize: 12.5,
                color:
                  deleteResult?.deleted || deleteResult?.alreadyGone
                    ? "var(--ok, #30a46c)"
                    : "var(--danger, #e5484d)",
              }}
            >
              {deleteMsg}
            </span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}

/* ── 4. Terraform pipeline (init → plan → apply) ───────────────────────────── */
function TerraformPipelineSection({ slug }: { slug: string }) {
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  const [envKey, setEnvKey] = useState("");
  useEffect(() => {
    if (!envKey && envs && envs.length > 0) setEnvKey(envs[0].key);
  }, [envs, envKey]);

  const runsQuery = useTerraformRuns(slug, envKey, !!envKey);
  // Only the ONE most recent run is shown here — older runs stay in the DB
  // but never render on this tab. The user wanted the pipeline card focused
  // on "what just happened", not a scrollable history.
  const RECENT_LIMIT = 1;
  const allRuns = runsQuery.data?.runs ?? [];
  const runs = allRuns.slice(0, RECENT_LIMIT);
  const hiddenCount = allRuns.length - runs.length;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Most recent Terraform run — init → plan → apply against the env's stored creds + S3 state.">
          Terraform pipeline
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {!envs || envs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Create an environment to run Terraform.
          </span>
        ) : (
          <div className="col gap-3">
            <div style={{ maxWidth: 320 }}>
              <Field label="Environment">
                <Select
                  value={envKey}
                  onValueChange={setEnvKey}
                  ariaLabel="Pipeline environment"
                  options={envs.map((e) => ({ value: e.key, label: e.name || e.key }))}
                />
              </Field>
            </div>
            {runs.length === 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                No runs yet. Generate infra from chat (e.g. “create cluster”), then hit{" "}
                <b>Plan</b> or <b>Apply</b>.
              </span>
            ) : (
              <div className="col gap-3">
                {runs.map((r) => (
                  <RunCard key={r.id} slug={slug} run={r} />
                ))}
                {hiddenCount > 0 && (
                  <span
                    className="muted"
                    style={{ fontSize: 12, textAlign: "right" }}
                  >
                    {hiddenCount} older run{hiddenCount === 1 ? "" : "s"} hidden — showing only
                    the most recent one.
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}

/* ── 1. AWS credentials (optional long-lived keys, encrypted at rest) ─────── */
function CredentialsSection({ slug }: { slug: string }) {
  const [credFor, setCredFor] = useState<{ id: string; name: string } | null>(null);
  const { data } = useQuery<AwsProvider[]>({
    queryKey: ["p", slug, "providers", "all", "infra"],
    queryFn: () => api.get<AwsProvider[]>(`/projects/${slug}/providers`, { env: "all" }),
    staleTime: 60_000,
  });
  const aws = (data ?? []).filter((p) => p.kind === "aws");
  if (aws.length === 0) return null;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Optional — only needed if you want to use a long-lived access key instead of the default AssumeRole connection. Encrypted at rest; no external service required.">
          AWS access keys
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-2">
          {aws.map((p) => (
            <div
              key={p.providerId}
              className="row gap-3"
              style={{ alignItems: "center", justifyContent: "space-between" }}
            >
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {p.region}
                </span>
                {p.hasAwsKeysStored ? (
                  <Badge tone="ok" withDot>
                    keys stored
                  </Badge>
                ) : (
                  <Badge tone="default" withDot>
                    using AssumeRole
                  </Badge>
                )}
              </div>
              <Btn
                variant="outline"
                size="sm"
                icon="lock"
                onClick={() => setCredFor({ id: p.providerId, name: p.name })}
              >
                {p.hasAwsKeysStored ? "Update keys" : "Add keys"}
              </Btn>
            </div>
          ))}
        </div>
      </Block.Body>
      <CloudCredentialsModal
        open={!!credFor}
        onOpenChange={(o) => !o && setCredFor(null)}
        providerId={credFor?.id ?? null}
        providerName={credFor?.name ?? ""}
        slug={slug}
      />
    </Block>
  );
}

