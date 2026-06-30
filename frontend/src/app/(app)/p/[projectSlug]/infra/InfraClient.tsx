"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead, Select } from "@/components/ui";
import { CloudCredentialsModal } from "@/components/modals/CloudCredentialsModal";
import { EksChatBox } from "@/components/domain/EksChatBox";
import { GkeChatBox } from "@/components/domain/GkeChatBox";
import { AksChatBox } from "@/components/domain/AksChatBox";
import { KubernetesManifestBuilder } from "@/components/domain/KubernetesManifestBuilder";
import { HelmChartBuilder } from "@/components/domain/HelmChartBuilder";
import { api } from "@/lib/api/client";
import {
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
      <KubernetesManifestBuilder slug={slug} />
      <HelmChartBuilder slug={slug} />
      <TerraformPipelineSection slug={slug} />
    </div>
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

function RunCard({ run }: { run: TfRun }) {
  const runningTone = run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "info";
  return (
    <Block>
      <Block.Header>
        <Block.Title sub={`${run.action} · ${run.envKey}`}>
          <span className="row gap-2" style={{ alignItems: "center" }}>
            {run.name}
            <Badge tone={runningTone} withDot>{run.status}</Badge>
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-2">
          {run.stages.map((s) => (
            <div key={s.name} className="col gap-1">
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Badge tone={STAGE_TONE[s.status]} withDot>{s.name}</Badge>
                <span className="muted" style={{ fontSize: 12 }}>
                  {s.status}{typeof s.exitCode === "number" ? ` · exit ${s.exitCode}` : ""}
                </span>
              </div>
              {s.logs.trim() && (
                <pre style={{ fontSize: 11.5, overflowX: "auto", whiteSpace: "pre-wrap", margin: 0, maxHeight: 220, background: "var(--surface-2, #0000000a)", padding: 8, borderRadius: 6 }}>
                  {s.logs.slice(-4000)}
                </pre>
              )}
            </div>
          ))}
          {run.error && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>{run.error}</span>}
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
                {runs.map((r) => <RunCard key={r.id} run={r} />)}
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
