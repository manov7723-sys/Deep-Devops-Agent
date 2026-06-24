"use client";

import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "./Icon";

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Optional left-side dot tone. */
  dotTone?: "ok" | "warn" | "danger" | "info";
}

export interface ChipGroupProps<T extends string> {
  options: ChipOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}

/**
 * Generic chip row. Used for alert categories, knowledge filter chips,
 * and any other "pick one of N" surface that wants the wireframe's
 * .chip / .chip.active style.
 */
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: ChipGroupProps<T>) {
  return (
    <div className="row gap-2 wrap" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn("chip", active && "active")}
            onClick={() => onChange(o.value)}
          >
            {o.dotTone && (
              <span
                className={`dot ${o.dotTone}`}
                style={{ width: 6, height: 6, boxShadow: "none" }}
              />
            )}
            {o.icon && <Icon name={o.icon} size={14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
