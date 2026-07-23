"use client";

import { useEffect, useState } from "react";
import { Btn, Field, Modal, Select, type SelectOption } from "@/components/ui";
import { useProjectRepos } from "@/hooks/queries/project";
import { useRepoWorkflows, useDispatchWorkflow } from "@/hooks/queries/repo-workflows";

export interface RunCiPipelineModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}

type RepoRow = { id: string; fullName: string; name: string };

/**
 * Trigger a GitHub Actions workflow directly. Reads the repo itself (via
 * GitHub's list-workflows API) rather than only pipelines DeepAgent happens
 * to track in the CiPipeline table — so ANY workflow file already present in
 * `.github/workflows/` can be run, including ones generated before this
 * feature existed or authored by hand. No commit happens here; this only
 * fires workflow_dispatch on the workflow you pick.
 */
export function RunCiPipelineModal({ open, onOpenChange, projectSlug }: RunCiPipelineModalProps) {
  const { data: repos, isLoading: reposLoading } = useProjectRepos(projectSlug);
  const [repoId, setRepoId] = useState("");
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    runUrl?: string | null;
    message?: string;
  } | null>(null);

  const { data: wf, isLoading: workflowsLoading } = useRepoWorkflows(projectSlug, repoId || null);
  const dispatch = useDispatchWorkflow(projectSlug, repoId || null);

  const repoRows = (repos ?? []) as unknown as RepoRow[];

  // Reset on open, and auto-pick when there's only one option — the common case.
  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setSuccessInfo(null);
    setWorkflowId(null);
    if (repoRows.length === 1) setRepoId(repoRows[0].id);
    else setRepoId("");
    // Only react to `open` toggling — repoRows changes shouldn't reset a pick mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (wf?.workflows.length === 1) setWorkflowId(wf.workflows[0].id);
  }, [wf]);

  function close() {
    setSuccessInfo(null);
    setServerError(null);
    setRepoId("");
    setWorkflowId(null);
    onOpenChange(false);
  }

  const repoOptions: SelectOption[] = repoRows.map((r) => ({
    value: r.id,
    label: r.fullName || r.name,
  }));
  const workflowOptions: SelectOption[] = (wf?.workflows ?? []).map((w) => ({
    value: String(w.id),
    label: w.name,
  }));

  const hasRepos = !reposLoading && repoRows.length > 0;
  const hasWorkflows = !!repoId && !workflowsLoading && (wf?.workflows.length ?? 0) > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title="Run pipeline"
      description="Triggers the GitHub Actions workflow you pick — reads directly from the repo, so any workflow file already there shows up, not just ones generated here."
      footer={
        successInfo ? (
          <>
            <Btn variant="ghost" onClick={close}>
              Close
            </Btn>
            {successInfo.runUrl && (
              <a
                className="btn primary"
                href={successInfo.runUrl}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "none" }}
              >
                Open on GitHub
              </a>
            )}
          </>
        ) : (
          <>
            <Btn variant="ghost" onClick={close}>
              Cancel
            </Btn>
            {hasWorkflows && (
              <Btn
                variant="primary"
                icon="play"
                loading={dispatch.isPending}
                disabled={!workflowId}
                onClick={() => {
                  setServerError(null);
                  if (workflowId == null) return;
                  dispatch.mutate(workflowId, {
                    onSuccess: (res) => setSuccessInfo(res),
                    onError: (e) =>
                      setServerError(e instanceof Error ? e.message : "Could not trigger the workflow."),
                  });
                }}
              >
                Run
              </Btn>
            )}
          </>
        )
      }
    >
      {successInfo ? (
        <div className="col gap-3">
          <div
            className="row gap-2"
            style={{
              padding: 12,
              background: "var(--ok-soft)",
              color: "var(--ok)",
              borderRadius: 10,
              fontSize: 13,
            }}
          >
            <strong>{successInfo.message ?? "Workflow triggered."}</strong>
          </div>
        </div>
      ) : reposLoading ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Loading repos…
        </p>
      ) : !hasRepos ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No repos attached to this project yet. Attach one from the Repositories tab first.
        </p>
      ) : (
        <div className="col gap-4">
          {repoRows.length > 1 && (
            <Field label="Repository" required>
              <Select
                options={repoOptions}
                value={repoId}
                onValueChange={(v) => {
                  setRepoId(v);
                  setWorkflowId(null);
                }}
                ariaLabel="Repository"
                placeholder="Pick a repo…"
              />
            </Field>
          )}

          {repoId &&
            (workflowsLoading ? (
              <p className="muted" style={{ fontSize: 13 }}>
                Looking for workflows in this repo…
              </p>
            ) : !hasWorkflows ? (
              <p className="muted" style={{ fontSize: 13 }}>
                No workflow files found in this repo yet. Ask Deep Agent in Chat to set up CI/CD (or
                "deploy my app") — once it commits a workflow, it'll show up here to run.
              </p>
            ) : (
              <Field label="Workflow" required>
                <Select
                  options={workflowOptions}
                  value={workflowId != null ? String(workflowId) : ""}
                  onValueChange={(v) => setWorkflowId(Number(v))}
                  ariaLabel="Workflow"
                  placeholder="Pick a workflow…"
                />
              </Field>
            ))}
        </div>
      )}

      {serverError && (
        <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
          {serverError}
        </p>
      )}
    </Modal>
  );
}
