"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Fragment, type ReactNode } from "react";
import { Empty } from "./Empty";
import type { IconName } from "./Icon";

export interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: IconName;
  /** Stable key per row — falls back to index. */
  rowKey?: (row: TData, index: number) => string;
  /** Optional row click. */
  onRowClick?: (row: TData) => void;
  /** Predicate — when true, render `renderExpanded(row)` as a child row below this one. */
  isExpanded?: (row: TData) => boolean;
  /** Renders the expanded child row content. The total columns are spanned automatically. */
  renderExpanded?: (row: TData) => ReactNode;
}

/**
 * Thin TanStack Table v8 wrapper that renders into the .tbl markup. Sort/filter
 * layer in later via column meta. Expandable rows render as a single full-width
 * cell beneath the parent row (Phase 8 admin subscriptions recipe).
 */
export function DataTable<TData>({
  data,
  columns,
  loading,
  emptyTitle = "No results",
  emptyDescription,
  emptyIcon = "search",
  rowKey,
  onRowClick,
  isExpanded,
  renderExpanded,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (loading) {
    return (
      <div className="col gap-2" style={{ padding: 18 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} className="skel" style={{ height: 18 }} />
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div style={{ padding: 18 }}>
        <Empty icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  const colSpan = table.getAllLeafColumns().length;

  return (
    <table className="tbl">
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => (
              <th key={h.id}>
                {h.isPlaceholder
                  ? null
                  : (flexRender(h.column.columnDef.header, h.getContext()) as ReactNode)}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row, i) => {
          const expanded = isExpanded?.(row.original) ?? false;
          return (
            <Fragment key={rowKey ? rowKey(row.original, i) : row.id}>
              <tr
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                style={{ cursor: onRowClick ? "pointer" : undefined }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext()) as ReactNode}
                  </td>
                ))}
              </tr>
              {expanded && renderExpanded && (
                <tr className="dda-row-expanded">
                  <td colSpan={colSpan} style={{ padding: 0 }}>
                    {renderExpanded(row.original)}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
