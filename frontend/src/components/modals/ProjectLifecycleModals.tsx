"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Btn, Field, Input, Modal } from "@/components/ui";
import {
  useArchiveProject,
  useDeleteProject,
  useTransferProject,
  useUnarchiveProject,
} from "@/hooks/queries/project";

/* ─────────────── Archive ─────────────── */

export function ArchiveProjectModal({
  open,
  onOpenChange,
  slug,
  projectName,
  archived,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  projectName: string;
  archived: boolean;
}) {
  const archive = useArchiveProject(slug);
  const unarchive = useUnarchiveProject(slug);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const busy = archive.isPending || unarchive.isPending;

  async function submit() {
    setError(null);
    try {
      if (archived) await unarchive.mutateAsync();
      else await archive.mutateAsync();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={archived ? `Unarchive ${projectName}?` : `Archive ${projectName}?`}
      description={
        archived
          ? "Re-enable agents, pipelines and writes on this project."
          : "Archived projects become read-only. Agents pause; cron stops. Reversible at any time."
      }
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon={archived ? "check" : "shield"}
            loading={busy}
            onClick={submit}
          >
            {archived ? "Unarchive" : "Archive project"}
          </Btn>
        </>
      }
    >
      <p style={{ fontSize: 13, lineHeight: 1.5 }}>
        {archived ? (
          <>
            <b>{projectName}</b> will become writable again, and any auto-deploy
            wiring will resume on the next push.
          </>
        ) : (
          <>
            While archived, members can still <i>view</i> the project, but no new
            pipelines, deployments or agent runs will start. Existing audit
            history is kept intact.
          </>
        )}
      </p>
      {error && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--danger)" }} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

/* ─────────────── Transfer ownership ─────────────── */

export function TransferProjectModal({
  open,
  onOpenChange,
  slug,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  projectName: string;
}) {
  const router = useRouter();
  const transfer = useTransferProject(slug);
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setEmail("");
      setConfirm("");
      setError(null);
      setDoneFor(null);
    }
  }, [open]);

  const canSubmit = email.includes("@") && confirm === slug;

  async function submit() {
    setError(null);
    try {
      const res = await transfer.mutateAsync({
        newOwnerEmail: email.trim(),
        confirmSlug: confirm.trim(),
      });
      setDoneFor(res.newOwner?.name ?? email);
      // The current user is now a developer — refresh server components.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not transfer project.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Transfer ${projectName}`}
      description="Hand ownership to another DeepAgent user. You become a developer on this project."
      width={560}
      footer={
        doneFor ? (
          <Btn variant="primary" icon="check" onClick={() => onOpenChange(false)}>
            Done
          </Btn>
        ) : (
          <>
            <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={transfer.isPending}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              icon="users"
              loading={transfer.isPending}
              disabled={!canSubmit}
              onClick={submit}
            >
              Transfer ownership
            </Btn>
          </>
        )
      }
    >
      {doneFor ? (
        <div className="col gap-3" style={{ fontSize: 13.5 }}>
          <p style={{ color: "var(--ok)" }}>
            Ownership transferred to <b>{doneFor}</b>.
          </p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            You&apos;ve been demoted to <b>developer</b> on this project. You can
            still push, deploy and review approvals — only owner-level lifecycle
            actions are gone.
          </p>
        </div>
      ) : (
        <div className="col gap-4">
          <Field
            label="New owner email"
            required
            hint="Must be the email of an existing DeepAgent account."
          >
            <Input
              type="email"
              placeholder="teammate@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </Field>
          <Field
            label="Type the project slug to confirm"
            required
            hint={`Expected: ${slug}`}
          >
            <Input
              className="mono"
              placeholder={slug}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          {error && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ─────────────── Delete ─────────────── */

export function DeleteProjectModal({
  open,
  onOpenChange,
  slug,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  projectName: string;
}) {
  const router = useRouter();
  const remove = useDeleteProject(slug);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirm("");
      setError(null);
    }
  }, [open]);

  const canSubmit = confirm === slug;

  async function submit() {
    setError(null);
    try {
      await remove.mutateAsync();
      onOpenChange(false);
      router.push("/u/dashboard");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete project.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${projectName}`}
      description="Soft-deletes the project. Audit history is kept; the project disappears from listings."
      width={560}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="trash"
            loading={remove.isPending}
            disabled={!canSubmit}
            onClick={submit}
            style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
          >
            Delete project
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <p style={{ fontSize: 13, color: "var(--danger)", lineHeight: 1.5 }}>
          This stops every agent, pauses every pipeline, and removes <b>{projectName}</b>{" "}
          from listings for all members. Snapshot and audit history are retained for
          recovery and forensics.
        </p>
        <Field
          label="Type the project slug to confirm"
          required
          hint={`Expected: ${slug}`}
        >
          <Input
            className="mono"
            placeholder={slug}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoFocus
          />
        </Field>
        {error && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
