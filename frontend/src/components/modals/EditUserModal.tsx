"use client";

/**
 * Admin-side "Edit user" modal — the counterpart to CreateUserModal.
 *
 * Reuses the same access-tier + per-project capability picker so the mental
 * model matches: what the admin ticked when creating a user is exactly what
 * they see and can toggle here.
 *
 * Flow: click Edit in the users table → GET /admin/users/[id] fills the
 * form → admin toggles what they want → Save fires PATCH with only the
 * changed fields. The route accepts partial updates so untouched fields
 * (like the password) stay as they were.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Btn, Field, Input, Modal } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import {
  ProjectMembershipPicker,
  type GlobalAccess,
  type Project,
  type ProjectMembership,
} from "./CreateUserModal";

type UserDetail = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  isSuperAdmin: boolean;
  globalAccess: GlobalAccess;
  memberships: ProjectMembership[];
};

type DetailResp =
  | { ok: true; user: UserDetail }
  | { ok: false; code?: string; message?: string };

type PatchResp = { ok: true } | { ok: false; code?: string; message?: string };

/**
 * Web-safe random password — same generator as CreateUserModal. Copy-paste
 * rather than an import so this file stays self-contained (the create modal
 * is closed-source stable and I don't want to bind the two together on this
 * detail).
 */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function EditUserModal({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Only id/name/email are needed to open — the modal fetches the full detail on open. */
  user: { id: string; name: string; email: string } | null;
}) {
  const qc = useQueryClient();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  // Kept in state so we can PATCH it back untouched — the Access dropdown UI
  // was removed on request, so this only ever changes via the server-fetched
  // user detail. Admin-tier users still exist (bootstrap), we just don't let
  // this modal alter that here.
  const [globalAccess, setGlobalAccess] = useState<GlobalAccess>("none");
  const [memberships, setMemberships] = useState<ProjectMembership[]>([]);
  const [resetPw, setResetPw] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showPw, setShowPw] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);

  // Fetch the user's current state whenever the modal opens with a new user.
  // staleTime 0 + explicit removeQueries on open (below) guarantees a fresh
  // GET every time — the cached "the user was a developer" response from
  // before a save must not be reused.
  const detailQ = useQuery<DetailResp>({
    queryKey: ["admin", "user-detail", user?.id],
    queryFn: () => api.get<DetailResp>(`/admin/users/${user!.id}`),
    enabled: open && !!user?.id,
    staleTime: 0,
    gcTime: 0,
  });

  // Every time the modal opens (or user target switches), wipe the query
  // cache for this user AND blank the form. Two problems this closes:
  //   1. React Query keeps referentially-equal data across refetches when
  //      values didn't change — but the SAVE path DID change values, and
  //      leaving the old array in place meant the useEffect below (keyed
  //      on detailQ.data identity) would sometimes not re-fire and the
  //      picker would keep showing the pre-save role.
  //   2. If the admin clicks Edit on user A, cancels, then clicks Edit on
  //      user B, the form state from A must not bleed into B before B's
  //      GET returns. Blanking prevents that flash of wrong data.
  useEffect(() => {
    if (!open || !user?.id) return;
    qc.removeQueries({ queryKey: ["admin", "user-detail", user.id] });
    setFirstName("");
    setLastName("");
    setGlobalAccess("none");
    setMemberships([]);
    setResetPw(false);
    setNewPassword("");
    setError(null);
    setSavedBanner(null);
  }, [open, user?.id, qc]);

  const projectsQ = useQuery<{ projects: Project[] }>({
    queryKey: ["admin", "all-projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
    enabled: open,
    staleTime: 60_000,
  });
  const projects = projectsQ.data?.projects ?? [];

  // Hydrate form state from the fetched detail. useEffect key on the response
  // identity so refetching seeds the form, but local edits after that aren't
  // clobbered by another render pass.
  useEffect(() => {
    if (detailQ.data && detailQ.data.ok) {
      const u = detailQ.data.user;
      setFirstName(u.firstName);
      setLastName(u.lastName);
      setGlobalAccess(u.globalAccess);
      setMemberships(u.memberships);
      setResetPw(false);
      setNewPassword("");
      setError(null);
      setSavedBanner(null);
    }
  }, [detailQ.data]);

  const canSubmit = useMemo(() => {
    if (firstName.trim().length === 0 || lastName.trim().length === 0) return false;
    if (resetPw && newPassword.length < 8) return false;
    return true;
  }, [firstName, lastName, resetPw, newPassword]);

  const save = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("no user selected");
      const payload: Record<string, unknown> = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        // globalAccess/isSuperAdmin are round-tripped unchanged — the UI to
        // edit them lives elsewhere (or nowhere yet). memberships is a
        // wholesale replace — anything omitted from this list is removed.
        globalAccess,
        memberships,
      };
      if (resetPw) payload.newPassword = newPassword;
      const res = await api.patch<PatchResp>(`/admin/users/${user.id}`, payload);
      if (!res.ok) {
        throw new Error(res.message ?? res.code ?? "Could not save changes.");
      }
    },
    onSuccess: () => {
      setSavedBanner(
        resetPw
          ? "Saved. Copy the new password below — it won't be shown again."
          : "Saved.",
      );
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "user-detail", user?.id] });
    },
    onError: (e) => setError(apiErrorMessage(e, "Could not save changes.")),
  });

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setError(null);
      setSavedBanner(null);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title={user ? `Edit ${user.name || user.email}` : "Edit user"}
      description="Rename, retire admin rights, adjust per-project access, or issue a fresh password."
      width={520}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={() => close(false)}>
            {savedBanner ? "Close" : "Cancel"}
          </Btn>
          {!savedBanner && (
            <Btn
              variant="primary"
              loading={save.isPending}
              disabled={!canSubmit || detailQ.isLoading}
              onClick={() => {
                setError(null);
                save.mutate();
              }}
            >
              Save changes
            </Btn>
          )}
        </div>
      }
    >
      {detailQ.isLoading ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>Loading user…</p>
      ) : detailQ.data && !detailQ.data.ok ? (
        <p style={{ margin: 0, color: "var(--danger)", fontSize: 13 }}>
          Couldn&apos;t load this user — {detailQ.data.code ?? "unknown error"}.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {savedBanner && (
            <p style={{ margin: 0, color: "var(--ok, #2c7a3f)", fontSize: 13 }}>{savedBanner}</p>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="First name" required>
              <Input
                autoFocus
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label="Last name" required>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
          </div>

          <Field label="Email">
            <Input type="email" value={user?.email ?? ""} disabled readOnly />
          </Field>

          <Field
            label="Projects"
            hint="Tick the projects this user can reach and what they can do in each."
          >
            <ProjectMembershipPicker
              projects={projects}
              memberships={memberships}
              onChange={setMemberships}
              loading={projectsQ.isLoading}
            />
          </Field>

          <Field
            label="Password"
            hint="Only rotate if the user has lost access; otherwise they change it themselves after signing in."
          >
            {!resetPw ? (
              <Btn
                variant="outline"
                size="sm"
                onClick={() => {
                  setResetPw(true);
                  setNewPassword(generatePassword());
                }}
              >
                Reset password
              </Btn>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <Input
                  type={showPw ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={{ flex: 1 }}
                />
                <Btn variant="outline" size="sm" onClick={() => setShowPw((s) => !s)}>
                  {showPw ? "Hide" : "Show"}
                </Btn>
                <Btn
                  variant="outline"
                  size="sm"
                  onClick={() => setNewPassword(generatePassword())}
                >
                  Regenerate
                </Btn>
                <Btn
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setResetPw(false);
                    setNewPassword("");
                  }}
                >
                  Cancel
                </Btn>
              </div>
            )}
          </Field>

          {error && <p style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>{error}</p>}
        </div>
      )}
    </Modal>
  );
}
