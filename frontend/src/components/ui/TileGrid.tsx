import type { ReactNode } from "react";

export interface TileGridProps {
  /** Minimum tile width in pixels before wrapping. */
  minTile?: number;
  /**
   * Maximum width for a single tile. Prevents a solo tile from stretching
   * to the container's full width (which used to produce a giant banner on
   * pages with N=1 items). Pass `"1fr"` to explicitly opt back into
   * fluid-fill behavior.
   */
  maxTile?: number | "1fr";
  gap?: number;
  className?: string;
  children: ReactNode;
}

/**
 * Responsive grid wrapper used by Projects / Knowledge / Cloud / Plans.
 * Fits as many `minTile`-wide tiles as the container allows; each column is
 * capped at `maxTile` so a single tile doesn't span the whole page and empty
 * grid tracks fall off the right edge with `justify-content: start`.
 *
 * Set `maxTile="1fr"` to revert to the pre-cap behavior (fluid-fill).
 */
export function TileGrid({
  minTile = 280,
  maxTile = 420,
  gap = 14,
  className,
  children,
}: TileGridProps) {
  const columnMax = maxTile === "1fr" ? "1fr" : `${maxTile}px`;
  const template =
    maxTile === "1fr"
      ? `repeat(auto-fill, minmax(${minTile}px, 1fr))`
      : `repeat(auto-fill, minmax(${minTile}px, ${columnMax}))`;
  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: template,
        justifyContent: maxTile === "1fr" ? "stretch" : "start",
        gap,
      }}
    >
      {children}
    </div>
  );
}
