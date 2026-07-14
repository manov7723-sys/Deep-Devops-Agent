"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Btn, Field, Input, Modal } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

export interface DeleteProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { slug: string; name: string } | null;
}

/**
 * Type-the-name-to-confirm project delete (AWS-console style). Only enabled once
 * the typed name matches exactly. Soft-deletes via DELETE /projects/[slug].
 */
export function DeleteProjectModal({ open, onOpenChange, project }: DeleteProjectModalProps) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const name = project?.name ?? "";
  const match = confirm.trim() === name && name.length > 0;

  function close(o: boolean) {
    if (!o) {
      setConfirm("");
      setErr(null);
    }
    onOpenChange(o);
  }

  const del = useMutation({
    mutationFn: () => api.del(`/projects/${project!.slug}`),
    onMutate: () => setErr(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      close(false);
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Delete project"
      description={project ? `Permanently remove "${name}" from your workspace.` : ""}
      footer={
        <div className="row between" style={{ gap: 8 }}>
          <Btn variant="ghost" onClick={() => close(false)} disabled={del.isPending}>
            Cancel
          </Btn>
          <Btn
            variant="danger"
            icon="trash"
            disabled={!match || del.isPending}
            loading={del.isPending}
            onClick={() => del.mutate()}
          >
            Delete project
          </Btn>
        </div>
      }
    >
      {project && (
        <div className="col gap-3">
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: "10px 12px",
              borderRadius: 8,
              background: "var(--danger-soft)",
              color: "var(--danger)",
              border: "1px solid var(--danger)",
            }}
          >
            ⚠️ This removes the project and its settings, environments, deployments, alerts and
            history from your workspace. Connected clusters and cloud accounts are <b>not</b>{" "}
            deleted — only this project. This can’t be easily undone.
          </div>
          <Field label={`Type the project name to confirm`}>
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={name}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && match) del.mutate();
              }}
            />
          </Field>
          <span className="faint" style={{ fontSize: 11.5 }}>
            To confirm, type <b style={{ color: "var(--text)" }}>{name}</b> exactly.
          </span>
          {err && (
            <Badge tone="danger" icon="alert">
              {err}
            </Badge>
          )}
        </div>
      )}
    </Modal>
  );
}
