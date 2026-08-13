/**
 * Project people-chat — the human conversation attached to a project.
 *
 * DIFFERENT from ChatMessage (that's the LLM agent transcript) and from
 * Notification (one-shot alerts). Everyone with a Membership on the project
 * is automatically in the conversation; membership removal removes them from
 * the chat with no separate cleanup.
 *
 * @mention resolution is intentionally server-side: the client sends the raw
 * body, the server parses @name tokens against project members and writes the
 * Notification rows. A client that stripped the mention client-side wouldn't
 * be able to spoof a notification for someone they aren't @-tagging.
 */
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

export const CHAT_PAGE_SIZE = 100;

/**
 * Emoji whitelist for reactions. Small on purpose — the point is
 * lightweight signal, not open self-expression. Extend as needed.
 */
export const ALLOWED_REACTIONS = new Set(["👍", "❤️", "😂", "🎉", "😢", "🚀", "👀", "✅"]);

/**
 * One attachment on a message. `path` is server-local (under `uploads/team-chat/`)
 * and is NEVER returned to the client — attachments are streamed via a project-
 * ACL-gated endpoint (`/api/v1/projects/[slug]/team-chat/attachments/[id]`).
 * `kind: image` unlocks inline `<img>` rendering; `file` is a downloadable card.
 */
export type ChatAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  /** Server-local path — used only inside the server; not sent to the client. */
  path: string;
};

/** Reply excerpt returned alongside a message that is a reply. */
export type ChatReplyRef = {
  id: string;
  body: string;
  authorName: string;
  isDeleted: boolean;
};

export type ChatMessageRow = {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  isMine: boolean;
  author: { id: string; name: string; email: string };
  mentionedUserIds: string[];
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  /**
   * Client-facing attachment shape — omits the server path. The client gets
   * an opaque `id` and hits the download endpoint to fetch bytes.
   */
  attachments: Array<{
    id: string;
    name: string;
    mime: string;
    size: number;
    kind: "image" | "file";
  }>;
  replyTo: ChatReplyRef | null;
};

/**
 * Newest-N messages for a project. Ordered ascending in the returned array so
 * the UI can render top-to-bottom without re-sorting; the "newest N" cap is
 * enforced by taking descending then reversing.
 */
export async function listProjectMessages(args: {
  projectId: string;
  viewerId: string;
  limit?: number;
  before?: Date | null;
}): Promise<ChatMessageRow[]> {
  const limit = Math.min(args.limit ?? CHAT_PAGE_SIZE, 200);
  const where: Prisma.ProjectMessageWhereInput = {
    projectId: args.projectId,
    ...(args.before ? { createdAt: { lt: args.before } } : {}),
  };
  const rows = await prisma.projectMessage.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      body: true,
      createdAt: true,
      editedAt: true,
      deletedAt: true,
      mentionedUserIds: true,
      attachments: true,
      replyToId: true,
      user: { select: { id: true, name: true, email: true } },
      reactions: { select: { emoji: true, userId: true } },
    },
  });

  // Bulk-resolve reply targets — one query for every replyTo id referenced
  // above. Cheaper than one findUnique per message row. Deleted parents are
  // included (deletedAt not filtered) so the UI can render "reply to a
  // deleted message" instead of hiding the whole reply.
  const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((v): v is string => !!v))];
  const parents = replyIds.length
    ? await prisma.projectMessage.findMany({
        where: { id: { in: replyIds } },
        select: {
          id: true,
          body: true,
          deletedAt: true,
          user: { select: { name: true } },
        },
      })
    : [];
  const parentById = new Map(parents.map((p) => [p.id, p]));

  return rows.reverse().map((r) => {
    const byEmoji = new Map<string, { count: number; mine: boolean }>();
    for (const rx of r.reactions) {
      const entry = byEmoji.get(rx.emoji) ?? { count: 0, mine: false };
      entry.count++;
      if (rx.userId === args.viewerId) entry.mine = true;
      byEmoji.set(rx.emoji, entry);
    }

    // Strip the server-local `path` from attachments before returning.
    const storedAttachments = (Array.isArray(r.attachments)
      ? (r.attachments as unknown as ChatAttachment[])
      : []
    ).filter((a) => a && typeof a === "object" && a.id);
    const attachments = storedAttachments.map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime,
      size: a.size,
      kind: a.kind,
    }));

    let replyTo: ChatReplyRef | null = null;
    if (r.replyToId) {
      const parent = parentById.get(r.replyToId);
      replyTo = parent
        ? {
            id: parent.id,
            body: parent.deletedAt ? "(message deleted)" : parent.body.slice(0, 200),
            authorName: parent.user.name,
            isDeleted: !!parent.deletedAt,
          }
        : { id: r.replyToId, body: "(message unavailable)", authorName: "", isDeleted: true };
    }

    return {
      id: r.id,
      // Deleted messages come back as a tombstone rather than being hidden
      // outright — matches Slack/Teams UX so a gap in the thread doesn't
      // look like a bug ("this message was deleted").
      body: r.deletedAt ? "(message deleted)" : r.body,
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt?.toISOString() ?? null,
      isDeleted: !!r.deletedAt,
      isMine: r.user.id === args.viewerId,
      author: r.user,
      mentionedUserIds: r.mentionedUserIds,
      reactions: [...byEmoji.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })),
      attachments,
      replyTo,
    };
  });
}

// ────────────────────────────────────────────────────────────────
// Attachment helpers — local-disk backed
// ────────────────────────────────────────────────────────────────

/**
 * Base directory for team-chat file uploads. Configurable via
 * TEAM_CHAT_UPLOAD_DIR; defaults to `<cwd>/uploads/team-chat/`. Files are
 * segregated per project so a bad ACL never crosses project boundaries.
 * Not web-served: the download endpoint reads bytes and streams them.
 */
export function teamChatUploadDir(): string {
  return process.env.TEAM_CHAT_UPLOAD_DIR?.trim() || "uploads/team-chat";
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 6;

/** MIME-prefix check that decides whether a client should render `<img>`. */
export function attachmentKindFor(mime: string): "image" | "file" {
  return /^image\//i.test(mime) ? "image" : "file";
}

/**
 * Resolve a stored attachment by id from a message row. Returns null when the
 * id isn't present on that message — callers use this to gate the download
 * endpoint (no id → 404, no info about whether it exists on another message).
 */
export function findStoredAttachment(
  attachments: unknown,
  attachmentId: string,
): ChatAttachment | null {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments as unknown[]) {
    if (a && typeof a === "object" && (a as ChatAttachment).id === attachmentId) {
      return a as ChatAttachment;
    }
  }
  return null;
}

/**
 * Parse @mentions in a message body against project members. Matches
 * @word tokens (Slack-simple), then resolves against member NAMES first
 * (case-insensitive, exact match) and EMAIL local-parts as a fallback.
 * De-duplicated; the message author never mentions themselves.
 */
export async function resolveMentions(args: {
  projectId: string;
  body: string;
  authorId: string;
}): Promise<string[]> {
  const tokens = new Set(
    [...args.body.matchAll(/(?:^|\s)@([A-Za-z0-9_\-.]+)/g)].map((m) => m[1]!.toLowerCase()),
  );
  if (tokens.size === 0) return [];

  const members = await prisma.membership.findMany({
    where: { projectId: args.projectId, userId: { not: args.authorId } },
    select: { user: { select: { id: true, name: true, email: true } } },
  });

  const hits = new Set<string>();
  for (const m of members) {
    const nameKey = (m.user.name || "").toLowerCase().split(/\s+/)[0] ?? "";
    const emailLocal = m.user.email.split("@")[0]?.toLowerCase() ?? "";
    if (tokens.has(nameKey) || tokens.has(emailLocal)) hits.add(m.user.id);
  }
  return [...hits];
}

/** Unread count for one member — messages with createdAt > chatReadAt. */
export async function unreadCount(args: { projectId: string; userId: string }): Promise<number> {
  const membership = await prisma.membership.findUnique({
    where: { projectId_userId: { projectId: args.projectId, userId: args.userId } },
    select: { chatReadAt: true },
  });
  if (!membership) return 0;
  return prisma.projectMessage.count({
    where: {
      projectId: args.projectId,
      // Exclude own messages — you can't be unread on something you just sent.
      userId: { not: args.userId },
      deletedAt: null,
      ...(membership.chatReadAt ? { createdAt: { gt: membership.chatReadAt } } : {}),
    },
  });
}

/** Advance the read cursor. Idempotent — never moves BACKWARDS. */
export async function markReadAt(args: {
  projectId: string;
  userId: string;
  at: Date;
}): Promise<void> {
  await prisma.membership.updateMany({
    where: {
      projectId: args.projectId,
      userId: args.userId,
      OR: [{ chatReadAt: null }, { chatReadAt: { lt: args.at } }],
    },
    data: { chatReadAt: args.at },
  });
}
