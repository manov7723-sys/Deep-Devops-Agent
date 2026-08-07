"use client";

/**
 * Project team chat — human conversation between everyone with a Membership
 * on the project. Distinct from the LLM agent chat at /p/[slug]/chat.
 *
 * Polls every 3 seconds. Real-time (SSE) is the intended upgrade path; the
 * schema and route shape are ready for it — swap the useQuery for an SSE
 * subscription and drop the interval.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Icon, Input, PageHead } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Message = {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  author: { id: string; name: string; email: string };
  mentionedUserIds: string[];
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
};
type MessagesResp = { ok: true; messages: Message[]; unread: number };
type MembersResp = {
  ok: true;
  members: Array<{ id: string; email: string; name: string; role: string; joinedAt: string }>;
};

const REACTIONS = ["👍", "❤️", "😂", "🎉", "🚀", "👀", "✅"] as const;

export function TeamChatClient({ slug }: { slug: string }) {
  const qc = useQueryClient();

  const messagesQ = useQuery<MessagesResp>({
    queryKey: ["p", slug, "team-chat", "messages"],
    queryFn: () => api.get<MessagesResp>(`/projects/${slug}/team-chat/messages`),
    // 3s polling — the requested cadence. Real-time upgrade path: SSE.
    refetchInterval: 3_000,
    staleTime: 0,
  });
  const membersQ = useQuery<MembersResp>({
    queryKey: ["p", slug, "team-chat", "members"],
    queryFn: () => api.get<MembersResp>(`/projects/${slug}/team-chat/members`),
    // Members change rarely — cache aggressively so the poll cost stays with
    // messages only.
    staleTime: 5 * 60_000,
  });
  const meQ = useQuery<{ user: { id: string } }>({
    queryKey: ["auth", "me"],
    queryFn: () => api.get("/auth/me"),
    staleTime: 60_000,
  });

  const messages = messagesQ.data?.ok ? messagesQ.data.messages : [];
  const members = membersQ.data?.ok ? membersQ.data.members : [];
  const meId = meQ.data?.user.id;

  // Auto-scroll to bottom when new messages arrive, but only when the user
  // is already ~near the bottom — jumping the reader mid-scroll while they
  // read history is the classic chat annoyance.
  const paneRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(0);
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const nearBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 120;
    if (messages.length > lastCountRef.current && nearBottom) {
      pane.scrollTop = pane.scrollHeight;
    }
    lastCountRef.current = messages.length;
  }, [messages.length]);
  // Also scroll on first mount so we open at "latest" instead of the top.
  useEffect(() => {
    const pane = paneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, []);

  // Advance the read cursor to the newest message we've rendered. Fires on
  // every message change AND on window focus, so a tab returning from
  // background clears the badge promptly.
  useEffect(() => {
    if (messages.length === 0) return;
    const newest = messages[messages.length - 1]!.createdAt;
    void api.post(`/projects/${slug}/team-chat/read`, { at: newest }).catch(() => {});
  }, [messages, slug]);

  const [draft, setDraft] = useState("");
  const send = useMutation({
    mutationFn: () => api.post(`/projects/${slug}/team-chat/messages`, { body: draft.trim() }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["p", slug, "team-chat", "messages"] });
    },
  });

  const react = useMutation({
    mutationFn: (args: { messageId: string; emoji: string }) =>
      api.post(`/projects/${slug}/team-chat/messages/${args.messageId}/reactions`, {
        emoji: args.emoji,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "team-chat", "messages"] }),
  });

  return (
    <>
      <PageHead
        title="Team chat"
        sub="Human conversation for everyone on this project. Members are auto-added; @mention someone by first-name or email-local."
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr minmax(220px, 260px)",
          gap: 16,
          height: "calc(100vh - 220px)",
          minHeight: 480,
        }}
      >
        {/* ── message pane ─────────────────────────────────── */}
        <div
          className="card"
          style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 0 }}
        >
          <div
            ref={paneRef}
            style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}
          >
            {messages.length === 0 ? (
              <p style={{ opacity: 0.6, textAlign: "center", marginTop: 40 }}>
                No messages yet. Say something.
              </p>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  isMine={m.author.id === meId}
                  onReact={(emoji) => react.mutate({ messageId: m.id, emoji })}
                />
              ))
            )}
          </div>

          {/* composer */}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              padding: "10px 12px",
              display: "flex",
              gap: 8,
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message the project team… use @name to mention someone"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
                  e.preventDefault();
                  send.mutate();
                }
              }}
            />
            <Btn
              variant="primary"
              disabled={!draft.trim() || send.isPending}
              onClick={() => send.mutate()}
            >
              Send
            </Btn>
          </div>
          {send.error && (
            <p style={{ color: "var(--danger)", fontSize: 12, padding: "0 12px 8px" }}>
              {apiErrorMessage(send.error)}
            </p>
          )}
        </div>

        {/* ── members panel ────────────────────────────────── */}
        <Block>
          <h4 style={{ marginTop: 0, marginBottom: 10, fontSize: 13, opacity: 0.7 }}>
            MEMBERS ({members.length})
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {members.map((m) => (
              <div
                key={m.id}
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {(m.name || m.email)[0]?.toUpperCase()}
                </span>
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {m.name || m.email}
                </span>
                {m.role === "owner" && (
                  <span style={{ marginLeft: "auto" }}>
                    <Badge tone="accent">owner</Badge>
                  </span>
                )}
              </div>
            ))}
          </div>
        </Block>
      </div>
    </>
  );
}

function MessageRow({
  m,
  isMine,
  onReact,
}: {
  m: Message;
  isMine: boolean;
  onReact: (emoji: string) => void;
}) {
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        marginBottom: 14,
        opacity: m.isDeleted ? 0.55 : 1,
      }}
      onMouseLeave={() => setShowReactionPicker(false)}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: isMine ? "var(--accent-soft, rgba(120,120,255,.2))" : "var(--surface-2)",
          display: "grid",
          placeItems: "center",
          fontSize: 12,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {(m.author.name || m.author.email)[0]?.toUpperCase()}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <strong style={{ fontSize: 13 }}>{m.author.name || m.author.email}</strong>
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {m.editedAt && " (edited)"}
          </span>
          <button
            aria-label="React"
            onClick={() => setShowReactionPicker((s) => !s)}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              opacity: 0.5,
              fontSize: 14,
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        <div style={{ fontSize: 14, marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {m.body}
        </div>
        {m.reactions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(r.emoji)}
                title={r.mine ? "You reacted — click to remove" : "Add your reaction"}
                style={{
                  display: "inline-flex",
                  gap: 4,
                  alignItems: "center",
                  padding: "2px 8px",
                  fontSize: 12,
                  border: r.mine ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: r.mine ? "var(--accent-soft, rgba(120,120,255,.14))" : "transparent",
                  borderRadius: 12,
                  cursor: "pointer",
                }}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {showReactionPicker && (
          <div
            style={{
              display: "flex",
              gap: 2,
              marginTop: 6,
              padding: "3px 6px",
              background: "var(--surface-2)",
              borderRadius: 16,
              width: "fit-content",
              border: "1px solid var(--border)",
            }}
          >
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  onReact(emoji);
                  setShowReactionPicker(false);
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 16,
                  padding: "2px 4px",
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
