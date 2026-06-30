"use client";

import { useEffect, useState } from "react";
import { Btn, Field, Input, Modal, Select } from "@/components/ui";
import { useInviteToProject } from "@/hooks/queries/project";

export interface InviteToProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  projectName: string;
}

/**
 * Single-project invite. Hits POST /projects/[slug]/invitations, which emails
 * the invitee an /auth/invite?token=… link. Pre-existing pending invite for
 * the same email is refreshed (idempotent server-side).
 */
export function InviteToProjectModal({
  open,
  onOpenChange,
  slug,
  projectName,
}: InviteToProjectModalProps) {
  const invite = useInviteToProject(slug);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"developer" | "viewer">("developer");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setEmail("");
      setRole("developer");
      setError(null);
    }
  }, [open]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function submit() {
    if (!emailOk) {
      setError("Enter a valid email.");
      return;
    }
    setError(null);
    try {
      await invite.mutateAsync({ email: email.trim().toLowerCase(), role });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send invite.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Invite to ${projectName}`}
      description="They'll get an email with a link to accept. The link expires in 7 days."
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={invite.isPending}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="send"
            loading={invite.isPending}
            disabled={!emailOk}
            onClick={submit}
          >
            Send invite
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <Field label="Email address" required>
          <Input
            type="email"
            autoComplete="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Role"
          hint={
            role === "viewer"
              ? "Read-only access to project state."
              : "Can run pipelines, edit settings and act on approvals."
          }
        >
          <Select
            value={role}
            onValueChange={(v) => setRole(v as "developer" | "viewer")}
            ariaLabel="Role"
            options={[
              { value: "developer", label: "Developer" },
              { value: "viewer", label: "Viewer" },
            ]}
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
