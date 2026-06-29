"use client";

import { Avatar, Badge, Btn, Icon, type IconName } from "@/components/ui";
import { MarkdownText } from "@/components/domain/MarkdownText";
import type { SeedChatMessage } from "@/lib/legacy-types";

export interface ChatMsgProps {
  message: SeedChatMessage;
  authorName?: string;
  onApprove?: (prNumber: number) => void;
  onRefine?: () => void;
  /** When true, ```options``` blocks render as clickable buttons (latest msg only). */
  interactive?: boolean;
  /** Called when the user clicks an option — sends it as the next message. */
  onOption?: (value: string) => void;
}

type OptionsData = { question?: string; options: string[]; key?: string };
type Segment = { type: "text"; value: string } | { type: "options"; data: OptionsData };

/** Split an agent message into text + ```options``` interactive segments. */
function parseSegments(text: string): Segment[] {
  const segs: Segment[] = [];
  const re = /```options\s*([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ type: "text", value: text.slice(last, m.index) });
    try {
      const data = JSON.parse(m[1].trim()) as OptionsData;
      if (data && Array.isArray(data.options) && data.options.length > 0) segs.push({ type: "options", data });
      else segs.push({ type: "text", value: m[0] });
    } catch {
      segs.push({ type: "text", value: m[0] }); // not valid JSON — show raw
    }
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
  return segs;
}

function OptionsBlock({
  data,
  interactive,
  onSelect,
}: {
  data: OptionsData;
  interactive: boolean;
  onSelect?: (value: string) => void;
}) {
  return (
    <div className="card" style={{ padding: 10 }}>
      {data.question && (
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{data.question}</div>
      )}
      <div className="row gap-2 wrap">
        {data.options.map((o) => (
          <Btn
            key={o}
            size="sm"
            variant="outline"
            disabled={!interactive}
            onClick={() => interactive && onSelect?.(o)}
          >
            {o}
          </Btn>
        ))}
      </div>
    </div>
  );
}

/**
 * One chat message. User messages render right-aligned in an accent-soft bubble.
 * Agent messages render left with optional plan steps card, code block w/ copy,
 * and a PR action row.
 */
export function ChatMsg({ message: m, authorName = "You", onApprove, onRefine, interactive = false, onOption }: ChatMsgProps) {
  if (m.role === "user") {
    return (
      <div className="row gap-3 dda-chat-row" style={{ flexDirection: "row-reverse" }}>
        <Avatar name={authorName} size={30} />
        <div className="dda-chat-user-bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="row gap-3 dda-chat-row">
      <span className="row center dda-chat-agent-tile">
        <Icon name="bot" size={16} />
      </span>
      <div className="col gap-3" style={{ maxWidth: "84%", minWidth: 0 }}>
        <div className="dda-chat-agent-bubble">
          {parseSegments(m.text).map((seg, i) =>
            seg.type === "options" ? (
              <OptionsBlock key={`opt-${i}`} data={seg.data} interactive={interactive} onSelect={onOption} />
            ) : seg.value.trim() ? (
              <MarkdownText key={`txt-${i}`} text={seg.value} />
            ) : null,
          )}
        </div>
        {m.plan && (
          <div className="card" style={{ padding: 6 }}>
            {m.plan.map((p, i) => (
              <div key={`${m.id}-plan-${i}`} className="row gap-3 dda-chat-plan-row">
                <span className="row center dda-chat-plan-icon">
                  <Icon name={p[0] as IconName} size={14} />
                </span>
                <span className="grow" style={{ fontSize: 12.5, fontWeight: 600 }}>{p[1]}</span>
                <Badge>{p[2]}</Badge>
              </div>
            ))}
          </div>
        )}
        {m.code && (
          <div className="card mono dda-chat-code">
            <div className="row between dda-chat-code-head">
              <span className="row gap-2" style={{ fontSize: 11.5 }}>
                <Icon name="layers" size={13} />
                {m.codeLang ?? "snippet.tf"}
              </span>
              <Btn variant="ghost" size="icon" aria-label="Copy code">
                <Icon name="copy" size={13} />
              </Btn>
            </div>
            <pre className="dda-chat-code-body">{m.code}</pre>
          </div>
        )}
        {m.pr && (
          <div className="row gap-2 wrap">
            <Btn size="sm" variant="primary" icon="approve" onClick={() => onApprove?.(m.pr!.number)}>
              Approve &amp; apply
            </Btn>
            <Btn size="sm" variant="outline" icon="github">
              View draft PR #{m.pr.number}
            </Btn>
            <Btn size="sm" variant="ghost" icon="edit" onClick={onRefine}>
              Refine
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
