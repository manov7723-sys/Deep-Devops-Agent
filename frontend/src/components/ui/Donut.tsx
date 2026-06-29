"use client";

import { useId, type ReactNode } from "react";

export type DonutSegment = { name: string; value: number; color: string };

export interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  /** Center slot — pass a tiny "MONTH $10.3k" stack or leave undefined for legend-only. */
  center?: ReactNode;
  ariaLabel?: string;
}

/**
 * Hand-rolled SVG donut chart — ports the wireframe's Donut primitive.
 * Variants: with-center-total | no-center | size/thickness override.
 */
export function Donut({
  segments,
  size = 120,
  thickness = 16,
  center,
  ariaLabel = "Donut chart",
}: DonutProps) {
  const reactId = useId();
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }} role="img" aria-label={ariaLabel}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={thickness}
        />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={`${reactId}-${i}`}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-off}
              strokeLinecap="butt"
            />
          );
          off += len;
          return el;
        })}
      </svg>
      {center && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {center}
        </div>
      )}
    </div>
  );
}
