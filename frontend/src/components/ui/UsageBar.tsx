import type { ReactNode } from "react";
import { Progress, type ProgressTone } from "./Progress";

export interface UsageBarProps {
  label: ReactNode;
  used: number;
  /** Number → finite limit. "unlimited" → renders the unlimited glyph. */
  limit: number | "unlimited";
}

/** Auto-toned 0–100% progress with used / limit label above. */
export function UsageBar({ label, used, limit }: UsageBarProps) {
  const pct = typeof limit === "number" ? Math.round((used / limit) * 100) : 30;
  const tone: ProgressTone = pct >= 95 ? "danger" : pct >= 80 ? "warn" : "default";
  return (
    <div className="col gap-1">
      <div className="row between" style={{ fontSize: 12.5 }}>
        <span className="muted">{label}</span>
        <b className="tnum nowrap">
          {used.toLocaleString()}{" "}
          <span className="faint">
            / {typeof limit === "number" ? limit.toLocaleString() : "∞"}
          </span>
        </b>
      </div>
      <Progress value={pct} tone={tone} />
    </div>
  );
}
