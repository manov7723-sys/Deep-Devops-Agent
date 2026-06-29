import type { ReactNode } from "react";

export interface ConfigRowProps {
  label: ReactNode;
  value: ReactNode;
}

/**
 * Read-mostly label/value row — two columns, label in muted text and value bold.
 * Used by env configuration cards + project settings.
 */
export function ConfigRow({ label, value }: ConfigRowProps) {
  return (
    <div className="row between dda-config-row" style={{ minHeight: 36 }}>
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
