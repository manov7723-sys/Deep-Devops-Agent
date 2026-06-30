"use client";

import type { ReactNode } from "react";
import { Badge, Btn, Icon } from "@/components/ui";
import type { SeedPlan } from "@/lib/legacy-types";

export interface PlanCardProps {
  plan: SeedPlan;
  /** True if this is the user's current plan — renders the Current badge. */
  current?: boolean;
  /** True for the recommended tier — shows the Most popular badge + accent border. */
  popular?: boolean;
  /** Action CTA — defaults to a sensible label per state. */
  cta?: ReactNode;
  onAction?: () => void;
}

function defaultCta(plan: SeedPlan, current: boolean): { label: string; variant: "primary" | "outline" } {
  if (current) return { label: "Current plan", variant: "outline" };
  if (plan.name === "Free") return { label: "Downgrade", variant: "outline" };
  if (plan.name === "Enterprise") return { label: "Contact sales", variant: "primary" };
  return { label: "Upgrade", variant: "primary" };
}

export function PlanCard({ plan, current = false, popular = false, cta, onAction }: PlanCardProps) {
  const accent = popular || plan.popular;
  const action = defaultCta(plan, current);

  return (
    <div
      className="card card-pad col gap-3 dda-plan-card"
      data-popular={accent ? "true" : undefined}
      data-current={current ? "true" : undefined}
      style={{
        borderColor: accent || current ? "var(--accent-line)" : "var(--border)",
        position: "relative",
      }}
    >
      {accent && !current && (
        <span className="badge accent dda-plan-pop">Most popular</span>
      )}
      {current && <span className="badge accent dda-plan-pop">Current</span>}
      <span style={{ fontWeight: 700, fontSize: 15 }}>{plan.name}</span>
      <div className="row gap-1" style={{ alignItems: "baseline" }}>
        <span style={{ fontSize: 26, fontWeight: 800 }}>{plan.price}</span>
        <span className="muted">{plan.period}</span>
      </div>
      <div className="col gap-2" style={{ marginTop: 4 }}>
        {plan.highlights.map((h) => (
          <span key={h} className="row gap-2" style={{ fontSize: 12.5 }}>
            <Icon name="check" size={14} style={{ color: "var(--ok)" }} />
            {h}
          </span>
        ))}
      </div>
      {cta ?? (
        <Btn variant={action.variant} block onClick={onAction} disabled={current}>
          {action.label}
        </Btn>
      )}
    </div>
  );
}
