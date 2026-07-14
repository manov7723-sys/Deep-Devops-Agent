"use client";

import { useId } from "react";

export interface SparkProps {
  data: number[];
  width?: number;
  height?: number;
  /** CSS color or var(...). Drives both the stroke and the area fill gradient. */
  tone?: string;
  /** Set false for line-only (no gradient area). */
  fill?: boolean;
  ariaLabel?: string;
}

/**
 * Hand-rolled sparkline. Renders a gradient area + line over `data`.
 * Used by Observability KPIs and any small inline trend.
 */
export function Spark({
  data,
  width = 120,
  height = 36,
  tone = "var(--accent)",
  fill = true,
  ariaLabel = "Sparkline",
}: SparkProps) {
  const id = useId().replace(/[^a-z0-9]/gi, "");
  if (data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map(
    (d, i) =>
      [
        (i / Math.max(1, data.length - 1)) * width,
        height - 3 - ((d - min) / rng) * (height - 6),
      ] as const,
  );
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", overflow: "visible" }}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone} stopOpacity="0.28" />
          <stop offset="1" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#spark-${id})`} />}
      <path
        d={line}
        fill="none"
        stroke={tone}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
