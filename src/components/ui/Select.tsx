"use client";

import * as RSelect from "@radix-ui/react-select";
import { Icon } from "./Icon";

export type SelectOption = { value: string; label: string; disabled?: boolean };

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  ariaLabel?: string;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = "Select…",
  disabled,
  name,
  ariaLabel,
}: SelectProps) {
  return (
    <RSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <RSelect.Trigger className="select row between" aria-label={ariaLabel} style={{ gap: 10 }}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon>
          <Icon name="chevD" size={14} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={6}
          className="card pop-in"
          style={{
            minWidth: "var(--radix-select-trigger-width)",
            padding: 6,
            // Modal sits at zIndex 210 (see Modal.tsx); the popup needs to
            // sit above it so it's visible when used inside a modal.
            zIndex: 250,
          }}
        >
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="row gap-2"
                style={{
                  padding: "9px 10px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: o.disabled ? "not-allowed" : "pointer",
                  opacity: o.disabled ? 0.5 : 1,
                  outline: "none",
                }}
              >
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator style={{ marginLeft: "auto" }}>
                  <Icon name="check" size={14} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
