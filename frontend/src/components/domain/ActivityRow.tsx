import { Badge, Icon, type IconName } from "@/components/ui";

const ENV_TONE: Record<string, "ok" | "warn" | "info" | "default"> = {
  release: "ok",
  beta: "warn",
  alpha: "info",
  shared: "default",
};

/** Shape now matches the server's `ActivityRow` from `lib/agentops/activity.ts`. */
export interface ActivityRowShape {
  id: string;
  envKey: string | null;
  actorName: string;
  actorKind: "user" | "agent" | "system";
  action: string;
  targetLabel: string;
  targetType: string | null;
  icon: string | null;
  createdAt: string;
}

export interface ActivityRowProps {
  a: ActivityRowShape;
}

/** Human-relative timestamp without bringing in a date library. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  return `${mo}mo`;
}

/**
 * Activity feed row — avatar tile + actor/action/target + env badge + relative
 * time. The icon tile tints to accent when the actor is an agent.
 */
export function ActivityRow({ a }: ActivityRowProps) {
  const agent = a.actorKind === "agent";
  const icon = (a.icon ?? "activity") as IconName;
  const envBadge = a.envKey ?? "shared";
  return (
    <div className="row gap-3 dda-activity-row">
      <span
        className="row center"
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          flex: "none",
          background: "var(--surface-2)",
          color: agent ? "var(--accent)" : "var(--text-muted)",
        }}
      >
        <Icon name={icon} size={15} />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13 }}>
          <b>{a.actorName}</b>{" "}
          <span className="muted">{a.action}</span>{" "}
          {a.targetLabel}
        </span>
      </div>
      <div className="row gap-3" style={{ flex: "none" }}>
        <Badge tone={ENV_TONE[envBadge] ?? "default"}>{envBadge}</Badge>
        <span className="faint" style={{ fontSize: 11.5, width: 50, textAlign: "right" }}>
          {timeAgo(a.createdAt)}
        </span>
      </div>
    </div>
  );
}
