import { cn } from "@/lib/utils/cn";

export type DotTone = "default" | "ok" | "warn" | "danger" | "info";

export interface StatusDotProps {
  tone?: DotTone;
  pulse?: boolean;
  label?: string;
}

export function StatusDot({ tone = "ok", pulse, label }: StatusDotProps) {
  return (
    <span className="row gap-2">
      <span className={cn("dot", tone, pulse && "pulse")} />
      {label && <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>}
    </span>
  );
}
