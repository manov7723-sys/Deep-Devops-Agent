"use client";

import { Badge, Btn, Icon, type IconName } from "@/components/ui";
import type { SeedAlert } from "@/lib/legacy-types";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info" } as const;

function sevTone(sev: SeedAlert["sev"]): "danger" | "warn" | "info" {
  return sev === "high" ? "danger" : sev === "medium" ? "warn" : "info";
}

function catIcon(cat: SeedAlert["cat"]): IconName {
  if (cat === "Security" || cat === "Compliance") return "shield";
  if (cat === "Performance") return "activity";
  return "alert";
}

export interface AlertCardProps {
  alert: SeedAlert;
  /** Local decision override — if the user clicked Acknowledge / Resolve. */
  override?: "ack" | "resolve" | null;
  onAck?: (id: string) => void;
  onResolve?: (id: string) => void;
  onAsk?: (id: string) => void;
}

export function AlertCard({ alert: a, override, onAck, onResolve, onAsk }: AlertCardProps) {
  const status = override ? (override === "ack" ? "ack" : "resolved") : a.status;
  const tone = sevTone(a.sev);
  return (
    <div
      className="card card-pad dda-alert-card"
      style={{ borderLeft: `3px solid var(--${tone})` }}
    >
      <div className="row between wrap gap-3">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span
            className="row center dda-alert-icon"
            style={{ background: `var(--${tone}-soft)`, color: `var(--${tone})` }}
          >
            <Icon name={catIcon(a.cat)} size={20} />
          </span>
          <div className="col" style={{ lineHeight: 1.4, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.3 }} className="tx-pretty">
              {a.title}
            </span>
            <span className="row gap-2 faint wrap" style={{ fontSize: 11.5, marginTop: 5 }}>
              <span className="mono">{a.resource}</span>
              <span>·</span>
              <span className="row gap-1">
                <Icon name="bot" size={12} />
                {a.source}
              </span>
              <span>·</span>
              <span>{a.when}</span>
            </span>
          </div>
        </div>
        <div className="row gap-2" style={{ flex: "none" }}>
          <Badge tone={tone} icon="alert">
            {a.sev}
          </Badge>
          <Badge tone={ENV_TONE[a.env]}>{a.env}</Badge>
        </div>
      </div>

      <p className="muted tx-pretty" style={{ fontSize: 13, lineHeight: 1.55, margin: "12px 0 0" }}>
        {a.detail}
      </p>

      <div className="row between wrap gap-3" style={{ marginTop: 14 }}>
        <span className="row gap-2" style={{ fontSize: 12.5 }}>
          <Icon name="zap" size={14} style={{ color: "var(--accent)", flex: "none" }} />
          <span className="muted">Recommended:</span>
          <b>{a.recommendation}</b>
        </span>
        {status === "resolved" ? (
          <Badge tone="ok" icon="check">
            Resolved
          </Badge>
        ) : status === "ack" ? (
          <div className="row gap-2">
            <Badge tone="info" icon="eye">
              Acknowledged
            </Badge>
            <Btn size="sm" variant="primary" icon="check" onClick={() => onResolve?.(a.id)}>
              Resolve
            </Btn>
          </div>
        ) : (
          <div className="row gap-2 wrap">
            <Btn size="sm" variant="primary" icon="check" onClick={() => onResolve?.(a.id)}>
              Resolve
            </Btn>
            <Btn size="sm" variant="outline" icon="eye" onClick={() => onAck?.(a.id)}>
              Acknowledge
            </Btn>
            <Btn size="sm" variant="ghost" icon="chat" onClick={() => onAsk?.(a.id)}>
              Ask agent
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
