"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Avatar,
  Badge,
  Block,
  Btn,
  DataTable,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  PageHead,
  Stat,
  StatusDot,
  type IconName,
} from "@/components/ui";
import { useAdminSubscriptions } from "@/hooks/queries/admin";
import type { AdminPlanTier, SeedAdminSubscription, SubscriptionStatus } from "@/lib/legacy-types";

const fmt = (n: number) => `$${n.toLocaleString()}`;

const PLAN_TONE: Record<AdminPlanTier, "accent" | "info" | "default" | "ok"> = {
  Scale: "accent",
  Pro: "info",
  Free: "default",
  Enterprise: "ok",
};

const STATUS_TONE: Record<SubscriptionStatus, "ok" | "info" | "warn" | "danger"> = {
  active: "ok",
  trial: "info",
  past_due: "warn",
  suspended: "danger",
};

export function AdminSubscriptionsClient() {
  const { data: subs, isLoading } = useAdminSubscriptions();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totals = useMemo(() => {
    if (!subs) return { totalMrr: 0, active: 0, addonMrr: 0, pastDue: 0 };
    const addonMrr = subs.reduce((t, s) => t + s.addons.reduce((a, x) => a + x.price, 0), 0);
    const totalMrr = subs
      .filter((s) => s.status !== "suspended")
      .reduce((t, s) => t + s.base + s.addons.reduce((a, x) => a + x.price, 0), 0);
    return {
      totalMrr,
      active: subs.filter((s) => s.status === "active").length,
      addonMrr,
      pastDue: subs.filter((s) => s.status === "past_due").length,
    };
  }, [subs]);

  const columns = useMemo<ColumnDef<SeedAdminSubscription>[]>(
    () => [
      {
        id: "user",
        header: "User",
        cell: ({ row }) => (
          <div className="row gap-3">
            <Avatar name={row.original.userName} size={34} />
            <div className="col" style={{ lineHeight: 1.3 }}>
              <span style={{ fontWeight: 600 }}>{row.original.userName}</span>
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
        cell: ({ row }) => <Badge tone={PLAN_TONE[row.original.plan]}>{row.original.plan}</Badge>,
      },
      {
        id: "addons",
        header: "Add-ons",
        cell: ({ row }) => {
          const s = row.original;
          if (s.addons.length === 0)
            return (
              <span className="faint" style={{ fontSize: 12.5 }}>
                None
              </span>
            );
          const isOpen = expanded.has(s.id);
          return (
            <button
              type="button"
              className="chip"
              onClick={() => toggle(s.id)}
              style={{ cursor: "pointer" }}
            >
              <Icon name="addon" size={13} style={{ color: "var(--accent)" }} />
              {s.addons.length} add-on{s.addons.length > 1 ? "s" : ""}
              <Icon
                name="chevD"
                size={13}
                style={{
                  transform: isOpen ? "rotate(180deg)" : undefined,
                  transition: "transform .15s",
                }}
              />
            </button>
          );
        },
      },
      {
        id: "mrr",
        header: "MRR",
        cell: ({ row }) => {
          const s = row.original;
          const addonTotal = s.addons.reduce((a, x) => a + x.price, 0);
          const total = s.base + addonTotal;
          return (
            <span className="tnum" style={{ fontWeight: 700 }}>
              {fmt(total)}
              {addonTotal > 0 && (
                <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
                  {" "}
                  ({fmt(s.base)}+{fmt(addonTotal)})
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusDot
            tone={STATUS_TONE[row.original.status]}
            label={row.original.status.replace("_", " ")}
          />
        ),
      },
      {
        id: "renews",
        header: "Renews",
        cell: ({ row }) => {
          const s = row.original;
          if (s.status === "past_due")
            return <span style={{ color: "var(--warn)", fontWeight: 600 }}>{s.renews}</span>;
          return <span className="muted">{s.renews}</span>;
        },
      },
      {
        id: "method",
        header: "Method",
        cell: ({ row }) => (
          <span className="mono faint" style={{ fontSize: 12 }}>
            {row.original.method}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="hide-sm">Actions</span>,
        cell: ({ row }) => (
          <Menu
            trigger={
              <Btn variant="ghost" size="icon" aria-label={`Actions for ${row.original.userName}`}>
                <Icon name="more" size={16} />
              </Btn>
            }
          >
            <MenuItem icon="eye">View user</MenuItem>
            <MenuItem icon="plus">Add add-on</MenuItem>
            <MenuItem icon="edit">Change plan</MenuItem>
            <MenuSeparator />
            <MenuItem icon="x" danger>
              Cancel
            </MenuItem>
          </Menu>
        ),
      },
    ],
    [expanded],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Subscriptions"
        sub="Per-user subscriptions, including add-ons purchased on top of each plan."
        actions={
          <Btn variant="outline" icon="download">
            Export
          </Btn>
        }
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 14,
        }}
      >
        <Stat
          label="Total MRR"
          value={fmt(totals.totalMrr)}
          icon="dollar"
          trend={{ up: true, v: "8.4%" }}
        />
        <Stat
          label="Active subscribers"
          value={totals.active}
          icon="users"
          sub={subs ? `${subs.length} total` : undefined}
        />
        <Stat label="Add-on MRR" value={fmt(totals.addonMrr)} icon="addon" sub="across all users" />
        <Stat label="Past due" value={totals.pastDue} icon="alert" sub="needs retry" />
      </div>

      <Block>
        <DataTable
          data={subs ?? []}
          columns={columns}
          loading={isLoading}
          rowKey={(s) => s.id}
          isExpanded={(s) => expanded.has(s.id) && s.addons.length > 0}
          renderExpanded={(s) => (
            <div>
              {s.addons.map((ad, j) => (
                <div key={`${s.id}-ad-${j}`} className="dda-admin-addon-row">
                  <span className="row gap-2 faint" style={{ fontSize: 12 }}>
                    <Icon name="chevR" size={12} />
                    <span className="dda-admin-addon-tile">
                      <Icon name={ad.icon as IconName} size={13} />
                    </span>
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1 }}>{ad.name}</span>
                  <span className="tnum" style={{ fontWeight: 600 }}>
                    {fmt(ad.price)}
                  </span>
                  <Badge tone="ok">add-on</Badge>
                </div>
              ))}
            </div>
          )}
          emptyTitle="No subscriptions"
          emptyIcon="card"
        />
      </Block>
    </div>
  );
}
