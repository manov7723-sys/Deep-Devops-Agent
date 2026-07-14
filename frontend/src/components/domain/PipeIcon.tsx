import { Icon, type IconName } from "@/components/ui";

export type PipelineStatus = "ok" | "running" | "failed";

export interface PipeIconProps {
  status: PipelineStatus;
  size?: number;
}

const ICON: Record<PipelineStatus, { icon: IconName; tone: "ok" | "info" | "danger" }> = {
  ok: { icon: "check", tone: "ok" },
  running: { icon: "refresh", tone: "info" },
  failed: { icon: "x", tone: "danger" },
};

/** Tinted status tile for pipeline cards, with spin animation when running. */
export function PipeIcon({ status, size = 30 }: PipeIconProps) {
  const { icon, tone } = ICON[status];
  return (
    <span
      className="row center"
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        flex: "none",
        background: `var(--${tone}-soft)`,
        color: `var(--${tone})`,
      }}
      aria-label={status}
    >
      <Icon
        name={icon}
        size={Math.max(13, Math.round(size * 0.5))}
        className={status === "running" ? "spin" : undefined}
      />
    </span>
  );
}
