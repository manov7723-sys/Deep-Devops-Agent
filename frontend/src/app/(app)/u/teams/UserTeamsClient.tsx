"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Avatar,
  Badge,
  Block,
  Btn,
  DataTable,
  Field,
  Icon,
  Menu,
  MenuItem,
  Modal,
  PageHead,
} from "@/components/ui";
import { InviteMemberModal } from "@/components/modals/InviteMemberModal";
import {
  useTeams,
  useTeamPendingInvitations,
  useResendInvitation,
  useRevokePendingInvitation,
  useRemoveMemberFromProject,
  type TeamMember,
  type TeamMemberSharedProject,
  type TeamPendingInvitation,
  type ProjectRoleApi,
} from "@/hooks/queries/teams";

const ROLE_TONE: Record<ProjectRoleApi, "accent" | "info" | "default"> = {
  owner: "accent",
  developer: "info",
  viewer: "default",
};

const ROLE_LABEL: Record<ProjectRoleApi, string> = {
  owner: "Owner",
  developer: "Developer",
  viewer: "Viewer",
};

function expiresLabel(iso: string): string {
  const days = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / (24 * 3600 * 1000)));
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export function UserTeamsClient() {
  const { data: teams, isLoading: teamsLoading } = useTeams();
  const { data: pendingInvites, isLoading: invitesLoading } = useTeamPendingInvitations();
  const resend = useResendInvitation();
  const revoke = useRevokePendingInvitation();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowOk, setRowOk] = useState<string | null>(null);

  const columns = useMemo<ColumnDef<TeamMember>[]>(
    () => [
      {
        id: "member",
        header: "Member",
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="row gap-3">
              <Avatar name={m.name} size={34} />
              <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span className="faint" style={{ fontSize: 12 }}>
                  {m.email}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: "role",
        header: "Role",
        cell: ({ row }) => (
          <Badge tone={ROLE_TONE[row.original.role]}>{ROLE_LABEL[row.original.role]}</Badge>
        ),
      },
      {
        id: "projects",
        header: "Shared projects",
        cell: ({ row }) => {
          const list = row.original.sharedProjects ?? [];
          if (list.length === 0) return <span className="muted">{row.original.projects}</span>;
          return (
            <div className="row gap-1 wrap">
              {list.slice(0, 3).map((p) => (
                <Badge key={p.id} tone="default">
                  {p.name}
                </Badge>
              ))}
              {list.length > 3 && (
                <span className="faint" style={{ fontSize: 11.5 }}>
                  +{list.length - 3} more
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: "lastActive",
        header: "Last active",
        cell: ({ row }) => <span className="faint">{row.original.lastActive}</span>,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const m = row.original;
          const canRemoveAny = (m.sharedProjects ?? []).some(
            (p) => p.myRole === "owner" || p.myRole === "developer",
          );
          return (
            <Menu
              trigger={
                <Btn variant="ghost" size="icon" aria-label="Row actions">
                  <Icon name="more" size={16} />
                </Btn>
              }
            >
              <MenuItem
                icon="trash"
                danger
                disabled={!canRemoveAny}
                onSelect={() => {
                  setRowError(null);
                  setRowOk(null);
                  setRemoveTarget(m);
                }}
              >
                Remove from projects…
              </MenuItem>
            </Menu>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Teams"
        sub="Collaborators across your projects — and invitations waiting to be accepted."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
            Invite member
          </Btn>
        }
      />

      {(rowOk || rowError) && (
        <p
          role={rowError ? "alert" : "status"}
          style={{
            padding: "10px 14px",
            fontSize: 12.5,
            borderRadius: 8,
            color: rowError ? "var(--danger)" : "var(--ok)",
            background: rowError ? "var(--danger-soft)" : "var(--ok-soft)",
          }}
        >
          {rowError ?? rowOk}
        </p>
      )}

      <Block>
        <Block.Header>
          <Block.Title sub="Sent and not yet accepted. Resend to bump the email, or revoke to invalidate the link.">
            Pending invitations
          </Block.Title>
          <Block.Actions>
            <Badge tone="default">{pendingInvites?.length ?? 0}</Badge>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {invitesLoading || !pendingInvites ? (
            <Block.Loading />
          ) : pendingInvites.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              No pending invitations.
            </span>
          ) : (
            <div className="col">
              {pendingInvites.map((inv) => (
                <PendingInviteRow
                  key={inv.id}
                  inv={inv}
                  busyResend={resend.isPending}
                  busyRevoke={revoke.isPending}
                  onResend={async () => {
                    setRowError(null);
                    setRowOk(null);
                    try {
                      await resend.mutateAsync({
                        projectSlug: inv.projectSlug,
                        invitationId: inv.id,
                      });
                      setRowOk(`Resent invitation to ${inv.email} for ${inv.projectName}.`);
                    } catch (e) {
                      setRowError(e instanceof Error ? e.message : "Could not resend invitation.");
                    }
                  }}
                  onRevoke={async () => {
                    if (!confirm(`Revoke the invitation for ${inv.email} on ${inv.projectName}?`)) {
                      return;
                    }
                    setRowError(null);
                    setRowOk(null);
                    try {
                      await revoke.mutateAsync({
                        projectSlug: inv.projectSlug,
                        invitationId: inv.id,
                      });
                      setRowOk(`Revoked invitation to ${inv.email}.`);
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

      <Block>
        <Block.Header>
          <Block.Title>Members</Block.Title>
          <Block.Actions>
            <Badge tone="default">{teams?.length ?? 0}</Badge>
          </Block.Actions>
        </Block.Header>
        <DataTable
          data={teams ?? []}
          columns={columns}
          loading={teamsLoading}
          rowKey={(m) => m.id}
          emptyTitle="No collaborators yet"
          emptyDescription="Invite teammates to share projects and review approvals."
          emptyIcon="teams"
        />
      </Block>

      <InviteMemberModal open={inviteOpen} onOpenChange={setInviteOpen} />

      {removeTarget && (
        <RemoveFromProjectsModal
          open={!!removeTarget}
          onOpenChange={(o) => {
            if (!o) setRemoveTarget(null);
          }}
          member={removeTarget}
          onDone={(message) => {
            setRowOk(message);
            setRemoveTarget(null);
          }}
          onError={(message) => {
            setRowError(message);
          }}
        />
      )}
    </div>
  );
}

function PendingInviteRow({
  inv,
  busyResend,
  busyRevoke,
  onResend,
  onRevoke,
}: {
  inv: TeamPendingInvitation;
  busyResend: boolean;
  busyRevoke: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
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
            {ROLE_LABEL[inv.role]} on <b>{inv.projectName}</b> · invited by {inv.invitedByName} ·{" "}
            {expiresLabel(inv.expiresAt)}
          </span>
        </div>
      </div>
      <div className="row gap-2">
        <Btn size="sm" variant="outline" icon="mail" loading={busyResend} onClick={onResend}>
          Resend
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          icon="x"
          aria-label={`Revoke invitation for ${inv.email}`}
          loading={busyRevoke}
          onClick={onRevoke}
        />
      </div>
    </div>
  );
}

function RemoveFromProjectsModal({
  open,
  onOpenChange,
  member,
  onDone,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: TeamMember;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const remove = useRemoveMemberFromProject();
  const removable = (member.sharedProjects ?? []).filter(
    (p) => p.memberRole !== "owner" && (p.myRole === "owner" || p.myRole === "developer"),
  );
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const pickedSlugs = Object.entries(picked)
    .filter(([, on]) => on)
    .map(([slug]) => slug);

  async function submit() {
    if (pickedSlugs.length === 0) return;
    const results = await Promise.allSettled(
      pickedSlugs.map((slug) => remove.mutateAsync({ projectSlug: slug, userId: member.id })),
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === 0) {
      onDone(
        `Removed ${member.name} from ${pickedSlugs.length} project${pickedSlugs.length === 1 ? "" : "s"}.`,
      );
      onOpenChange(false);
      return;
    }
    onError(
      `Removed from ${results.length - failures.length}/${results.length}. ${failures.length} failed.`,
    );
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${member.name}`}
      description={`Pick the projects to remove ${member.email} from. Owner rows and projects you don't manage are hidden.`}
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
            disabled={pickedSlugs.length === 0}
            onClick={submit}
            style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
          >
            Remove from {pickedSlugs.length} project{pickedSlugs.length === 1 ? "" : "s"}
          </Btn>
        </>
      }
    >
      {removable.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          There are no projects where you can remove this user. Either they own those projects, or
          you don&apos;t have manage rights on them.
        </p>
      ) : (
        <Field label="Shared projects" hint={`${pickedSlugs.length} selected`}>
          <div className="col gap-2">
            {removable.map((p) => (
              <ProjectCheckRow
                key={p.id}
                project={p}
                checked={!!picked[p.slug]}
                onToggle={() => setPicked((cur) => ({ ...cur, [p.slug]: !cur[p.slug] }))}
              />
            ))}
          </div>
        </Field>
      )}
    </Modal>
  );
}

function ProjectCheckRow({
  project,
  checked,
  onToggle,
}: {
  project: TeamMemberSharedProject;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className="row gap-3"
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: checked ? "var(--accent-soft)" : "transparent",
        cursor: "pointer",
        alignItems: "center",
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div className="col grow" style={{ lineHeight: 1.3, minWidth: 0 }}>
        <span style={{ fontWeight: 600 }}>{project.name}</span>
        <span className="faint mono" style={{ fontSize: 11 }}>
          {project.slug} · they are {ROLE_LABEL[project.memberRole].toLowerCase()}
        </span>
      </div>
    </label>
  );
}
