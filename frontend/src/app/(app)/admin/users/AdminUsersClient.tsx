"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Avatar,
  Badge,
  Block,
  Btn,
  ChipGroup,
  DataTable,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  PageHead,
  SearchFilter,
  StatusDot,
} from "@/components/ui";
import { useAdminUsers } from "@/hooks/queries/admin";
import { GrantTokensModal } from "@/components/modals/GrantTokensModal";
import type { AdminUserRow } from "@/lib/admin/aggregates";

type AdminPlanTier = "Free" | "Pro" | "Scale" | "Enterprise";
type AdminUserStatus = "active" | "trial" | "past_due" | "suspended" | "none";

type PlanFilter = "all" | AdminPlanTier;
type StatusFilter = "all" | AdminUserStatus;

const PLAN_TONE: Record<AdminPlanTier, "accent" | "info" | "default" | "ok"> = {
  Scale: "accent",
  Pro: "info",
  Free: "default",
  Enterprise: "ok",
};

const STATUS_TONE: Record<AdminUserStatus, "ok" | "info" | "warn" | "danger" | "default"> = {
  active: "ok",
  trial: "info",
  past_due: "warn",
  suspended: "danger",
  none: "default",
};

// Stripe enum (SubscriptionStatus) → 4-bucket UI label
function uiStatus(raw: string | null | undefined): AdminUserStatus {
  if (raw === "active") return "active";
  if (raw === "trialing") return "trial";
  if (raw === "past_due" || raw === "incomplete") return "past_due";
  if (raw === "canceled" || raw === "unpaid" || raw === "incomplete_expired" || raw === "paused")
    return "suspended";
  return "none";
}

const PLAN_LABEL: Record<string, AdminPlanTier> = {
  free: "Free",
  pro: "Pro",
  scale: "Scale",
  enterprise: "Enterprise",
};

function uiPlan(raw: string | null | undefined): AdminPlanTier {
  if (!raw) return "Free";
  return PLAN_LABEL[String(raw).toLowerCase()] ?? "Free";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

const PLAN_OPTIONS: Array<{ value: PlanFilter; label: string }> = [
  { value: "all", label: "All plans" },
  { value: "Free", label: "Free" },
  { value: "Pro", label: "Pro" },
  { value: "Scale", label: "Scale" },
];

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All status" },
  { value: "active", label: "Active" },
  { value: "trial", label: "Trial" },
  { value: "past_due", label: "Past due" },
  { value: "suspended", label: "Suspended" },
];

export function AdminUsersClient() {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  const plan = (sp.get("plan") as PlanFilter | null) ?? "all";
  const status = (sp.get("status") as StatusFilter | null) ?? "all";
  const { data: users, isLoading } = useAdminUsers(q);

  const [grantTarget, setGrantTarget] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);

  const filtered = useMemo(() => {
    if (!users) return [];
    return users.filter((u) => {
      if (plan !== "all" && uiPlan(u.planTier) !== plan) return false;
      if (status !== "all" && uiStatus(u.subscriptionStatus) !== status) return false;
      return true;
    });
  }, [users, plan, status]);

  function setParam(key: string, value: string) {
    const p = new URLSearchParams(sp);
    if (value === "all" || value === "") p.delete(key);
    else p.set(key, value);
    const url = new URL(window.location.href);
    url.search = p.toString();
    window.history.replaceState(null, "", url);
  }

  const columns = useMemo<ColumnDef<AdminUserRow>[]>(
    () => [
      {
        id: "user",
        header: "User",
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
        id: "plan",
        header: "Plan",
        cell: ({ row }) => {
          const p = uiPlan(row.original.planTier);
          return <Badge tone={PLAN_TONE[p]}>{p}</Badge>;
        },
      },
      {
        id: "projects",
        header: "Projects",
        cell: ({ row }) => <span className="muted tnum">{row.original.ownedProjects}</span>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const s = uiStatus(row.original.subscriptionStatus);
          return <StatusDot tone={STATUS_TONE[s]} label={s.replace("_", " ")} />;
        },
      },
      {
        id: "2fa",
        header: "2FA",
        cell: ({ row }) => (
          <span className="faint">{row.original.twoFactorEnabled ? "On" : "Off"}</span>
        ),
      },
      {
        id: "joined",
        header: "Joined",
        cell: ({ row }) => <span className="faint">{fmtDate(row.original.createdAt)}</span>,
      },
      {
        id: "actions",
        header: () => <span className="hide-sm">Actions</span>,
        cell: ({ row }) => (
          <Menu
            trigger={
              <Btn variant="ghost" size="icon" aria-label={`Actions for ${row.original.name}`}>
                <Icon name="more" size={16} />
              </Btn>
            }
          >
            <MenuItem icon="eye">View</MenuItem>
            <MenuItem icon="edit">Edit plan</MenuItem>
            <MenuItem
              icon="zap"
              onSelect={() =>
                setGrantTarget({
                  id: row.original.id,
                  name: row.original.name,
                  email: row.original.email,
                })
              }
            >
              Grant tokens
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="lock" danger>
              Suspend
            </MenuItem>
          </Menu>
        ),
      },
    ],
    [],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Users"
        sub={users ? `${users.length} accounts on the platform.` : ""}
        actions={
          <Btn variant="primary" icon="plus">
            Add user
          </Btn>
        }
      />
      <div className="row between wrap gap-3">
        <SearchFilter placeholder="Search users…" width={300} />
        <div className="row gap-2 wrap">
          <ChipGroup
            options={PLAN_OPTIONS}
            value={plan}
            onChange={(v) => setParam("plan", v)}
            ariaLabel="Plan filter"
          />
          <ChipGroup
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => setParam("status", v)}
            ariaLabel="Status filter"
          />
        </div>
      </div>
      <Block>
        <DataTable
          data={filtered}
          columns={columns}
          loading={isLoading}
          rowKey={(u) => u.id}
          emptyTitle="No users match"
          emptyDescription="Try a different search term or filter."
          emptyIcon="users"
        />
      </Block>
      <GrantTokensModal
        open={grantTarget !== null}
        onOpenChange={(open) => {
          if (!open) setGrantTarget(null);
        }}
        user={grantTarget}
      />
    </div>
  );
}
