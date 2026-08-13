"use client";

/**
 * Wizard step 3 — "Analysis & Recommendations".
 *
 * Runs the repo-intelligence scan (POST /repos/analyze) against the FIRST
 * repo the user selected in step 2, then renders the report as an editable
 * recommendation list. Every row defaults to Accepted; the user can skip
 * individual items. Nothing is provisioned here — accepted items become the
 * project's saved Deployment Plan, consumed later inside the project.
 *
 * Fail-soft by design: analysis errors/timeouts never block the wizard —
 * the user just continues without a plan.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Btn, Icon, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import {
  computeCostEstimate,
  type CapacityPlan,
  type RepoAnalysisReport,
  type Recommendation,
} from "@/lib/analysis/repo-analyzer";

// "accepted" (default) / "skipped" for each recommendation the user reviews.
// "applied" is kept in the union so the in-project RecommendedSetupPanel can
// mark rows as applied (post-creation) without a schema change.
export type PlanItems = Record<string, "accepted" | "skipped" | "applied">;

const PROGRESS_LABELS = [
  "Reading repository metadata…",
  "Listing the file tree…",
  "Reading manifests & README…",
  "Detecting services…",
  "Extracting environment variables…",
  "Auditing scaffolding files…",
  "Building recommendations…",
];

const AREA_LABEL: Record<string, string> = {
  cluster: "Cluster",
  replicas: "Scaling",
  resources: "Resources",
  database: "Database",
  services: "Services",
  exposure: "Exposure",
  env: "Config",
};

export function RepoAnalysisStep({
  repoFullName,
  accountId,
  report,
  onReport,
  planItems,
  onPlanItems,
  infraRepo,
  onInfraRepoChange,
  availableInfraRepos,
}: {
  repoFullName: string | null;
  accountId: string | null;
  report: RepoAnalysisReport | null;
  onReport: (r: RepoAnalysisReport | null) => void;
  planItems: PlanItems;
  onPlanItems: (items: PlanItems) => void;
  /**
   * Infra-repo pick — empty string means "same as app repo" (Terraform lands
   * in ./infra/). Any other value is the fullName of a separate GitHub repo
   * the user picked. Wizard persists this into the saved plan under the
   * sentinel key `__infraRepo` so the in-project RecommendedSetupPanel shows
   * the right target in its banner.
   */
  infraRepo?: string;
  onInfraRepoChange?: (v: string) => void;
  /** GitHub repos the user could commit infra to. Excludes the app repo. */
  availableInfraRepos?: { value: string; label: string }[];
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressIdx, setProgressIdx] = useState(0);
  const startedFor = useRef<string | null>(null);
  // Per-file generate-and-commit state: "busy" while committing, a path
  // string once committed, "error:<msg>" on failure.
  const [genState, setGenState] = useState<Record<string, string>>({});
  // Capacity slider state — target concurrent users. Debounced call to
  // /repos/resize on change; while pending, the recommendations stay showing
  // the previous plan (no flicker) and a small "resizing…" chip appears.
  const [resizing, setResizing] = useState(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onCapacityChange(nextTarget: number) {
    if (!report) return;
    // Optimistic UI: bump the visible number immediately so the input feels
    // live; the actual recommendation rows swap when the resize returns.
    onReport({
      ...report,
      capacity: { ...report.capacity, targetConcurrentUsers: nextTarget },
    });
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    setResizing(true);
    resizeTimer.current = setTimeout(() => {
      api
        .post<{ ok: boolean; capacity: CapacityPlan; recommendations: Recommendation[] }>(
          "/repos/resize",
          {
            services: report.services,
            targetConcurrentUsers: nextTarget,
          },
        )
        .then((res) => {
          if (!res.ok) return;
          // Splice new cluster + replicas rows into the recommendations list,
          // leaving the other rows (resources, database, exposure, env) alone.
          const kept = report.recommendations.filter(
            (r) => r.area !== "cluster" && r.area !== "replicas",
          );
          const workerRows = report.recommendations.filter(
            (r) =>
              r.area === "replicas" &&
              !res.recommendations.some((n) => n.id === r.id),
          );
          onReport({
            ...report,
            capacity: res.capacity,
            recommendations: [...res.recommendations, ...workerRows, ...kept],
          });
        })
        .finally(() => setResizing(false));
    }, 250);
  }

  function generateFile(fileId: string) {
    if (!report || !repoFullName) return;
    setGenState((s) => ({ ...s, [fileId]: "busy" }));
    api
      .post<{ ok: boolean; path?: string; branch?: string; message?: string }>("/repos/scaffold", {
        fullName: repoFullName,
        accountId: accountId ?? undefined,
        fileId,
        report,
      })
      .then((res) => {
        setGenState((s) => ({
          ...s,
          [fileId]: res.ok && res.path ? `done:${res.path}` : `error:${res.message ?? "failed"}`,
        }));
      })
      .catch((e) =>
        setGenState((s) => ({ ...s, [fileId]: `error:${apiErrorMessage(e, "Commit failed.")}` })),
      );
  }

  // Kick the analysis when the step mounts (or the target repo changed).
  useEffect(() => {
    if (!repoFullName) return;
    if (report && report.repoFullName === repoFullName) return;
    if (startedFor.current === repoFullName) return;
    startedFor.current = repoFullName;
    setAnalyzing(true);
    setError(null);
    setProgressIdx(0);
    const ticker = setInterval(
      () => setProgressIdx((i) => Math.min(i + 1, PROGRESS_LABELS.length - 1)),
      1400,
    );
    api
      .post<{ ok: boolean; report?: RepoAnalysisReport; message?: string }>("/repos/analyze", {
        fullName: repoFullName,
        accountId: accountId ?? undefined,
      })
      .then((res) => {
        if (res.ok && res.report) {
          onReport(res.report);
          // Default every recommendation to accepted.
          const items: PlanItems = {};
          for (const r of res.report.recommendations) items[r.id] = "accepted";
          onPlanItems(items);
        } else {
          setError(res.message ?? "Analysis failed.");
        }
      })
      .catch((e) => setError(apiErrorMessage(e, "Analysis failed.")))
      .finally(() => {
        clearInterval(ticker);
        setAnalyzing(false);
      });
    return () => clearInterval(ticker);
  }, [repoFullName, accountId, report, onReport, onPlanItems]);

  if (!repoFullName) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        Select a repository in the previous step first.
      </p>
    );
  }

  if (analyzing) {
    return (
      <div className="col center gap-3" style={{ padding: "36px 0" }}>
        <span
          className="row center"
          style={{ width: 44, height: 44, borderRadius: 12, background: "var(--surface-2)" }}
        >
          <Icon name="search" size={22} />
        </span>
        <strong style={{ fontSize: 14 }}>Analyzing {repoFullName}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {PROGRESS_LABELS[progressIdx]}
        </span>
        <span className="muted" style={{ fontSize: 11.5, opacity: 0.7 }}>
          Reads the code + README to recommend your cluster, scaling and services.
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="col gap-3">
        <div
          className="col gap-2"
          style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: 14, fontSize: 13 }}
        >
          <span style={{ fontWeight: 600 }}>Analysis didn&apos;t complete</span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {error} — you can continue without recommendations, or retry.
          </span>
          <button
            type="button"
            className="btn outline sm"
            style={{ width: "fit-content" }}
            onClick={() => {
              startedFor.current = null;
              onReport(null);
              setError(null);
            }}
          >
            <Icon name="refresh" size={13} /> Retry analysis
          </button>
        </div>
      </div>
    );
  }

  if (!report) return null;

  const accepted = Object.values(planItems).filter((v) => v === "accepted").length;
  const blocker = report.missingFiles.find((f) => f.blocking);

  const cost = report.capacity
    ? computeCostEstimate(report.capacity, report.infraNeeds, { hasOwnDb: false })
    : null;

  // Verdict → colour + tone for the top-of-page card. `not_fit` also gates
  // Continue via the wizard (see CreateProjectWizard.canNext), so the border
  // matches that severity.
  const verdictColor =
    report.deployability.status === "ready"
      ? "var(--ok, #30a46c)"
      : report.deployability.status === "warn"
        ? "var(--warn, #f5a524)"
        : "var(--danger, #e5484d)";
  const verdictIcon =
    report.deployability.status === "ready"
      ? "check"
      : report.deployability.status === "warn"
        ? "alert"
        : "x";

  return (
    <div className="col gap-4">
      {/* ── Deployability verdict — the very first thing the user sees.
          Ready = green, warn = amber, not_fit = red (and Continue disabled). */}
      <div
        className="col gap-2"
        style={{
          border: `1px solid ${verdictColor}`,
          borderRadius: 10,
          padding: "12px 14px",
          background: report.deployability.status === "ready" ? "var(--surface-1)" : "transparent",
        }}
      >
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <Icon name={verdictIcon} size={16} style={{ color: verdictColor, flex: "none" }} />
          <b style={{ fontSize: 13.5, color: verdictColor }}>{report.deployability.title}</b>
          {report.deployability.concernCount > 0 && (
            <Badge tone="default">
              {report.deployability.concernCount} concern
              {report.deployability.concernCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>{report.deployability.reason}</span>
      </div>

      {/* Per-service language chips — shows what the agent actually decided
          the runtime is (framework/version/package manager), so the user can
          spot a wrong detection before the plan builds on top of it. */}
      {report.services.length > 0 && (
        <div className="col gap-2">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Detected services
          </span>
          {report.services.map((s) => {
            const lp = s.languageProfile;
            const chips = [
              lp.framework,
              lp.version ? `${lp.language} ${lp.version}` : lp.language,
              lp.server,
              lp.packageManager,
              lp.buildTool,
            ].filter(Boolean) as string[];
            return (
              <div
                key={s.path || s.name}
                className="row gap-2 wrap"
                style={{
                  alignItems: "center",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 12.5,
                }}
              >
                <b>{s.name}</b>
                <span className="muted">{s.role}</span>
                {chips.map((c) => (
                  <Badge key={c} tone="default">
                    {c}
                  </Badge>
                ))}
                {!s.hasDockerfile && (
                  <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto" }}>
                    no Dockerfile
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Migrations — one row per detected tool, with the init-container recommendation. */}
      {report.migrations.length > 0 && (
        <div className="col gap-2">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Database migrations
          </span>
          {report.migrations.map((m) => (
            <div
              key={m.service + m.tool}
              className="row gap-2"
              style={{
                alignItems: "flex-start",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12.5,
              }}
            >
              <Icon name="db" size={14} style={{ flex: "none", marginTop: 2 }} />
              <span className="col" style={{ gap: 2 }}>
                <b>
                  {m.tool} · {m.service}
                </b>
                <span className="muted" style={{ lineHeight: 1.5 }}>
                  {m.recommendation}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {/* Hard gate — a successful scan with no README stops the wizard until
          the developer pushes one. Never generated: the README is how the
          agent understands the application before sizing its deployment. */}
      {blocker && (
        <div
          className="col gap-2"
          style={{
            border: "1px solid var(--danger, #e5484d)",
            borderRadius: 10,
            padding: "12px 14px",
            fontSize: 13,
          }}
        >
          <span className="row gap-2" style={{ alignItems: "center", fontWeight: 700 }}>
            <Icon name="alert" size={16} /> {blocker.label}
          </span>
          <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            {blocker.detail}
          </span>
          <button
            type="button"
            className="btn outline sm"
            style={{ width: "fit-content" }}
            onClick={() => {
              startedFor.current = null;
              onReport(null);
            }}
          >
            <Icon name="refresh" size={13} /> Re-analyze (after pushing the README)
          </button>
        </div>
      )}
      {/* Summary strip */}
      <div
        className="row gap-3 wrap"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "10px 14px",
          alignItems: "center",
          fontSize: 12.5,
        }}
      >
        <Icon name="check" size={15} />
        <span>
          <b>{report.services.length}</b> service{report.services.length === 1 ? "" : "s"} ·{" "}
          <b>{report.fileCount}</b> files ·{" "}
          <b>{report.envVars.length}</b> env vars ·{" "}
          <b>{report.missingFiles.length}</b> missing file{report.missingFiles.length === 1 ? "" : "s"}
        </span>
        <span className="muted" style={{ marginLeft: "auto" }}>
          {report.services.map((s) => s.stackTitle).join(" + ")}
        </span>
      </div>

      {report.readmeSummary && (
        <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>
          <b>README:</b> {report.readmeSummary}
        </p>
      )}

      {/* Capacity slider — the user tells us the target concurrent users and
          the cluster + replicas rows below re-size to match. Anchored on the
          agent's OOTB estimate, editable to any number the user actually
          expects. Debounced by 250 ms so dragging feels smooth. */}
      {report.capacity && (
        <div
          className="col gap-2"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
          <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <b style={{ fontSize: 13 }}>Expected concurrent users</b>
            <Badge tone="accent">
              {report.capacity.targetConcurrentUsers.toLocaleString()}
            </Badge>
            {resizing && (
              <span className="muted" style={{ fontSize: 11.5 }}>resizing recommendations…</span>
            )}
            <span
              className="muted"
              style={{ fontSize: 11.5, marginLeft: "auto" }}
            >
              Cluster serves up to{" "}
              <b>{report.capacity.cluster.maxConcurrentUsers.toLocaleString()}</b> at HPA-max
            </span>
          </div>
          <div className="row gap-3" style={{ alignItems: "center" }}>
            <input
              type="range"
              min={100}
              max={20000}
              step={100}
              value={Math.min(20000, Math.max(100, report.capacity.targetConcurrentUsers))}
              onChange={(e) => onCapacityChange(Number(e.target.value))}
              style={{ flex: 1 }}
              aria-label="Target concurrent users"
            />
            <input
              type="number"
              min={10}
              max={1_000_000}
              step={100}
              value={report.capacity.targetConcurrentUsers}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 10) onCapacityChange(v);
              }}
              style={{
                width: 100,
                fontSize: 12.5,
                padding: "4px 8px",
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}
              aria-label="Target concurrent users (exact)"
            />
          </div>
          <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            {report.capacity.reasoning} You know your traffic — nudge this and the cluster + replicas below re-size to match.
          </span>
        </div>
      )}

      {/* Agent review — the platform agent tests deployment readiness so the
          user doesn't have to. pass = green, warn = amber (README unclear /
          risky), skipped = neutral (no model configured). */}
      {report.agentReview && report.agentReview.verdict !== "skipped" && (
        <div
          className="row gap-2"
          style={{
            alignItems: "flex-start",
            border: `1px solid ${report.agentReview.verdict === "pass" ? "var(--ok, #30a46c)" : "var(--warn, #f5a524)"}`,
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 12.5,
          }}
        >
          <Icon
            name="bot"
            size={16}
            style={{
              flex: "none",
              marginTop: 1,
              color: report.agentReview.verdict === "pass" ? "var(--ok, #30a46c)" : "var(--warn, #f5a524)",
            }}
          />
          <span className="col" style={{ gap: 2 }}>
            <b>
              Agent review — {report.agentReview.verdict === "pass" ? "ready for deployment sizing" : "README needs attention"}
            </b>
            <span className="muted" style={{ lineHeight: 1.5 }}>{report.agentReview.notes}</span>
          </span>
        </div>
      )}

      {/*
        Infrastructure repository picker. Two options:
          • same-repo (default) — Terraform lands in ./infra/ inside the app repo.
          • separate-repo       — commits to <picked-repo>/<project-slug>/aws/
        Persisted into the DeploymentPlan under items.__infraRepo so the
        in-project RecommendedSetupPanel can show the right target in its
        banner (empty = same-repo). Hidden entirely if the wizard didn't
        wire the callback in (older callers stay untouched).
      */}
      {onInfraRepoChange && (
        <div
          className="col gap-2"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="server" size={16} style={{ color: "var(--accent, #8b7cf5)" }} />
            <b style={{ fontSize: 13 }}>Where should the infrastructure code live?</b>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            The Terraform (cluster, DB, S3) we generate needs a git home. Pick
            <b> Same repo</b> for a monorepo layout, or <b>Separate repo</b> to
            keep infra reviewed on its own timeline.
          </p>
          <div className="col gap-2">
            <button
              type="button"
              onClick={() => onInfraRepoChange("")}
              className="row gap-3"
              style={{
                alignItems: "center",
                textAlign: "left",
                border: `1px solid ${!infraRepo ? "var(--accent, #8b7cf5)" : "var(--border)"}`,
                background: !infraRepo ? "var(--accent-soft, rgba(139,124,245,0.14))" : "transparent",
                borderRadius: 10,
                padding: "10px 12px",
                cursor: "pointer",
                width: "100%",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: `2px solid ${!infraRepo ? "var(--accent, #8b7cf5)" : "var(--border)"}`,
                  background: !infraRepo ? "radial-gradient(circle, var(--accent, #8b7cf5) 40%, transparent 44%)" : "transparent",
                  flex: "none",
                }}
              />
              <span className="col" style={{ flex: 1, gap: 2 }}>
                <b style={{ fontSize: 13 }}>
                  Same repo — {repoFullName ? repoFullName.split("/").pop() : "app repo"}
                </b>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Commit into <code>./infra/</code>. Simplest — one PR reviews app + infra together.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                // If they had a separate repo pick, keep it; else pick the first
                // available so the dropdown isn't blank.
                const initial =
                  infraRepo || availableInfraRepos?.[0]?.value || "";
                onInfraRepoChange(initial || "__pending__");
              }}
              className="row gap-3"
              style={{
                alignItems: "center",
                textAlign: "left",
                border: `1px solid ${infraRepo ? "var(--accent, #8b7cf5)" : "var(--border)"}`,
                background: infraRepo ? "var(--accent-soft, rgba(139,124,245,0.14))" : "transparent",
                borderRadius: 10,
                padding: "10px 12px",
                cursor: "pointer",
                width: "100%",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: `2px solid ${infraRepo ? "var(--accent, #8b7cf5)" : "var(--border)"}`,
                  background: infraRepo ? "radial-gradient(circle, var(--accent, #8b7cf5) 40%, transparent 44%)" : "transparent",
                  flex: "none",
                }}
              />
              <span className="col" style={{ flex: 1, gap: 2 }}>
                <b style={{ fontSize: 13 }}>Separate infra repo</b>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Recommended for prod. Keeps platform changes reviewable on their own timeline.
                </span>
              </span>
            </button>
            {infraRepo && (
              <div className="col gap-1" style={{ marginTop: 4 }}>
                <span className="field-label">Infra repository</span>
                <Select
                  value={infraRepo === "__pending__" ? "" : infraRepo}
                  onValueChange={onInfraRepoChange}
                  placeholder="Pick a repo from your GitHub…"
                  options={
                    availableInfraRepos && availableInfraRepos.length > 0
                      ? availableInfraRepos
                      : [{ value: "", label: "No other repos found in this GitHub account", disabled: true }]
                  }
                />
                <span className="muted" style={{ fontSize: 11 }}>
                  We commit to <code>&lt;repo&gt;/deepagent/&lt;env&gt;/</code> so one infra
                  repo can hold many projects side-by-side.
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recommendations — accept/skip each */}
      <div className="col gap-2">
        <span className="field-label" style={{ marginBottom: 0 }}>
          Recommendations ({accepted}/{report.recommendations.length} accepted)
        </span>
        {report.recommendations.map((r) => {
          const state = planItems[r.id] ?? "accepted";
          const on = state === "accepted";
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onPlanItems({ ...planItems, [r.id]: on ? "skipped" : "accepted" })}
              className="row gap-3"
              style={{
                alignItems: "flex-start",
                textAlign: "left",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                background: on ? "var(--accent-soft, rgba(120,120,255,.06))" : "transparent",
                borderRadius: 10,
                padding: "10px 12px",
                cursor: "pointer",
                opacity: on ? 1 : 0.6,
              }}
            >
              <span
                className="row center"
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  flex: "none",
                  marginTop: 1,
                  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                  background: on ? "var(--accent)" : "transparent",
                  color: "#fff",
                }}
              >
                {on && <Icon name="check" size={12} />}
              </span>
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="row gap-2" style={{ alignItems: "center" }}>
                  <Badge tone="default">{AREA_LABEL[r.area] ?? r.area}</Badge>
                  <b style={{ fontSize: 13 }}>{r.title}</b>
                </span>
                <span style={{ fontSize: 12.5 }}>{r.value}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {r.why}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Missing files — informational here; generated from the project later */}
      {report.missingFiles.length > 0 && (
        <div className="col gap-2">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Missing files ({report.missingFiles.length})
          </span>
          {report.missingFiles.map((f) => {
            const state = genState[f.id] ?? "";
            const done = state.startsWith("done:");
            const busy = state === "busy";
            const err = state.startsWith("error:") ? state.slice(6) : null;
            return (
              <div
                key={f.id}
                className="row gap-2"
                style={{
                  alignItems: "center",
                  border: done ? "1px solid var(--ok, #30a46c)" : "1px dashed var(--border)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 12.5,
                }}
              >
                <Icon
                  name={done ? "check" : "alert"}
                  size={14}
                  style={{ flex: "none", color: done ? "var(--ok, #30a46c)" : undefined }}
                />
                <span className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                  <b>{f.label}</b>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {done
                      ? `Committed ${state.slice(5)} to ${report.defaultBranch}.`
                      : f.detail}
                  </span>
                  {err && (
                    <span style={{ fontSize: 11.5, color: "var(--danger)" }}>{err}</span>
                  )}
                </span>
                {f.generatable && !done && (
                  <Btn
                    size="sm"
                    variant="outline"
                    icon="check"
                    loading={busy}
                    onClick={() => generateFile(f.id)}
                  >
                    Generate &amp; commit
                  </Btn>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Cost estimate — recomputes on every capacity slider change AND when
          the own-DB toggle flips. Rough US-region on-demand ballpark, not a
          billing preview: managed DB, cluster nodes, EKS control plane,
          Redis/S3/SES allowances, ALB baseline. */}
      {cost && (
        <div
          className="col gap-2"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 14px",
            background: "var(--surface-1)",
          }}
        >
          <div
            className="row gap-2"
            style={{ alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap" }}
          >
            <b style={{ fontSize: 13 }}>Estimated monthly cost</b>
            <span style={{ fontWeight: 700, fontSize: 18, color: "var(--accent, #6d5ae6)" }}>
              ~${cost.monthlyUsd.toLocaleString()}<span style={{ fontSize: 12, opacity: 0.7 }}> /month</span>
            </span>
          </div>
          <div className="col gap-1" style={{ fontSize: 12 }}>
            {cost.lineItems.map((it, i) => (
              <div
                key={i}
                className="row gap-2"
                style={{ alignItems: "baseline", justifyContent: "space-between" }}
              >
                <span className="col" style={{ gap: 0, minWidth: 0 }}>
                  <span>{it.label}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {it.detail}
                  </span>
                </span>
                <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                  ${it.monthlyUsd.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            {cost.assumptions}
          </span>
        </div>
      )}
    </div>
  );
}
