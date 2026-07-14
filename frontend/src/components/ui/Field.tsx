import type { CSSProperties, ReactNode } from "react";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /**
   * Cap the field's max width so inputs don't stretch to the full container.
   * Pages used to wrap every `<Field>` in `<div style={{minWidth: N}}>` at
   * 150/180/220/240/320 — this consolidates the pattern. Common values:
   * 220 (short: date, small select), 320 (medium: name, region),
   * 480 (long: URL, path). Unset = fill parent (form column).
   */
  maxWidth?: number;
  children: ReactNode;
}

export function Field({ label, hint, error, required, maxWidth, children }: FieldProps) {
  const style: CSSProperties | undefined = maxWidth
    ? { gap: 0, maxWidth, width: "100%" }
    : { gap: 0 };
  return (
    <label className="col" style={style}>
      {label && (
        <span className="field-label">
          {label}
          {required && (
            <span style={{ color: "var(--danger)", marginLeft: 4 }} aria-hidden>
              *
            </span>
          )}
        </span>
      )}
      {children}
      {error ? (
        <span style={{ fontSize: 11.5, marginTop: 5, color: "var(--danger)" }}>{error}</span>
      ) : hint ? (
        <span className="faint" style={{ fontSize: 11.5, marginTop: 5 }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}
