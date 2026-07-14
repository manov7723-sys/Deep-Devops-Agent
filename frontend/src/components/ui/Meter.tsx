import type { ReactNode } from "react";
import { Progress, type ProgressTone } from "./Progress";

export interface MeterProps {
  label: ReactNode;
  value: number;
  height?: number;
  /** Override the auto-tone (ok <55 / warn <75 / danger ≥75). */
  tone?: ProgressTone;
}

/**
 * Compact label + percent + Progress row. Used inside CloudStatsCard
 * compute/data variants for CPU and Memory utilization.
 */
export function Meter({ label, value, height = 5, tone }: MeterProps) {
  const auto: ProgressTone = value >= 75 ? "danger" : value >= 55 ? "warn" : "ok";
  return (
    <div className="col gap-1">
      <div className="row between" style={{ fontSize: 11.5 }}>
        <span className="muted">{label}</span>
        <b className="tnum">{Math.round(value)}%</b>
      </div>
      <Progress
        value={value}
        tone={tone ?? auto}
        height={height}
        ariaLabel={typeof label === "string" ? label : undefined}
      />
    </div>
  );
}
