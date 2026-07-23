"use client";

/**
 * CI/CD Pipelines panel — the saved pipelines the agent generated in chat.
 * Each pipeline's script is editable here; "Run pipeline" commits it to the
 * repo's default branch and triggers the GitHub Actions run, which is then
 * mirrored live (stages/steps/errors). The "Agent reviewer" toggle lets the
 * agent auto-fix and re-run a failed pipeline.
 */
import { useEffect, useState } from "react";
import { Badge, Block, Btn, Icon, Textarea, Toggle, type BadgeTone } from "@/components/ui";
import {
  useCiPipelines,
  useCiPipeline,
  useUpdateCiPipeline,
  useRunCiPipeline,
  useDeleteCiPipeline,
  useCiPipelineStatus,
  type CiFile,
} from "@/hooks/queries/ci-pipelines";

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "default",
  committed: "default",
  committing: "info",
  running: "info",
  success: "accent",
  failed: "danger",
  error: "danger",
};

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "default"}>{status}</Badge>;
}

export function CiPipelinesPanel({ slug }: { slug: string }) {
  const { data: pipelines, isLoading } = useCiPipelines(slug);
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Block>
        <Block.Header>
          <Block.Title>CI/CD Pipelines</Block.Title>
        </Block.Header>
        <Block.Loading />
      </Block>
    );
  }
  if (!pipelines || pipelines.length === 0) {
    return (
      <Block>
        <Block.Header>
          <Block.Title>CI/CD Pipelines</Block.Title>
        </Block.Header>
        <Block.Empty
          icon="cicd"
          title="No saved pipelines yet"
          description="Ask Deep Agent in Chat to set up CI/CD for a repo. When you're happy, it saves the pipeline here — then you edit the script and click Run."
        />
      </Block>
    );
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Generated in chat. Edit the script, then Run to commit + trigger on GitHub.">
          CI/CD Pipelines
        </Block.Title>
      </Block.Header>
      <div className="col" style={{ gap: 0 }}>
        {pipelines.map((p) => (
          <PipelineRow
            key={p.id}
            slug={slug}
            id={p.id}
            name={p.name}
            repoFullName={p.repoFullName}
            branch={p.branch}
            status={p.status}
            agentReview={p.agentReview}
            open={openId === p.id}
            onToggle={() => setOpenId(openId === p.id ? null : p.id)}
          />
        ))}
      </div>
    </Block>
  );
}

function PipelineRow(props: {
  slug: string;
  id: string;
  name: string;
  repoFullName: string;
  branch: string;
  status: string;
  agentReview: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { slug, id, open } = props;
  const detail = useCiPipeline(slug, open ? id : null);
  const update = useUpdateCiPipeline(slug, id);
  const run = useRunCiPipeline(slug, id);
  const del = useDeleteCiPipeline(slug);

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<CiFile[] | null>(null);
  const [dirty, setDirty] = useState(false);

  // Load files into editable draft when detail arrives.
  useEffect(() => {
    if (detail.data && draft === null) {
      setDraft(detail.data.files);
      setActiveFile(detail.data.workflowPath ?? detail.data.files[0]?.path ?? null);
    }
  }, [detail.data, draft]);

  const liveStatuses = ["committing", "running"];
  const status = useCiPipelineStatus(slug, open ? id : null, false);
  // Poll while running / committing / healing.
  const isLive =
    !!status.data && (liveStatuses.includes(status.data.status) || status.data.healing);
  const statusLive = useCiPipelineStatus(slug, open ? id : null, isLive);
  const st = statusLive.data ?? status.data;

  const currentFile = draft?.find((f) => f.path === activeFile) ?? null;

  function editFile(content: string) {
    if (!draft || !activeFile) return;
    setDraft(draft.map((f) => (f.path === activeFile ? { ...f, content } : f)));
    setDirty(true);
  }
  async function save() {
    if (!draft) return;
    await update.mutateAsync({ files: draft });
    setDirty(false);
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      {/* Header row */}
      <div className="row between gap-3" style={{ padding: "12px 16px", alignItems: "center" }}>
        <button
          type="button"
          className="row gap-2"
          onClick={props.onToggle}
          style={{
            background: "none",
            border: 0,
            cursor: "pointer",
            textAlign: "left",
            flex: 1,
            minWidth: 0,
          }}
        >
          <Icon name={open ? "chevUD" : "chevR"} />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>{props.name}</span>
            <span className="faint" style={{ fontSize: 12 }}>
              {props.repoFullName} · {props.branch ?? "main"}
            </span>
          </div>
        </button>
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <StatusBadge status={st?.status ?? props.status} />
          <Btn
            size="sm"
            variant="primary"
            icon="play"
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            Run
          </Btn>
        </div>
      </div>

      {open && (
        <div className="col gap-3" style={{ padding: "0 16px 16px 40px" }}>
          {run.isError && (
            <div className="faint" style={{ color: "var(--danger)", fontSize: 12 }}>
              {(run.error as Error).message}
            </div>
          )}

          {/* Agent reviewer toggle */}
          <label className="row gap-2" style={{ alignItems: "center", cursor: "pointer" }}>
            <Toggle
              checked={detail.data?.agentReview ?? props.agentReview}
              onCheckedChange={(v) => update.mutate({ agentReview: v })}
            />
            <span style={{ fontSize: 13 }}>
              <Icon name="bot" /> Agent reviewer — auto-fix &amp; re-run a failed pipeline
            </span>
          </label>

          {/* Editable script */}
          {detail.isLoading || draft === null ? (
            <div className="faint" style={{ fontSize: 12 }}>
              Loading script…
            </div>
          ) : (
            <div className="col gap-2">
              <div className="row gap-2 wrap">
                {draft.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setActiveFile(f.path)}
                    className="btn sm"
                    style={{
                      fontSize: 11,
                      opacity: activeFile === f.path ? 1 : 0.6,
                      fontFamily: "var(--font-mono, monospace)",
                    }}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              <Textarea
                value={currentFile?.content ?? ""}
                onChange={(e) => editFile(e.target.value)}
                spellCheck={false}
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 12,
                  minHeight: 260,
                  whiteSpace: "pre",
                }}
              />
              <div className="row gap-2">
                <Btn
                  size="sm"
                  variant="outline"
                  icon="check"
                  disabled={!dirty}
                  loading={update.isPending}
                  onClick={save}
                >
                  Save changes
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={() => {
                    if (confirm("Delete this pipeline?")) del.mutate(id);
                  }}
                >
                  Delete
                </Btn>
              </div>
            </div>
          )}

          {/* Live run status */}
          {st && st.status !== "draft" && (
            <div
              className="col gap-2"
              style={{ borderTop: "1px dashed var(--border)", paddingTop: 12 }}
            >
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Run status</span>
                <StatusBadge status={st.status} />
                {st.healing && (
                  <Badge tone="info">
                    <Icon name="bot" /> agent reviewing…
                  </Badge>
                )}
                {st.runUrl && (
                  <a
                    href={st.runUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="row gap-1"
                    style={{ fontSize: 12 }}
                  >
                    Open on GitHub <Icon name="ext" />
                  </a>
                )}
              </div>
              {st.healNote && (
                <div className="faint" style={{ fontSize: 12 }}>
                  {st.healNote}
                </div>
              )}
              {st.lastError && (
                <div style={{ color: "var(--danger)", fontSize: 12 }}>{st.lastError}</div>
              )}
              {st.agentReview && (
                <div className="faint" style={{ fontSize: 11 }}>
                  Agent reviewer attempts: {st.healAttempts}/{st.maxHealAttempts}
                </div>
              )}
              <div className="col" style={{ gap: 4 }}>
                {(st.stages ?? []).map((stage) => (
                  <div key={stage.name} className="col" style={{ gap: 2 }}>
                    <div
                      className="row gap-2"
                      style={{ alignItems: "center", fontSize: 12, fontWeight: 600 }}
                    >
                      <StepDot status={stage.status} conclusion={stage.conclusion} />
                      {stage.name}
                    </div>
                    <div className="col" style={{ gap: 1, paddingLeft: 18 }}>
                      {stage.steps.map((s, i) => (
                        <div
                          key={i}
                          className="row gap-2"
                          style={{ alignItems: "center", fontSize: 11.5 }}
                        >
                          <StepDot status={s.status} conclusion={s.conclusion} />
                          <span className="faint">{s.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepDot({ status, conclusion }: { status: string; conclusion: string | null }) {
  const color =
    conclusion === "success"
      ? "var(--ok, #22c55e)"
      : conclusion === "failure"
        ? "var(--danger, #ef4444)"
        : conclusion === "skipped"
          ? "var(--border)"
          : status === "in_progress"
            ? "var(--accent, #8b5cf6)"
            : "var(--muted, #888)";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}
