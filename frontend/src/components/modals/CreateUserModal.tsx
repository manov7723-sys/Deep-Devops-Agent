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
 * Per-project access picker with click-to-expand capability checkboxes.
 *
 * The admin sees the full project list. Clicking a project name expands its
 * capability panel — one checkbox per meaningful action. Selecting any
 * capability adds an implicit "View project", because seeing nothing but
 * being able to write to it makes no sense.
 *
 * IMPORTANT ARCHITECTURAL NOTE (2026-08). The backend still has three roles
 * — viewer / developer / owner — not per-capability permissions. The
 * checkboxes here are UX; on submit they're collapsed to the SMALLEST role
 * that covers everything ticked. Real per-capability enforcement (each
 * checkbox becomes its own permission enforced by every route) is a
 * separate backend project — flagged, not done. Semantics for the admin
 * still work: ticking "Manage team members" grants the exact ability, it
 * just also grants everything else `owner` grants.
 *
 * Capability → minimum role:
 *   view / view_secrets / deploy / manage_secrets / manage_cloud → developer (or viewer for view alone)
 *   manage_members / manage_settings / delete_project → owner
 */
type Capability =
  | "view"
  | "view_secrets"
  | "deploy"
  | "manage_secrets"
  | "manage_cloud"
  | "manage_members"
  | "manage_settings"
  | "delete_project";

const CAPABILITIES: Array<{ id: Capability; label: string; hint: string; requires: ProjectMembership["role"] }> = [
  { id: "view", label: "View project", hint: "See dashboards, resources, logs (read-only).", requires: "viewer" },
  { id: "view_secrets", label: "Reveal secret values", hint: "Env viewer + inspect pod env (still requires TOTP step-up).", requires: "developer" },
  { id: "deploy", label: "Deploy applications", hint: "Trigger CI/CD, run pipelines, apply manifests.", requires: "developer" },
  { id: "manage_secrets", label: "Manage app secrets", hint: "Write app-env values, connect databases.", requires: "developer" },
  { id: "manage_cloud", label: "Manage cloud connections", hint: "Connect AWS / Azure / GCP accounts to this project.", requires: "developer" },
  { id: "manage_members", label: "Manage team members", hint: "Invite people to the project and change their roles.", requires: "owner" },
  { id: "manage_settings", label: "Manage project settings", hint: "Rename, archive, change the target cloud.", requires: "owner" },
  { id: "delete_project", label: "Transfer or delete project", hint: "Destructive — includes transferring ownership.", requires: "owner" },
];

const RANK: Record<ProjectMembership["role"], number> = { viewer: 1, developer: 2, owner: 3 };

/** Map a set of capability slugs to the smallest role that covers them all. */
function capabilitiesToRole(caps: Set<Capability>): ProjectMembership["role"] | null {
  if (caps.size === 0) return null;
  let role: ProjectMembership["role"] = "viewer";
  for (const cap of caps) {
    const need = CAPABILITIES.find((c) => c.id === cap)!.requires;
    if (RANK[need] > RANK[role]) role = need;
  }
  return role;
}

/** Reverse map — used to preselect a project's checkboxes from an existing role. */
function roleToCapabilities(role: ProjectMembership["role"]): Set<Capability> {
  const out = new Set<Capability>();
  for (const cap of CAPABILITIES) if (RANK[role] >= RANK[cap.requires]) out.add(cap.id);
  return out;
}

const ROLE_LABEL: Record<ProjectMembership["role"], string> = {
  viewer: "Viewer",
  developer: "Developer",
  owner: "Owner",
};

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
  // Per-project checkbox state, keyed by projectId. Kept local to this
  // component so the modal-level state stays flat (memberships[]) — the two
  // sync via a useEffect at the end of every capability change.
  const [caps, setCaps] = useState<Map<string, Set<Capability>>>(() => {
    const out = new Map<string, Set<Capability>>();
    for (const m of memberships) out.set(m.projectId, roleToCapabilities(m.role));
    return out;
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  if (loading) return <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>Loading projects…</p>;
  if (projects.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>
        No projects yet — create some first, then edit this user to add access.
      </p>
    );
  }

  const visible = filter.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : projects;

  function updateCaps(projectId: string, next: Set<Capability>) {
    const nextMap = new Map(caps);
    if (next.size === 0) nextMap.delete(projectId);
    else nextMap.set(projectId, next);
    setCaps(nextMap);
    // Sync back to memberships[]: role = smallest that covers the ticked caps.
    const out: ProjectMembership[] = [];
    for (const [pid, capSet] of nextMap) {
      const role = capabilitiesToRole(capSet);
      if (role) out.push({ projectId: pid, role });
    }
    onChange(out);
  }

  function toggleCap(projectId: string, cap: Capability) {
    const current = new Set(caps.get(projectId) ?? []);
    if (current.has(cap)) current.delete(cap);
    else {
      current.add(cap);
      // Any non-view capability implicitly grants view — no ability to write
      // to something you can't see. Enforced client-side so the checkbox state
      // reflects the honest capability set.
      if (cap !== "view") current.add("view");
    }
    updateCaps(projectId, current);
  }

  function applyPreset(projectId: string, preset: "view" | "full" | "owner" | "none") {
    if (preset === "none") return updateCaps(projectId, new Set());
    const role: ProjectMembership["role"] =
      preset === "view" ? "viewer" : preset === "full" ? "developer" : "owner";
    updateCaps(projectId, roleToCapabilities(role));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Input
        type="text"
        placeholder={`Search ${projects.length} projects…`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          maxHeight: 380,
          overflowY: "auto",
        }}
      >
        {visible.length === 0 ? (
          <p style={{ margin: 0, padding: 12, fontSize: 13, opacity: 0.6, textAlign: "center" }}>
            No projects match &ldquo;{filter}&rdquo;.
          </p>
        ) : (
          visible.map((p) => {
            const capSet = caps.get(p.id) ?? new Set<Capability>();
            const role = capabilitiesToRole(capSet);
            const isOpen = expanded === p.id;
            return (
              <div key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                {/* Row header — click to expand */}
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : p.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "10px 12px",
                    border: "none",
                    background: role
                      ? "var(--accent-soft, rgba(120,120,255,.06))"
                      : "transparent",
                    cursor: "pointer",
                    font: "inherit",
                    color: "inherit",
                    textAlign: "left",
                  }}
                >
                  <Icon name={isOpen ? "chevD" : "chevR"} size={12} />
                  <span style={{ flex: 1, fontSize: 13 }}>{p.name}</span>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>
                    {role ? `${ROLE_LABEL[role]} · ${capSet.size} of ${CAPABILITIES.length}` : "No access"}
                  </span>
                </button>

                {/* Expanded capability panel */}
                {isOpen && (
                  <div
                    style={{
                      padding: "8px 12px 14px 34px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      background: "var(--surface-1)",
                    }}
                  >
                    {/* Presets — one click for the common cases */}
                    <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                      <Btn size="sm" variant="outline" onClick={() => applyPreset(p.id, "view")}>
                        Preset: View only
                      </Btn>
                      <Btn size="sm" variant="outline" onClick={() => applyPreset(p.id, "full")}>
                        Full access
                      </Btn>
                      <Btn size="sm" variant="outline" onClick={() => applyPreset(p.id, "owner")}>
                        Owner
                      </Btn>
                      {role && (
                        <Btn size="sm" variant="ghost" onClick={() => applyPreset(p.id, "none")}>
                          Clear
                        </Btn>
                      )}
                    </div>

                    {CAPABILITIES.map((cap) => {
                      const checked = capSet.has(cap.id);
                      // "view" is implied by any other tick — surface as
                      // disabled+checked when the user has picked something
                      // else, so they understand the coupling rather than
                      // finding a checkbox that mysteriously flips itself on.
                      const implied = cap.id === "view" && !checked === false && capSet.size > 1;
                      return (
                        <label
                          key={cap.id}
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "flex-start",
                            padding: "4px 0",
                            cursor: implied ? "default" : "pointer",
                            fontSize: 13,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={implied}
                            onChange={() => toggleCap(p.id, cap.id)}
                            style={{ marginTop: 2 }}
                          />
                          <span style={{ display: "flex", flexDirection: "column" }}>
                            <span>
                              <strong>{cap.label}</strong>
                              {implied && (
                                <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.5 }}>
                                  (implied)
                                </span>
                              )}
                            </span>
                            <span style={{ opacity: 0.6, fontSize: 12 }}>{cap.hint}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>
        {memberships.length === 0
          ? "No projects selected — user will only see projects added later."
          : `Access on ${memberships.length} project${memberships.length === 1 ? "" : "s"}.`}
      </p>
    </div>
  );
}
