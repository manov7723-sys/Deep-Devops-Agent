import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: IconName;
  trend?: { up: boolean; v: string };
}

export function Stat({ label, value, sub, icon, trend }: StatProps) {
  return (
    <div className="card card-pad col gap-3" style={{ minWidth: 0 }}>
      <div className="row between">
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
        {icon && (
          <span style={{ color: "var(--text-faint)" }}>
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      <div className="row gap-2" style={{ alignItems: "baseline" }}>
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }} className="tnum">
          {value}
        </span>
        {trend && (
          <span
            style={{
              color: trend.up ? "var(--ok)" : "var(--danger)",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {trend.up ? "▲" : "▼"} {trend.v}
          </span>
        )}
      </div>
      {sub && (
        <span className="faint" style={{ fontSize: 12 }}>
          {sub}
        </span>
      )}
    </div>
  );
}
