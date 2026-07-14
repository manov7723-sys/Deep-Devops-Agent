"use client";

import { Spark, StatusDot } from "@/components/ui";
import type { SeedObservabilityKpi } from "@/lib/legacy-types";

const TONE_VAR: Record<SeedObservabilityKpi["tone"], string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  info: "var(--info)",
};

export interface ObservabilityKpiProps {
  kpi: SeedObservabilityKpi;
}

export function ObservabilityKpi({ kpi }: ObservabilityKpiProps) {
  return (
    <div className="card card-pad col gap-3">
      <div className="row between">
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
          {kpi.name}
        </span>
        <StatusDot tone={kpi.tone} />
      </div>
      <span style={{ fontSize: 26, fontWeight: 800 }} className="tnum">
        {kpi.value}
      </span>
      <Spark
        data={kpi.data}
        width={200}
        height={40}
        tone={TONE_VAR[kpi.tone]}
        ariaLabel={`${kpi.name} trend`}
      />
    </div>
  );
}
