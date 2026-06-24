"use client";

/**
 * EKS creation "static chat box" — a deterministic (no-LLM) cluster-creation
 * flow styled like the original DevOps-Agent chat. An assistant bubble holds a
 * single-page form; on submit the generated Terraform runs through the project
 * pipeline (#3) and a Jenkins-style init → plan → apply stage view streams back
 * as another assistant bubble.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select, Toggle } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api/client";
import {
  usePushInfraFiles,
  useStartTerraformRun,
  useTerraformRun,
  type TfRun,
  type TfStageStatus,
} from "@/hooks/queries/connectivity";

type RepoRow = { id: string; fullName: string; name: string; defaultBranch: string };

type EksOptions = {
  defaults: {
    region: string;
    kubernetesVersion: string;
    instanceType: string;
    desiredNodes: number;
    minNodes: number;
    maxNodes: number;
    endpointPublic: boolean;
  };
  instanceTypes: string[];
  kubernetesVersions: string[];
};
type EnvRow = { id: string; key: string; name: string };
type EksResult = {
  clusterName: string;
  region: string;
  fileCount: number;
  files: Record<string, string>;
  hasRemoteState: boolean;
};

type Bubble =
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "user"; text: string };

const STAGE_SYMBOL: Record<TfStageStatus, string> = {
  pending: "○",
  running: "◐",
  succeeded: "✓",
  failed: "✕",
  skipped: "–",
};

export function EksChatBox({ slug }: { slug: string }) {
  const opts = useQuery<EksOptions>({
    queryKey: ["p", slug, "eks", "options"],
    queryFn: () => api.get<EksOptions>(`/projects/${slug}/eks`),
    staleTime: 300_000,
  });
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  const { data: repos } = useQuery<RepoRow[]>({
    queryKey: ["p", slug, "repos"],
    queryFn: () => api.get<RepoRow[]>(`/projects/${slug}/repos`),
    staleTime: 60_000,
  });

  // Form state (deterministic — mirrors the old blueprint form fields).
  const [name, setName] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [version, setVersion] = useState("1.30");
  const [instanceType, setInstanceType] = useState("t3.medium");
  const [desired, setDesired] = useState(2);
  const [minN, setMinN] = useState(1);
  const [maxN, setMaxN] = useState(3);
  const [publicEp, setPublicEp] = useState(true);
  const [envKey, setEnvKey] = useState("");
  // VPC: create new (default) or reuse an existing VPC (avoids the VPC limit).
  const [createVpc, setCreateVpc] = useState(true);
  const [existingVpcId, setExistingVpcId] = useState("");
  const [existingSubnetIds, setExistingSubnetIds] = useState("");

  const [bubbles, setBubbles] = useState<Bubble[]>([
    {
      id: "intro",
      role: "assistant",
      text: "Let's create an EKS cluster. Fill in the details below — this is a deterministic blueprint, no AI tokens are used. Pick an environment so I can use its Vault credentials and S3 state.",
    },
  ]);
  const [phase, setPhase] = useState<"form" | "working">("form");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  // Step 1 output: the generated files (already pushed to GitHub), held so
  // Step 2 (Apply) runs the exact same content.
  const [generated, setGenerated] = useState<{ files: Record<string, string>; clusterName: string } | null>(null);

  // GitHub push (optional): repo + custom, auto-suggested file path.
  const [repoFullName, setRepoFullName] = useState("");
  const [ghPath, setGhPath] = useState("");
  const [ghPathTouched, setGhPathTouched] = useState(false);
  const pushFiles = usePushInfraFiles(slug);

  const startRun = useStartTerraformRun(slug, envKey);
  const runQuery = useTerraformRun(slug, envKey, runId);
  const run = runQuery.data?.run ?? null;

  useEffect(() => {
    if (opts.data) {
      setRegion((r) => r || opts.data!.defaults.region);
      setVersion(opts.data.defaults.kubernetesVersion);
      setInstanceType(opts.data.defaults.instanceType);
    }
  }, [opts.data]);
  useEffect(() => {
    if (!envKey && envs && envs.length > 0) setEnvKey(envs[0].key);
  }, [envs, envKey]);
  useEffect(() => {
    if (!repoFullName && repos && repos.length > 0) setRepoFullName(repos[0].fullName);
  }, [repos, repoFullName]);
  // Auto-suggest the GitHub folder from the cluster name (until the user edits).
  useEffect(() => {
    if (!ghPathTouched) setGhPath(`terraform/eks/${name.trim() || "<cluster>"}`);
  }, [name, ghPathTouched]);

  const versions = opts.data?.kubernetesVersions ?? ["1.30"];
  const types = opts.data?.instanceTypes ?? ["t3.medium"];
  const nameOk = /^[a-z][a-z0-9-]{1,38}$/.test(name.trim());
  const canCreate = nameOk && !!region.trim() && !!envKey && (createVpc || !!existingVpcId.trim()) && !busy;

  function say(role: Bubble["role"], text: string) {
    setBubbles((b) => [...b, { id: `${role}-${b.length}-${text.slice(0, 6)}`, role, text }]);
  }

  // Build the /eks request body from the current form.
  function eksBody() {
    return {
      name: name.trim(),
      region: region.trim(),
      kubernetesVersion: version,
      instanceType,
      desiredNodes: desired,
      minNodes: minN,
      maxNodes: maxN,
      endpointPublic: publicEp,
      createVpc,
      existingVpcId: createVpc ? undefined : existingVpcId.trim(),
      existingSubnetIds: createVpc
        ? undefined
        : existingSubnetIds.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  // STEP 1 — generate the HCL and push it INTO the GitHub repo. The generated
  // files are held in state so STEP 2 applies the exact same content.
  async function generateToGithub() {
    if (!canCreate || !repoFullName || !ghPath.trim()) return;
    setBusy(true);
    setGenerated(null);
    setRunId(null);
    say("user", `Generate Terraform for “${name.trim()}” → push to ${repoFullName}/${ghPath.trim()}.`);
    try {
      const gen = await api.post<EksResult>(`/projects/${slug}/eks`, eksBody());
      const pushed = await pushFiles.mutateAsync({
        repoFullName,
        basePath: ghPath.trim(),
        files: gen.files,
        branch: `infra/eks-${name.trim()}`,
        message: `Add EKS cluster ${name.trim()} (Terraform)`,
        pullRequestBody: `Deterministic EKS blueprint for \`${name.trim()}\` in ${region.trim()}.`,
      });
      setGenerated({ files: gen.files, clusterName: gen.clusterName });
      say(
        "assistant",
        pushed.pullRequest
          ? `✅ Generated ${gen.fileCount} files and pushed to ${repoFullName} — PR #${pushed.pullRequest.number}: ${pushed.pullRequest.url}\nReview it, then click “Apply to AWS”.`
          : `✅ Generated ${gen.fileCount} files and pushed to ${repoFullName} (branch infra/eks-${name.trim()}).\nNow click “Apply to AWS”.`,
      );
    } catch (e) {
      say("assistant", `❌ Generate/push failed: ${apiErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // STEP 2 — apply the generated/pushed files to AWS.
  async function applyGenerated() {
    if (!generated || !envKey) return;
    setBusy(true);
    setPhase("working");
    say("user", `Apply “${generated.clusterName}” to AWS (${envKey}).`);
    try {
      const res = await startRun.mutateAsync({
        action: "apply",
        name: generated.clusterName,
        files: generated.files,
        stack: `eks-${name.trim()}`,
      });
      if (!res.ok || !res.run) {
        say("assistant", `❌ Couldn't start apply: ${res.message ?? "unknown error"}`);
        setPhase("form");
      } else {
        setRunId(res.run.id);
        say("assistant", "Applying to AWS — EKS takes ~15–20 min. Watch the stages below.");
      }
    } catch (e) {
      say("assistant", `❌ ${apiErrorMessage(e)}`);
      setPhase("form");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setRunId(null);
    setGenerated(null);
    setPhase("form");
    setBubbles((b) => [
      ...b,
      { id: `divider-${b.length}`, role: "assistant", text: "Create another cluster below." },
    ]);
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Deterministic EKS blueprint (VPC + managed node group). No LLM — runs init → plan → apply.">
          Create EKS cluster
        </Block.Title>
      </Block.Header>

      <Block.Body>
      <div className="col gap-3" style={{ maxWidth: 640 }}>
        {/* Chat transcript */}
        <div className="col gap-2">
          {bubbles.map((b) => (
            <ChatBubble key={b.id} role={b.role}>{b.text}</ChatBubble>
          ))}
        </div>

        {/* Form lives in an assistant card until a run starts */}
        {phase === "form" && (
          <div style={{ marginLeft: 34 }}>
            <Block>
              <Block.Body>
              <div className="col gap-3">
                <Field label="Environment" required hint="Provides the AWS keys (Vault) + S3 state backend.">
                  {!envs || envs.length === 0 ? (
                    <span className="muted" style={{ fontSize: 13 }}>Create an environment first.</span>
                  ) : (
                    <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment"
                      options={envs.map((e) => ({ value: e.key, label: e.name || e.key }))} />
                  )}
                </Field>
                <Field label="Cluster name" required hint="Lowercase letters, digits, hyphens; start with a letter.">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-cluster" />
                </Field>
                <Field label="Region" required>
                  <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
                </Field>
                <Field label="Kubernetes version">
                  <Select value={version} onValueChange={setVersion} ariaLabel="Kubernetes version"
                    options={versions.map((v) => ({ value: v, label: v }))} />
                </Field>
                <Field label="Node instance type">
                  <Select value={instanceType} onValueChange={setInstanceType} ariaLabel="Instance type"
                    options={types.map((t) => ({ value: t, label: t }))} />
                </Field>
                <div className="row gap-3">
                  <Field label="Desired"><Input type="number" value={desired} onChange={(e) => setDesired(+e.target.value)} /></Field>
                  <Field label="Min"><Input type="number" value={minN} onChange={(e) => setMinN(+e.target.value)} /></Field>
                  <Field label="Max"><Input type="number" value={maxN} onChange={(e) => setMaxN(+e.target.value)} /></Field>
                </div>
                <Field label="Public API endpoint">
                  <Toggle checked={publicEp} onCheckedChange={setPublicEp} />
                </Field>

                {/* VPC: create new, or reuse an existing one (avoids the AWS
                    VPCs-per-region limit). */}
                <Field
                  label="Create a new VPC"
                  hint={createVpc ? "A dedicated VPC is created for the cluster." : "Reuse an existing VPC instead (no new VPC counts against your limit)."}
                >
                  <Toggle checked={createVpc} onCheckedChange={setCreateVpc} />
                </Field>
                {!createVpc && (
                  <>
                    <Field label="Existing VPC ID" required hint="e.g. vpc-09a50dc10ecb46968 (your default VPC works).">
                      <Input className="mono" value={existingVpcId}
                        onChange={(e) => setExistingVpcId(e.target.value)} placeholder="vpc-xxxxxxxxxxxx" />
                    </Field>
                    <Field label="Subnet IDs (optional)" hint="Comma-separated, ≥2 across different AZs. Leave blank to auto-discover the VPC's subnets.">
                      <Input className="mono" value={existingSubnetIds}
                        onChange={(e) => setExistingSubnetIds(e.target.value)} placeholder="subnet-aaa, subnet-bbb" />
                    </Field>
                  </>
                )}

                {/* GitHub repo — the generated code is written here (Step 1). */}
                <div className="col gap-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <span className="text-sm" style={{ fontWeight: 600 }}>GitHub repository (code is generated here)</span>
                  {!repos || repos.length === 0 ? (
                    <span className="muted" style={{ fontSize: 13 }}>Attach a repo on the CI/CD &amp; Repos tab first.</span>
                  ) : (
                    <>
                      <Field label="Repository" required>
                        <Select value={repoFullName} onValueChange={setRepoFullName} ariaLabel="Repository"
                          options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))} />
                      </Field>
                      <Field label="GitHub file path (folder)" required hint="Where the generated .tf files are committed. Edit freely.">
                        <Input className="mono" value={ghPath}
                          onChange={(e) => { setGhPath(e.target.value); setGhPathTouched(true); }}
                          placeholder="terraform/eks/my-cluster" />
                      </Field>
                    </>
                  )}
                </div>

                {/* Two-step flow: 1) generate → GitHub, then 2) apply. */}
                <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                  <Btn
                    variant="primary"
                    icon="github"
                    loading={pushFiles.isPending}
                    disabled={!canCreate || !repoFullName || !ghPath.trim()}
                    onClick={generateToGithub}
                  >
                    {generated ? "Regenerate to GitHub" : "1 · Generate to GitHub"}
                  </Btn>
                  <Btn
                    variant={generated ? "primary" : "outline"}
                    icon="server"
                    loading={startRun.isPending}
                    disabled={!generated || busy}
                    onClick={applyGenerated}
                  >
                    2 · Apply to AWS
                  </Btn>
                  {!nameOk && name.trim() && <span className="muted" style={{ fontSize: 12.5 }}>Invalid cluster name.</span>}
                  {!generated && (
                    <span className="faint" style={{ fontSize: 12 }}>Generate the code first, then Apply.</span>
                  )}
                </div>
              </div>
              </Block.Body>
            </Block>
          </div>
        )}

        {/* Jenkins-style stage view once a run is active */}
        {run && (
          <div style={{ marginLeft: 34 }}>
            <TerraformStageView run={run} />
            {(run.status === "succeeded" || run.status === "failed") && (
              <div style={{ marginTop: 10 }}>
                <Btn variant="ghost" size="sm" icon="refresh" onClick={reset}>Create another</Btn>
              </div>
            )}
          </div>
        )}
      </div>
      </Block.Body>
    </Block>
  );
}

function ChatBubble({ role, children }: { role: "assistant" | "user"; children: React.ReactNode }) {
  const isAssistant = role === "assistant";
  return (
    <div className="row gap-2" style={{ alignItems: "flex-start", flexDirection: isAssistant ? "row" : "row-reverse" }}>
      <span className="row center" style={{ width: 26, height: 26, flex: "none", borderRadius: 8, background: "var(--surface-3, #00000010)" }}>
        <Icon name={isAssistant ? "bot" : "user"} size={14} />
      </span>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          padding: "8px 12px",
          borderRadius: 10,
          maxWidth: 520,
          background: isAssistant ? "var(--surface-2, #00000008)" : "var(--accent-soft, var(--accent, #5b8cff)22)",
          border: "1px solid var(--border, #00000014)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TerraformStageView({ run }: { run: TfRun }) {
  const [open, setOpen] = useState<string | null>(null);
  const tone = run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "info";
  return (
    <Block>
      <Block.Header>
        <Block.Title sub={`${run.action} · ${run.envKey}`}>
          <span className="row gap-2" style={{ alignItems: "center" }}>
            {run.name}
            <Badge tone={tone} withDot>{run.status}</Badge>
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
      <div className="col gap-1">
        {run.stages.map((s) => (
          <div key={s.name} className="col">
            <button
              type="button"
              className="row gap-2"
              style={{ alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: "4px 0", textAlign: "left", width: "100%" }}
              onClick={() => setOpen((o) => (o === s.name ? null : s.name))}
            >
              <span style={{ width: 16, textAlign: "center", color: stageColor(s.status) }}>{STAGE_SYMBOL[s.status]}</span>
              <span className="mono" style={{ fontSize: 12.5 }}>terraform {s.name}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {s.status === "succeeded" ? `${s.name} succeeded`
                  : s.status === "running" ? `${s.name} running…`
                  : s.status === "failed" ? `${s.name} failed`
                  : s.status === "skipped" ? "skipped"
                  : "pending"}
                {typeof s.exitCode === "number" ? ` · exit ${s.exitCode}` : ""}
              </span>
            </button>
            {open === s.name && s.logs.trim() && (
              <pre style={{ fontSize: 11.5, overflowX: "auto", whiteSpace: "pre-wrap", margin: "2px 0 6px 16px", maxHeight: 240, background: "var(--surface-2, #0000000a)", padding: 8, borderRadius: 6 }}>
                {s.logs.slice(-3000)}
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

function stageColor(status: TfStageStatus): string {
  if (status === "succeeded") return "var(--ok, #30a46c)";
  if (status === "failed") return "var(--danger, #e5484d)";
  if (status === "running") return "var(--accent, #5b8cff)";
  return "var(--muted, #888)";
}

/** Pull the server's human message out of the api client's ApiError (which puts
 *  the raw JSON body in `details`), falling back to the HTTP status text. */
function apiErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && "details" in e) {
    const details = (e as { details?: unknown }).details;
    if (typeof details === "string") {
      try {
        const parsed = JSON.parse(details) as { message?: string };
        if (parsed.message) return parsed.message;
      } catch {
        /* not JSON — fall through */
      }
    }
  }
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message?: unknown }).message ?? "Request failed.");
  }
  return e instanceof Error ? e.message : "Request failed.";
}
