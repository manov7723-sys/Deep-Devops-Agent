import { Icon } from "./Icon";

export interface WizardStepsProps {
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
}

export function WizardSteps({ steps, current }: WizardStepsProps) {
  return (
    <div
      className="row"
      style={{ marginBottom: 22, alignItems: "center" }}
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={steps.length}
      aria-valuenow={current + 1}
    >
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div
            key={label}
            className="row"
            style={{ flex: i < steps.length - 1 ? 1 : "none", alignItems: "center" }}
          >
            <div className="row gap-2" style={{ alignItems: "center", flex: "none" }}>
              <span
                className="row center"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 99,
                  fontSize: 12,
                  fontWeight: 700,
                  background: done
                    ? "var(--accent)"
                    : active
                      ? "var(--accent-soft)"
                      : "var(--surface-2)",
                  color: done ? "var(--accent-fg)" : active ? "var(--accent)" : "var(--text-faint)",
                  border: `1px solid ${active ? "var(--accent-line)" : "var(--border)"}`,
                  transition: "all .15s",
                }}
              >
                {done ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span
                className="hide-sm"
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: i <= current ? "var(--text)" : "var(--text-faint)",
                }}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className="grow"
                style={{
                  height: 2,
                  borderRadius: 2,
                  background: done ? "var(--accent)" : "var(--border)",
                  margin: "0 10px",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
