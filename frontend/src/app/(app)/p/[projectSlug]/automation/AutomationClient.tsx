"use client";

import { Fragment, useEffect, useState, type ComponentProps, type CSSProperties } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, PageHead, Progress, Select, StatusDot } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import type { BadgeTone } from "@/components/ui/Badge";
import { api } from "@/lib/api/client";

type RepoRow = { id: string; fullName: string; name: string; defaultBranch: string };
type GenFile = { path: string; content: string };
type GenResult = {
  ok: true;
  stackTitle?: string;
  reasoning?: string;
  files: GenFile[];
  notes: string[];
  existingDockerfile?: boolean;
  hasDockerfile?: boolean;
};
type PushResult = { ok: boolean; pullRequest?: { number: number; url: string }; branch?: string };

function apiErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && "details" in e) {
    const d = (e as { details?: unknown }).details;
    if (typeof d === "string") {
      try {
        const j = JSON.parse(d) as { message?: string };
        if (j.message) return j.message;
      } catch {
        /* not JSON */
      }
    }
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function ProjectAutomationClient({ slug }: { slug: string }) {
  const { data: repos } = useQuery<RepoRow[]>({
    queryKey: ["p", slug, "repos"],
    queryFn: () => api.get<RepoRow[]>(`/projects/${slug}/repos`),
    staleTime: 60_000,
  });

  const [repoFullName, setRepoFullName] = useState("");
  useEffect(() => {
    if (!repoFullName && repos && repos.length > 0) setRepoFullName(repos[0].fullName);
  }, [repos, repoFullName]);

  const noRepos = repos && repos.length === 0;

  return (
    <div className="col gap-5">
      <PageHead
        title="Automation"
        sub="One-click agent tasks for your repositories. The agent does the work and opens a pull request you review — except security scans, which run and show results right here."
      />

      {noRepos ? (
        <Block>
          <Block.Body>
            <span className="muted" style={{ fontSize: 13 }}>
              Attach a repository on the CI/CD &amp; Repos tab first.
            </span>
          </Block.Body>
        </Block>
      ) : (
        <>
          {/* Shared repository picker for every automation below. */}
          <Block>
            <Block.Body>
              <div style={{ maxWidth: 420 }}>
                <Field label="Repository">
                  <Select
                    value={repoFullName}
                    onValueChange={setRepoFullName}
                    ariaLabel="Repository"
                    options={(repos ?? []).map((r) => ({ value: r.fullName, label: r.fullName }))}
                  />
                </Field>
              </div>
            </Block.Body>
          </Block>

          {/* key by repo so switching repos resets each card's state. */}
          <GenerateAutomation
            key={`dockerfile-${repoFullName}`}
            slug={slug}
            repoFullName={repoFullName}
            icon="box"
            title="Create Dockerfile"
            sub="The agent reads your repo, detects the stack, and generates a production Dockerfile — then opens a PR."
            endpoint={`/projects/${slug}/automation/dockerfile`}
            branchPrefix="automation/dockerfile"
            commitMessage="Add Dockerfile (DeepAgent automation)"
            prTitle="Dockerfile"
          />
          <GenerateAutomation
            key={`compose-${repoFullName}`}
            slug={slug}
            repoFullName={repoFullName}
            icon="layers"
            title="Create docker-compose"
            sub="Generates a docker-compose.yml that builds and runs your app locally with the right port mapping."
            endpoint={`/projects/${slug}/automation/compose`}
            branchPrefix="automation/compose"
            commitMessage="Add docker-compose.yml (DeepAgent automation)"
            prTitle="docker-compose"
          />
          <GenerateAutomation
            key={`workflow-${repoFullName}`}
            slug={slug}
            repoFullName={repoFullName}
            icon="cicd"
            title="Create CI workflow"
            sub="Generates a stack-aware GitHub Actions workflow (install → build → test) that runs on every push and pull request."
            endpoint={`/projects/${slug}/automation/workflow`}
            branchPrefix="automation/ci-workflow"
            commitMessage="Add CI workflow (DeepAgent automation)"
            prTitle="CI workflow"
          />
          <TrivyAutomation key={`trivy-${repoFullName}`} slug={slug} repoFullName={repoFullName} />

        </>
      )}
    </div>
  );
}

/* ── Shared generate → preview → PR card (Dockerfile / compose / workflow) ── */
function GenerateAutomation({
  slug,
  repoFullName,
  icon,
  title,
  sub,
  endpoint,
  branchPrefix,
  commitMessage,
  prTitle,
}: {
  slug: string;
  repoFullName: string;
  icon: ComponentProps<typeof Icon>["name"];
  title: string;
  sub: string;
  endpoint: string;
  branchPrefix: string;
  commitMessage: string;
  prTitle: string;
}) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [pr, setPr] = useState<PushResult["pullRequest"] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const analyze = useMutation({
    mutationFn: () => api.post<GenResult>(endpoint, { repoFullName }),
    onMutate: () => { setErr(null); setPr(null); },
    onSuccess: (r) => setOpenFile(r.files[0]?.path ?? null),
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const result = analyze.data;

  const createPr = useMutation({
    mutationFn: () => {
      const files = Object.fromEntries((result?.files ?? []).map((f) => [f.path, f.content]));
      const name = repoFullName.split("/")[1] || "app";
      return api.post<PushResult>(`/projects/${slug}/infra/push`, {
        repoFullName,
        basePath: "",
        files,
        branch: `${branchPrefix}-${name}`,
        message: commitMessage,
        pullRequestBody:
          `Generated by DeepAgent's ${prTitle} automation.\n\n` +
          `${result?.stackTitle ? `**Stack:** ${result.stackTitle}\n` : ""}` +
          `${result?.reasoning ? `**Why:** ${result.reasoning}\n` : ""}` +
          `\nFiles: ${(result?.files ?? []).map((f) => `\`${f.path}\``).join(", ")}.`,
      });
    },
    onMutate: () => setErr(null),
    onSuccess: (r) => {
      if (r.pullRequest) setPr(r.pullRequest);
      else setErr("Committed, but no pull request was returned.");
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={sub}>
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name={icon} size={16} /> {title}
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3" style={{ maxWidth: 720 }}>
          <Btn
            variant="primary"
            icon="zap"
            loading={analyze.isPending}
            disabled={!repoFullName || analyze.isPending}
            onClick={() => analyze.mutate()}
          >
            {analyze.isPending ? "Analyzing repo…" : "Analyze & generate"}
          </Btn>

          {err && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {err}</span>}

          {result && (
            <div className="col gap-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                {result.stackTitle && <Badge tone="ok" withDot>Detected: {result.stackTitle}</Badge>}
                {result.existingDockerfile && <Badge tone="warn" withDot>repo already has a Dockerfile</Badge>}
                {result.hasDockerfile === false && <Badge tone="warn" withDot>no Dockerfile in repo yet</Badge>}
              </div>
              {result.reasoning && <span className="muted" style={{ fontSize: 12.5 }}>{result.reasoning}</span>}

              {/* File tabs + preview */}
              <div className="row gap-2 wrap">
                {result.files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className={`chip ${openFile === f.path ? "active" : ""}`}
                    style={{ height: 32 }}
                    onClick={() => setOpenFile(f.path)}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              {openFile && (
                <pre style={{ fontSize: 11.5, overflowX: "auto", whiteSpace: "pre", margin: 0, maxHeight: 360, background: "var(--surface-2, #0000000a)", padding: 10, borderRadius: 8 }}>
                  {result.files.find((f) => f.path === openFile)?.content}
                </pre>
              )}
              {result.notes.length > 0 && (
                <ul className="muted" style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}

              {/* Create PR */}
              <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <Btn variant="primary" icon="github" loading={createPr.isPending} disabled={createPr.isPending || !!pr}
                  onClick={() => createPr.mutate()}>
                  {pr ? "PR created" : "Create pull request"}
                </Btn>
                <Btn variant="ghost" size="sm" icon="refresh" onClick={() => analyze.mutate()}>Re-analyze</Btn>
                {pr && (
                  <a href={pr.url} target="_blank" rel="noreferrer" className="row gap-1" style={{ fontSize: 13, alignItems: "center" }}>
                    <Icon name="ext" size={13} /> PR #{pr.number}
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}

/* ── Trivy security scan (in-app results) + add-scan-workflow PR ─────────── */
type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
type FindingClass = "vuln" | "misconfig" | "secret";
type TrivyFinding = {
  class: FindingClass;
  target: string;
  targetType: string;
  pkgName: string;
  vulnerabilityId: string;
  severity: Severity;
  status: string;
  installedVersion: string;
  fixedVersion: string;
  location: string;
  title: string;
  primaryUrl: string;
};
type TrivyScan = {
  ok: true;
  artifact: string;
  total: number;
  truncated: boolean;
  counts: Record<Severity, number>;
  findings: TrivyFinding[];
};

/** Animated, staged progress shown while a Trivy scan is running. The stages
 *  advance on a timer (real scan timing varies); the final stage stays active
 *  until the response lands, so we never claim "done" before it actually is. */
function ScanProgress({ running }: { running: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 250);
    return () => clearInterval(id);
  }, [running]);

  if (!running) return null;

  const stages = [
    { at: 0, label: "Connecting to repository" },
    { at: 2, label: "Updating vulnerability database" },
    { at: 6, label: "Scanning dependencies & code" },
    { at: 14, label: "Compiling results" },
  ];
  let active = 0;
  for (let i = 0; i < stages.length; i++) if (elapsed >= stages[i].at) active = i;
  // Ease toward ~92% so the bar feels live without ever pretending to finish.
  const pct = Math.min(92, (1 - Math.exp(-elapsed / 7)) * 100);

  return (
    <div className="col gap-3 fade-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div className="row gap-2" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <span className="row gap-2" style={{ alignItems: "center", fontSize: 13, fontWeight: 500 }}>
          <Icon name="shield" size={14} /> Scanning repository…
        </span>
        <span className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{Math.floor(elapsed)}s</span>
      </div>
      <Progress value={pct} ariaLabel="Scan progress" />
      <ul className="col gap-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {stages.map((s, i) => (
          <li key={s.label} className="row gap-2" style={{ alignItems: "center", fontSize: 12.5 }}>
            {i < active ? (
              <Icon name="check" size={13} />
            ) : i === active ? (
              <StatusDot tone="info" pulse />
            ) : (
              <span className="dot" style={{ opacity: 0.35 }} />
            )}
            <span className={i <= active ? "" : "muted"}>
              {s.label}{i === active ? "…" : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warn",
  LOW: "info",
  UNKNOWN: "default",
};
const SEVERITY_ROW: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];

const CLASS_LABEL: Record<FindingClass, { label: string; tone: BadgeTone }> = {
  vuln: { label: "Vuln", tone: "danger" },
  misconfig: { label: "Misconfig", tone: "warn" },
  secret: { label: "Secret", tone: "accent" },
};

const TH: CSSProperties = { padding: "6px 8px", whiteSpace: "nowrap", fontWeight: 600 };
const TD: CSSProperties = { padding: "6px 8px", verticalAlign: "top" };

type TargetGroup = { key: string; target: string; targetType: string; rows: TrivyFinding[] };

/** Group findings by the scanned target (file), like Trivy's report sections. */
function groupByTarget(findings: TrivyFinding[]): TargetGroup[] {
  const map = new Map<string, TargetGroup>();
  for (const f of findings) {
    const target = f.target || "(repository)";
    const key = `${target}|${f.targetType}`;
    let g = map.get(key);
    if (!g) {
      g = { key, target, targetType: f.targetType, rows: [] };
      map.set(key, g);
    }
    g.rows.push(f);
  }
  return [...map.values()];
}

function TrivyAutomation({ slug, repoFullName }: { slug: string; repoFullName: string }) {
  const [pr, setPr] = useState<PushResult["pullRequest"] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const scan = useMutation({
    mutationFn: () => api.post<TrivyScan>(`/projects/${slug}/automation/trivy/scan`, { repoFullName }),
    onMutate: () => setErr(null),
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const result = scan.data;

  const addWorkflow = useMutation({
    mutationFn: async () => {
      const gen = await api.post<GenResult>(`/projects/${slug}/automation/trivy/workflow`, {});
      const files = Object.fromEntries(gen.files.map((f) => [f.path, f.content]));
      const name = repoFullName.split("/")[1] || "app";
      return api.post<PushResult>(`/projects/${slug}/infra/push`, {
        repoFullName,
        basePath: "",
        files,
        branch: `automation/trivy-${name}`,
        message: "Add Trivy security scan workflow (DeepAgent automation)",
        pullRequestBody:
          "Generated by DeepAgent's security-scan automation.\n\n" +
          "Adds `.github/workflows/trivy.yml` — Trivy scans dependencies, secrets and misconfigurations on every push and pull request.",
      });
    },
    onMutate: () => setErr(null),
    onSuccess: (r) => {
      if (r.pullRequest) setPr(r.pullRequest);
      else setErr("Committed, but no pull request was returned.");
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Scans the connected repo for known vulnerabilities with Trivy and shows the results here. Add the workflow to also scan on every push/PR.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="shield" size={16} /> Security scan (Trivy)
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
            <Btn variant="primary" icon="shield" loading={scan.isPending} disabled={!repoFullName || scan.isPending}
              onClick={() => scan.mutate()}>
              {scan.isPending ? "Scanning… (this can take a minute)" : "Scan now"}
            </Btn>
            <Btn variant="ghost" icon="github" loading={addWorkflow.isPending} disabled={addWorkflow.isPending || !!pr}
              onClick={() => addWorkflow.mutate()}>
              {pr ? "Workflow PR created" : "Add scan workflow (PR)"}
            </Btn>
            {pr && (
              <a href={pr.url} target="_blank" rel="noreferrer" className="row gap-1" style={{ fontSize: 13, alignItems: "center" }}>
                <Icon name="ext" size={13} /> PR #{pr.number}
              </a>
            )}
          </div>

          {err && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {err}</span>}

          <ScanProgress running={scan.isPending} />

          {!scan.isPending && result && (
            <div className="col gap-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {result.total === 0 ? (
                <Badge tone="solid-ok" withDot>No known vulnerabilities found 🎉</Badge>
              ) : (
                <>
                  <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 12.5 }}>{result.total} findings:</span>
                    {SEVERITY_ROW.filter((s) => result.counts[s] > 0).map((s) => (
                      <Badge key={s} tone={SEVERITY_TONE[s]} withDot>{s} {result.counts[s]}</Badge>
                    ))}
                  </div>
                  {/* Grouped by target (file scanned), mirroring Trivy's report:
                      Library · Vulnerability · Severity · Status · Installed · Fixed in · Title. */}
                  <div style={{ overflowX: "auto", maxHeight: 460, border: "1px solid var(--border)", borderRadius: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", position: "sticky", top: 0, zIndex: 1, background: "var(--surface, #fff)" }}>
                          <th style={TH}>Type</th>
                          <th style={TH}>Library / Where</th>
                          <th style={TH}>ID</th>
                          <th style={TH}>Severity</th>
                          <th style={TH}>Status</th>
                          <th style={TH}>Installed</th>
                          <th style={TH}>Fixed in</th>
                          <th style={TH}>Title</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupByTarget(result.findings).map((g) => (
                          <Fragment key={g.key}>
                            <tr>
                              <td colSpan={8} style={{ padding: "7px 8px", background: "var(--surface-2, #0000000a)", fontWeight: 600 }}>
                                <span className="row gap-2" style={{ alignItems: "center" }}>
                                  <Icon name="db" size={12} /> {g.target}
                                  {g.targetType && <Badge tone="default">{g.targetType}</Badge>}
                                  <span className="muted" style={{ fontWeight: 400 }}>· {g.rows.length}</span>
                                </span>
                              </td>
                            </tr>
                            {g.rows.map((f, i) => (
                              <tr key={`${f.vulnerabilityId}-${f.pkgName}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                                <td style={TD}><Badge tone={CLASS_LABEL[f.class].tone}>{CLASS_LABEL[f.class].label}</Badge></td>
                                <td style={{ ...TD, fontFamily: "var(--font-mono, monospace)" }}>{f.pkgName || f.location || "—"}</td>
                                <td style={TD}>
                                  {f.primaryUrl ? (
                                    <a href={f.primaryUrl} target="_blank" rel="noreferrer">{f.vulnerabilityId}</a>
                                  ) : f.vulnerabilityId}
                                </td>
                                <td style={TD}><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge></td>
                                <td style={TD}>
                                  <span className={f.status === "fixed" ? "" : "muted"} style={{ fontSize: 11.5 }}>{f.status || "—"}</span>
                                </td>
                                <td style={{ ...TD, fontFamily: "var(--font-mono, monospace)" }}>{f.installedVersion || "—"}</td>
                                <td style={{ ...TD, fontFamily: "var(--font-mono, monospace)" }}>{f.fixedVersion || "—"}</td>
                                <td style={{ ...TD, maxWidth: 320 }}><span className="muted">{f.title || "—"}</span></td>
                              </tr>
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {result.truncated && (
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      Showing the {result.findings.length} most severe of {result.total} findings.
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
