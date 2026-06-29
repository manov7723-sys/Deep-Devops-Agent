import type { ReactNode } from "react";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, hint, error, required, children }: FieldProps) {
  return (
    <label className="col" style={{ gap: 0 }}>
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
