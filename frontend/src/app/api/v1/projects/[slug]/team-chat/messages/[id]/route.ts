import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveMentions } from "@/lib/chat/project-chat";

/**
 * PATCH  → edit the body of your OWN message (author-only). Sets editedAt.
 *          Re-parses @mentions so newly-added ones fire notifications.
 * DELETE → soft-delete your OWN message. Sets deletedAt; the timeline still
 *          renders it as "(message deleted)" tombstone rather than yanking
 *          the row so replies to it don't dangle. Attachments on disk are
 *          left in place — a hard-delete purge is a separate cleanup job.
 *
 * Only the author can edit or delete. Admins can be added later; keeping it
 * scoped to author-only matches Slack/WhatsApp and avoids the whole
 * "someone else changed my words" surprise.
 */

const EditBody = z.object({
  body: z.string().trim().min(1, "Message can't be empty").max(4000, "Message too long"),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = EditBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const existing = await prisma.projectMessage.findFirst({
    where: {
      id,
      projectId: gate.access.project.id,
      userId: gate.access.session.userId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json(
      { ok: false, code: "not_your_message" },
      { status: 404 },
    );
  }

  const mentionedUserIds = await resolveMentions({
    projectId: gate.access.project.id,
    body: parsed.data.body,
    authorId: gate.access.session.userId,
  });

  await prisma.projectMessage.update({
    where: { id },
    data: {
      body: parsed.data.body,
      mentionedUserIds,
      editedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const res = await prisma.projectMessage.updateMany({
    where: {
      id,
      projectId: gate.access.project.id,
      userId: gate.access.session.userId,
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });
  if (res.count === 0) {
    return NextResponse.json({ ok: false, code: "not_your_message" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
