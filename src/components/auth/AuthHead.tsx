import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui";

export interface AuthHeadProps {
  title: ReactNode;
  sub?: ReactNode;
  icon?: IconName;
  iconTone?: "accent" | "ok" | "info" | "warn" | "danger";
}

const toneStyle: Record<NonNullable<AuthHeadProps["iconTone"]>, { bg: string; fg: string }> = {
  accent: { bg: "var(--accent-soft)", fg: "var(--accent)" },
  ok: { bg: "var(--ok-soft)", fg: "var(--ok)" },
  info: { bg: "var(--info-soft)", fg: "var(--info)" },
  warn: { bg: "var(--warn-soft)", fg: "var(--warn)" },
  danger: { bg: "var(--danger-soft)", fg: "var(--danger)" },
};

export function AuthHead({ title, sub, icon, iconTone = "accent" }: AuthHeadProps) {
  const tone = toneStyle[iconTone];
  return (
    <div className="col gap-3">
      {icon && (
        <span
          className="row center"
          style={{ width: 52, height: 52, borderRadius: 14, background: tone.bg, color: tone.fg }}
        >
          <Icon name={icon} size={24} />
        </span>
      )}
      <div className="col gap-2">
        <h2 style={{ fontSize: 25, fontWeight: 800, letterSpacing: "-0.02em" }}>{title}</h2>
        {sub && (
          <p className="muted" style={{ fontSize: 14 }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}
