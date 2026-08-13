"use client";

/**
 * Project team chat — human conversation between everyone with a Membership
 * on the project. Distinct from the LLM agent chat at /p/[slug]/chat.
 *
 * Features:
 *   • Text, @mentions, reactions.
 *   • Image + file attachments (multi, ≤ 25 MB each, ≤ 6 per message).
 *   • Reply-to: quoted parent renders above the reply body.
 *   • Edit / delete your own messages (soft delete → tombstone).
 *   • Typing indicators (heartbeat POST every ~3 s while composing).
 *
 * Polls every 3 seconds for messages + typing. Real-time (SSE) is the
 * intended upgrade path — swap the useQuery for an SSE subscription.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Icon, Input, PageHead } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
};
type ReplyRef = {
  id: string;
  body: string;
  authorName: string;
  isDeleted: boolean;
};
type Message = {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  isMine: boolean;
  author: { id: string; name: string; email: string };
  mentionedUserIds: string[];
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  attachments: Attachment[];
  replyTo: ReplyRef | null;
};
type MessagesResp = { ok: true; messages: Message[]; unread: number };
type MembersResp = {
  ok: true;
  members: Array<{ id: string; email: string; name: string; role: string; joinedAt: string }>;
};
type TypingResp = {
  ok: true;
  typing: Array<{ userId: string; userName: string }>;
};
type UploadResp =
  | {
      ok: true;
      attachments: Array<Attachment & { path: string }>;
    }
  | { ok: false; code?: string; message?: string };

const REACTIONS = ["👍", "❤️", "😂", "🎉", "🚀", "👀", "✅"] as const;
const TYPING_HEARTBEAT_MS = 3_000;

// Pretty-print bytes as KB/MB with one decimal — good enough for chat tiles.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TeamChatClient({ slug }: { slug: string }) {
  const qc = useQueryClient();

  const messagesQ = useQuery<MessagesResp>({
    queryKey: ["p", slug, "team-chat", "messages"],
    queryFn: () => api.get<MessagesResp>(`/projects/${slug}/team-chat/messages`),
    refetchInterval: 3_000,
    staleTime: 0,
  });
  const membersQ = useQuery<MembersResp>({
    queryKey: ["p", slug, "team-chat", "members"],
    queryFn: () => api.get<MembersResp>(`/projects/${slug}/team-chat/members`),
    staleTime: 5 * 60_000,
  });
  const typingQ = useQuery<TypingResp>({
    queryKey: ["p", slug, "team-chat", "typing"],
    queryFn: () => api.get<TypingResp>(`/projects/${slug}/team-chat/typing`),
    // Match the message-poll cadence — typing is a low-value signal and the
    // 6 s server-side expiry hides any lag from a single dropped request.
    refetchInterval: 3_000,
    staleTime: 0,
  });
  const meQ = useQuery<{ user: { id: string } }>({
    queryKey: ["auth", "me"],
    queryFn: () => api.get("/auth/me"),
    staleTime: 60_000,
  });

  const messages = messagesQ.data?.ok ? messagesQ.data.messages : [];
  const members = membersQ.data?.ok ? membersQ.data.members : [];
  const typingUsers = typingQ.data?.ok ? typingQ.data.typing : [];
  const meId = meQ.data?.user.id;

  // Composer state — text, staged attachments (uploaded but not yet sent),
  // reply target, edit target. Edit steals the composer so the user isn't
  // presented with two inputs at once.
  const [draft, setDraft] = useState("");
  const [staged, setStaged] = useState<Array<Attachment & { path: string }>>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);

  // Auto-scroll when new messages arrive AND the user is near the bottom.
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
  useEffect(() => {
    const pane = paneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, []);

  // Read cursor — advance to the newest rendered message.
  useEffect(() => {
    if (messages.length === 0) return;
    const newest = messages[messages.length - 1]!.createdAt;
    void api.post(`/projects/${slug}/team-chat/read`, { at: newest }).catch(() => {});
  }, [messages, slug]);

  // Typing heartbeat — POST /typing every TYPING_HEARTBEAT_MS while the
  // draft has content. Not on every keystroke: that would flood the endpoint
  // AND the browser's request queue on a fast typer.
  const lastHeartbeatRef = useRef(0);
  useEffect(() => {
    if (editing || draft.trim().length === 0) return;
    const now = Date.now();
    if (now - lastHeartbeatRef.current < TYPING_HEARTBEAT_MS) return;
    lastHeartbeatRef.current = now;
    void api.post(`/projects/${slug}/team-chat/typing`, {}).catch(() => {});
  }, [draft, slug, editing]);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await api.postForm<UploadResp>(
        `/projects/${slug}/team-chat/upload`,
        form,
      );
      if (!res.ok) throw new Error(res.message ?? "Upload failed.");
      return res.attachments;
    },
    onSuccess: (attachments) => {
      setStaged((s) => [...s, ...attachments]);
      setComposerError(null);
    },
    onError: (e) => setComposerError(apiErrorMessage(e, "Upload failed.")),
  });

  const send = useMutation({
    mutationFn: () => {
      const body = draft.trim();
      return api.post(`/projects/${slug}/team-chat/messages`, {
        body: body || undefined,
        attachments: staged.length
          ? staged.map((a) => ({
              id: a.id,
              name: a.name,
              mime: a.mime,
              size: a.size,
              path: a.path,
            }))
          : undefined,
        replyToId: replyTo?.id,
      });
    },
    onSuccess: () => {
      setDraft("");
      setStaged([]);
      setReplyTo(null);
      setComposerError(null);
      // Explicit stop-typing so the indicator drops immediately for peers
      // instead of waiting for the 6 s server-side idle timeout.
      void api
        .post(`/projects/${slug}/team-chat/typing`, { stop: true })
        .catch(() => {});
      void qc.invalidateQueries({ queryKey: ["p", slug, "team-chat", "messages"] });
    },
    onError: (e) => setComposerError(apiErrorMessage(e, "Send failed.")),
  });

  const react = useMutation({
    mutationFn: (args: { messageId: string; emoji: string }) =>
      api.post(`/projects/${slug}/team-chat/messages/${args.messageId}/reactions`, {
        emoji: args.emoji,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "team-chat", "messages"] }),
  });

  const editMsg = useMutation({
    mutationFn: (args: { messageId: string; body: string }) =>
      api.patch(`/projects/${slug}/team-chat/messages/${args.messageId}`, {
        body: args.body,
      }),
    onSuccess: () => {
      setEditing(null);
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["p", slug, "team-chat", "messages"] });
    },
    onError: (e) => setComposerError(apiErrorMessage(e, "Edit failed.")),
  });

  const deleteMsg = useMutation({
    mutationFn: (messageId: string) =>
      api.del(`/projects/${slug}/team-chat/messages/${messageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "team-chat", "messages"] }),
  });

  function beginEdit(m: Message) {
    setEditing(m);
    setDraft(m.body);
    setReplyTo(null);
    setStaged([]);
    setComposerError(null);
  }
  function cancelEdit() {
    setEditing(null);
    setDraft("");
  }

  function submitComposer() {
    if (editing) {
      const trimmed = draft.trim();
      if (!trimmed) return;
      editMsg.mutate({ messageId: editing.id, body: trimmed });
      return;
    }
    if (!draft.trim() && staged.length === 0) return;
    send.mutate();
  }

  const canSend = editing
    ? draft.trim().length > 0 && !editMsg.isPending
    : (draft.trim().length > 0 || staged.length > 0) && !send.isPending && !upload.isPending;

  const typingLabel = useMemo(() => {
    if (typingUsers.length === 0) return null;
    if (typingUsers.length === 1) return `${typingUsers[0]!.userName} is typing…`;
    if (typingUsers.length === 2)
      return `${typingUsers[0]!.userName} and ${typingUsers[1]!.userName} are typing…`;
    return `${typingUsers[0]!.userName} and ${typingUsers.length - 1} others are typing…`;
  }, [typingUsers]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  function pickFiles() {
    fileInputRef.current?.click();
  }
  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) upload.mutate(files);
    // Reset so picking the same file twice in a row still fires onChange.
    e.target.value = "";
  }

  return (
    <>
      <PageHead
        title="Team chat"
        sub="Human conversation for everyone on this project. @mention someone by first-name or email-local. Attach images and files inline."
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
          <div ref={paneRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
            {messages.length === 0 ? (
              <p style={{ opacity: 0.6, textAlign: "center", marginTop: 40 }}>
                No messages yet. Say something.
              </p>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  slug={slug}
                  m={m}
                  meId={meId}
                  onReact={(emoji) => react.mutate({ messageId: m.id, emoji })}
                  onReply={() => {
                    setReplyTo(m);
                    setEditing(null);
                  }}
                  onEdit={() => beginEdit(m)}
                  onDelete={() => {
                    if (window.confirm("Delete this message? Only you can undo by not clicking.")) {
                      deleteMsg.mutate(m.id);
                    }
                  }}
                />
              ))
            )}
          </div>

          {/* typing row — quiet 12 px line above the composer */}
          {typingLabel && (
            <div
              style={{
                padding: "4px 20px",
                fontSize: 12,
                opacity: 0.7,
                borderTop: "1px solid var(--border-soft, var(--border))",
              }}
            >
              {typingLabel}
            </div>
          )}

          {/* reply-to / edit banner above the composer */}
          {(replyTo || editing) && (
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: "8px 12px",
                borderTop: "1px solid var(--border)",
                background: "var(--surface-2)",
              }}
            >
              <span style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                <Icon name={editing ? "edit" : "chevL"} size={12} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {editing
                    ? "Editing your message"
                    : `Replying to ${replyTo!.author.name || replyTo!.author.email}`}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.7,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {(editing ? editing.body : replyTo!.body) || "(no text)"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (editing) cancelEdit();
                  else setReplyTo(null);
                }}
                style={{ background: "transparent", border: 0, cursor: "pointer", opacity: 0.7 }}
                aria-label="Cancel"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          {/* staged attachments strip (uploaded but not yet sent) */}
          {staged.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                padding: "8px 12px",
                borderTop: "1px solid var(--border)",
                background: "var(--surface-1)",
              }}
            >
              {staged.map((a) => (
                <div
                  key={a.id}
                  className="row gap-2"
                  style={{
                    alignItems: "center",
                    padding: "4px 8px 4px 4px",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    background: "var(--surface-2)",
                    fontSize: 12,
                  }}
                >
                  <span
                    className="row center"
                    style={{
                      width: 24,
                      height: 24,
                      background: "var(--surface-1)",
                      borderRadius: 4,
                    }}
                  >
                    <Icon name={a.kind === "image" ? "eye" : "book"} size={12} />
                  </span>
                  <span
                    style={{
                      maxWidth: 140,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.name}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {formatBytes(a.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setStaged((s) => s.filter((x) => x.id !== a.id))}
                    style={{
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      opacity: 0.6,
                    }}
                    aria-label={`Remove ${a.name}`}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* composer */}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              padding: "10px 12px",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={onFilesPicked}
            />
            <Btn
              variant="ghost"
              size="icon"
              onClick={pickFiles}
              disabled={upload.isPending || !!editing}
              aria-label="Attach files"
              title={editing ? "Attachments can't be edited" : "Attach files"}
            >
              {upload.isPending ? <Icon name="clock" size={16} /> : <Icon name="link" size={16} />}
            </Btn>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                editing
                  ? "Edit your message…"
                  : "Message the project team… use @name to mention someone"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && canSend) {
                  e.preventDefault();
                  submitComposer();
                }
                if (e.key === "Escape") {
                  if (editing) cancelEdit();
                  else if (replyTo) setReplyTo(null);
                }
              }}
              style={{ flex: 1 }}
            />
            <Btn
              variant="primary"
              disabled={!canSend}
              onClick={submitComposer}
              loading={send.isPending || editMsg.isPending}
            >
              {editing ? "Save" : "Send"}
            </Btn>
          </div>
          {composerError && (
            <p style={{ color: "var(--danger)", fontSize: 12, padding: "0 12px 8px" }}>
              {composerError}
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
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
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
  slug,
  m,
  meId,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: {
  slug: string;
  m: Message;
  meId: string | undefined;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const isMine = m.author.id === meId;

  const attachmentUrl = (attachmentId: string) =>
    `/api/v1/projects/${slug}/team-chat/messages/${m.id}/attachments/${attachmentId}`;

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        marginBottom: 14,
        opacity: m.isDeleted ? 0.55 : 1,
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        setShowActions(false);
        setShowReactionPicker(false);
      }}
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

          {/* Row-level actions — hover to reveal. Reply is available for
              everyone, edit + delete only for the author (and never on a
              tombstoned message). */}
          {!m.isDeleted && (
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 2,
                opacity: showActions ? 1 : 0,
                transition: "opacity 90ms",
              }}
            >
              <IconAction icon="plus" title="React" onClick={() => setShowReactionPicker((s) => !s)} />
              <IconAction icon="chevL" title="Reply" onClick={onReply} />
              {isMine && <IconAction icon="edit" title="Edit" onClick={onEdit} />}
              {isMine && <IconAction icon="trash" title="Delete" onClick={onDelete} danger />}
            </div>
          )}
        </div>

        {/* Reply-to excerpt above the body */}
        {m.replyTo && (
          <div
            style={{
              margin: "4px 0 4px 0",
              padding: "6px 8px",
              borderLeft: "3px solid var(--accent, #7b7bff)",
              background: "var(--surface-2)",
              fontSize: 12,
              borderRadius: 4,
              opacity: m.replyTo.isDeleted ? 0.6 : 1,
            }}
          >
            <div style={{ fontWeight: 600, opacity: 0.85 }}>
              {m.replyTo.authorName || "Someone"}
            </div>
            <div
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                opacity: 0.8,
              }}
            >
              {m.replyTo.body}
            </div>
          </div>
        )}

        {m.body && (
          <div
            style={{
              fontSize: 14,
              marginTop: 2,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {m.body}
          </div>
        )}

        {/* Attachments — images render inline, other files as a compact
            downloadable card. Grid caps image height so a huge photo doesn't
            blow out the pane; click-through opens original in a new tab. */}
        {m.attachments.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 6,
            }}
          >
            {m.attachments.map((a) =>
              a.kind === "image" ? (
                <a
                  key={a.id}
                  href={attachmentUrl(a.id)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "block",
                    maxWidth: 320,
                    borderRadius: 8,
                    overflow: "hidden",
                    border: "1px solid var(--border)",
                  }}
                >
                  <img
                    src={attachmentUrl(a.id)}
                    alt={a.name}
                    style={{
                      display: "block",
                      maxWidth: "100%",
                      maxHeight: 280,
                      objectFit: "contain",
                      background: "var(--surface-2)",
                    }}
                  />
                </a>
              ) : (
                <a
                  key={a.id}
                  href={attachmentUrl(a.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="row gap-2"
                  style={{
                    alignItems: "center",
                    padding: "8px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    textDecoration: "none",
                    color: "inherit",
                    background: "var(--surface-1)",
                    fontSize: 13,
                    minWidth: 200,
                  }}
                >
                  <span
                    className="row center"
                    style={{
                      width: 32,
                      height: 32,
                      background: "var(--surface-2)",
                      borderRadius: 6,
                      flex: "none",
                    }}
                  >
                    <Icon name="book" size={16} />
                  </span>
                  <span className="col" style={{ minWidth: 0, gap: 0 }}>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.name}
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {formatBytes(a.size)} · {a.mime.split("/").pop() ?? a.mime}
                    </span>
                  </span>
                </a>
              ),
            )}
          </div>
        )}

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

function IconAction({
  icon,
  title,
  onClick,
  danger,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        border: 0,
        background: "transparent",
        cursor: "pointer",
        padding: 4,
        borderRadius: 4,
        color: danger ? "var(--danger)" : "inherit",
        opacity: 0.7,
      }}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
