"use client";

import * as Switch from "@radix-ui/react-switch";
import { cn } from "@/lib/utils/cn";

export interface ToggleProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  name?: string;
  className?: string;
}

export function Toggle({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  ariaLabel,
  name,
  className,
}: ToggleProps) {
  return (
    <Switch.Root
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      name={name}
      aria-label={ariaLabel}
      className={cn("toggle", className)}
    >
      <Switch.Thumb style={{ display: "none" }} />
    </Switch.Root>
  );
}
