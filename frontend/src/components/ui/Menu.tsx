"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  width?: number;
}

export function Menu({
  trigger,
  children,
  align = "end",
  side = "bottom",
  width = 220,
}: MenuProps) {
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content
          align={align}
          side={side}
          sideOffset={6}
          className="card pop-in"
          style={{ width, padding: 6, boxShadow: "var(--shadow-lg)", zIndex: 80 }}
        >
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export interface MenuItemProps {
  icon?: IconName;
  children: ReactNode;
  onSelect?: (e: Event) => void;
  danger?: boolean;
  disabled?: boolean;
}

export function MenuItem({ icon, children, onSelect, danger, disabled }: MenuItemProps) {
  return (
    <DM.Item
      disabled={disabled}
      onSelect={onSelect}
      className="row gap-3"
      style={{
        padding: "9px 10px",
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 13,
        fontWeight: 600,
        color: danger ? "var(--danger)" : "var(--text)",
        opacity: disabled ? 0.5 : 1,
        outline: "none",
      }}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </DM.Item>
  );
}

export function MenuSeparator() {
  return <DM.Separator style={{ height: 1, background: "var(--border-soft)", margin: "4px 0" }} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DM.Label
      style={{
        padding: "6px 10px",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-faint)",
        fontWeight: 700,
      }}
    >
      {children}
    </DM.Label>
  );
}
