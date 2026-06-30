/**
 * Hand-rolled SVG bar chart — ports the wireframe's Bars primitive.
 * Used by Usage agent token consumption, Admin recurring revenue, ProjCost.
 *
 * Renders proportional bars across the full container width. Tone follows
 * --accent unless caller overrides.
 */
export interface BarsProps {
  data: number[];
  width?: number;
  height?: number;
  gap?: number;
  tone?: string;
  ariaLabel?: string;
}

export function Bars({
  data,
  width = 560,
  height = 140,
  gap = 6,
  tone = "var(--accent)",
  ariaLabel = "Bar chart",
}: BarsProps) {
  if (data.length === 0) return null;
  const max = Math.max(...data) || 1;
  const bw = (width - gap * (data.length - 1)) / data.length;
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      {data.map((d, i) => {
        const bh = (d / max) * (height - 4);
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={height - bh}
            width={bw}
            height={bh}
            rx={Math.min(2.5, bw / 2)}
            fill={tone}
            opacity={0.55 + 0.45 * (d / max)}
          />
        );
      })}
    </svg>
  );
}
