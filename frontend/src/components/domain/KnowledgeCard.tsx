"use client";

import { Badge, Icon } from "@/components/ui";
import type { SeedKnowledgeDoc } from "@/lib/legacy-types";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info", shared: "default" } as const;

export interface KnowledgeCardProps {
  doc: SeedKnowledgeDoc;
  /** Optional search term to highlight in title/excerpt. */
  highlight?: string;
}

function withHighlight(text: string, term: string) {
  const t = term.trim();
  if (!t) return text;
  const idx = text.toLowerCase().indexOf(t.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="dda-kb-mark">{text.slice(idx, idx + t.length)}</mark>
      {text.slice(idx + t.length)}
    </>
  );
}

export function KnowledgeCard({ doc: k, highlight = "" }: KnowledgeCardProps) {
  const runbook = k.type === "Runbook";
  return (
    <div className="card card-pad col gap-3 dda-kb-card">
      <div className="row between">
        <span
          className="row center dda-kb-icon"
          style={{ color: runbook ? "var(--accent)" : "var(--info)" }}
        >
          <Icon name={runbook ? "terminal" : "book"} size={18} />
        </span>
        <Badge tone={runbook ? "accent" : "info"}>{k.type}</Badge>
      </div>
      <div className="col gap-1">
        <span style={{ fontWeight: 700, fontSize: 14 }}>{withHighlight(k.title, highlight)}</span>
        <span className="muted tx-pretty" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
          {withHighlight(k.excerpt, highlight)}
        </span>
      </div>
      <div className="row gap-2 wrap">
        {k.tags.map((t) => (
          <span key={t} className="badge" style={{ background: "var(--surface-2)" }}>
            #{t}
          </span>
        ))}
      </div>
      <div className="divider" />
      <div className="row between faint" style={{ fontSize: 11.5 }}>
        <span className="row gap-2">
          <span className="row gap-1">
            <Icon name="github" size={12} />
            {k.repo}
          </span>
          <Badge tone={ENV_TONE[k.env]}>{k.env}</Badge>
        </span>
        <span>Updated {k.updated}</span>
      </div>
    </div>
  );
}
