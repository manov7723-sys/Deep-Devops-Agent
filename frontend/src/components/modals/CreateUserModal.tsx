"use client";

/**
 * Admin-side "New user" modal.
 *
 * The AWS-simple flow you asked for: email + name + password (generatable) +
 * one access-tier pick + optional per-project memberships. Everything goes
 * through POST /admin/users/create in one round-trip; the backend keeps
 * isSuperAdmin and globalAccess in lockstep when the admin tier is chosen.
 *
 * Kept intentionally short — no team pick, no email verification round-trip,
 * no invite link. Admin creates, hands the user their credentials, done.
 * When invitation links are useful (fewer touchpoints), the team-invite flow
 * at /teams/[slug]/invitations already exists.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Btn, Field, Icon, Input, Modal, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Project = { id: string; slug: string; name: string };

type ProjectMembership = {
  projectId: string;
  role: "owner" | "developer" | "viewer";
};

type CreateResp =
  | { ok: true; user: { id: string; email: string; name: string } }
  | { ok: false; code?: string; message?: string };

const ACCESS_OPTIONS = [
  { value: "none", label: "None — only selected projects (default)" },
  { value: "view_all", label: "View all projects (read-only)" },
  { value: "full_all", label: "Full access to all projects" },
  { value: "admin", label: "Admin — can do everything, including create users" },
];

/**
 * Web-safe random password. Crypto.getRandomValues is available in the
 * browser (this file runs in a client component). No node:crypto — that
 * import above is only for the type-comment; the actual call uses the
 * Web Crypto API so we don't drag node polyfills into the bundle.
 */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function CreateUserModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: () => void;
}) {
  const qc = useQueryClient();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(() => generatePassword());
  const [globalAccess, setGlobalAccess] = useState<"none" | "view_all" | "full_all" | "admin">(
    "none",
  );
  const [memberships, setMemberships] = useState<ProjectMembership[]>([]);
  const [showPw, setShowPw] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createdBanner, setCreatedBanner] = useState<string | null>(null);

  // Only meaningful when access = "none" (the "selected projects" case).
  // For the global tiers the user sees everything anyway, so per-project
  // rows here would be redundant.
  const showProjectPicker = globalAccess === "none";

  const projectsQ = useQuery<{ projects: Project[] }>({
    queryKey: ["admin", "all-projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
    enabled: open && showProjectPicker,
    staleTime: 60_000,
  });
  const projects = projectsQ.data?.projects ?? [];

  const canSubmit = useMemo(() => {
    return (
      firstName.trim().length > 0 &&
      lastName.trim().length > 0 &&
      /.+@.+\..+/.test(email) &&
      password.length >= 8
    );
  }, [firstName, lastName, email, password]);

  const submit = useMutation({
    mutationFn: async () => {
      const res = await api.post<CreateResp>("/admin/users/create", {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
        globalAccess,
        isSuperAdmin: globalAccess === "admin",
        memberships: showProjectPicker ? memberships : [],
        preVerified: true,
      });
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not create user.");
      return res.user;
    },
    onSuccess: (user) => {
      // Deliberately does NOT close the modal — the admin needs to copy the
      // password out somewhere before it disappears. Show a banner with the
      // account details and a Copy button.
      setCreatedBanner(
        `Created ${user.email}. Copy the password now — it won't be shown again.`,
      );
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      onCreated?.();
    },
    onError: (e) => setError(apiErrorMessage(e, "Could not create user.")),
  });

  function reset() {
    setFirstName("");
    setLastName("");
    setEmail("");
    setPassword(generatePassword());
    setGlobalAccess("none");
    setMemberships([]);
    setShowPw(true);
    setError(null);
    setCreatedBanner(null);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="New user"
      description="Admin-issued account. The user can sign in immediately with the credentials below."
      width={520}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            {createdBanner ? "Close" : "Cancel"}
          </Btn>
          {!createdBanner && (
            <Btn
              variant="primary"
              loading={submit.isPending}
              disabled={!canSubmit}
              onClick={() => {
                setError(null);
                submit.mutate();
              }}
            >
              Create user
            </Btn>
          )}
        </div>
      }
    >
      {createdBanner ? (
        <div>
          <p style={{ margin: 0, color: "var(--ok, #2c7a3f)" }}>{createdBanner}</p>
          <div
            style={{
              marginTop: 12,
              padding: 10,
              background: "var(--surface-2)",
              borderRadius: 8,
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 13,
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <div style={{ flex: 1 }}>
              <div>email: {email.trim().toLowerCase()}</div>
              <div>password: {password}</div>
            </div>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(
                  `email: ${email.trim().toLowerCase()}\npassword: ${password}`,
                );
              }}
            >
              <Icon name="copy" size={14} /> Copy
            </Btn>
          </div>
          <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
            Share these on a channel you trust — the password is never shown again.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="First name" required>
              <Input
                autoFocus
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Ada"
              />
            </Field>
            <Field label="Last name" required>
              <Input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Lovelace"
              />
            </Field>
          </div>

          <Field label="Email" required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@company.com"
            />
          </Field>

          <Field
            label="Password"
            required
            hint="Auto-generated. Regenerate for a fresh one; the user can change it after first sign-in."
          >
            <div style={{ display: "flex", gap: 6 }}>
              <Input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ flex: 1 }}
              />
              <Btn variant="outline" size="sm" onClick={() => setShowPw((s) => !s)}>
                {showPw ? "Hide" : "Show"}
              </Btn>
              <Btn variant="outline" size="sm" onClick={() => setPassword(generatePassword())}>
                Regenerate
              </Btn>
            </div>
          </Field>

          <Field
            label="Access"
            hint="Choose the broadest access this user needs. Per-project picks below apply only when this is set to None."
          >
            <Select
              value={globalAccess}
              placeholder="Pick access"
              options={ACCESS_OPTIONS}
              onValueChange={(v) => setGlobalAccess(v as typeof globalAccess)}
            />
          </Field>

          {showProjectPicker && (
            <Field
              label="Projects"
              hint="Optional — pick projects this user gets access to and what role they hold in each."
            >
              <ProjectMembershipPicker
                projects={projects}
                memberships={memberships}
                onChange={setMemberships}
                loading={projectsQ.isLoading}
              />
            </Field>
          )}

          {error && <p style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>{error}</p>}
        </div>
      )}
    </Modal>
  );
}

/**
 * Project-access picker, AWS-IAM style.
 *
 * The admin picks ONE role at the top and then checks which projects it
 * applies to — same shape as attaching an IAM policy to a set of resources.
 * Prior version had a per-row role dropdown, which turned selecting five
 * projects into ten clicks; this collapses it to one radio + N checkboxes.
 *
 * A per-project role override is deliberately NOT in the first version. If a
 * particular user genuinely needs "viewer on A, developer on B" the admin can
 * create them at the higher role, then downgrade the outlier from the
 * project's own members page — that's rare enough not to complicate the
 * common case.
 */
const ROLE_OPTIONS: Array<{ value: ProjectMembership["role"]; label: string; hint: string }> = [
  { value: "viewer", label: "View access", hint: "Read-only — dashboards, logs, env viewer" },
  { value: "developer", label: "Full access", hint: "Read + write — everything except transferring ownership" },
  { value: "owner", label: "Owner", hint: "Everything, including deleting the project" },
];

function ProjectMembershipPicker({
  projects,
  memberships,
  onChange,
  loading,
}: {
  projects: Project[];
  memberships: ProjectMembership[];
  onChange: (next: ProjectMembership[]) => void;
  loading: boolean;
}) {
  const [role, setRole] = useState<ProjectMembership["role"]>(
    // Preserve whatever role the existing selections use (if any) so switching
    // "Access" tier off and back on doesn't silently downgrade the picks.
    (memberships[0]?.role ?? "developer") as ProjectMembership["role"],
  );
  const [filter, setFilter] = useState("");

  if (loading) return <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>Loading projects…</p>;
  if (projects.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>
        No projects yet — create some first, then edit this user to add access.
      </p>
    );
  }

  const selected = new Set(memberships.map((m) => m.projectId));
  const visible = filter.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : projects;

  function setRoleForAll(next: ProjectMembership["role"]) {
    setRole(next);
    // Re-stamp the role on every existing pick so the top control stays a
    // single source of truth. If a user WANTS "viewer on A, developer on B"
    // they can flip individual checkboxes off, change the role, and re-check
    // — messy but explicit, and matches how AWS IAM policy-swaps work.
    onChange(memberships.map((m) => ({ ...m, role: next })));
  }

  function toggle(projectId: string) {
    if (selected.has(projectId)) {
      onChange(memberships.filter((m) => m.projectId !== projectId));
    } else {
      onChange([...memberships, { projectId, role }]);
    }
  }

  function setAll(check: boolean) {
    if (check) {
      // "Select all" respects the current filter — clicking it while a search
      // is active only adds the visible ones, matching how every checkbox
      // list in this app already behaves.
      const ids = new Set(visible.map((p) => p.id));
      const others = memberships.filter((m) => !ids.has(m.projectId));
      const added = visible.map((p) => ({ projectId: p.id, role }));
      onChange([...others, ...added]);
    } else {
      const ids = new Set(visible.map((p) => p.id));
      onChange(memberships.filter((m) => !ids.has(m.projectId)));
    }
  }

  const visibleSelectedCount = visible.filter((p) => selected.has(p.id)).length;
  const allVisibleChecked = visible.length > 0 && visibleSelectedCount === visible.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Role radio group — one choice applies to every checked project. */}
      <div
        role="radiogroup"
        aria-label="Role for selected projects"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {ROLE_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "6px 10px",
              border: role === opt.value ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: role === opt.value ? "var(--accent-soft, rgba(120,120,255,.10))" : "transparent",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="radio"
              name="proj-role"
              checked={role === opt.value}
              onChange={() => setRoleForAll(opt.value)}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: "flex", flexDirection: "column" }}>
              <strong>{opt.label}</strong>
              <span style={{ opacity: 0.65, fontSize: 12 }}>{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {/* Filter + select-all bar */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Input
          type="text"
          placeholder={`Search ${projects.length} projects…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <Btn variant="ghost" size="sm" onClick={() => setAll(!allVisibleChecked)}>
          {allVisibleChecked ? "Clear" : "Select all"}
        </Btn>
      </div>

      {/* Project checklist */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          maxHeight: 240,
          overflowY: "auto",
        }}
      >
        {visible.length === 0 ? (
          <p style={{ margin: 0, padding: 12, fontSize: 13, opacity: 0.6, textAlign: "center" }}>
            No projects match &ldquo;{filter}&rdquo;.
          </p>
        ) : (
          visible.map((p) => {
            const isChecked = selected.has(p.id);
            return (
              <label
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  background: isChecked ? "var(--accent-soft, rgba(120,120,255,.06))" : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(p.id)}
                />
                <span style={{ flex: 1, fontSize: 13 }}>{p.name}</span>
                {isChecked && (
                  <span style={{ fontSize: 11, opacity: 0.6 }}>
                    {ROLE_OPTIONS.find((r) => r.value === role)?.label}
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>

      <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>
        {memberships.length === 0
          ? "No projects selected — user will only see projects added later."
          : `${memberships.length} project${memberships.length === 1 ? "" : "s"} — user gets ${ROLE_OPTIONS.find((r) => r.value === role)?.label.toLowerCase()} on each.`}
      </p>
    </div>
  );
}
