"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Badge,
  Block,
  Btn,
  DataTable,
  Icon,
  PageHead,
  Toggle,
} from "@/components/ui";
import { useAdminModelPatch, useAdminModels } from "@/hooks/queries/admin-ops";
import { AddModelModal } from "@/components/modals/AddModelModal";
import type { SeedAdminModel } from "@/lib/legacy-types";

export function AdminModelsClient() {
  const { data: models, isLoading } = useAdminModels();
  const patch = useAdminModelPatch();
  const [addOpen, setAddOpen] = useState(false);

  const columns = useMemo<ColumnDef<SeedAdminModel>[]>(
    () => [
      {
        id: "name",
        header: "Model",
        cell: ({ row }) => (
          <div className="row gap-2">
            <Icon name="model" size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontWeight: 600 }}>{row.original.name}</span>
            {row.original.isDefault && <Badge tone="accent">Default</Badge>}
          </div>
        ),
      },
      {
        id: "provider",
        header: "Provider",
        cell: ({ row }) => <span className="muted">{row.original.provider}</span>,
      },
      {
        id: "ctx",
        header: "Context",
        cell: ({ row }) => <span className="mono" style={{ fontSize: 12 }}>{row.original.ctx}</span>,
      },
      {
        id: "cost",
        header: "Cost",
        cell: ({ row }) => <span className="mono faint" style={{ fontSize: 11.5 }}>{row.original.cost}</span>,
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) => (
          <Toggle
            checked={row.original.on}
            onCheckedChange={(v) => patch.mutate({ id: row.original.id, patch: { on: v } })}
            ariaLabel={`${row.original.name} enabled`}
          />
        ),
      },
      {
        id: "default",
        header: "",
        cell: ({ row }) =>
          row.original.isDefault ? null : (
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => patch.mutate({ id: row.original.id, patch: { isDefault: true } })}
            >
              Set default
            </Btn>
          ),
      },
    ],
    [patch],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Models"
        sub="Available LLMs and the platform default. Bring your own model."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add model
          </Btn>
        }
      />
      <Block>
        <DataTable
          data={models ?? []}
          columns={columns}
          loading={isLoading}
          rowKey={(m) => m.id}
          emptyTitle="No models configured"
          emptyIcon="model"
        />
      </Block>
      <AddModelModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
