"use client";

/**
 * Cluster-creation wizard engine (console-style).
 *
 * Renders a static, paged form — like a cloud console's "Create cluster" flow:
 * one or two pages of fields with Back / Next at the bottom, a final review
 * page, then the deterministic two-step run (generate Terraform → push to
 * GitHub → apply) with a Jenkins-style stage view. No LLM.
 *
 * The engine is cloud-agnostic; EKS / GKE / AKS each pass a `ClusterChatConfig`
 * (the field script grouped into pages + how to build the request body).
 */
import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Block, Btn, Field, Input, Select } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api/client";
import {
  usePushInfraFiles,
  useStartTerraformRun,
  useTerraformRun,
} from "@/hooks/queries/connectivity";
import { TerraformStageView, apiErrorMessage } from "@/components/domain/cluster-chat-shared";

export type EnvRow = { id: string; key: string; name: string };
export type RepoRow = { id: string; fullName: string; name: string; defaultBranch: string };

export type Answers = Record<string, string | number | boolean>;
type Opt = { value: string; label: string };

/** Parse a "list" step's stored JSON value back into rows. Never throws. */
export function parseListRows(v: string | number | boolean | undefined): Record<string, string>[] {
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, string>[]) : [];
  } catch {
    return [];
  }
}

/** Context handed to a step's dynamic option/default functions. */
export type StepCtx = {
  answers: Answers;
  envs: EnvRow[];
  repos: RepoRow[];
  /** Whatever the cloud's `/eks|/gke|/aks` GET returned (defaults + option lists). */
  opts: Record<string, unknown> | undefined;
  /** Results of `config.extraQueries`, keyed by their `key` (e.g. live GCP projects). */
  sources: Record<string, unknown>;
};

type BaseStep = {
  key: string;
  /** Field label shown on the page and in the review summary. */
  label: string;
  hint?: string;
  /** Which wizard page (1-based) this field belongs on. Defaults to page 1. */
  page?: number;
  /** Hide this field entirely when the predicate is true (conditional branches). */
  skip?: (a: Answers) => boolean;
  optional?: boolean;
};
/** A single field within a "list" step's repeatable row. */
export type ListField = {
  key: string;
  label: string;
  kind: "text" | "select";
  mono?: boolean;
  placeholder?: string;
  options?: (c: StepCtx) => Opt[];
  default?: (c: StepCtx) => string;
  validate?: (v: string) => string | null;
};

export type Step =
  | (BaseStep & {
      kind: "select";
      options: (c: StepCtx) => Opt[];
      default?: (c: StepCtx) => string;
      emptyNote?: string;
    })
  | (BaseStep & {
      kind: "text" | "number";
      placeholder?: string;
      mono?: boolean;
      default?: (c: StepCtx) => string;
      validate?: (v: string, a: Answers) => string | null;
    })
  | (BaseStep & {
      kind: "choice";
      choices: { value: string | boolean; label: string }[];
    })
  | (BaseStep & {
      // Multiple values stored as a comma-joined string (matches the EKS
      // existingSubnetIds shape). Rendered as toggleable chips.
      kind: "multiselect";
      options: (c: StepCtx) => Opt[];
      emptyNote?: string;
    })
  | (BaseStep & {
      // Read-only informational block — no input, no stored value.
      kind: "info";
      text: (c: StepCtx) => string;
    })
  | (BaseStep & {
      // A repeatable group of rows (e.g. "+ Add user"). Stored as a
      // JSON-stringified array of per-field records so it fits the Answers
      // type without widening it.
      kind: "list";
      fields: ListField[];
      addLabel?: string; // "+ Add user"
      max?: number;
    });

export type ClusterChatConfig = {
  cloud: "aws" | "gcp" | "azure" | "proxmox";
  cloudLabel: string; // "AWS"
  title: string; // "Create EKS cluster"
  blueprintSub: string;
  optionsPath: string; // "eks" | "gke" | "aks"
  stackPrefix: string; // "eks"
  ghPathPrefix: string; // "terraform/eks"
  branchPrefix: string; // "eks"
  applyEta: string; // "~15–20 min"
  steps: Step[];
  /** Title shown above each page; index 0 = page 1. */
  pageTitles?: string[];
  /**
   * Extra GET queries whose results are exposed via `ctx.sources[key]`.
   * `params` (derived from the current answers) is sent as the query string and
   * keys the cache, so the query refetches when those answers change (e.g. the
   * AWS VPC list when env/region change). Return null from `params` — or false
   * from `enabled` — to hold the query until prerequisites are chosen.
   */
  extraQueries?: {
    key: string;
    path: string;
    params?: (a: Answers) => Record<string, string> | null;
    enabled?: (a: Answers) => boolean;
  }[];
  /** Map the collected answers into the generate-endpoint request body. */
  buildBody: (a: Answers) => Record<string, unknown>;
};

type GenResult = {
  clusterName: string;
  fileCount: number;
  files: Record<string, string>;
};

export function ClusterChat({ slug, config }: { slug: string; config: ClusterChatConfig }) {
  const opts = useQuery<Record<string, unknown>>({
    queryKey: ["p", slug, config.optionsPath, "options"],
    queryFn: () => api.get<Record<string, unknown>>(`/projects/${slug}/${config.optionsPath}`),
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
  const extra = config.extraQueries ?? [];
  const [values, setValues] = useState<Answers>({});
  const extraResults = useQueries({
    queries: extra.map((q) => {
      const params = q.params ? q.params(values) : undefined;
      const enabled = (q.enabled ? q.enabled(values) : true) && params !== null;
      return {
        queryKey: ["p", slug, "wizard-src", q.key, params ?? null],
        queryFn: () => api.get<unknown>(`/projects/${slug}/${q.path}`, params ?? undefined),
        enabled,
        staleTime: 60_000,
      };
    }),
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  // pageIdx in [0 .. pages.length]; the final index renders the review page.
  const [pageIdx, setPageIdx] = useState(0);
  const [phase, setPhase] = useState<"form" | "working">("form");

  // Generate/apply state (the deterministic two-step flow).
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{
    files: Record<string, string>;
    clusterName: string;
  } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const envKey = String(values.envKey ?? "");
  const pushFiles = usePushInfraFiles(slug);
  const startRun = useStartTerraformRun(slug, envKey);
  const runQuery = useTerraformRun(slug, envKey, runId);
  const run = runQuery.data?.run ?? null;

  const sources = useMemo(() => {
    const s: Record<string, unknown> = {};
    extra.forEach((q, i) => {
      s[q.key] = extraResults[i]?.data;
    });
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(extraResults.map((r) => r.dataUpdatedAt))]);

  const ctx: StepCtx = useMemo(
    () => ({ answers: values, envs: envs ?? [], repos: repos ?? [], opts: opts.data, sources }),
    [values, envs, repos, opts.data, sources],
  );

  const pages = useMemo(() => {
    const set = new Set<number>();
    for (const s of config.steps) set.add(s.page ?? 1);
    return Array.from(set).sort((a, b) => a - b);
  }, [config.steps]);

  const stepsOnPage = (p: number) =>
    config.steps.filter((s) => (s.page ?? 1) === p && (!s.skip || !s.skip(values)));

  // Seed sensible defaults as data arrives and as pages are reached (without
  // clobbering user edits). Gating to pages reached so far lets later-page
  // defaults read earlier answers — e.g. the GitHub path picks up the name.
  useEffect(() => {
    const maxPage = pageIdx >= pages.length ? Infinity : pages[pageIdx];
    setValues((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const s of config.steps) {
        if ((s.page ?? 1) > maxPage) continue;
        if (next[s.key] !== undefined) continue;
        if (s.kind === "select") {
          // Don't force a value on optional selects (e.g. GKE subnetwork =
          // "leave unset to auto-allocate"); only seed required ones.
          const o = s.options(ctx);
          if (o.length && !s.optional) {
            next[s.key] = s.default ? s.default(ctx) : o[0].value;
            changed = true;
          }
        } else if (s.kind === "choice") {
          next[s.key] = s.choices[0].value;
          changed = true;
        } else if ("default" in s && s.default) {
          next[s.key] = s.default(ctx);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envs, repos, opts.data, sources, pageIdx]);

  function setVal(key: string, v: string | number | boolean) {
    setValues((p) => ({ ...p, [key]: v }));
    setErrors((e) => (e[key] ? { ...e, [key]: "" } : e));
  }

  function validateField(s: Step): string | null {
    const v = values[s.key];
    if (s.kind === "select") return v ? null : s.optional ? null : "Select an option.";
    if (s.kind === "multiselect") {
      const chosen = String(v ?? "")
        .split(",")
        .filter(Boolean);
      return chosen.length === 0 && !s.optional ? "Select at least one." : null;
    }
    if (s.kind === "choice") return v === undefined ? "Choose one." : null;
    if (s.kind === "info") return null;
    if (s.kind === "list") {
      for (const row of parseListRows(v)) {
        for (const f of s.fields) {
          const err = f.validate?.(String(row[f.key] ?? "").trim());
          if (err) return err;
        }
      }
      return null;
    }
    if (s.kind === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return "Enter a number.";
      return s.validate?.(String(v), values) ?? null;
    }
    // text
    const t = String(v ?? "").trim();
    if (!t && !s.optional) return "Required.";
    return s.validate?.(t, values) ?? null;
  }

  function validatePage(p: number): boolean {
    const errs: Record<string, string> = {};
    for (const s of stepsOnPage(p)) {
      const e = validateField(s);
      if (e) errs[s.key] = e;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  const onReview = pageIdx >= pages.length;
  const currentPage = pages[pageIdx];

  function next() {
    if (onReview) return;
    if (!validatePage(currentPage)) return;
    setPageIdx((i) => i + 1);
  }
  function back() {
    setNote(null);
    setPageIdx((i) => Math.max(0, i - 1));
  }

  function displayValue(s: Step, value: string | number | boolean | undefined): string {
    if (value === undefined || value === "") return "—";
    if (s.kind === "select")
      return s.options(ctx).find((o) => o.value === value)?.label ?? String(value);
    if (s.kind === "multiselect") {
      const opts = s.options(ctx);
      const chosen = String(value).split(",").filter(Boolean);
      return chosen.map((v) => opts.find((o) => o.value === v)?.label ?? v).join(", ") || "—";
    }
    if (s.kind === "choice")
      return s.choices.find((c) => c.value === value)?.label ?? String(value);
    if (s.kind === "list") {
      const rows = parseListRows(value);
      return rows.length === 0 ? "—" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;
    }
    return String(value);
  }

  function restart() {
    setValues({});
    setErrors({});
    setPageIdx(0);
    setPhase("form");
    setGenerated(null);
    setRunId(null);
    setNote(null);
  }

  // After a failed apply: return to the review page KEEPING all answers, so the
  // user can regenerate (picks up any fix) + re-apply without re-filling the
  // form. Clears the prior generate so Apply is re-enabled only after a fresh one.
  function backToForm() {
    setPhase("form");
    setRunId(null);
    setGenerated(null);
    setNote(null);
    setPageIdx(pages.length); // the review page
  }

  // STEP 1 — generate the HCL and push it INTO the GitHub repo.
  async function generateToGithub() {
    const name = String(values.name ?? "").trim();
    const repoFullName = String(values.repoFullName ?? "");
    const ghPath = String(values.ghPath ?? "").trim();
    if (!name || !repoFullName || !ghPath) return;
    setBusy(true);
    setGenerated(null);
    setRunId(null);
    setNote(null);
    try {
      const gen = await api.post<GenResult>(
        `/projects/${slug}/${config.optionsPath}`,
        config.buildBody(values),
      );
      const pushed = await pushFiles.mutateAsync({
        repoFullName,
        basePath: ghPath,
        files: gen.files,
        branch: `infra/${config.branchPrefix}-${name}`,
        message: `Add ${config.cloudLabel} cluster ${name} (Terraform)`,
        pullRequestBody: `Deterministic ${config.cloudLabel} blueprint for \`${name}\`.`,
      });
      setGenerated({ files: gen.files, clusterName: gen.clusterName });
      setNote(
        pushed.pullRequest
          ? `✅ Generated ${gen.fileCount} files → ${repoFullName} · PR #${pushed.pullRequest.number}: ${pushed.pullRequest.url}`
          : `✅ Generated ${gen.fileCount} files → ${repoFullName} (branch infra/${config.branchPrefix}-${name}).`,
      );
    } catch (e) {
      setNote(`❌ Generate/push failed: ${apiErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // STEP 2 — apply the generated/pushed files.
  async function applyGenerated() {
    const name = String(values.name ?? "").trim();
    if (!generated || !envKey) return;
    setBusy(true);
    setPhase("working");
    setNote(null);
    try {
      const res = await startRun.mutateAsync({
        action: "apply",
        name: generated.clusterName,
        files: generated.files,
        stack: `${config.stackPrefix}-${name}`,
      });
      if (!res.ok || !res.run) {
        setNote(`❌ Couldn't start apply: ${res.message ?? "unknown error"}`);
        setPhase("form");
      } else {
        setRunId(res.run.id);
        setNote(
          `Applying to ${config.cloudLabel} — this takes ${config.applyEta}. Watch the stages below.`,
        );
      }
    } catch (e) {
      setNote(`❌ ${apiErrorMessage(e)}`);
      setPhase("form");
    } finally {
      setBusy(false);
    }
  }

  const canGenerate =
    !!String(values.name ?? "").trim() &&
    !!String(values.repoFullName ?? "") &&
    !!String(values.ghPath ?? "").trim() &&
    !busy;

  const totalSteps = pages.length + 1; // + review
  const stepLabel = onReview
    ? `Step ${totalSteps} of ${totalSteps} · Review & create`
    : `Step ${pageIdx + 1} of ${totalSteps} · ${config.pageTitles?.[pageIdx] ?? `Page ${pageIdx + 1}`}`;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={config.blueprintSub}>{config.title}</Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 620 }}>
          {/* Stepper header */}
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background:
                    i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)",
                }}
              />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            {stepLabel}
          </span>

          {/* Input page */}
          {!onReview && phase === "form" && (
            <div className="col gap-3">
              {stepsOnPage(currentPage).map((s) => (
                <FieldControl
                  key={s.key}
                  step={s}
                  ctx={ctx}
                  value={values[s.key]}
                  error={errors[s.key]}
                  onChange={(v) => setVal(s.key, v)}
                />
              ))}
            </div>
          )}

          {/* Review page */}
          {onReview && phase === "form" && (
            <div className="col gap-3">
              <div
                className="col gap-1"
                style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}
              >
                {config.steps
                  .filter(
                    (s) =>
                      (!s.skip || !s.skip(values)) &&
                      values[s.key] !== undefined &&
                      values[s.key] !== "",
                  )
                  .map((s) => (
                    <div key={s.key} className="row between" style={{ gap: 12, fontSize: 13 }}>
                      <span className="muted">{s.label}</span>
                      <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>
                        {displayValue(s, values[s.key])}
                      </span>
                    </div>
                  ))}
              </div>
              <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <Btn
                  variant="primary"
                  icon="github"
                  loading={pushFiles.isPending}
                  disabled={!canGenerate}
                  onClick={generateToGithub}
                >
                  {generated ? "Regenerate to GitHub" : "Generate to GitHub"}
                </Btn>
                <Btn
                  variant={generated ? "primary" : "outline"}
                  icon="server"
                  loading={startRun.isPending}
                  disabled={!generated || busy}
                  onClick={applyGenerated}
                >
                  Apply to {config.cloudLabel}
                </Btn>
              </div>
            </div>
          )}

          {note && (
            <span
              style={{
                fontSize: 12.5,
                color: note.startsWith("❌") ? "var(--danger, #e5484d)" : "var(--muted, #888)",
              }}
            >
              {note}
            </span>
          )}

          {/* Bottom nav */}
          {phase === "form" && (
            <div
              className="row between"
              style={{ alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 12 }}
            >
              <Btn variant="ghost" icon="chevL" disabled={pageIdx === 0 || busy} onClick={back}>
                Back
              </Btn>
              {!onReview ? (
                <Btn variant="primary" iconRight="chevR" onClick={next}>
                  Next
                </Btn>
              ) : (
                <Btn variant="ghost" size="sm" icon="refresh" onClick={restart}>
                  Start over
                </Btn>
              )}
            </div>
          )}

          {/* Jenkins-style stage view once a run is active */}
          {run && (
            <div>
              <TerraformStageView run={run} />
              {(run.status === "succeeded" || run.status === "failed") && (
                <div className="row gap-2" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  {run.status === "failed" && (
                    <Btn variant="primary" size="sm" icon="refresh" onClick={backToForm}>
                      Back to form &amp; retry
                    </Btn>
                  )}
                  <Btn variant="ghost" size="sm" icon="refresh" onClick={restart}>
                    Create another
                  </Btn>
                </div>
              )}
            </div>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}

/** Render the right input control for a single field. */
function FieldControl({
  step,
  ctx,
  value,
  error,
  onChange,
}: {
  step: Step;
  ctx: StepCtx;
  value: string | number | boolean | undefined;
  error?: string;
  onChange: (v: string | number | boolean) => void;
}) {
  if (step.kind === "choice") {
    return (
      <Field label={step.label} hint={step.hint} error={error}>
        <div className="row gap-2 wrap">
          {step.choices.map((c) => (
            <button
              key={String(c.value)}
              type="button"
              className={`chip ${value === c.value ? "active" : ""}`}
              style={{ height: 38 }}
              onClick={() => onChange(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </Field>
    );
  }

  if (step.kind === "select") {
    const options = step.options(ctx);
    return (
      <Field label={step.label} hint={step.hint} required={!step.optional} error={error}>
        {options.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {step.emptyNote ?? "Nothing to choose yet."}
          </span>
        ) : (
          <Select
            value={String(value ?? "")}
            onValueChange={onChange}
            ariaLabel={step.label}
            options={options}
          />
        )}
      </Field>
    );
  }

  if (step.kind === "multiselect") {
    const options = step.options(ctx);
    const chosen = new Set(
      String(value ?? "")
        .split(",")
        .filter(Boolean),
    );
    const toggle = (v: string) => {
      const nextSet = new Set(chosen);
      if (nextSet.has(v)) nextSet.delete(v);
      else nextSet.add(v);
      // Preserve option order in the stored comma list.
      onChange(
        options
          .map((o) => o.value)
          .filter((x) => nextSet.has(x))
          .join(","),
      );
    };
    return (
      <Field label={step.label} hint={step.hint} required={!step.optional} error={error}>
        {options.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {step.emptyNote ?? "Nothing to choose yet."}
          </span>
        ) : (
          <div className="col gap-1">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`chip ${chosen.has(o.value) ? "active" : ""}`}
                style={{ justifyContent: "flex-start", height: 34, textAlign: "left" }}
                onClick={() => toggle(o.value)}
              >
                <Icon name={chosen.has(o.value) ? "check" : "plus"} size={13} /> {o.label}
              </button>
            ))}
          </div>
        )}
      </Field>
    );
  }

  if (step.kind === "info") {
    return (
      <Field label={step.label}>
        <span className="muted" style={{ fontSize: 13 }}>
          {step.text(ctx)}
        </span>
      </Field>
    );
  }

  if (step.kind === "list") {
    const rows = parseListRows(value);
    const setRows = (next: Record<string, string>[]) => onChange(JSON.stringify(next));
    const updateRow = (i: number, key: string, v: string) =>
      setRows(rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
    const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));
    const addRow = () => {
      const blank: Record<string, string> = {};
      for (const f of step.fields) blank[f.key] = f.default ? f.default(ctx) : "";
      setRows([...rows, blank]);
    };
    const atMax = step.max !== undefined && rows.length >= step.max;
    return (
      <Field label={step.label} hint={step.hint} error={error}>
        <div className="col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="row gap-2" style={{ alignItems: "flex-end" }}>
              {step.fields.map((f) => (
                <div key={f.key} className="col gap-1" style={{ flex: 1, minWidth: 0 }}>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {f.label}
                  </span>
                  {f.kind === "select" ? (
                    <Select
                      value={row[f.key] ?? ""}
                      onValueChange={(v) => updateRow(i, f.key, v)}
                      ariaLabel={f.label}
                      options={f.options ? f.options(ctx) : []}
                    />
                  ) : (
                    <Input
                      className={f.mono ? "mono" : undefined}
                      value={row[f.key] ?? ""}
                      placeholder={f.placeholder}
                      onChange={(e) => updateRow(i, f.key, e.target.value)}
                    />
                  )}
                </div>
              ))}
              <Btn variant="ghost" size="icon" aria-label="Remove" onClick={() => removeRow(i)}>
                <Icon name="x" size={14} />
              </Btn>
            </div>
          ))}
          <Btn variant="outline" size="sm" icon="plus" disabled={atMax} onClick={addRow}>
            {step.addLabel ?? "+ Add"}
          </Btn>
        </div>
      </Field>
    );
  }

  // text | number
  return (
    <Field label={step.label} hint={step.hint} required={!step.optional} error={error}>
      <Input
        type={step.kind === "number" ? "number" : "text"}
        className={step.mono ? "mono" : undefined}
        value={String(value ?? "")}
        placeholder={step.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
