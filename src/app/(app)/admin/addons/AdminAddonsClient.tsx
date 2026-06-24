"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Avatar,
  Block,
  Btn,
  DataTable,
  Icon,
  PageHead,
  StatusDot,
  type IconName,
} from "@/components/ui";
import { useAdminAddons } from "@/hooks/queries/admin-ops";
import type { SeedAdminAddonPurchase } from "@/lib/legacy-types";
import { CreateAddonModal } from "@/components/modals/CreateAddonModal";

const STATUS_TONE = {
  active: "ok",
  pending: "info",
  cancelled: "danger",
} as const;

export function AdminAddonsClient() {
  const { data: addons, isLoading } = useAdminAddons();
  const [createOpen, setCreateOpen] = useState(false);

  const columns = useMemo<ColumnDef<SeedAdminAddonPurchase>[]>(
    () => [
      {
        id: "addon",
        header: "Add-on",
        cell: ({ row }) => (
          <div className="row gap-2">
            <span
              className="row center"
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                flex: "none",
              }}
            >
              <Icon name={row.original.icon as IconName} size={15} />
            </span>
            <span style={{ fontWeight: 600 }}>{row.original.name}</span>
          </div>
        ),
      },
      {
        id: "user",
        header: "User",
        cell: ({ row }) => (
          <div className="row gap-3">
            <Avatar name={row.original.user} size={30} />
            <div className="col" style={{ lineHeight: 1.3 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{row.original.user}</span>
              <span className="faint" style={{ fontSize: 11.5 }}>{row.original.email}</span>
            </div>
          </div>
        ),
      },
      {
        id: "price",
        header: "Price",
        cell: ({ row }) => <span className="tnum" style={{ fontWeight: 700 }}>{row.original.price}</span>,
      },
      {
        id: "when",
        header: "Purchased",
        cell: ({ row }) => <span className="faint">{row.original.when}</span>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusDot
            tone={STATUS_TONE[row.original.status]}
            label={row.original.status === "active" ? "Active" : row.original.status}
          />
        ),
      },
    ],
    [],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Add-on purchases"
        sub="Extra tokens, seats, environments, models and compute bought by users on top of their plans."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            New add-on
          </Btn>
        }
      />
      <Block>
        <DataTable
          data={addons ?? []}
          columns={columns}
          loading={isLoading}
          rowKey={(a) => a.id}
          emptyTitle="No add-on purchases"
          emptyIcon="addon"
        />
      </Block>
      <CreateAddonModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
