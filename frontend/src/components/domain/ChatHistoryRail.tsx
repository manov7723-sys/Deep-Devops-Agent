"use client";

import { useMemo } from "react";
import { Btn, Icon } from "@/components/ui";
import { useChatThreads, type ChatThreadSummary } from "@/hooks/queries/project";

export interface ChatHistoryRailProps {
  slug: string;
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
  disabled?: boolean;
}

/**
 * Right-side history rail: lists the project's chat threads grouped by
 * recency (Today / Yesterday / Previous 7 days / Older). Clicking a row makes
 * it the active thread; New chat asks the parent to spin up a fresh one.
 */
export function ChatHistoryRail({
  slug,
  activeThreadId,
  onSelect,
  onNewChat,
  disabled,
}: ChatHistoryRailProps) {
  const { data: threads, isLoading } = useChatThreads(slug);

  const groups = useMemo(() => groupThreads(threads ?? []), [threads]);

  return (
    <aside className="dda-chat-rail" aria-label="Recent chats">
      <div className="row gap-2" style={{ padding: "12px 12px 8px", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Recent chats</span>
        <Btn
          size="sm"
          variant="primary"
          icon="plus"
          onClick={onNewChat}
          disabled={disabled}
        >
          New
        </Btn>
      </div>

      <div className="dda-chat-rail-scroll">
        {isLoading && (
          <div className="col gap-2" style={{ padding: "8px 12px" }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="dda-chat-rail-skel" />
            ))}
          </div>
        )}
        {!isLoading && (!threads || threads.length === 0) && (
          <div className="col gap-2 center" style={{ padding: "32px 16px", textAlign: "center" }}>
            <Icon name="chat" size={22} style={{ color: "var(--text-faint)" }} />
            <span className="faint" style={{ fontSize: 12 }}>
              No chats yet. Ask something to start.
            </span>
          </div>
        )}
        {!isLoading && groups.map((group) => (
          <section key={group.label} className="col gap-1" style={{ padding: "6px 8px 10px" }}>
            <h4 className="dda-chat-rail-heading">{group.label}</h4>
            {group.items.map((t) => {
              const active = t.id === activeThreadId;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`dda-chat-rail-item${active ? " is-active" : ""}`}
                  onClick={() => onSelect(t.id)}
                  disabled={disabled}
                >
                  <span className="dda-chat-rail-item-title">
                    {t.title || "Untitled chat"}
                  </span>
                  <span className="dda-chat-rail-item-meta">
                    {formatShortDate(t.lastMessageAt ?? t.updatedAt)}
                    {t.messageCount > 0 && (
                      <>
                        <span aria-hidden> · </span>
                        {t.messageCount} msg{t.messageCount === 1 ? "" : "s"}
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

type Group = { label: string; items: ChatThreadSummary[] };

function groupThreads(threads: ChatThreadSummary[]): Group[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  const yesterdayStart = todayStart - dayMs;
  const sevenDaysAgo = now - 7 * dayMs;
  const thirtyDaysAgo = now - 30 * dayMs;

  const buckets: Record<string, ChatThreadSummary[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    "Previous 30 days": [],
    Older: [],
  };

  for (const t of threads) {
    const ts = new Date(t.lastMessageAt ?? t.updatedAt).getTime();
    if (ts >= todayStart) buckets.Today!.push(t);
    else if (ts >= yesterdayStart) buckets.Yesterday!.push(t);
    else if (ts >= sevenDaysAgo) buckets["Previous 7 days"]!.push(t);
    else if (ts >= thirtyDaysAgo) buckets["Previous 30 days"]!.push(t);
    else buckets.Older!.push(t);
  }

  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
