"use client";

import type { ReactNode } from "react";
import { Badge, Icon, Toggle, type IconName } from "@/components/ui";

export interface ToggleRowProps {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  /** Right-side meta — e.g. "$30 /mo" rendered before the toggle. */
  meta?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** Optional badge (e.g. "Active") next to the title. */
  badge?: ReactNode;
}

/**
 * Domain primitive used wherever a single boolean row appears:
 * Subscription add-ons, env on/off, agent on/off, model on/off, 2FA enable.
 */
export function ToggleRow({
  icon,
  title,
  description,
  meta,
  checked,
  onCheckedChange,
  disabled,
  badge,
}: ToggleRowProps) {
  return (
    <div className="row between gap-3 dda-toggle-row">
      <div className="row gap-3" style={{ minWidth: 0 }}>
        {icon && (
          <span className="row center dda-toggle-icon" data-active={checked ? "true" : undefined}>
            <Icon name={icon} size={18} />
          </span>
        )}
        <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
          <span className="row gap-2" style={{ fontWeight: 600, fontSize: 13.5 }}>
            {title}
            {badge}
            {checked && !badge && <Badge tone="ok">Active</Badge>}
          </span>
          {description && (
            <span className="faint" style={{ fontSize: 12 }}>
              {description}
            </span>
          )}
        </div>
      </div>
      <div className="row gap-3" style={{ flex: "none", alignItems: "center" }}>
        {meta}
        <Toggle
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          ariaLabel={typeof title === "string" ? title : undefined}
        />
      </div>
    </div>
  );
}
