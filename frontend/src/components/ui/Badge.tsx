import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "./Icon";

export type BadgeTone = "default" | "ok" | "warn" | "danger" | "info" | "accent" | "solid-ok";

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconName;
  withDot?: boolean;
  children: ReactNode;
}

const toneClass: Record<BadgeTone, string> = {
  default: "",
  ok: "ok",
  warn: "warn",
  danger: "danger",
  info: "info",
  accent: "accent",
  "solid-ok": "solid-ok",
};

export function Badge({ tone = "default", icon, withDot, children }: BadgeProps) {
  return (
    <span className={cn("badge", toneClass[tone])}>
      {withDot && (
        <span
          className={cn(
            "dot",
            tone === "ok" || tone === "warn" || tone === "danger" || tone === "info" ? tone : "",
          )}
          style={{ width: 7, height: 7, boxShadow: "none" }}
        />
      )}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}
