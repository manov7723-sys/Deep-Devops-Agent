"use client";

import { Badge, Btn, Icon, Meter, StatusDot, type IconName } from "@/components/ui";
import type { CloudCategory, SeedCloudResource } from "@/lib/legacy-types";

const ENV_TONE = { release: "ok", beta: "warn", alpha: "info" } as const;

const CAT_ICON: Record<CloudCategory, IconName> = {
  compute: "cpu",
  network: "globe",
  storage: "box",
  data: "db",
};

export interface CloudStatsCardProps {
  resource: SeedCloudResource;
}

export function CloudStatsCard({ resource: s }: CloudStatsCardProps) {
  const metered = s.category === "compute" || s.category === "data";
  return (
    <div className="card card-pad col gap-3">
      <div className="row between">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="row center dda-cloud-stat-icon">
            <Icon name={CAT_ICON[s.category]} size={18} />
          </span>
          <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
            <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{s.name}</span>
            <span className="faint" style={{ fontSize: 11.5 }}>{s.type} · {s.region}</span>
          </div>
        </div>
        <StatusDot tone={s.status} />
      </div>

      <div className="row gap-2 wrap">
        <span className="badge" style={{ background: "var(--surface-2)" }}>{s.badges[0]}</span>
        <span className="badge" style={{ background: "var(--surface-2)" }}>{s.badges[1]}</span>
        <Badge tone={ENV_TONE[s.env]}>{s.env}</Badge>
      </div>

      {metered && (s.cpu !== undefined || s.mem !== undefined) && (
        <div className="col gap-2" style={{ marginTop: 2 }}>
          {s.cpu !== undefined && <Meter label="CPU" value={s.cpu} />}
          {s.mem !== undefined && <Meter label="Memory" value={s.mem} />}
        </div>
      )}

      {s.policy && (
        <div className="col gap-1 dda-cloud-policy">
          <span className="faint" style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Bucket policy
          </span>
          <span
            className="mono"
            style={{
              fontSize: 11.5,
              color: s.policy.includes("ON") ? "var(--warn)" : "var(--text-muted)",
            }}
          >
            {s.policy}
          </span>
        </div>
      )}

      <div className="row gap-2">
        <Btn size="sm" variant="outline" icon="stats" block>
          Metrics
        </Btn>
        <Btn size="sm" variant="ghost" icon="terminal" aria-label="Terminal" />
        <Btn size="sm" variant="ghost" icon="ext" aria-label="Open" />
      </div>
    </div>
  );
}
