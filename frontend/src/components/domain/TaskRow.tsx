"use client";

import { Badge, Btn, Icon, Progress, type IconName } from "@/components/ui";
import type { SeedTask } from "@/lib/legacy-types";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info" } as const;

const STATUS_COLOR: Record<SeedTask["status"], string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  running: "var(--info)",
};

const STATUS_BG: Record<SeedTask["status"], { bg: string; fg: string }> = {
  ok: { bg: "var(--accent-soft)", fg: "var(--accent)" },
  warn: { bg: "var(--warn-soft)", fg: "var(--warn)" },
  running: { bg: "var(--info-soft)", fg: "var(--info)" },
};

export interface TaskRowProps {
  task: SeedTask;
  onRun?: (id: string) => void;
}

export function TaskRow({ task: t, onRun }: TaskRowProps) {
  const bg = STATUS_BG[t.status];
  const envLabel = t.env === "all" ? "all envs" : t.env;
  const envTone = t.env === "all" ? "default" : ENV_TONE[t.env as keyof typeof ENV_TONE];
  return (
    <div className="card card-pad">
      <div className="row between wrap gap-3">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="row center dda-task-icon" style={{ background: bg.bg, color: bg.fg }}>
            <Icon name={t.icon as IconName} size={19} />
          </span>
          <div className="col" style={{ lineHeight: 1.4, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</span>
            <span className="row gap-2 faint wrap" style={{ fontSize: 11.5 }}>
              <span className="row gap-1">
                <Icon name="bot" size={12} /> {t.agent}
              </span>
              <span>·</span>
              <span>{t.schedule}</span>
              <span>·</span>
              <span>last: {t.lastRun}</span>
            </span>
          </div>
        </div>
        <div className="row gap-3" style={{ flex: "none", alignItems: "center" }}>
          <div className="col hide-sm" style={{ alignItems: "flex-end", lineHeight: 1.3 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: STATUS_COLOR[t.status] }}>
              {t.findings}
            </span>
            <Badge tone={envTone}>{envLabel}</Badge>
          </div>
          {t.status === "running" ? (
            <span
              className="row gap-2"
              style={{ color: "var(--info)", fontSize: 12.5, fontWeight: 700 }}
            >
              <Icon name="refresh" size={15} className="spin" />
              Running
            </span>
          ) : (
            <Btn size="sm" variant="ghost" icon="play" onClick={() => onRun?.(t.id)}>
              Run
            </Btn>
          )}
        </div>
      </div>
      {t.status === "running" && typeof t.progressPct === "number" && (
        <div style={{ marginTop: 12 }}>
          <Progress value={t.progressPct} ariaLabel="Task progress" />
        </div>
      )}
    </div>
  );
}
