"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Avatar,
  Badge,
  Block,
  Btn,
  ConfigRow,
  DataTable,
  Field,
  HuePicker,
  Icon,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  PageHead,
  Select,
  StatusDot,
  Textarea,
  Toggle,
} from "@/components/ui";
import { ProjectAvatar } from "@/components/domain/ProjectAvatar";
import { DangerRow } from "@/components/domain/DangerRow";
import {
  useIntegrations,
  useDisconnectIntegration,
  useProjectSettings,
  useUpdateProjectSettings,
  useProjectMembers,
  useChangeMemberRole,
  useRemoveMember,
  useProjectInvitations,
  useRevokeInvitation,
  type ProjectMember,
  type ProjectInvitation,
} from "@/hooks/queries/project";
import { useAvailableModels } from "@/hooks/queries/models";
import { useProjectAuditLog } from "@/hooks/queries/audit-log";
import {
  ConnectIntegrationModal,
  INTEGRATION_PROVIDERS,
  type IntegrationKind,
} from "@/components/modals/ConnectIntegrationModal";
import {
  ArchiveProjectModal,
  DeleteProjectModal,
  TransferProjectModal,
} from "@/components/modals/ProjectLifecycleModals";
import { InviteToProjectModal } from "@/components/modals/InviteToProjectModal";
import type { ProjectRoleApi as ProjectRole } from "@/lib/api/schemas/projects-api";

type Tab = "general" | "members" | "integrations" | "audit" | "danger";

const ROLE_TONE: Record<ProjectRole, "accent" | "info" | "default"> = {
  owner: "accent",
  developer: "info",
  viewer: "default",
};

const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "Owner",
  developer: "Developer",
  viewer: "Viewer",
};

function fmtJoinedDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ProjectSettingsClient({
  slug,
  projectName,
}: {
  slug: string;
  projectName: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = (sp.get("tab") as Tab | null) ?? "general";

  function setTab(next: Tab) {
    const p = new URLSearchParams(sp);
    p.set("tab", next);
    const q = p.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route);
  }

  return (
    <div className="col gap-5">
      <PageHead
        title="Project settings"
        sub={`Configure ${projectName} — details, members, integrations and lifecycle.`}
        tabs={[
          { value: "general", label: "General" },
          { value: "members", label: "Members" },
          { value: "integrations", label: "Integrations" },
          { value: "audit", label: "Audit log" },
          { value: "danger", label: "Danger zone" },
        ]}
        tabValue={tab}
        onTabChange={(v) => setTab(v as Tab)}
      />

      {tab === "general" && <GeneralTab slug={slug} />}
      {tab === "members" && <MembersTab slug={slug} projectName={projectName} />}
      {tab === "integrations" && <IntegrationsTab slug={slug} />}
      {tab === "audit" && <AuditLogTab slug={slug} />}
      {tab === "danger" && <DangerTab slug={slug} projectName={projectName} />}
    </div>
  );
}

function GeneralTab({ slug }: { slug: string }) {
  const { data: settings } = useProjectSettings(slug);
  const update = useUpdateProjectSettings(slug);
  const { data: models } = useAvailableModels();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hue, setHue] = useState(285);
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [requireApproval, setRequireApproval] = useState(true);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [defaultModel, setDefaultModel] = useState("");
  const [branchEditing, setBranchEditing] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setName(settings.project.name);
    setDescription(settings.meta.description ?? settings.project.description);
    setHue(settings.project.colorHue);
    setAutoDeploy(settings.meta.autoDeployNonProd);
    setRequireApproval(settings.meta.requireApprovalRelease);
    setDefaultBranch(settings.meta.defaultBranch);
    setDefaultModel(settings.meta.defaultModel);
  }, [settings]);

  if (!settings) {
    return (
      <div style={{ maxWidth: 720 }}>
        <Block>
          <Block.Loading />
        </Block>
      </div>
    );
  }

  return (
    <div className="col gap-4" style={{ maxWidth: 720 }}>
      <Block>
        <Block.Header>
          <Block.Title>Project identity</Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-4">
            <div className="row gap-4 wrap" style={{ alignItems: "center" }}>
              <ProjectAvatar name={name || settings.project.name} hue={hue} size={64} radius={16} />
              <div className="col gap-2">
                <span className="field-label" style={{ marginBottom: 0 }}>
                  Project icon
                </span>
                <HuePicker value={hue} onChange={setHue} />
              </div>
            </div>
            <div className="divider" />
            <Field label="Project name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description">
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Project slug" hint="Used in URLs and CLI.">
              <Input className="mono" value={settings.project.slug} readOnly />
            </Field>
            <div className="row">
              <Btn
                variant="primary"
                icon="check"
                loading={update.isPending}
                onClick={() => update.mutate({ name, description, colorHue: hue })}
              >
                Save changes
              </Btn>
            </div>
          </div>
        </Block.Body>
      </Block>

      <Block>
        <Block.Header>
          <Block.Title>Defaults</Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <ConfigRow
              label="Default branch"
              value={
                branchEditing ? (
                  <div className="row gap-2">
                    <Input
                      className="mono"
                      value={defaultBranch}
                      onChange={(e) => setDefaultBranch(e.target.value)}
                      style={{ width: 160 }}
                      autoFocus
                    />
                    <Btn
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const b = defaultBranch.trim() || "main";
                        update.mutate({ defaultBranch: b });
                        setDefaultBranch(b);
                        setBranchEditing(false);
                      }}
                    >
                      Save
                    </Btn>
                    <Btn
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDefaultBranch(settings.meta.defaultBranch);
                        setBranchEditing(false);
                      }}
                    >
                      Cancel
                    </Btn>
                  </div>
                ) : (
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <code className="mono">{settings.meta.defaultBranch}</code>
                    <Btn
                      size="sm"
                      variant="ghost"
                      icon="edit"
                      onClick={() => setBranchEditing(true)}
                    >
                      Edit
                    </Btn>
                  </div>
                )
              }
            />
            <ConfigRow
              label="Auto-deploy non-prod"
              value={
                <Toggle
                  checked={autoDeploy}
                  onCheckedChange={(v) => {
                    setAutoDeploy(v);
                    update.mutate({ autoDeployNonProd: v });
                  }}
                  ariaLabel="Auto-deploy non-prod"
                />
              }
            />
            <ConfigRow
              label="Require approval for release"
              value={
                <Toggle
                  checked={requireApproval}
                  onCheckedChange={(v) => {
                    setRequireApproval(v);
                    update.mutate({ requireApprovalRelease: v });
                  }}
                  ariaLabel="Require approval for release"
                />
              }
            />
            <ConfigRow
              label="Default model"
              value={
                models && models.length > 0 ? (
                  <Select
                    options={models.map((m) => ({
                      value: m.name,
                      label: `${m.name} · ${m.provider}${m.ctx !== "—" ? " · " + m.ctx : ""}${m.isDefault ? " · platform default" : ""}`,
                    }))}
                    value={defaultModel}
                    onValueChange={(v) => {
                      setDefaultModel(v);
                      update.mutate({ defaultModel: v });
                    }}
                    ariaLabel="Default model"
                  />
                ) : (
                  <div className="col gap-1">
                    <Badge icon="model">{settings.meta.defaultModel}</Badge>
                    <span className="faint" style={{ fontSize: 11.5 }}>
                      No models enabled. Ask an admin to enable a model in Admin → Models.
                    </span>
                  </div>
                )
              }
            />
          </div>
        </Block.Body>
      </Block>
    </div>
  );
}

function MembersTab({ slug, projectName }: { slug: string; projectName: string }) {
  const { data: members, isLoading: membersLoading } = useProjectMembers(slug);
  const { data: invitations, isLoading: invitesLoading } = useProjectInvitations(slug);
  const { data: settings } = useProjectSettings(slug);
  const myRole = (settings?.project as { myRole?: ProjectRole } | undefined)?.myRole ?? "viewer";
  const canManage = myRole === "owner" || myRole === "developer";

  const changeRole = useChangeMemberRole(slug);
  const removeMember = useRemoveMember(slug);
  const revoke = useRevokeInvitation(slug);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [roleTarget, setRoleTarget] = useState<ProjectMember | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectMember | null>(null);

  const memberColumns = useMemo<ColumnDef<ProjectMember>[]>(
    () => [
      {
        id: "member",
        header: "Member",
        cell: ({ row }) => (
          <div className="row gap-3">
            <Avatar name={row.original.name} size={34} />
            <div className="col" style={{ lineHeight: 1.3 }}>
              <span style={{ fontWeight: 600 }}>{row.original.name}</span>
              <span className="faint" style={{ fontSize: 12 }}>
                {row.original.email}
              </span>
            </div>
          </div>
        ),
      },
      {
        id: "role",
        header: "Role",
        cell: ({ row }) => (
          <Badge tone={ROLE_TONE[row.original.role]}>{ROLE_LABEL[row.original.role]}</Badge>
        ),
      },
      {
        id: "joined",
        header: "Joined",
        cell: ({ row }) => <span className="faint">{fmtJoinedDate(row.original.joinedAt)}</span>,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const m = row.original;
          // Owners can't be demoted or removed from the row menu — Transfer
          // ownership is the only path (lives in the Danger zone).
          const targetingOwner = m.role === "owner";
          const disabled = !canManage || targetingOwner;
          return (
            <Menu
              trigger={
                <Btn variant="ghost" size="icon" aria-label="Row actions" disabled={disabled}>
                  <Icon name="more" size={16} />
                </Btn>
              }
            >
              <MenuItem
                icon="edit"
                disabled={disabled}
                onSelect={() => {
                  setRowError(null);
                  setRoleTarget(m);
                }}
              >
                Change role
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon="trash"
                danger
                disabled={disabled}
                onSelect={() => {
                  setRowError(null);
                  setConfirmRemove(m);
                }}
              >
                Remove from project
              </MenuItem>
            </Menu>
          );
        },
      },
    ],
    [canManage],
  );

  return (
    <div className="col gap-4">
      <Block>
        <Block.Header>
          <Block.Title>Project members</Block.Title>
          <Block.Actions>
            <Btn
              size="sm"
              variant="primary"
              icon="plus"
              disabled={!canManage}
              onClick={() => setInviteOpen(true)}
            >
              Add member
            </Btn>
          </Block.Actions>
        </Block.Header>
        <DataTable
          data={members ?? []}
          columns={memberColumns}
          loading={membersLoading}
          rowKey={(m) => m.membershipId}
          emptyTitle="No project members"
          emptyIcon="teams"
        />
        {rowError && (
          <div
            style={{
              padding: "8px 14px",
              fontSize: 12.5,
              color: "var(--danger)",
            }}
            role="alert"
          >
            {rowError}
          </div>
        )}
      </Block>

      <Block>
        <Block.Header>
          <Block.Title sub="Invites that have been sent but not yet accepted.">
            Pending invitations
          </Block.Title>
          <Block.Actions>
            <Badge tone="default">{invitations?.length ?? 0}</Badge>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {invitesLoading || !invitations ? (
            <Block.Loading />
          ) : invitations.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              No pending invitations.
            </span>
          ) : (
            <div className="col">
              {invitations.map((inv) => (
                <PendingInviteRow
                  key={inv.id}
                  inv={inv}
                  canRevoke={canManage}
                  busy={revoke.isPending}
                  onRevoke={async () => {
                    setRowError(null);
                    try {
                      await revoke.mutateAsync(inv.id);
                    } catch (e) {
                      setRowError(e instanceof Error ? e.message : "Could not revoke.");
                    }
                  }}
                />
              ))}
            </div>
          )}
        </Block.Body>
      </Block>

      <InviteToProjectModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        slug={slug}
        projectName={projectName}
      />

      {roleTarget && (
        <ChangeRoleModal
          open={!!roleTarget}
          onOpenChange={(o) => {
            if (!o) setRoleTarget(null);
          }}
          member={roleTarget}
          onSubmit={async (newRole) => {
            try {
              await changeRole.mutateAsync({ userId: roleTarget.userId, role: newRole });
              setRoleTarget(null);
            } catch (e) {
              setRowError(e instanceof Error ? e.message : "Could not change role.");
              setRoleTarget(null);
            }
          }}
          submitting={changeRole.isPending}
        />
      )}

      {confirmRemove && (
        <ConfirmRemoveMemberModal
          open={!!confirmRemove}
          onOpenChange={(o) => {
            if (!o) setConfirmRemove(null);
          }}
          member={confirmRemove}
          onConfirm={async () => {
            try {
              await removeMember.mutateAsync(confirmRemove.userId);
              setConfirmRemove(null);
            } catch (e) {
              setRowError(e instanceof Error ? e.message : "Could not remove member.");
              setConfirmRemove(null);
            }
          }}
          submitting={removeMember.isPending}
        />
      )}
    </div>
  );
}

function PendingInviteRow({
  inv,
  canRevoke,
  busy,
  onRevoke,
}: {
  inv: ProjectInvitation;
  canRevoke: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const expiresInDays = Math.max(
    0,
    Math.round((new Date(inv.expiresAt).getTime() - Date.now()) / (24 * 3600 * 1000)),
  );
  return (
    <div
      className="row between gap-3"
      style={{ padding: "12px 0", borderBottom: "1px solid var(--border-soft)" }}
    >
      <div className="row gap-3" style={{ minWidth: 0 }}>
        <span
          className="row center"
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: "var(--surface-2)",
            color: "var(--text-faint)",
            flex: "none",
          }}
        >
          <Icon name="mail" size={16} />
        </span>
        <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{inv.email}</span>
          <span className="faint" style={{ fontSize: 12 }}>
            Invited as {ROLE_LABEL[inv.role]} by {inv.invitedByName} ·{" "}
            {expiresInDays === 0
              ? "expires today"
              : expiresInDays === 1
                ? "expires tomorrow"
                : `expires in ${expiresInDays} days`}
          </span>
        </div>
      </div>
      <Btn size="sm" variant="outline" icon="x" disabled={!canRevoke || busy} onClick={onRevoke}>
        Revoke
      </Btn>
    </div>
  );
}

function ChangeRoleModal({
  open,
  onOpenChange,
  member,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: ProjectMember;
  onSubmit: (role: "developer" | "viewer") => Promise<void>;
  submitting: boolean;
}) {
  const [role, setRole] = useState<"developer" | "viewer">(
    member.role === "viewer" ? "viewer" : "developer",
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Change role · ${member.name}`}
      description="Owners can't be changed here — use the Danger zone to transfer ownership."
      width={500}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="check"
            loading={submitting}
            onClick={() => onSubmit(role)}
            disabled={role === member.role}
          >
            Update role
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <Field
          label="New role"
          hint={
            role === "viewer"
              ? "Read-only access. Can't deploy or change settings."
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
      </div>
    </Modal>
  );
}

function ConfirmRemoveMemberModal({
  open,
  onOpenChange,
  member,
  onConfirm,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: ProjectMember;
  onConfirm: () => Promise<void>;
  submitting: boolean;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${member.name}?`}
      description="They lose access immediately. They can be re-invited later."
      width={500}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="trash"
            loading={submitting}
            onClick={onConfirm}
            style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
          >
            Remove
          </Btn>
        </>
      }
    >
      <p style={{ fontSize: 13, lineHeight: 1.5 }}>
        <b>{member.email}</b> will lose access to this project. Pending tasks they were assigned
        will need a new owner.
      </p>
    </Modal>
  );
}

function IntegrationsTab({ slug }: { slug: string }) {
  const { data: integrations } = useIntegrations(slug);
  const disconnect = useDisconnectIntegration(slug);
  const [connectOpen, setConnectOpen] = useState(false);
  const [preset, setPreset] = useState<IntegrationKind | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const connectedProviders = new Set(
    (integrations ?? []).map((i) => (i as { provider?: string }).provider ?? i.id),
  );

  const openPreset = (kind: IntegrationKind | null) => {
    setRowError(null);
    setPreset(kind);
    setConnectOpen(true);
  };

  async function doDisconnect(id: string, label: string) {
    setRowError(null);
    if (
      !confirm(`Disconnect ${label}? Project alerts and webhooks routed there will stop firing.`)
    ) {
      return;
    }
    try {
      await disconnect.mutateAsync(id);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "Could not disconnect.");
    }
  }

  return (
    <div className="col gap-4" style={{ maxWidth: 760 }}>
      <Block>
        <Block.Header>
          <Block.Title>Connected services</Block.Title>
          <Block.Actions>
            <Btn size="sm" variant="primary" icon="plus" onClick={() => openPreset(null)}>
              Connect new
            </Btn>
          </Block.Actions>
        </Block.Header>
        {integrations ? (
          integrations.length === 0 ? (
            <Block.Body>
              <span className="muted" style={{ fontSize: 13 }}>
                No integrations yet. Click <b>Connect new</b> to wire Slack, PagerDuty, Grafana,
                Prometheus, Datadog or Sentry.
              </span>
            </Block.Body>
          ) : (
            <div className="col">
              {integrations.map((s) => {
                const rowKind = ((s as { provider?: string }).provider ?? s.id) as IntegrationKind;
                return (
                  <div
                    key={s.id}
                    className="row between gap-3"
                    style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-soft)" }}
                  >
                    <div className="row gap-3" style={{ minWidth: 0 }}>
                      <span
                        className="row center"
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 9,
                          background: "var(--surface-2)",
                          color: "var(--text-muted)",
                          flex: "none",
                        }}
                      >
                        <Icon name={s.icon as Parameters<typeof Icon>[0]["name"]} size={18} />
                      </span>
                      <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
                        <span className="row gap-2" style={{ fontWeight: 600 }}>
                          {s.name}
                          {s.connected && <StatusDot tone="ok" />}
                        </span>
                        <span className="faint" style={{ fontSize: 12 }}>
                          {s.description}
                        </span>
                      </div>
                    </div>
                    <div className="row gap-2">
                      {s.connected ? (
                        <>
                          <Btn
                            size="sm"
                            variant="outline"
                            icon="edit"
                            onClick={() => openPreset(rowKind)}
                          >
                            Reconfigure
                          </Btn>
                          <Btn
                            size="sm"
                            variant="ghost"
                            icon="x"
                            aria-label={`Disconnect ${s.name}`}
                            loading={disconnect.isPending}
                            onClick={() => doDisconnect(s.id, s.name)}
                          />
                        </>
                      ) : (
                        <Btn
                          size="sm"
                          variant="primary"
                          icon="link"
                          onClick={() => openPreset(rowKind)}
                        >
                          Connect
                        </Btn>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <Block.Loading />
        )}
      </Block>

      <Block>
        <Block.Header>
          <Block.Title sub="Quick-add any integration we offer.">Available providers</Block.Title>
        </Block.Header>
        <Block.Body>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {INTEGRATION_PROVIDERS.map((p) => {
              const isConnected = connectedProviders.has(p.kind);
              return (
                <button
                  type="button"
                  key={p.kind}
                  onClick={() => openPreset(p.kind)}
                  className="card card-pad col gap-2"
                  style={{
                    textAlign: "left",
                    cursor: "pointer",
                    borderColor: "var(--border)",
                    opacity: isConnected ? 0.7 : 1,
                  }}
                >
                  <span className="row gap-2" style={{ alignItems: "center" }}>
                    <span
                      className="row center"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: "var(--accent-soft)",
                        color: "var(--accent)",
                        flex: "none",
                      }}
                    >
                      <Icon name={p.icon as Parameters<typeof Icon>[0]["name"]} size={15} />
                    </span>
                    <span style={{ fontWeight: 700 }}>{p.name}</span>
                    {isConnected && <StatusDot tone="ok" label="connected" />}
                  </span>
                  <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                    {p.description}
                  </span>
                </button>
              );
            })}
          </div>
        </Block.Body>
      </Block>

      {rowError && (
        <p
          role="alert"
          style={{
            padding: "10px 14px",
            fontSize: 12.5,
            color: "var(--danger)",
            background: "var(--danger-soft)",
            borderRadius: 8,
          }}
        >
          {rowError}
        </p>
      )}

      <ConnectIntegrationModal
        open={connectOpen}
        onOpenChange={setConnectOpen}
        projectSlug={slug}
        preset={preset}
      />
    </div>
  );
}

const AUDIT_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "project.", label: "Project" },
  { value: "env.", label: "Envs" },
  { value: "pipeline.", label: "Pipelines" },
  { value: "approval.", label: "Approvals" },
  { value: "deployment.", label: "Deployments" },
  { value: "integration.", label: "Integrations" },
  { value: "cloud_provider.", label: "Cloud" },
  { value: "repo.", label: "Repos" },
];

function AuditLogTab({ slug }: { slug: string }) {
  const [filter, setFilter] = useState("");
  const { data: rows, isLoading } = useProjectAuditLog(
    slug,
    filter ? { action: filter } : undefined,
  );

  return (
    <div className="col gap-4" style={{ maxWidth: 920 }}>
      <Block>
        <Block.Header>
          <Block.Title sub="Every state change touching this project. Newest first.">
            Audit log
          </Block.Title>
          <Block.Actions>
            <Badge tone="default">{rows?.length ?? 0} entries</Badge>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          <div className="row gap-2 wrap" style={{ marginBottom: 12 }}>
            {AUDIT_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`chip ${filter === f.value ? "active" : ""}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {isLoading || !rows ? (
            <Block.Loading />
          ) : rows.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              {filter
                ? "No entries for this filter."
                : "Nothing logged yet — this fills up as people act on the project."}
            </span>
          ) : (
            <div className="col">
              {rows.map((r) => (
                <AuditRow key={r.id} row={r} />
              ))}
            </div>
          )}
        </Block.Body>
      </Block>
    </div>
  );
}

function AuditRow({ row }: { row: import("@/hooks/queries/audit-log").AuditLogRow }) {
  const when = new Date(row.createdAt);
  const meta = row.metadata as Record<string, unknown> | null;
  return (
    <div
      className="row between gap-3"
      style={{ padding: "12px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13 }}
    >
      <div className="col" style={{ lineHeight: 1.4, minWidth: 0, flex: 1 }}>
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <span className="mono" style={{ fontWeight: 600 }}>
            {row.action}
          </span>
          {row.targetType && (
            <span className="faint" style={{ fontSize: 11.5 }}>
              · {row.targetType}
              {row.targetId ? ` ${row.targetId.slice(0, 8)}` : ""}
            </span>
          )}
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          {row.actorName ? `${row.actorName} (${row.actorEmail ?? "—"})` : "system"}
          {row.ipAddress ? ` · ${row.ipAddress}` : ""}
        </div>
        {meta && Object.keys(meta).length > 0 && (
          <code
            className="mono faint"
            style={{
              fontSize: 11,
              marginTop: 4,
              padding: "4px 6px",
              background: "var(--surface-2)",
              borderRadius: 4,
              maxWidth: "100%",
              overflowX: "auto",
              display: "block",
              whiteSpace: "nowrap",
            }}
          >
            {Object.entries(meta)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("  ·  ")}
          </code>
        )}
      </div>
      <span className="faint mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
        {when.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </div>
  );
}

function DangerTab({ slug, projectName }: { slug: string; projectName: string }) {
  const { data: settings } = useProjectSettings(slug);
  const archived = !!(settings?.project as { archivedAt?: string | null } | undefined)?.archivedAt;
  const myRole = (settings?.project as { myRole?: ProjectRole } | undefined)?.myRole;
  const canManage = myRole === "owner";

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="col gap-4" style={{ maxWidth: 680 }}>
      <div className="card dda-danger-card">
        <div className="card-h">
          <span className="card-title" style={{ color: "var(--danger)" }}>
            Danger zone
          </span>
        </div>
        {!canManage && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--warn-soft)",
              color: "var(--warn)",
              fontSize: 12.5,
              borderRadius: 8,
              margin: "8px 14px",
            }}
          >
            Only the project <b>owner</b> can run these actions. Ask the owner to act.
          </div>
        )}
        <div className="col">
          <DangerRow
            title={archived ? "Unarchive project" : "Archive project"}
            description={
              archived
                ? "Re-enable agents and writes. Reversible."
                : "Make read-only and stop all agents. Reversible."
            }
            ctaLabel={archived ? "Unarchive" : "Archive"}
            onAction={canManage ? () => setArchiveOpen(true) : undefined}
          />
          <DangerRow
            title="Transfer ownership"
            description="Move this project to another account owner. You stay as a developer."
            ctaLabel="Transfer"
            onAction={canManage ? () => setTransferOpen(true) : undefined}
          />
          <DangerRow
            title="Delete project"
            description="Soft-deletes the project. Removed from listings; audit history retained."
            ctaLabel="Delete"
            destructive
            onAction={canManage ? () => setDeleteOpen(true) : undefined}
          />
        </div>
      </div>

      <ArchiveProjectModal
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        slug={slug}
        projectName={projectName}
        archived={archived}
      />
      <TransferProjectModal
        open={transferOpen}
        onOpenChange={setTransferOpen}
        slug={slug}
        projectName={projectName}
      />
      <DeleteProjectModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        slug={slug}
        projectName={projectName}
      />
    </div>
  );
}
