"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Icon, Input, PageHead, Select } from "@/components/ui";
import { CloudCredentialsModal } from "@/components/modals/CloudCredentialsModal";
import { EksChatBox } from "@/components/domain/EksChatBox";
import { GkeChatBox } from "@/components/domain/GkeChatBox";
import { AksChatBox } from "@/components/domain/AksChatBox";
import { KubernetesManifestBuilder } from "@/components/domain/KubernetesManifestBuilder";
import { HelmChartBuilder } from "@/components/domain/HelmChartBuilder";
import { api } from "@/lib/api/client";
import {
  useDeleteGkeCluster,
  useRerunTerraformRun,
  useTerraformRuns,
  type TfRun,
  type TfStageStatus,
} from "@/hooks/queries/connectivity";

type AwsProvider = {
  providerId: string;
  kind: "aws" | "gcp" | "azure";
  name: string;
  region: string;
  hasVaultCreds: boolean;
};
type EnvRow = { id: string; key: string; name: string };
type TfBackend = { bucket: string | null; region: string | null; table: string | null };

export function ProjectInfraClient({ slug }: { slug: string }) {
  return (
    <div className="col gap-5">
      <PageHead
        title="Infrastructure"
        sub="Cloud credentials (Vault), Terraform state, and managed-Kubernetes cluster provisioning (EKS · GKE · AKS)."
      />
      <CredentialsSection slug={slug} />
      <StateSection slug={slug} />
      <ClusterCreateSection slug={slug} />
      <GkeClusterUtilities slug={slug} />
      <KubernetesManifestBuilder slug={slug} />
      <HelmChartBuilder slug={slug} />
      <TerraformPipelineSection slug={slug} />
    </div>
  );
}

/* ── GKE utilities: delete an orphaned cluster (persistent, not tied to a run) ── */
function GkeClusterUtilities({ slug }: { slug: string }) {
  const { data: projectInfo } = useQuery<{ project: { cloud: string | null } }>({
    queryKey: ["p", slug, "project-cloud"],
    queryFn: () => api.get<{ project: { cloud: string | null } }>(`/projects/${slug}`),
    staleTime: 60_000,
  });
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  const [envKey, setEnvKey] = useState("");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("us-central1");
  const [name, setName] = useState("");
  useEffect(() => {
    if (!envKey && envs && envs.length > 0) setEnvKey(envs[0].key);
  }, [envs, envKey]);
  const del = useDeleteGkeCluster(slug, envKey);

  // Only meaningful on GCP projects. Anything else, no reason to show it.
  if (projectInfo?.project?.cloud !== "gcp") return null;

  const canDelete =
    !!envKey && project.trim().length > 0 && location.trim().length > 0 && name.trim().length > 0;
  const result = del.data;
  const resultMsg =
    result?.alreadyGone
      ? `Cluster "${name}" was already gone.`
      : result?.deleted
        ? `Deleted "${name}". You can now regenerate + apply the Terraform.`
        : del.error instanceof Error
          ? del.error.message
          : null;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Delete an orphaned GKE cluster in GCP — for when a prior Terraform apply crashed after creating the cluster but before writing state (so a new apply hits 409 alreadyExists). Uses the env's stored GCP creds; no gcloud needed.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="trash" size={16} /> Delete orphaned GKE cluster
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {!envs || envs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Create an environment first.</span>
        ) : (
          <div className="col gap-3" style={{ maxWidth: 520 }}>
            <Field label="Environment (provides GCP creds)">
              <Select
                value={envKey}
                onValueChange={setEnvKey}
                ariaLabel="Env for GCP creds"
                options={envs.map((e) => ({ value: e.key, label: e.name || e.key }))}
              />
            </Field>
            <Field label="GCP project id">
              <Input
                className="mono"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="new-project-495604"
              />
            </Field>
            <Field label="Location (region or zone)">
              <Input
                className="mono"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="us-central1"
              />
            </Field>
            <Field label="Cluster name">
              <Input
                className="mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="dev"
              />
            </Field>
            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Btn
                variant="primary"
                icon="trash"
                loading={del.isPending}
                disabled={!canDelete || del.isPending}
                onClick={() =>
                  del.mutate({
                    project: project.trim(),
                    location: location.trim(),
                    name: name.trim(),
                  })
                }
              >
                Delete cluster
              </Btn>
              <span className="muted" style={{ fontSize: 12 }}>
                Fires DELETE + polls the operation. Typically 3-6 min.
              </span>
            </div>
            {resultMsg && (
              <span
                style={{
                  fontSize: 12.5,
                  color: result?.deleted || result?.alreadyGone ? "var(--ok, #30a46c)" : "var(--danger, #e5484d)",
                }}
              >
                {resultMsg}
              </span>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}

/* ── Cluster creation — picks the chat box that matches the project's cloud ─── */
function ClusterCreateSection({ slug }: { slug: string }) {
  // The cloud this project targets isolates which managed-Kubernetes blueprint
  // is offered (AWS → EKS, GCP → GKE, Azure → AKS). Legacy projects with no
  // chosen cloud fall back to EKS.
  const { data: projectInfo } = useQuery<{ project: { cloud: string | null } }>({
    queryKey: ["p", slug, "project-cloud"],
    queryFn: () => api.get<{ project: { cloud: string | null } }>(`/projects/${slug}`),
    staleTime: 60_000,
  });
  const cloud = projectInfo?.project?.cloud ?? null;

  if (cloud === "gcp") return <GkeChatBox slug={slug} />;
  if (cloud === "azure") return <AksChatBox slug={slug} />;
  return <EksChatBox slug={slug} />;
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
function findOrphanedGkeCluster(run: TfRun): { project: string; location: string; name: string } | null {
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
  const runningTone = run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "info";
  const rerun = useRerunTerraformRun(slug, run.envKey);
  const deleteGke = useDeleteGkeCluster(slug, run.envKey);
  const isTerminal = run.status === "succeeded" || run.status === "failed";
  const errText =
    rerun.error instanceof Error ? rerun.error.message : rerun.error ? "Rerun failed." : null;
  const rerunLabel = `Rerun (${run.action})`;

  // If this run failed because a prior apply orphaned a cluster in GCP, offer
  // an in-app delete button so the user never touches gcloud (matches the
  // "self-contained" invariant this app is built to).
  const orphan = findOrphanedGkeCluster(run);
  const deleteResult = deleteGke.data;
  const deleteMsg =
    deleteResult?.alreadyGone
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
        <div className="row gap-2" style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <Block.Title sub={`${run.action} · ${run.envKey}`}>
            <span className="row gap-2" style={{ alignItems: "center" }}>
              {run.name}
              <Badge tone={runningTone} withDot>{run.status}</Badge>
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
                disabled={deleteGke.isPending || !!deleteResult?.deleted || !!deleteResult?.alreadyGone}
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
              disabled={!isTerminal || rerun.isPending || deleteGke.isPending}
              title={
                isTerminal
                  ? `Replay this run with the same files + backend.`
                  : "Wait for the run to finish before rerunning."
              }
              onClick={() => rerun.mutate({ runId: run.id })}
            >
              {rerunLabel}
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
                  <Badge tone={STAGE_TONE[s.status]} withDot>{s.name}</Badge>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {s.status}{typeof s.exitCode === "number" ? ` · exit ${s.exitCode}` : ""}
                  </span>
                  {stageDuration && s.status !== "pending" && s.status !== "skipped" && (
                    <span className="row gap-1 muted" style={{ fontSize: 12, alignItems: "center" }}>
                      <span aria-hidden>·</span>
                      <Icon name="clock" size={11} />
                      {stageDuration}
                    </span>
                  )}
                </div>
                {s.logs.trim() && (
                  <pre style={{ fontSize: 11.5, overflowX: "auto", whiteSpace: "pre-wrap", margin: 0, maxHeight: 220, background: "var(--surface-2, #0000000a)", padding: 8, borderRadius: 6 }}>
                    {s.logs.slice(-4000)}
                  </pre>
                )}
              </div>
            );
          })}
          {run.error && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>{run.error}</span>}
          {errText && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>
              {errText.includes("source_evicted") || errText.includes("410")
                ? "Can't rerun — this run's source spec is no longer in memory (older than the last 100 runs). Start a fresh run from the create form."
                : errText}
            </span>
          )}
          {orphan && !deleteGke.isPending && !deleteResult && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              A cluster with this name already exists in GCP (likely from an earlier apply that lost state). Use
              <b> Delete existing cluster</b> to wipe it, then Rerun.
            </span>
          )}
          {deleteMsg && (
            <span
              style={{
                fontSize: 12.5,
                color: deleteResult?.deleted || deleteResult?.alreadyGone ? "var(--ok, #30a46c)" : "var(--danger, #e5484d)",
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
  const runs = runsQuery.data?.runs ?? [];

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Runs that generated infra (e.g. EKS) executes — init → plan → apply against the env's Vault creds + S3 state.">
          Terraform pipeline
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {!envs || envs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Create an environment to run Terraform.</span>
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
                No runs yet. Generate an EKS cluster above, then hit <b>Plan</b> or <b>Apply</b>.
              </span>
            ) : (
              <div className="col gap-3">
                {runs.map((r) => <RunCard key={r.id} slug={slug} run={r} />)}
              </div>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}

/* ── 1. AWS credentials (HashiCorp Vault) ──────────────────────────────────── */
function CredentialsSection({ slug }: { slug: string }) {
  const [credFor, setCredFor] = useState<{ id: string; name: string } | null>(null);
  const { data } = useQuery<AwsProvider[]>({
    queryKey: ["p", slug, "providers", "all", "infra"],
    queryFn: () => api.get<AwsProvider[]>(`/projects/${slug}/providers`, { env: "all" }),
    staleTime: 60_000,
  });
  const aws = (data ?? []).filter((p) => p.kind === "aws");

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="AWS access key + secret are stored in HashiCorp Vault, never in the database.">
          Cloud credentials (Vault)
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {aws.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            No AWS provider yet. Add one on the Cloud providers page, then set its keys here.
          </span>
        ) : (
          <div className="col gap-2">
            {aws.map((p) => (
              <div key={p.providerId} className="row gap-3" style={{ alignItems: "center", justifyContent: "space-between" }}>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span className="muted" style={{ fontSize: 13 }}>{p.region}</span>
                  {p.hasVaultCreds ? <Badge tone="ok" withDot>keys in Vault</Badge> : <Badge tone="warn" withDot>no keys</Badge>}
                </div>
                <Btn variant="outline" size="sm" icon="lock" onClick={() => setCredFor({ id: p.providerId, name: p.name })}>
                  {p.hasVaultCreds ? "Update keys" : "Add keys"}
                </Btn>
              </div>
            ))}
          </div>
        )}
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

/* ── 2. Terraform state (S3 bucket) ────────────────────────────────────────── */
function StateSection({ slug }: { slug: string }) {
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  const [envKey, setEnvKey] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [table, setTable] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!envKey && envs && envs.length > 0) setEnvKey(envs[0].key);
  }, [envs, envKey]);

  const current = useQuery<TfBackend>({
    queryKey: ["p", slug, "tf-backend", envKey],
    queryFn: () => api.get<TfBackend>(`/projects/${slug}/envs/${envKey}/tf-backend`),
    enabled: !!envKey,
  });
  useEffect(() => {
    if (current.data) {
      setBucket(current.data.bucket ?? "");
      setRegion(current.data.region ?? "us-east-1");
      setTable(current.data.table ?? "");
    }
  }, [current.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/projects/${slug}/envs/${envKey}/tf-backend`, {
        bucket: bucket.trim(),
        region: region.trim(),
        ...(table.trim() ? { table: table.trim() } : {}),
      }),
    onSuccess: () => setMsg("Saved."),
    onError: (e: unknown) => setMsg(e instanceof Error ? e.message : "Save failed."),
  });

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Per-environment S3 bucket (+ optional DynamoDB lock) that backs Terraform remote state.">
          Terraform state (S3)
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {!envs || envs.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Create an environment first to configure its state backend.</span>
        ) : (
          <div className="col gap-3" style={{ maxWidth: 520 }}>
          <Field label="Environment">
            <Select
              value={envKey}
              onValueChange={(v) => { setEnvKey(v); setMsg(null); }}
              ariaLabel="Environment"
              options={envs.map((e) => ({ value: e.key, label: e.name || e.key }))}
            />
          </Field>
          <Field label="S3 state bucket" required>
            <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-tfstate-bucket" />
          </Field>
          <Field label="Bucket region" required>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
          </Field>
          <Field label="DynamoDB lock table" hint="Optional — enables state locking.">
            <Input value={table} onChange={(e) => setTable(e.target.value)} placeholder="terraform-locks" />
          </Field>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <Btn
              variant="primary"
              icon="check"
              loading={save.isPending}
              disabled={!bucket.trim() || !region.trim()}
              onClick={() => { setMsg(null); save.mutate(); }}
            >
              Save state backend
            </Btn>
            {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
          </div>
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
