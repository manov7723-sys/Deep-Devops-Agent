"use client";

import { Avatar, Badge, Btn, Icon, type IconName } from "@/components/ui";
import { MarkdownText } from "@/components/domain/MarkdownText";
import { ProxmoxVmBox } from "@/components/domain/ProxmoxVmBox";
import { CicdSetupBox } from "@/components/domain/CicdSetupBox";
import { EksChatBox } from "@/components/domain/EksChatBox";
import { GkeChatBox } from "@/components/domain/GkeChatBox";
import { AksChatBox } from "@/components/domain/AksChatBox";
import { ClusterConnectBox } from "@/components/domain/ClusterConnectBox";
import { CloudConnectBox } from "@/components/domain/CloudConnectBox";
import { SecretEntryBox } from "@/components/domain/SecretEntryBox";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
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
  /** Project slug — lets embedded interactive boxes (e.g. ```proxmox-vm```) call the project's APIs. */
  slug?: string;
}

type OptionsData = { question?: string; options: string[]; key?: string };
type ApprovalCardData = { approvalId: string };
type Segment =
  | { type: "text"; value: string }
  | { type: "options"; data: OptionsData }
  | { type: "proxmox-vm" }
  | { type: "cicd-setup" }
  | { type: "eks-create" }
  | { type: "gke-create" }
  | { type: "aks-create" }
  | { type: "cluster-connect" }
  | { type: "cloud-connect" }
  | { type: "secret-entry" }
  | { type: "approval-card"; data: ApprovalCardData };

/** Bare (no-payload) fences that render a self-contained interactive box. */
const BARE_FENCES = [
  "proxmox-vm",
  "cicd-setup",
  "eks-create",
  "gke-create",
  "aks-create",
  "cluster-connect",
  "cloud-connect",
  "secret-entry",
] as const;
type BareFence = (typeof BARE_FENCES)[number];
function isBareFence(name: string): name is BareFence {
  return (BARE_FENCES as readonly string[]).includes(name);
}
function bareSegment(name: BareFence): Segment {
  switch (name) {
    case "proxmox-vm": return { type: "proxmox-vm" };
    case "cicd-setup": return { type: "cicd-setup" };
    case "eks-create": return { type: "eks-create" };
    case "gke-create": return { type: "gke-create" };
    case "aks-create": return { type: "aks-create" };
    case "cluster-connect": return { type: "cluster-connect" };
    case "cloud-connect": return { type: "cloud-connect" };
    case "secret-entry": return { type: "secret-entry" };
  }
}

/**
 * Pull BARE option-JSON (`{"question":…,"options":[…]}`) out of plain text and
 * turn it into clickable options segments. Cheaper models sometimes print the
 * JSON without the ```options``` fence (or print it twice) — without this the
 * user sees raw JSON instead of buttons.
 */
function extractBareOptions(value: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  for (;;) {
    const start = value.indexOf('{"question"', i);
    if (start === -1) break;
    // Balanced-brace scan (string-aware) to find the end of the JSON object.
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let j = start; j < value.length; j++) {
      const c = value[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      else if (!inStr) {
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    if (end === -1) break;
    let parsed: OptionsData | null = null;
    try {
      const j = JSON.parse(value.slice(start, end + 1)) as OptionsData;
      if (j && Array.isArray(j.options) && j.options.length > 0) parsed = j;
    } catch {
      /* not valid JSON — leave as text */
    }
    if (parsed) {
      if (start > i) out.push({ type: "text", value: value.slice(i, start) });
      out.push({ type: "options", data: parsed });
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  if (i < value.length) out.push({ type: "text", value: value.slice(i) });
  return out.length ? out : [{ type: "text", value }];
}

/** Drop back-to-back duplicate options blocks (models sometimes emit the same question twice). */
function dedupeOptions(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.type === "options") {
      const key = JSON.stringify(s.data);
      const prev = out[out.length - 1];
      const prevPrev = out[out.length - 2];
      if (prev?.type === "options" && JSON.stringify(prev.data) === key) continue;
      if (prev?.type === "text" && !prev.value.trim() && prevPrev?.type === "options" && JSON.stringify(prevPrev.data) === key) {
        out.pop();
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

/**
 * Split an agent message into text + interactive segments: ```options``` blocks
 * (clickable choices), bare option-JSON (fence forgotten), and the
 * ```proxmox-vm``` / ```cicd-setup``` fences (render interactive boxes inline).
 */
function parseSegments(text: string): Segment[] {
  const segs: Segment[] = [];
  const re = /```(options|approval-card|proxmox-vm|cicd-setup|eks-create|gke-create|aks-create|cluster-connect|cloud-connect|secret-entry)\s*([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push(...extractBareOptions(text.slice(last, m.index)));
    if (isBareFence(m[1])) {
      segs.push(bareSegment(m[1]));
    } else if (m[1] === "approval-card") {
      try {
        const data = JSON.parse(m[2].trim()) as ApprovalCardData;
        if (data && typeof data.approvalId === "string" && data.approvalId) segs.push({ type: "approval-card", data });
        else segs.push({ type: "text", value: m[0] });
      } catch {
        segs.push({ type: "text", value: m[0] });
      }
    } else {
      try {
        const data = JSON.parse(m[2].trim()) as OptionsData;
        if (data && Array.isArray(data.options) && data.options.length > 0) segs.push({ type: "options", data });
        else segs.push({ type: "text", value: m[0] });
      } catch {
        segs.push({ type: "text", value: m[0] }); // not valid JSON — show raw
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) segs.push(...extractBareOptions(text.slice(last)));
  return dedupeOptions(segs);
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
export function ChatMsg({ message: m, authorName = "You", onApprove, onRefine, interactive = false, onOption, slug }: ChatMsgProps) {
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
            ) : seg.type === "proxmox-vm" ? (
              slug ? <ProxmoxVmBox key={`pvm-${i}`} slug={slug} /> : null
            ) : seg.type === "cicd-setup" ? (
              slug ? <CicdSetupBox key={`cicd-${i}`} slug={slug} /> : null
            ) : seg.type === "eks-create" ? (
              slug ? <EksChatBox key={`eks-${i}`} slug={slug} /> : null
            ) : seg.type === "gke-create" ? (
              slug ? <GkeChatBox key={`gke-${i}`} slug={slug} /> : null
            ) : seg.type === "aks-create" ? (
              slug ? <AksChatBox key={`aks-${i}`} slug={slug} /> : null
            ) : seg.type === "cluster-connect" ? (
              slug ? <ClusterConnectBox key={`cc-${i}`} slug={slug} /> : null
            ) : seg.type === "cloud-connect" ? (
              slug ? <CloudConnectBox key={`cloud-${i}`} slug={slug} /> : null
            ) : seg.type === "secret-entry" ? (
              slug ? <SecretEntryBox key={`secret-${i}`} slug={slug} /> : null
            ) : seg.type === "approval-card" ? (
              slug ? <ApprovalCard key={`appr-${i}`} slug={slug} approvalId={seg.data.approvalId} /> : null
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
