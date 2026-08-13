import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listTypingUsers, recordTypingActivity } from "@/lib/chat/typing";

/**
 * GET  → current typing users for this project (excluding the caller).
 * POST → record a typing heartbeat, or `{"stop":true}` to clear the caller.
 *
 * Membership is the ONLY gate — a user with project access is in the room.
 * The client heartbeats every 3s while composing (a lower cadence than the
 * 6s idle expiry so a single dropped request doesn't cause the indicator
 * to flicker for another user).
 */

const HeartbeatBody = z.object({ stop: z.boolean().optional() });

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  return NextResponse.json({
    ok: true,
    typing: listTypingUsers({
      projectId: gate.access.project.id,
      excludeUserId: gate.access.session.userId,
    }),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = HeartbeatBody.safeParse(await req.json().catch(() => ({})));
  recordTypingActivity({
    projectId: gate.access.project.id,
    userId: gate.access.session.userId,
    userName: gate.access.session.user.name,
    stop: parsed.success && parsed.data.stop === true,
  });
  return NextResponse.json({ ok: true });
}
