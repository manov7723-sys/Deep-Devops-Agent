import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  listProjectMessages,
  resolveMentions,
  unreadCount,
  CHAT_PAGE_SIZE,
} from "@/lib/chat/project-chat";

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

const SendBody = z.object({
  body: z.string().trim().min(1, "Message can't be empty").max(4000, "Message too long"),
});

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

  const mentionedUserIds = await resolveMentions({
    projectId: gate.access.project.id,
    body: parsed.data.body,
    authorId: gate.access.session.userId,
  });

  const message = await prisma.projectMessage.create({
    data: {
      projectId: gate.access.project.id,
      userId: gate.access.session.userId,
      body: parsed.data.body,
      mentionedUserIds,
    },
    select: { id: true, createdAt: true },
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
              subtitle: parsed.data.body.slice(0, 120),
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
