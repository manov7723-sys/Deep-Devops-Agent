"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Badge,
  Block,
  Btn,
  DataTable,
  PageHead,
  Stat,
} from "@/components/ui";
import { useAdminBillingStats, useAdminInvoices } from "@/hooks/queries/admin-ops";
import type { SeedAdminInvoice } from "@/lib/legacy-types";

export function AdminBillingClient() {
  const { data: invoices, isLoading } = useAdminInvoices();
  const { data: stats } = useAdminBillingStats();

  const columns = useMemo<ColumnDef<SeedAdminInvoice>[]>(
    () => [
      {
        id: "inv",
        header: "Invoice",
        cell: ({ row }) => (
          <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{row.original.number}</span>
        ),
      },
      {
        id: "customer",
        header: "Customer",
        cell: ({ row }) => <span className="muted">{row.original.customer}</span>,
      },
      {
        id: "amount",
        header: "Amount",
        cell: ({ row }) => <span className="tnum" style={{ fontWeight: 700 }}>{row.original.amount}</span>,
      },
      {
        id: "date",
        header: "Date",
        cell: ({ row }) => <span className="faint">{row.original.date}</span>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge
            tone={row.original.status === "paid" ? "ok" : row.original.status === "failed" ? "danger" : "info"}
            icon={row.original.status === "paid" ? "check" : "alert"}
          >
            {row.original.status}
          </Badge>
        ),
      },
      {
        id: "download",
        header: () => <span className="hide-sm">Download</span>,
        cell: ({ row }) => (
          <Btn
            size="sm"
            variant="ghost"
            icon="download"
            aria-label={`Download ${row.original.number}`}
          />
        ),
      },
    ],
    [],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Billing"
        sub="Invoices and payment events across the platform."
        actions={
          <Btn variant="outline" icon="download">
            Export all
          </Btn>
        }
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <Stat
          label="Collected (May)"
          value={stats?.collectedThisMonth ?? "—"}
          icon="dollar"
          trend={stats?.collectedTrend}
        />
        <Stat
          label="Outstanding"
          value={stats?.outstanding ?? "—"}
          icon="clock"
          sub={stats ? `${stats.outstandingCount} invoices` : undefined}
        />
        <Stat
          label="Failed payments"
          value={stats?.failedPayments ?? "—"}
          icon="alert"
          sub="needs retry"
        />
        <Stat label="Refunds" value={stats?.refunds ?? "—"} icon="receipt" />
      </div>
      <Block>
        <Block.Header>
          <Block.Title>Invoices</Block.Title>
        </Block.Header>
        <DataTable
          data={invoices ?? []}
          columns={columns}
          loading={isLoading}
          rowKey={(i) => i.id}
          emptyTitle="No invoices"
          emptyIcon="receipt"
        />
      </Block>
    </div>
  );
}
