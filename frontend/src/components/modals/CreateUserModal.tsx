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
  if (loading) return <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>Loading projects…</p>;
  if (projects.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>
        No projects yet — create some first, then edit this user to add access.
      </p>
    );
  }

  const roleFor = (id: string) => memberships.find((m) => m.projectId === id)?.role ?? "";
  const toggle = (id: string, role: string) => {
    const rest = memberships.filter((m) => m.projectId !== id);
    if (!role) onChange(rest);
    else
      onChange([...rest, { projectId: id, role: role as ProjectMembership["role"] }]);
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        maxHeight: 220,
        overflowY: "auto",
      }}
    >
      {projects.map((p) => {
        const current = roleFor(p.id);
        return (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ flex: 1, fontSize: 13 }}>{p.name}</span>
            <Select
              value={current}
              placeholder="—"
              options={[
                { value: "", label: "— no access" },
                { value: "viewer", label: "viewer" },
                { value: "developer", label: "developer" },
                { value: "owner", label: "owner" },
              ]}
              onValueChange={(v) => toggle(p.id, v)}
            />
          </div>
        );
      })}
    </div>
  );
}
