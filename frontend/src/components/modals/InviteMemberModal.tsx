"use client";

import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Btn, Field, Input, Modal, Select } from "@/components/ui";
import { useInviteMember } from "@/hooks/queries/teams";
import { useProjects } from "@/hooks/queries/projects";

type AssignableRole = "developer" | "viewer";

export interface InviteMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Project-scoped invite flow:
 *   email + role (developer|viewer) + at least one project the caller
 *   owns. The server route /teams enforces the rule that the caller
 *   must be an owner of every selected project.
 */
export function InviteMemberModal({ open, onOpenChange }: InviteMemberModalProps) {
  const invite = useInviteMember();
  const { data: projects } = useProjects();
  const [serverError, setServerError] = useState<string | null>(null);

  // Only show projects where the caller is the owner — only owners
  // can invite into a project.
  const ownedProjects = (projects ?? []).filter((p) => p.myRole === "owner");

  const form = useForm({
    defaultValues: { email: "", role: "developer" as AssignableRole, projectIds: [] as string[] },
    onSubmit: async ({ value }) => {
      setServerError(null);
      if (value.projectIds.length === 0) {
        setServerError("Pick at least one project to invite them to.");
        return;
      }
      try {
        await invite.mutateAsync({
          email: value.email,
          role: value.role,
          projectIds: value.projectIds,
        });
        form.reset();
        onOpenChange(false);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not send invite.");
      }
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Invite team member"
      description="They will receive an email with a link to accept and join the selected projects."
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="send"
            loading={invite.isPending}
            onClick={() => form.handleSubmit()}
          >
            Send invite
          </Btn>
        </>
      }
    >
      <form
        className="col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.Field
          name="email"
          validators={{
            onChange: ({ value }) =>
              !value
                ? "Email is required"
                : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
                  ? "Enter a valid email"
                  : undefined,
          }}
        >
          {(field) => (
            <Field label="Email address" required error={field.state.meta.errors[0]}>
              <Input
                type="email"
                autoComplete="email"
                placeholder="teammate@company.com"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                autoFocus
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="role">
          {(field) => (
            <Field
              label="Role"
              hint={
                field.state.value === "viewer"
                  ? "Can see project state but not change it"
                  : "Can run pipelines, edit settings, and merge approvals"
              }
            >
              <Select
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as AssignableRole)}
                ariaLabel="Role"
                options={[
                  { value: "developer", label: "Developer" },
                  { value: "viewer", label: "Viewer" },
                ]}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="projectIds">
          {(field) => (
            <Field
              label="Projects"
              required
              hint={
                ownedProjects.length === 0
                  ? "You need to own at least one project before you can invite collaborators."
                  : "Pick one or more projects to invite them to."
              }
            >
              {ownedProjects.length === 0 ? (
                <span className="muted" style={{ fontSize: 13 }}>
                  No owned projects yet.
                </span>
              ) : (
                <div className="col gap-1" style={{ maxHeight: 220, overflow: "auto" }}>
                  {ownedProjects.map((p) => {
                    const checked = field.state.value.includes(p.id);
                    return (
                      <label
                        key={p.id}
                        className="row gap-2"
                        style={{
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid var(--border)",
                          cursor: "pointer",
                          background: checked ? "var(--accent-soft)" : "transparent",
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = checked
                              ? field.state.value.filter((id) => id !== p.id)
                              : [...field.state.value, p.id];
                            field.handleChange(next);
                          }}
                        />
                        <span style={{ fontWeight: 600 }}>{p.name}</span>
                        <span className="faint mono" style={{ fontSize: 11 }}>
                          {p.slug}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </Field>
          )}
        </form.Field>

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
