"use client";

import { Badge, Btn, Progress } from "@/components/ui";
import { PipeIcon } from "./PipeIcon";
import type { SeedPipeline } from "@/lib/legacy-types";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info" } as const;

export interface PipelineCardProps {
  pipeline: SeedPipeline;
}

export function PipelineCard({ pipeline: p }: PipelineCardProps) {
  return (
    <div className="card card-pad">
      <div className="row between wrap gap-3" style={{ marginBottom: 14 }}>
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <PipeIcon status={p.status} size={36} />
          <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
            <span className="row gap-2" style={{ fontWeight: 700, fontSize: 14 }}>
              {p.repo}
              <Badge tone={ENV_TONE[p.env]}>{p.env}</Badge>
            </span>
            <span className="faint mono" style={{ fontSize: 11.5 }}>
              {p.sha} · {p.branch} · by {p.who}
            </span>
          </div>
        </div>
        <div className="row gap-3" style={{ flex: "none" }}>
          <div className="col hide-sm" style={{ alignItems: "flex-end", lineHeight: 1.3 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>
              {p.status === "running" ? "Running" : p.status === "failed" ? "Failed" : "Succeeded"}
            </span>
            <span className="faint" style={{ fontSize: 11 }}>
              {p.duration} · {p.startedRelative}
            </span>
          </div>
          {p.status === "failed" ? (
            <Btn size="sm" variant="outline" icon="refresh">
              Retry
            </Btn>
          ) : (
            <Btn size="sm" variant="ghost" icon="ext" aria-label="Open" />
          )}
        </div>
      </div>
      <div className="row gap-1 wrap" style={{ alignItems: "stretch" }}>
        {p.stages.map((s, i) => {
          const tone =
            s.status === "ok"
              ? "ok"
              : s.status === "fail"
                ? "danger"
                : s.status === "run"
                  ? "info"
                  : "";
          return (
            <div
              key={`${s.label}-${i}`}
              className="row gap-2 dda-pipeline-stage"
              data-state={s.status}
              style={{
                borderColor: s.status === "fail" ? "var(--danger)" : "var(--border-soft)",
              }}
            >
              <span
                className={`dot ${tone} ${s.status === "run" ? "pulse" : ""}`}
                style={{ flex: "none" }}
              />
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: s.status === "wait" ? "var(--text-faint)" : "var(--text)",
                }}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
      {p.status === "running" && (
        <div style={{ marginTop: 12 }}>
          <Progress value={p.progressPct} ariaLabel="Pipeline progress" />
        </div>
      )}
    </div>
  );
}
