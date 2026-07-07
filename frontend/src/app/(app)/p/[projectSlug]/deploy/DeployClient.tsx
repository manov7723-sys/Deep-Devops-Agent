"use client";

/**
 * Deploy-My-App — a guided wizard that takes a container image and runs it on a
 * connected cluster: pick repo + environment → configure → review the manifest
 * → deploy → watch the rollout. Build+push happens in CI (Automation → Push to
 * registry); this step takes the resulting image and gets it running.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Icon, Input, PageHead, Select, Textarea, Toggle } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectRepos } from "@/hooks/queries/project";
import { buildDeployManifest, sanitizeAppName, type DeploySpec } from "@/lib/devops/deploy-manifest";

type DeployTarget = {
  envId: string;
  envKey: string;
  name: string;
  namespace: string;
  cloudKind: string | null;
  isProduction: boolean;
};
type Prefill = { appName: string; containerPort: number; stackTitle: string | null; reasoning: string | null; hasDockerfile: boolean };
type PrepareResp = { ok: true; targets: DeployTarget[]; prefill: Prefill | null };
type ApplyResp = { ok: true; applied: boolean; dryRun: boolean; resources: string[]; namespace: string; appName: string; envKey: string };
type StatusResp = { ok: true; found: boolean; ready: string; healthy: boolean; pods: Array<{ name: string; status: string; ready: string }> };
type RegImage = { repository: string; tag: string; image: string; pushedAt?: string };
type ImagesResp = { ok: true; cloud: string; images: RegImage[]; note?: string };

function parseEnv(text: string): Array<{ key: string; value: string }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i === -1 ? { key: l, value: "" } : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter((e) => e.key);
}

const STEPS = ["App & target", "Image & config", "Review", "Rollout"];

export function DeployClient({ slug }: { slug: string }) {
  const reposQuery = useProjectRepos(slug);
  const repos = (reposQuery.data ?? []) as unknown as Array<{ fullName: string }>;

  const [mode, setMode] = useState<"express" | "guided">("express");
  const [step, setStep] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  // Step 1
  const [repoFullName, setRepoFullName] = useState("");
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [envKey, setEnvKey] = useState("");
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  // Step 2
  const [appName, setAppName] = useState("");
  const [image, setImage] = useState("");
  const [containerPort, setContainerPort] = useState("8080");
  const [replicas, setReplicas] = useState("1");
  const [envText, setEnvText] = useState("");
  const [expose, setExpose] = useState(false);
  const [host, setHost] = useState("");
  const [regImages, setRegImages] = useState<RegImage[] | null>(null);
  const [regNote, setRegNote] = useState<string | null>(null);

  // Step 3
  const [prodConfirm, setProdConfirm] = useState("");

  // Deploy result
  const [deployed, setDeployed] = useState<ApplyResp | null>(null);
  const [cdPr, setCdPr] = useState<{ number: number; url: string } | null>(null);

  useEffect(() => {
    if (!repoFullName && repos.length > 0) setRepoFullName(repos[0].fullName);
  }, [repos, repoFullName]);

  const target = useMemo(() => targets.find((t) => t.envKey === envKey) ?? null, [targets, envKey]);

  const spec: DeploySpec = useMemo(
    () => ({
      appName: appName || sanitizeAppName(repoFullName.split("/")[1] || "app"),
      image,
      namespace: target?.namespace || "default",
      replicas: Math.max(1, Number(replicas) || 1),
      containerPort: Math.max(1, Number(containerPort) || 8080),
      env: parseEnv(envText),
      expose,
      host,
    }),
    [appName, repoFullName, image, target, replicas, containerPort, envText, expose, host],
  );

  const preview = useMemo(() => buildDeployManifest(spec), [spec]);

  // Prepare: load deployable envs + prefill from the repo.
  const prepare = useMutation({
    mutationFn: () => api.post<PrepareResp>(`/projects/${slug}/deploy/prepare`, { repoFullName: repoFullName || undefined }),
    onMutate: () => setErr(null),
    onSuccess: (r) => {
      setTargets(r.targets);
      if (r.targets.length && !r.targets.some((t) => t.envKey === envKey)) setEnvKey(r.targets[0].envKey);
      if (r.prefill) {
        setPrefill(r.prefill);
        setAppName((a) => a || r.prefill!.appName);
        setContainerPort((p) => (p === "8080" ? String(r.prefill!.containerPort) : p));
      }
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  // Browse the connected registry (ECR/GAR/ACR) for a pushed image.
  const browse = useMutation({
    mutationFn: () => api.get<ImagesResp>(`/projects/${slug}/deploy/images`),
    onMutate: () => { setErr(null); setRegNote(null); },
    onSuccess: (r) => {
      setRegImages(r.images);
      setRegNote(r.note ?? (r.images.length ? null : "No images found in the connected registry yet — push one first (Automation → Push to registry)."));
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  // Apply the manifest to the cluster.
  const apply = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<ApplyResp>(`/projects/${slug}/deploy/apply`, {
        envKey,
        appName: spec.appName,
        image: spec.image,
        namespace: spec.namespace,
        replicas: spec.replicas,
        containerPort: spec.containerPort,
        env: spec.env,
        expose: spec.expose,
        host: spec.host || undefined,
        dryRun,
      }),
    onMutate: () => setErr(null),
    onSuccess: (r, dryRun) => {
      if (dryRun) {
        setErr(null);
        alert("✅ Validation passed — the manifest is valid for this cluster.");
      } else {
        setDeployed(r);
        setStep(3);
      }
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  // Write the CD files (manifest + deploy workflow) to the repo and open a PR.
  const writeCd = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; files: string[]; branch: string; pullRequest?: { number: number; url: string } }>(
        `/projects/${slug}/deploy/cd-files`,
        {
          repoFullName,
          envKey,
          appName: spec.appName,
          image: spec.image,
          containerPort: spec.containerPort,
          replicas: spec.replicas,
          env: spec.env,
          expose: spec.expose,
          host: spec.host || undefined,
          namespace: spec.namespace,
        },
      ),
    onMutate: () => setErr(null),
    onSuccess: (r) => setCdPr(r.pullRequest ?? null),
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  // Poll rollout status once deployed.
  const statusQ = useQuery<StatusResp>({
    queryKey: ["p", slug, "deploy-status", deployed?.envKey, deployed?.appName, deployed?.namespace],
    queryFn: () =>
      api.get<StatusResp>(
        `/projects/${slug}/deploy/status?envKey=${encodeURIComponent(deployed!.envKey)}&app=${encodeURIComponent(deployed!.appName)}&namespace=${encodeURIComponent(deployed!.namespace)}`,
      ),
    enabled: !!deployed,
    refetchInterval: (q) => (q.state.data?.healthy ? false : 4000),
  });

  // Express mode: auto-load deployable environments once we have a repo, so the
  // one-click form is ready without a manual "detect" step.
  useEffect(() => {
    if (mode === "express" && repoFullName && targets.length === 0 && !prepare.isPending && !prepare.isSuccess) {
      prepare.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, repoFullName]);

  const isProd = !!target?.isProduction;
  const canDeploy =
    !!envKey && !!spec.image.trim() && (!spec.expose || !!spec.host?.trim()) && (!isProd || prodConfirm === spec.appName);

  return (
    <div className="col gap-4">
      <PageHead
        title="Deploy my app"
        sub="Take a container image and get it running on a connected cluster — configure, review the manifest, deploy, and watch the rollout."
      />

      {/* Mode switch — Express (one-click) vs Guided (step-by-step). */}
      {!deployed && (
        <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
          <Btn variant={mode === "express" ? "primary" : "outline"} size="sm" icon="zap" onClick={() => setMode("express")}>
            Express (one-click)
          </Btn>
          <Btn variant={mode === "guided" ? "primary" : "outline"} size="sm" icon="layers" onClick={() => setMode("guided")}>
            Guided (step-by-step)
          </Btn>
        </div>
      )}

      {/* Stepper (guided only) */}
      {mode === "guided" && !deployed && (
        <div className="row gap-2 wrap">
          {STEPS.map((s, i) => (
            <span key={s} className="row gap-2" style={{ alignItems: "center" }}>
              <Badge tone={i === step ? "accent" : i < step ? "ok" : "default"} withDot={i <= step}>
                {i + 1}. {s}
              </Badge>
              {i < STEPS.length - 1 && <Icon name="chevR" size={12} />}
            </span>
          ))}
        </div>
      )}

      {err && <Badge tone="danger" icon="alert">{err}</Badge>}

      {/* ── Express — one-click deploy ────────────────────────────────────── */}
      {mode === "express" && !deployed && (
        <Block>
          <Block.Header>
            <Block.Title sub="Fill the essentials and deploy in one click — sensible defaults, no step-by-step. Switch to Guided to choose each Kubernetes file.">
              One-click deploy
            </Block.Title>
          </Block.Header>
          <Block.Body>
            <div className="col gap-3" style={{ maxWidth: 640 }}>
              <div className="row gap-3 wrap">
                <div style={{ minWidth: 240, flex: 1 }}>
                  <Field label="Repository">
                    <Select value={repoFullName} onValueChange={setRepoFullName} ariaLabel="Repository"
                      options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))} />
                  </Field>
                </div>
                <div style={{ minWidth: 240, flex: 1 }}>
                  <Field label="Environment" hint={prepare.isPending ? "Loading clusters…" : "Cluster to deploy to."}>
                    <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment"
                      options={targets.map((t) => ({ value: t.envKey, label: `${t.name} (${t.namespace})${t.isProduction ? " · prod" : ""}` }))} />
                  </Field>
                </div>
              </div>

              <Field label="Container image" hint="Pick one you pushed, or paste a reference (e.g. nginx:latest).">
                <Input value={image} placeholder="registry/my-app:tag" onChange={(e) => setImage(e.target.value)} />
              </Field>
              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                <Btn variant="ghost" size="sm" icon="box" loading={browse.isPending} onClick={() => browse.mutate()}>
                  {browse.isPending ? "Loading images…" : "Browse registry"}
                </Btn>
                {regImages && regImages.length > 0 && (
                  <div style={{ minWidth: 300, flex: 1 }}>
                    <Select value={image} onValueChange={setImage} ariaLabel="Pick image from registry"
                      options={[{ value: "", label: "Pick a pushed image…" }, ...regImages.map((i) => ({ value: i.image, label: `${i.repository}:${i.tag}` }))]} />
                  </div>
                )}
              </div>
              {regNote && <span className="muted" style={{ fontSize: 11.5 }}>{regNote}</span>}

              <div className="row gap-3 wrap">
                <div style={{ minWidth: 130 }}>
                  <Field label="Port"><Input type="number" value={containerPort} onChange={(e) => setContainerPort(e.target.value)} /></Field>
                </div>
                <div style={{ minWidth: 110 }}>
                  <Field label="Replicas"><Input type="number" min={1} value={replicas} onChange={(e) => setReplicas(e.target.value)} /></Field>
                </div>
                <div className="row gap-2" style={{ alignItems: "center", marginTop: 22 }}>
                  <Toggle checked={expose} onCheckedChange={setExpose} ariaLabel="Expose publicly" />
                  <span style={{ fontSize: 13 }}>Expose publicly</span>
                </div>
                {expose && (
                  <div style={{ minWidth: 220, flex: 1 }}>
                    <Field label="Public host"><Input value={host} placeholder="app.example.com" onChange={(e) => setHost(e.target.value)} /></Field>
                  </div>
                )}
              </div>

              {isProd && (
                <Field label={`PRODUCTION env — type the app name "${spec.appName}" to confirm.`}>
                  <Input value={prodConfirm} placeholder={spec.appName} onChange={(e) => setProdConfirm(e.target.value)} />
                </Field>
              )}

              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                <Btn variant="primary" icon="rocket" loading={apply.isPending} disabled={!canDeploy || apply.isPending} onClick={() => apply.mutate(false)}>
                  Deploy now
                </Btn>
                <span className="muted" style={{ fontSize: 11.5 }}>Deploys {preview.resources.join(" + ")} to {target?.name ?? "the selected cluster"}.</span>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}

      {/* ── Step 1 — App & target (guided) ────────────────────────────────── */}
      {mode === "guided" && step === 0 && (
        <Block>
          <Block.Header>
            <Block.Title sub="Pick the app's repo and the environment (cluster) to deploy it to.">App &amp; target</Block.Title>
          </Block.Header>
          <Block.Body>
            <div className="col gap-3" style={{ maxWidth: 520 }}>
              <Field label="Repository" hint="Used to auto-suggest the app name and port.">
                <Select
                  value={repoFullName}
                  onValueChange={setRepoFullName}
                  ariaLabel="Repository"
                  options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))}
                />
              </Field>

              <Btn variant="outline" icon="bot" loading={prepare.isPending} onClick={() => prepare.mutate()}>
                {prepare.isPending ? "Detecting…" : "Detect stack & load environments"}
              </Btn>

              {prefill && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {prefill.stackTitle ? `Detected ${prefill.stackTitle}. ` : ""}
                  Suggested port {prefill.containerPort}.{" "}
                  {prefill.hasDockerfile ? "Dockerfile present." : "No Dockerfile found — build & push an image first (Automation → Push to registry)."}
                </span>
              )}

              {targets.length > 0 ? (
                <Field label="Environment" hint="Only environments with a connected cluster are listed.">
                  <Select
                    value={envKey}
                    onValueChange={setEnvKey}
                    ariaLabel="Environment"
                    options={targets.map((t) => ({
                      value: t.envKey,
                      label: `${t.name} (${t.namespace})${t.isProduction ? " · prod" : ""}`,
                    }))}
                  />
                </Field>
              ) : prepare.isSuccess ? (
                <Badge tone="warn" icon="alert">
                  No environment has a cluster connected. Connect one on the Clusters tab first.
                </Badge>
              ) : null}

              <div className="row gap-2">
                <Btn variant="primary" iconRight="chevR" disabled={!envKey} onClick={() => setStep(1)}>
                  Next
                </Btn>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}

      {/* ── Step 2 — Image & config ───────────────────────────────────────── */}
      {mode === "guided" && step === 1 && (
        <Block>
          <Block.Header>
            <Block.Title sub="The image to run and how it should be configured.">Image &amp; configuration</Block.Title>
          </Block.Header>
          <Block.Body>
            <div className="col gap-3" style={{ maxWidth: 620 }}>
              <Field label="Container image" hint="Pick one you pushed to your registry, or paste a reference (e.g. 123.dkr.ecr.us-east-1.amazonaws.com/my-app:latest).">
                <Input value={image} placeholder="registry/my-app:tag" onChange={(e) => setImage(e.target.value)} />
              </Field>

              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                <Btn variant="ghost" size="sm" icon="box" loading={browse.isPending} onClick={() => browse.mutate()}>
                  {browse.isPending ? "Loading images…" : "Browse registry"}
                </Btn>
                {regImages && regImages.length > 0 && (
                  <div style={{ minWidth: 300, flex: 1 }}>
                    <Select
                      value={image}
                      onValueChange={setImage}
                      ariaLabel="Pick image from registry"
                      options={[
                        { value: "", label: "Pick a pushed image…" },
                        ...regImages.map((i) => ({ value: i.image, label: `${i.repository}:${i.tag}` })),
                      ]}
                    />
                  </div>
                )}
              </div>
              {regNote && <span className="muted" style={{ fontSize: 11.5 }}>{regNote}</span>}

              <div className="row gap-3 wrap">
                <div style={{ minWidth: 220, flex: 1 }}>
                  <Field label="App name" hint="Kubernetes resource name (lowercase).">
                    <Input value={appName} placeholder="my-app" onChange={(e) => setAppName(e.target.value)} />
                  </Field>
                </div>
                <div style={{ minWidth: 130 }}>
                  <Field label="Container port">
                    <Input type="number" value={containerPort} onChange={(e) => setContainerPort(e.target.value)} />
                  </Field>
                </div>
                <div style={{ minWidth: 110 }}>
                  <Field label="Replicas">
                    <Input type="number" min={1} value={replicas} onChange={(e) => setReplicas(e.target.value)} />
                  </Field>
                </div>
              </div>

              <Field label="Environment variables" hint="One KEY=VALUE per line (e.g. DATABASE_URL=postgres://…).">
                <Textarea rows={4} value={envText} placeholder={"KEY=VALUE\nANOTHER=value"} onChange={(e) => setEnvText(e.target.value)} />
              </Field>

              <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
                <span className="row gap-2" style={{ alignItems: "center" }}>
                  <Toggle checked={expose} onCheckedChange={setExpose} ariaLabel="Expose publicly" />
                  <span style={{ fontSize: 13 }}>Expose publicly (Ingress)</span>
                </span>
                {expose && (
                  <div style={{ minWidth: 260, flex: 1 }}>
                    <Field label="Public host">
                      <Input value={host} placeholder="app.example.com" onChange={(e) => setHost(e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>

              <div className="row gap-2">
                <Btn variant="ghost" icon="chevL" onClick={() => setStep(0)}>Back</Btn>
                <Btn variant="primary" iconRight="chevR" disabled={!image.trim() || (expose && !host.trim())} onClick={() => setStep(2)}>
                  Review
                </Btn>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}

      {/* ── Step 3 — Review & deploy ──────────────────────────────────────── */}
      {mode === "guided" && step === 2 && (
        <Block>
          <Block.Header>
            <Block.Title sub={`Deploying ${preview.resources.join(" + ")} to ${target?.name ?? envKey} (${spec.namespace}).`}>
              Review &amp; deploy
            </Block.Title>
          </Block.Header>
          <Block.Body>
            <div className="col gap-3">
              <div className="row gap-2 wrap">
                {preview.resources.map((r) => <Badge key={r} tone="info">{r}</Badge>)}
                <Badge tone="default">image: {spec.image || "—"}</Badge>
                <Badge tone="default">{spec.replicas} replica{spec.replicas > 1 ? "s" : ""}</Badge>
                {spec.expose && <Badge tone="warn">public: {spec.host}</Badge>}
              </div>

              <pre style={{ margin: 0, padding: 12, background: "var(--surface-2, #0000000a)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11.5, overflowX: "auto", maxHeight: 360 }}>
                {preview.yaml}
              </pre>

              {isProd && (
                <Field label={`This is a PRODUCTION environment — type the app name "${spec.appName}" to confirm.`}>
                  <Input value={prodConfirm} placeholder={spec.appName} onChange={(e) => setProdConfirm(e.target.value)} />
                </Field>
              )}

              <div className="row gap-2 wrap">
                <Btn variant="ghost" icon="chevL" onClick={() => setStep(1)}>Back</Btn>
                <Btn variant="outline" icon="check" loading={apply.isPending} onClick={() => apply.mutate(true)}>
                  Validate (dry-run)
                </Btn>
                <Btn variant="primary" icon="rocket" loading={apply.isPending} disabled={!canDeploy || apply.isPending} onClick={() => apply.mutate(false)}>
                  Deploy to {target?.name ?? envKey}
                </Btn>
              </div>

              <div className="col gap-2" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <span className="row gap-2 wrap" style={{ alignItems: "center" }}>
                  <Btn variant="outline" icon="github" loading={writeCd.isPending} disabled={writeCd.isPending || !spec.image.trim()} onClick={() => writeCd.mutate()}>
                    Write CD files to repo (PR)
                  </Btn>
                  {cdPr && (
                    <a href={cdPr.url} target="_blank" rel="noreferrer" className="row gap-1" style={{ fontSize: 13, alignItems: "center" }}>
                      <Icon name="ext" size={13} /> PR #{cdPr.number}
                    </a>
                  )}
                </span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Commits <code>k8s/manifest.yaml</code> + <code>.github/workflows/deploy.yml</code> so deploys are versioned in Git.
                  The deploy workflow needs a <code>KUBECONFIG_B64</code> repo secret to reach the cluster.
                </span>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}

      {/* ── Step 4 — Rollout (both modes) ─────────────────────────────────── */}
      {deployed && (
        <Block>
          <Block.Header>
            <Block.Title sub={`${deployed.appName} on ${deployed.envKey} (${deployed.namespace}).`}>
              <span className="row gap-2" style={{ alignItems: "center" }}>
                Rollout
                {statusQ.data?.healthy ? (
                  <Badge tone="solid-ok" withDot>Live 🎉</Badge>
                ) : (
                  <Badge tone="warn" withDot>Rolling out…</Badge>
                )}
              </span>
            </Block.Title>
          </Block.Header>
          <Block.Body>
            <div className="col gap-3">
              <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
                <Badge tone={statusQ.data?.healthy ? "ok" : "info"}>Ready {statusQ.data?.ready ?? "…"}</Badge>
                <span className="muted" style={{ fontSize: 12 }}>
                  {statusQ.isFetching ? "checking…" : statusQ.data?.healthy ? "All replicas are ready." : "Waiting for pods to become ready…"}
                </span>
                <Btn variant="ghost" size="sm" icon="refresh" onClick={() => statusQ.refetch()}>Refresh</Btn>
              </div>

              {(statusQ.data?.pods.length ?? 0) > 0 && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ textAlign: "left", background: "var(--surface-2, #0000000a)" }}>
                        <th style={{ padding: "7px 10px" }}>Pod</th>
                        <th style={{ padding: "7px 10px" }}>Status</th>
                        <th style={{ padding: "7px 10px" }}>Ready</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statusQ.data!.pods.map((p) => (
                        <tr key={p.name} style={{ borderTop: "1px solid var(--border)" }}>
                          <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono, monospace)" }}>{p.name}</td>
                          <td style={{ padding: "7px 10px" }}>
                            <Badge tone={p.status === "Running" ? "ok" : p.status === "Failed" ? "danger" : "warn"}>{p.status}</Badge>
                          </td>
                          <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono, monospace)" }}>{p.ready}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!statusQ.data?.healthy && (
                <span className="muted" style={{ fontSize: 11.5 }}>
                  If pods stay not-ready, the usual causes are: the image can&apos;t be pulled (check the image/registry access), the app doesn&apos;t listen on port {spec.containerPort}, or it&apos;s missing an env var. Check pod logs on the Infrastructure tab.
                </span>
              )}

              <div className="row gap-2">
                <Btn variant="outline" icon="rocket" onClick={() => { setDeployed(null); setStep(0); }}>Deploy another</Btn>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}
    </div>
  );
}
