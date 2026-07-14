"use client";

/**
 * "Set up CI/CD" box — a deterministic form (no LLM) that generates a complete
 * pipeline and opens ONE PR: Dockerfile + build/scan/push-to-ECR workflow + K8s
 * manifests + a CD workflow that deploys after CI succeeds. Renders on the CI/CD
 * tab and inline in chat (```cicd-setup``` fence), so "set up ci/cd for my app"
 * shows a form instead of the agent asking 20 questions.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Block, Btn, Field, Icon, Input, Select, Textarea, Toggle } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type StackField = {
  key: string;
  type: "string" | "number";
  description: string;
  default?: string | number;
  options?: string[];
};
type StackOpt = { id: string; title: string; fields: StackField[] };
type Options = {
  ok: boolean;
  repos: { fullName: string; defaultBranch: string }[];
  envs: { envKey: string; name: string; namespace: string; cloudKind: string | null }[];
  clouds: string[];
  registrySupported: boolean;
  stacks: StackOpt[];
};
type SetupResult = {
  ok: boolean;
  pullRequest?: { number: number; url: string };
  files: string[];
  branch: string;
  imageRef: string;
  namespace: string;
  kubeconfigSet: boolean;
  kubeconfigNote?: string;
  registeredPipeline?: { id: string; name: string; agentReview: boolean };
  notes: string[];
};

function sanitize(raw: string): string {
  return (
    (raw || "app")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "app"
  );
}
function parseEnv(text: string): Array<{ key: string; value: string }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i === -1
        ? { key: l, value: "" }
        : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter((e) => e.key);
}

export function CicdSetupBox({ slug }: { slug: string }) {
  const opts = useQuery<Options>({
    queryKey: ["p", slug, "cicd-setup-options"],
    queryFn: () => api.get<Options>(`/projects/${slug}/cicd/setup`),
    staleTime: 60_000,
  });
  const data = opts.data;

  const [repoFullName, setRepoFullName] = useState("");
  const [stackId, setStackId] = useState("static-spa");
  const [dockerParams, setDockerParams] = useState<Record<string, string>>({});
  const [branch, setBranch] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [appName, setAppName] = useState("");
  const [imageName, setImageName] = useState("");
  const [containerPort, setContainerPort] = useState("80");
  const [replicas, setReplicas] = useState("1");
  const [expose, setExpose] = useState(false);
  const [host, setHost] = useState("");
  const [envText, setEnvText] = useState("");
  const [scanGate, setScanGate] = useState(true);
  const [agentReview, setAgentReview] = useState(true);
  const [include, setInclude] = useState({
    dockerfile: true,
    compose: true,
    nginx: true,
    ciWorkflow: true,
    manifest: true,
    cdWorkflow: true,
  });
  const [err, setErr] = useState<string | null>(null);
  const setInc = (k: keyof typeof include, v: boolean) => setInclude((p) => ({ ...p, [k]: v }));

  // Live branch list for the selected repo (fetched from GitHub).
  const branchesQ = useQuery<{ ok: boolean; branches: string[]; defaultBranch?: string }>({
    queryKey: ["p", slug, "cicd-branches", repoFullName],
    queryFn: () =>
      api.get<{ ok: boolean; branches: string[]; defaultBranch?: string }>(
        `/projects/${slug}/cicd/branches`,
        { repo: repoFullName },
      ),
    enabled: !!repoFullName,
    staleTime: 60_000,
  });
  const branchList = branchesQ.data?.branches ?? [];

  const stack = useMemo(() => data?.stacks.find((s) => s.id === stackId) ?? null, [data, stackId]);

  // Seed repo + env once options arrive.
  useEffect(() => {
    if (!data) return;
    if (!repoFullName && data.repos[0]) setRepoFullName(data.repos[0].fullName);
    if (!envKey && data.envs[0]) setEnvKey(data.envs[0].envKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // When the repo changes, default the branch + app name from it.
  useEffect(() => {
    const r = data?.repos.find((x) => x.fullName === repoFullName);
    if (!r) return;
    const short = sanitize(r.fullName.split("/")[1] || "app");
    setAppName((a) => a || short);
    setImageName((v) => v || short);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoFullName, data]);

  // Seed/validate the branch from the repo's live branch list (resets when the
  // selected repo changes and the old branch doesn't exist in the new repo).
  useEffect(() => {
    const list = branchesQ.data?.branches;
    if (!list || !list.length) return;
    if (!branch || !list.includes(branch)) setBranch(branchesQ.data?.defaultBranch || list[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesQ.data]);

  // Seed the selected stack's Docker field defaults.
  useEffect(() => {
    if (!stack) return;
    setDockerParams((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const f of stack.fields)
        if (next[f.key] === undefined) {
          next[f.key] = String(f.default ?? "");
          changed = true;
        }
      return changed ? next : prev;
    });
  }, [stack]);

  const setup = useMutation({
    mutationFn: () =>
      api.post<SetupResult>(`/projects/${slug}/cicd/setup`, {
        repoFullName,
        envKey,
        stack: stackId,
        dockerParams,
        scanGate,
        appName,
        imageName: imageName.trim() || undefined,
        containerPort: Number(containerPort) || 80,
        replicas: Number(replicas) || 1,
        env: parseEnv(envText),
        expose,
        host: expose ? host : undefined,
        branch: branch || undefined,
        include,
        agentReview,
      }),
    onMutate: () => setErr(null),
    onError: (e) => setErr(apiErrorMessage(e, "CI/CD setup failed.")),
  });

  const result = setup.data;
  const canSubmit = !!repoFullName && !!envKey && !!appName.trim() && !setup.isPending && !result;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Deterministic — generates Dockerfile + CI (build/scan/push) + K8s manifests + CD (deploy after CI), then opens ONE PR.">
          Set up CI/CD pipeline
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {opts.isLoading ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Loading your repos, envs and cloud…
          </span>
        ) : !data ? (
          <span style={{ fontSize: 13, color: "var(--danger)" }}>
            Couldn&apos;t load setup options.
          </span>
        ) : result ? (
          <ResultPanel
            result={result}
            onReset={() => {
              setup.reset();
            }}
          />
        ) : (
          <div className="col gap-4" style={{ maxWidth: 620 }}>
            {!data.registrySupported && (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--danger)",
                  border: "1px dashed var(--border)",
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                Automatic CI/CD targets AWS ECR today. Connected: {data.clouds.join(", ") || "none"}
                . Connect an AWS account on the Cloud tab first.
              </div>
            )}

            {/* ── Build ─────────────────────────────────────────── */}
            <SectionLabel>Build &amp; push</SectionLabel>
            <Field label="Repository" hint="The app's source repo (GitHub).">
              <Select
                value={repoFullName}
                onValueChange={setRepoFullName}
                ariaLabel="Repository"
                options={data.repos.map((r) => ({ value: r.fullName, label: r.fullName }))}
              />
            </Field>
            <Field
              label="Image name"
              hint="The container image (ECR repo) name. Used in BOTH the CI push and the Deployment."
            >
              <Input
                value={imageName}
                placeholder="dynamic-react-app"
                onChange={(e) => setImageName(e.target.value)}
              />
            </Field>
            <Field label="Stack" hint="How the Dockerfile + CI build are generated.">
              <Select
                value={stackId}
                onValueChange={setStackId}
                ariaLabel="Stack"
                options={data.stacks.map((s) => ({ value: s.id, label: s.title }))}
              />
            </Field>
            {stack?.fields.map((f) => (
              <Field key={f.key} label={f.key} hint={f.description}>
                {f.options && f.options.length ? (
                  <Select
                    value={dockerParams[f.key] ?? String(f.default ?? "")}
                    onValueChange={(v) => setDockerParams((p) => ({ ...p, [f.key]: v }))}
                    ariaLabel={f.key}
                    options={f.options.map((o) => ({ value: o, label: o }))}
                  />
                ) : (
                  <Input
                    type={f.type === "number" ? "number" : "text"}
                    value={dockerParams[f.key] ?? ""}
                    placeholder={String(f.default ?? "")}
                    onChange={(e) => setDockerParams((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Field
              label="Trigger branch"
              hint="CI runs on push to this branch. Loaded from the repo."
            >
              {branchList.length ? (
                <Select
                  value={branch}
                  onValueChange={setBranch}
                  ariaLabel="Trigger branch"
                  options={branchList.map((b) => ({ value: b, label: b }))}
                />
              ) : (
                <Input
                  value={branch}
                  placeholder="master"
                  onChange={(e) => setBranch(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Trivy scan gate"
              hint="Fail the build on HIGH/CRITICAL vulnerabilities before pushing."
            >
              <Toggle
                checked={scanGate}
                onCheckedChange={setScanGate}
                ariaLabel="Trivy scan gate"
              />
            </Field>
            <Field
              label="Agent auto-review"
              hint="Track it on the CI/CD tab; a failed run started from there gets its workflow auto-fixed + re-run by the agent (up to 3×, commits the fix to the default branch)."
            >
              <Toggle
                checked={agentReview}
                onCheckedChange={setAgentReview}
                ariaLabel="Agent auto-review"
              />
            </Field>

            {/* ── Deploy ────────────────────────────────────────── */}
            <SectionLabel>Deploy</SectionLabel>
            <Field label="Environment" hint="Its cluster + namespace is the deploy target.">
              <Select
                value={envKey}
                onValueChange={setEnvKey}
                ariaLabel="Environment"
                options={data.envs.map((e) => ({
                  value: e.envKey,
                  label: `${e.name} · ${e.namespace}${e.cloudKind ? ` · ${e.cloudKind}` : ""}`,
                }))}
              />
            </Field>
            <Field
              label="App name"
              hint="Kubernetes Deployment/Service name (lowercase DNS label)."
            >
              <Input
                value={appName}
                placeholder="dynamic-react-app"
                onChange={(e) => setAppName(e.target.value)}
              />
            </Field>
            <div className="row gap-3" style={{ flexWrap: "wrap" }}>
              <Field label="Container port">
                <Input
                  type="number"
                  value={containerPort}
                  onChange={(e) => setContainerPort(e.target.value)}
                />
              </Field>
              <Field label="Replicas">
                <Input
                  type="number"
                  value={replicas}
                  onChange={(e) => setReplicas(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Expose via Ingress" hint="Off = internal (ClusterIP) only.">
              <Toggle checked={expose} onCheckedChange={setExpose} ariaLabel="Expose via Ingress" />
            </Field>
            {expose && (
              <Field label="Host" hint="Public hostname for the Ingress.">
                <Input
                  value={host}
                  placeholder="app.example.com"
                  onChange={(e) => setHost(e.target.value)}
                />
              </Field>
            )}
            <Field label="Environment variables" hint="One KEY=VALUE per line (optional).">
              <Textarea
                rows={3}
                value={envText}
                placeholder={"REACT_APP_API_URL=https://api.example.com"}
                onChange={(e) => setEnvText(e.target.value)}
              />
            </Field>

            {/* ── Files to write (toggle any off) ───────────────── */}
            <SectionLabel>Files to write</SectionLabel>
            <div className="col gap-2">
              <FileToggle
                label="Dockerfile"
                hint="+ .dockerignore"
                on={include.dockerfile}
                set={(v) => setInc("dockerfile", v)}
              />
              <FileToggle
                label="docker-compose.yml"
                hint="For local runs"
                on={include.compose}
                set={(v) => setInc("compose", v)}
              />
              {stackId === "static-spa" && (
                <FileToggle
                  label="nginx.conf"
                  hint="SPA server config (static-spa only)"
                  on={include.nginx}
                  set={(v) => setInc("nginx", v)}
                />
              )}
              <FileToggle
                label="CI workflow"
                hint="build-and-push.yml — build → Trivy → push to ECR"
                on={include.ciWorkflow}
                set={(v) => setInc("ciWorkflow", v)}
              />
              <FileToggle
                label="Kubernetes manifest"
                hint="manifest.yaml — Deployment + Service (+ Ingress)"
                on={include.manifest}
                set={(v) => setInc("manifest", v)}
              />
              <FileToggle
                label="CD workflow"
                hint="deploy.yml — deploys after CI succeeds"
                on={include.cdWorkflow}
                set={(v) => setInc("cdWorkflow", v)}
              />
            </div>

            {err && (
              <span style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
                {err}
              </span>
            )}

            <div
              className="row between"
              style={{ alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 12 }}
            >
              <span className="faint" style={{ fontSize: 11.5 }}>
                Opens a pull request with all files.
              </span>
              <Btn
                variant="primary"
                icon="github"
                loading={setup.isPending}
                disabled={!canSubmit}
                onClick={() => setup.mutate()}
              >
                Generate &amp; open PR
              </Btn>
            </div>
          </div>
        )}
      </Block.Body>
    </Block>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="muted"
      style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}
    >
      {children}
    </span>
  );
}

function FileToggle({
  label,
  hint,
  on,
  set,
}: {
  label: string;
  hint: string;
  on: boolean;
  set: (v: boolean) => void;
}) {
  return (
    <div className="row between" style={{ alignItems: "center", gap: 12 }}>
      <div className="col" style={{ lineHeight: 1.3 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {hint}
        </span>
      </div>
      <Toggle checked={on} onCheckedChange={set} ariaLabel={label} />
    </div>
  );
}

function ResultPanel({ result, onReset }: { result: SetupResult; onReset: () => void }) {
  return (
    <div className="col gap-3" style={{ maxWidth: 620 }}>
      <div className="row gap-2" style={{ alignItems: "center", fontWeight: 700, fontSize: 14 }}>
        <Icon name="check" size={16} /> Pipeline generated
      </div>
      {result.pullRequest ? (
        <a
          className="btn primary sm"
          style={{ width: "fit-content", textDecoration: "none" }}
          href={result.pullRequest.url}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="github" size={14} /> Review PR #{result.pullRequest.number}
        </a>
      ) : (
        <span className="muted" style={{ fontSize: 13 }}>
          Files committed to branch <code>{result.branch}</code>.
        </span>
      )}
      <div
        className="col gap-1"
        style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, fontSize: 12.5 }}
      >
        {result.files.map((f) => (
          <div key={f} className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="layers" size={12} /> <span className="mono">{f}</span>
          </div>
        ))}
      </div>
      <div className="col gap-1" style={{ fontSize: 12.5 }}>
        <span>
          Image: <span className="mono">{result.imageRef}</span>
        </span>
        <span>
          Namespace: <span className="mono">{result.namespace}</span>
        </span>
        <span>
          Cluster secret <code>KUBECONFIG_B64</code>:{" "}
          {result.kubeconfigSet
            ? "set ✅"
            : `not set — ${result.kubeconfigNote ?? "set it manually so CD can reach the cluster."}`}
        </span>
        {result.registeredPipeline && (
          <span>
            Agent auto-review: <strong>on</strong> — tracked on the CI/CD tab as “
            {result.registeredPipeline.name}”. Run it from there so a failed run gets auto-fixed.
          </span>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
        Merge the PR into <code>{result.branch}</code> → CI builds, scans &amp; pushes the image →
        CD deploys it to the cluster after CI succeeds.
      </div>
      <Btn variant="ghost" size="sm" icon="refresh" onClick={onReset}>
        Set up another
      </Btn>
    </div>
  );
}
