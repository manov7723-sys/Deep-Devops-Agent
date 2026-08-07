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

export type ChatMessageRow = {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  author: { id: string; name: string; email: string };
  mentionedUserIds: string[];
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
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
      user: { select: { id: true, name: true, email: true } },
      reactions: { select: { emoji: true, userId: true } },
    },
  });

  return rows.reverse().map((r) => {
    const byEmoji = new Map<string, { count: number; mine: boolean }>();
    for (const rx of r.reactions) {
      const entry = byEmoji.get(rx.emoji) ?? { count: 0, mine: false };
      entry.count++;
      if (rx.userId === args.viewerId) entry.mine = true;
      byEmoji.set(rx.emoji, entry);
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
      author: r.user,
      mentionedUserIds: r.mentionedUserIds,
      reactions: [...byEmoji.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })),
    };
  });
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
