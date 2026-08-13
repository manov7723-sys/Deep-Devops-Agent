import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  listProjectMessages,
  resolveMentions,
  unreadCount,
  CHAT_PAGE_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentKindFor,
} from "@/lib/chat/project-chat";
import { recordTypingActivity } from "@/lib/chat/typing";

/**
 * Project people-chat messages. Membership is the ONLY gate — a user with
 * project access is in the chat automatically; there is no per-channel
 * invitation to manage.
 *
 * GET returns the latest page plus the caller's unread count so the badge
 * and the message list update from a single request (halves the polling
 * overhead).
 *
 * POST sends a message, parses @mentions against project members, and writes
 * one Notification per mentioned user. Mention resolution is server-side so a
 * client can't spoof a notification for someone they didn't tag.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const beforeParam = url.searchParams.get("before");
  const before = beforeParam ? new Date(beforeParam) : null;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? CHAT_PAGE_SIZE), 200);

  const [messages, unread] = await Promise.all([
    listProjectMessages({
      projectId: gate.access.project.id,
      viewerId: gate.access.session.userId,
      limit,
      before: before && !isNaN(before.getTime()) ? before : null,
    }),
    unreadCount({ projectId: gate.access.project.id, userId: gate.access.session.userId }),
  ]);

  return NextResponse.json({ ok: true, messages, unread });
}

/**
 * Attachment schema matches what /upload returns — id + name + mime + size +
 * server-local path. The client passes this array verbatim; the server never
 * trusts `kind` from the client (recomputed from mime) and stores the record
 * onto the message row.
 */
const AttachmentInput = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(300),
  mime: z.string().min(1).max(200),
  size: z.number().int().min(0),
  path: z.string().min(1).max(500),
});

const SendBody = z
  .object({
    body: z.string().trim().max(4000, "Message too long").optional(),
    attachments: z.array(AttachmentInput).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    replyToId: z.string().uuid().optional(),
  })
  .refine(
    (v) => (v.body && v.body.length > 0) || (v.attachments && v.attachments.length > 0),
    { message: "Message needs text or at least one attachment." },
  );

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = SendBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const body = parsed.data.body ?? "";
  const mentionedUserIds = body
    ? await resolveMentions({
        projectId: gate.access.project.id,
        body,
        authorId: gate.access.session.userId,
      })
    : [];

  // Validate replyToId belongs to this project so a caller can't quote a
  // message from another project by supplying its id — cheap findFirst.
  let replyToId: string | null = null;
  if (parsed.data.replyToId) {
    const parent = await prisma.projectMessage.findFirst({
      where: { id: parsed.data.replyToId, projectId: gate.access.project.id },
      select: { id: true },
    });
    if (parent) replyToId = parent.id;
  }

  // Recompute `kind` from mime server-side — the client never sets it directly.
  const attachments = (parsed.data.attachments ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size,
    kind: attachmentKindFor(a.mime),
    path: a.path,
  }));

  const message = await prisma.projectMessage.create({
    data: {
      projectId: gate.access.project.id,
      userId: gate.access.session.userId,
      body,
      mentionedUserIds,
      attachments: attachments.length
        ? (attachments as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      replyToId,
    },
    select: { id: true, createdAt: true },
  });

  // Clear the sender's own "typing" state — they just sent the message.
  recordTypingActivity({
    projectId: gate.access.project.id,
    userId: gate.access.session.userId,
    userName: gate.access.session.user.name,
    stop: true,
  });

  // Fire Notification rows for each mentioned user. Not in the same
  // transaction as the message: if the notification write fails for one
  // recipient, the message must still exist. Fire-and-forget on the
  // Promise.all so a slow write doesn't hold up the POST response.
  if (mentionedUserIds.length > 0) {
    const linkHref = `/p/${slug}/chat`;
    void Promise.all(
      mentionedUserIds.map((uid) =>
        prisma.notification
          .create({
            data: {
              userId: uid,
              category: "mention",
              icon: "chat",
              title: `${gate.access.session.user.name} mentioned you`,
              subtitle: body.slice(0, 120),
              linkHref,
            },
          })
          .catch((e) => {
            console.error(`[chat] mention notification failed for ${uid}: ${e}`);
          }),
      ),
    );
  }

  // Advance the sender's OWN read cursor to this message so they never see
  // their own message as unread. Idempotent update.
  await prisma.membership.updateMany({
    where: { projectId: gate.access.project.id, userId: gate.access.session.userId },
    data: { chatReadAt: message.createdAt },
  });

  return NextResponse.json({ ok: true, id: message.id, createdAt: message.createdAt.toISOString() });
}
