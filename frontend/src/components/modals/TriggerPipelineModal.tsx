"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Input, Modal, Select, type SelectOption } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface TriggerPipelineModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  /**
   * Preselect the env key when the modal opens. Useful when a "Deploy now"
   * button on another page navigates here with a specific env in mind.
   */
  initialEnvKey?: string | null;
}

type EnvRow = {
  id: string;
  key: string;
  name: string;
  isProduction: boolean;
};

type ProjectRepoRow = {
  id: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
};

type TriggerResponse = {
  ok: boolean;
  pipeline?: { id: string; branch: string; sha: string; status: string };
  approval?: { id: string; status: string } | null;
  requiresApproval?: boolean;
  message?: string;
  code?: string;
};

/**
 * Manually trigger a deployment pipeline. The user picks an env + repo +
 * branch; the server creates the Pipeline + 5 stages and (if the env requires
 * approval) an Approval row that the pipeline waits on.
 */
export function TriggerPipelineModal({
  open,
  onOpenChange,
  projectSlug,
  initialEnvKey,
}: TriggerPipelineModalProps) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<TriggerResponse | null>(null);

  const envsQuery = useQuery<EnvRow[]>({
    queryKey: ["p", projectSlug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${projectSlug}/envs`),
    enabled: open,
    staleTime: 30_000,
  });
  const reposQuery = useQuery<ProjectRepoRow[]>({
    queryKey: ["p", projectSlug, "repos"],
    queryFn: () => api.get<ProjectRepoRow[]>(`/projects/${projectSlug}/repos`),
    enabled: open,
    staleTime: 30_000,
  });

  const envOptions: SelectOption[] = (envsQuery.data ?? []).map((e) => ({
    value: e.key,
    label: e.isProduction ? `${e.name} (prod)` : e.name,
  }));
  const repoOptions: SelectOption[] = (reposQuery.data ?? []).map((r) => ({
    value: r.id,
    label: r.fullName ?? r.name,
  }));

  const trigger = useMutation({
    mutationFn: async (body: { envKey: string; repoId: string; branch: string; sha?: string }) => {
      const res = await api.post<TriggerResponse>(`/projects/${projectSlug}/pipelines`, body);
      if (!res.ok || !res.pipeline) {
        throw new Error(res.message ?? res.code ?? "Could not trigger pipeline.");
      }
      return res;
    },
    onSuccess: async () => {
      // Invalidate everything the project workspace might be displaying.
      await qc.invalidateQueries({ queryKey: ["p", projectSlug] });
    },
  });

  const form = useForm({
    defaultValues: { envKey: initialEnvKey ?? "", repoId: "", branch: "main", sha: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      setSuccessInfo(null);
      if (!value.envKey) {
        setServerError("Pick an environment.");
        return;
      }
      if (!value.repoId) {
        setServerError("Pick a repository.");
        return;
      }
      try {
        const result = await trigger.mutateAsync({
          envKey: value.envKey,
          repoId: value.repoId,
          branch: value.branch.trim() || "main",
          sha: value.sha.trim() || undefined,
        });
        setSuccessInfo(result);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not trigger pipeline.");
      }
    },
  });

  // When the modal opens (or initialEnvKey changes while open), preselect
  // the env. Supports the "Deploy now" flow from /environments where the
  // page navigates to /cicd?env=alpha&trigger=1.
  useEffect(() => {
    if (open && initialEnvKey) {
      form.setFieldValue("envKey", initialEnvKey);
    }
    // setFieldValue is stable; rerun whenever open OR initialEnvKey changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialEnvKey]);

  function close() {
    setSuccessInfo(null);
    setServerError(null);
    form.reset();
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
        else onOpenChange(true);
      }}
      title="Trigger deployment"
      description="Start a CI/CD run for a repo + branch on an environment."
      footer={
        successInfo ? (
          <>
            <Btn variant="ghost" onClick={close}>
              Close
            </Btn>
            {successInfo.approval ? (
              <a
                className="btn primary"
                href={`/p/${projectSlug}/approvals`}
                style={{ textDecoration: "none" }}
              >
                Go to approvals
              </a>
            ) : (
              <a
                className="btn primary"
                href={`/p/${projectSlug}/cicd`}
                style={{ textDecoration: "none" }}
              >
                Open pipeline
              </a>
            )}
          </>
        ) : (
          <>
            <Btn variant="ghost" onClick={close}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              icon="play"
              loading={trigger.isPending}
              onClick={() => form.handleSubmit()}
            >
              Trigger
            </Btn>
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
              background: successInfo.requiresApproval ? "var(--warn-soft)" : "var(--ok-soft)",
              color: successInfo.requiresApproval ? "var(--warn)" : "var(--ok)",
              borderRadius: 10,
              fontSize: 13,
            }}
          >
            <strong>
              {successInfo.requiresApproval
                ? "Pipeline running — waiting for approval"
                : "Pipeline started"}
            </strong>
          </div>
          <div className="col gap-1" style={{ fontSize: 13 }}>
            <span>
              <b>Pipeline:</b> <span className="mono">{successInfo.pipeline?.id.slice(0, 8)}</span>
            </span>
            <span>
              <b>Branch:</b> {successInfo.pipeline?.branch}
            </span>
            <span>
              <b>SHA:</b> <span className="mono">{successInfo.pipeline?.sha.slice(0, 7)}</span>
            </span>
            <span>
              <b>Status:</b> {successInfo.pipeline?.status}
            </span>
            {successInfo.approval && (
              <span>
                <b>Approval:</b> <span className="mono">{successInfo.approval.id.slice(0, 8)}</span>{" "}
                · pending
              </span>
            )}
          </div>
        </div>
      ) : (
        <form
          className="col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <form.Field name="envKey">
            {(field) => (
              <Field
                label="Environment"
                required
                hint={
                  envsQuery.isLoading
                    ? "Loading…"
                    : envOptions.length === 0
                      ? "No envs in this project yet. Create one on the Environments tab first."
                      : "Production envs trigger an approval automatically."
                }
              >
                <Select
                  options={envOptions}
                  value={field.state.value}
                  onValueChange={field.handleChange}
                  ariaLabel="Environment"
                  placeholder="Pick an env…"
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="repoId">
            {(field) => (
              <Field
                label="Repository"
                required
                hint={
                  reposQuery.isLoading
                    ? "Loading…"
                    : repoOptions.length === 0
                      ? "No repos attached yet. Attach one on the CI/CD tab first."
                      : undefined
                }
              >
                <Select
                  options={repoOptions}
                  value={field.state.value}
                  onValueChange={field.handleChange}
                  ariaLabel="Repository"
                  placeholder="Pick a repo…"
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="branch">
            {(field) => (
              <Field label="Branch" required>
                <Input
                  className="mono"
                  placeholder="main"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="sha">
            {(field) => (
              <Field
                label="Commit SHA"
                hint="Optional — defaults to a fresh ref captured from HEAD."
              >
                <Input
                  className="mono"
                  placeholder="a1b2c3d…"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>

          {serverError && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {serverError}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
