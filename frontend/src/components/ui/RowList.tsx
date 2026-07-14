import type { ReactNode } from "react";

export interface RowListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** Optional key extractor (defaults to index). */
  getKey?: (item: T, index: number) => string;
  empty?: ReactNode;
  /** Visual style of separators between rows. */
  divider?: boolean;
}

/**
 * Vertical card-style rows. Each row composes whatever it wants inside.
 * Used by dashboard "Your projects" block, tasks, approvals, alerts, activity.
 */
export function RowList<T>({ items, renderItem, getKey, empty, divider = true }: RowListProps<T>) {
  if (items.length === 0) {
    return <>{empty}</>;
  }
  return (
    <div className="col">
      {items.map((item, i) => (
        <div
          key={getKey ? getKey(item, i) : String(i)}
          className="dda-row-list-row"
          style={{
            padding: "14px 18px",
            borderBottom: divider && i < items.length - 1 ? "1px solid var(--border-soft)" : "none",
          }}
        >
          {renderItem(item, i)}
        </div>
      ))}
    </div>
  );
}
