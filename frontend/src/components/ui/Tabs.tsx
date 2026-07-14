"use client";

import * as RTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export interface TabItem {
  value: string;
  label: ReactNode;
  content?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
}

export function Tabs({ items, value, defaultValue, onValueChange }: TabsProps) {
  return (
    <RTabs.Root
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={onValueChange}
    >
      <RTabs.List className="tabs" style={{ overflowX: "auto" }}>
        {items.map((t) => (
          <RTabs.Trigger key={t.value} value={t.value} disabled={t.disabled} className="tab">
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map(
        (t) =>
          t.content !== undefined && (
            <RTabs.Content
              key={t.value}
              value={t.value}
              style={{ paddingTop: 16, outline: "none" }}
            >
              {t.content}
            </RTabs.Content>
          ),
      )}
    </RTabs.Root>
  );
}
