import { cn } from "@/lib/utils/cn";

export type ProgressTone = "default" | "ok" | "warn" | "danger";

export interface ProgressProps {
  value: number;
  tone?: ProgressTone;
  height?: number;
  ariaLabel?: string;
}

const toneClass: Record<ProgressTone, string> = {
  default: "",
  ok: "ok",
  warn: "warn",
  danger: "danger",
};

export function Progress({ value, tone = "default", height = 6, ariaLabel }: ProgressProps) {
  const v = Math.min(100, Math.max(0, value));
  return (
    <div
      className={cn("prog", toneClass[tone])}
      style={{ height }}
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
    >
      <i style={{ width: `${v}%` }} />
    </div>
  );
}
