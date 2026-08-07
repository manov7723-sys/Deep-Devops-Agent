import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { ALLOWED_REACTIONS } from "@/lib/chat/project-chat";

/**
 * Toggle a reaction on a message. One row per (message, user, emoji);
 * re-POSTing the same emoji removes it. Emoji is validated against a small
 * whitelist so we don't accidentally store arbitrary strings (which would
 * turn the reactions column into a UGC free-for-all).
 *
 * A user can react to messages in projects they have access to, whether or
 * not they wrote the message. Reactions on deleted messages are rejected so
 * a tombstone can't accumulate reactions.
 */
const Body = z.object({ emoji: z.string().min(1).max(8) });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }
  const { emoji } = parsed.data;
  if (!ALLOWED_REACTIONS.has(emoji)) {
    return NextResponse.json(
      { ok: false, code: "emoji_not_allowed", message: `Pick from ${[...ALLOWED_REACTIONS].join(" ")}` },
      { status: 400 },
    );
  }

  // Confirm the message belongs to this project — otherwise a member of
  // project A could react to a message in project B just by knowing its id.
  const message = await prisma.projectMessage.findFirst({
    where: { id, projectId: gate.access.project.id, deletedAt: null },
    select: { id: true },
  });
  if (!message) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  // Toggle: if the row exists delete it, otherwise create it.
  const existing = await prisma.projectMessageReaction.findUnique({
    where: {
      messageId_userId_emoji: { messageId: id, userId: gate.access.session.userId, emoji },
    },
  });
  if (existing) {
    await prisma.projectMessageReaction.delete({
      where: {
        messageId_userId_emoji: { messageId: id, userId: gate.access.session.userId, emoji },
      },
    });
    return NextResponse.json({ ok: true, state: "removed" });
  }
  await prisma.projectMessageReaction.create({
    data: { messageId: id, userId: gate.access.session.userId, emoji },
  });
  return NextResponse.json({ ok: true, state: "added" });
}
