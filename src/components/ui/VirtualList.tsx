"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode } from "react";

export interface VirtualListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** Estimated row height. Real height is measured after first render. */
  estimateSize?: number;
  /** Optional key extractor (defaults to index). */
  getKey?: (item: T, index: number) => string;
  /** Height of the scrolling viewport. */
  height?: number | string;
}

/**
 * TanStack Virtual wrapper for long lists (audit feeds, large activity logs).
 * Renders only visible rows; uses dynamic measurement for variable heights.
 */
export function VirtualList<T>({
  items,
  renderItem,
  estimateSize = 64,
  getKey,
  height = 600,
}: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => ref.current,
    estimateSize: () => estimateSize,
    overscan: 6,
  });

  return (
    <div
      ref={ref}
      className="dda-virtual-scroll"
      style={{ height, overflow: "auto", position: "relative" }}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index];
          return (
            <div
              key={getKey ? getKey(item, v.index) : v.index}
              ref={virtualizer.measureElement}
              data-index={v.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${v.start}px)`,
              }}
            >
              {renderItem(item, v.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
