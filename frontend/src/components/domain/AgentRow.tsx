"use client";

import { Badge, Btn, Icon, Toggle } from "@/components/ui";
import type { SeedAgent } from "@/lib/legacy-types";

export interface AgentRowProps {
  agent: SeedAgent;
  onEditPrompt?: (id: string) => void;
  onToggle?: (id: string, on: boolean) => void;
}

export function AgentRow({ agent: a, onEditPrompt, onToggle }: AgentRowProps) {
  return (
    <div className="card card-pad">
      <div className="row between wrap gap-3">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="row center dda-agent-tile" data-on={a.on ? "true" : undefined}>
            <Icon name="bot" size={20} />
          </span>
          <div className="col" style={{ lineHeight: 1.4, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>{a.name}</span>
            <span className="faint" style={{ fontSize: 12.5 }}>
              {a.skill}
            </span>
          </div>
        </div>
        <div className="row gap-3">
          <Btn size="sm" variant="outline" icon="edit" onClick={() => onEditPrompt?.(a.id)}>
            Prompt
          </Btn>
          <Toggle
            checked={a.on}
            onCheckedChange={(v) => onToggle?.(a.id, v)}
            ariaLabel={`${a.name} enabled`}
          />
        </div>
      </div>
      <div className="row gap-2 wrap" style={{ marginTop: 14 }}>
        <Badge icon="zap">Trigger: {a.trigger}</Badge>
        <Badge icon="approve">{a.approvals}</Badge>
        <Badge icon="model">{a.model}</Badge>
      </div>
    </div>
  );
}
