import type { ReactNode } from "react";

export interface TileGridProps {
  /** Minimum tile width in pixels before wrapping. */
  minTile?: number;
  gap?: number;
  className?: string;
  children: ReactNode;
}

/**
 * Responsive grid wrapper used by Projects / Knowledge / Cloud / Plans.
 * Auto-fills as many `minTile`-wide tiles as the viewport allows.
 */
export function TileGrid({ minTile = 280, gap = 14, className, children }: TileGridProps) {
  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${minTile}px, 1fr))`,
        gap,
      }}
    >
      {children}
    </div>
  );
}
