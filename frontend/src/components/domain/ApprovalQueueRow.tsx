"use client";

import { Badge } from "@/components/ui";
import type { SeedApproval } from "@/lib/legacy-types";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info" } as const;

function riskDot(risk: SeedApproval["risk"]): "danger" | "warn" | "ok" {
  return risk === "high" ? "danger" : risk === "medium" ? "warn" : "ok";
}

export interface ApprovalQueueRowProps {
  approval: SeedApproval;
  active: boolean;
  /** Optional already-acted indicator — "approved" or "rejected". */
  decision?: "approve" | "reject" | null;
  onSelect: (id: string) => void;
}

export function ApprovalQueueRow({
  approval: a,
  active,
  decision,
  onSelect,
}: ApprovalQueueRowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(a.id)}
      className="row gap-3 between dda-approval-row"
      data-active={active ? "true" : undefined}
    >
      <div className="row gap-3" style={{ minWidth: 0 }}>
        <span className={`dot ${riskDot(a.risk)}`} style={{ flex: "none" }} />
        <div className="col" style={{ minWidth: 0, lineHeight: 1.35, textAlign: "left" }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {a.title}
          </span>
          <span className="faint" style={{ fontSize: 11 }}>
            {a.agent} · {a.requestedRelative}
          </span>
        </div>
      </div>
      {decision ? (
        <Badge tone={decision === "approve" ? "ok" : "danger"}>
          {decision === "approve" ? "Approved" : "Rejected"}
        </Badge>
      ) : (
        <Badge tone={ENV_TONE[a.env]}>{a.env}</Badge>
      )}
    </button>
  );
}
