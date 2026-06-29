"use client";

import type { ReactNode } from "react";
import { Btn } from "@/components/ui";

export interface DangerRowProps {
  title: ReactNode;
  description: ReactNode;
  /** "true" for the catastrophic action (renders red text + danger button). */
  destructive?: boolean;
  ctaLabel: string;
  onAction?: () => void;
}

export function DangerRow({ title, description, destructive, ctaLabel, onAction }: DangerRowProps) {
  return (
    <div className="row between wrap gap-3 dda-danger-row">
      <div className="col" style={{ lineHeight: 1.4, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: destructive ? "var(--danger)" : "var(--text)" }}>
          {title}
        </span>
        <span className="faint" style={{ fontSize: 12.5 }}>{description}</span>
      </div>
      <Btn
        size="sm"
        variant={destructive ? "danger" : "outline"}
        icon={destructive ? "trash" : undefined}
        onClick={onAction}
      >
        {ctaLabel}
      </Btn>
    </div>
  );
}
