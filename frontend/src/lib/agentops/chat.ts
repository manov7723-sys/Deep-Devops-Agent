/**
 * Chat threads + messages. Phase 9 stores user messages only; the agent
 * response pipeline (LLM call, plan steps, code blocks) lives in a later phase.
 */
import type { ChatMessage, ChatRole, ChatThread } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type ThreadSummary = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
};

export type MessageRow = {
  id: string;
  role: ChatRole;
  authorName: string | null;
  text: string;
  codeBody: string | null;
  codeLang: string | null;
  prNumber: number | null;
  createdAt: string;
};

export async function listThreads(projectId: string): Promise<ThreadSummary[]> {
  const rows = await prisma.chatThread.findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    lastMessageAt: t.messages[0]?.createdAt.toISOString() ?? null,
    messageCount: t._count.messages,
  }));
}

function messageRow(m: ChatMessage & { author: { name: string } | null }): MessageRow {
  return {
    id: m.id,
    role: m.role,
    authorName: m.author?.name ?? null,
    text: m.text,
    codeBody: m.codeBody,
    codeLang: m.codeLang,
    prNumber: m.prNumber,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function getThreadDetail(
  projectId: string,
  threadId: string,
): Promise<{ thread: ThreadSummary; messages: MessageRow[] } | null> {
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, projectId },
    include: { _count: { select: { messages: true } } },
  });
  if (!thread) return null;
  const messages = await prisma.chatMessage.findMany({
    where: { threadId, projectId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { name: true } } },
  });
  const last = messages.at(-1);
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      lastMessageAt: last?.createdAt.toISOString() ?? null,
      messageCount: thread._count.messages,
    },
    messages: messages.map(messageRow),
  };
}

export async function createThread(
  projectId: string,
  authorUserId: string,
  title?: string,
  firstMessage?: string,
): Promise<{ threadId: string; firstMessageId?: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const t = await tx.chatThread.create({
      data: { projectId, title: title ?? null },
      select: { id: true },
    });
    let firstMessageId: string | undefined;
    if (firstMessage && firstMessage.trim().length > 0) {
      const m = await tx.chatMessage.create({
        data: {
          projectId,
          threadId: t.id,
          role: "user",
          authorUserId,
          text: firstMessage,
        },
        select: { id: true },
      });
      firstMessageId = m.id;
      await tx.chatThread.update({
        where: { id: t.id },
        data: { updatedAt: new Date() },
      });
    }
    return { threadId: t.id, firstMessageId };
  });
  return result;
}

export type PostMessageResult =
  | { ok: true; message: MessageRow }
  | { ok: false; code: "thread_not_found" };

export async function postUserMessage(
  projectId: string,
  threadId: string,
  authorUserId: string,
  text: string,
): Promise<PostMessageResult> {
  const t = await prisma.chatThread.findFirst({
    where: { id: threadId, projectId },
    select: { id: true },
  });
  if (!t) return { ok: false, code: "thread_not_found" };

  const created = await prisma.chatMessage.create({
    data: {
      projectId,
      threadId,
      role: "user",
      authorUserId,
      text,
    },
    include: { author: { select: { name: true } } },
  });
  await prisma.chatThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date() },
  });
  return { ok: true, message: messageRow(created) };
}

/**
 * Always-available starter prompts so users know they can just ASK the agent to
 * do things (deploy, CI/CD, scan). Shown first; DB suggestions fill the rest.
 */
const BUILTIN_SUGGESTIONS: Array<{ id: string; icon: string; text: string }> = [
  { id: "builtin-deploy", icon: "rocket", text: "Deploy my application to the cluster" },
  { id: "builtin-pipeline", icon: "zap", text: "Set up CI/CD and deploy my app" },
  { id: "builtin-scan", icon: "shield", text: "Scan my repo for vulnerabilities" },
];

export async function listSuggestions(projectId: string): Promise<
  Array<{ id: string; icon: string; text: string }>
> {
  const rows = await prisma.chatSuggestion.findMany({
    where: { OR: [{ projectId }, { projectId: null }] },
    orderBy: [{ projectId: "desc" }, { order: "asc" }],
    take: 8,
  });
  const db = rows.map((r) => ({ id: r.id, icon: r.icon, text: r.text }));

  // Built-ins first, then DB suggestions — deduped by text, capped at 8.
  const seen = new Set<string>();
  return [...BUILTIN_SUGGESTIONS, ...db]
    .filter((s) => {
      const k = s.text.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
}
