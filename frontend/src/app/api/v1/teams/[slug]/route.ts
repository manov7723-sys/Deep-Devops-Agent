import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { listTeamMembers } from "@/lib/teams/teams";

/**
 * GET /teams/[slug] — team detail + members + own role.
 *
 * Members only. A non-member gets 404 rather than 403 for the same reason
 * requireProjectAccess does: don't confirm existence of a team you can't see.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const { slug } = await ctx.params;
  const team = await prisma.team.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      createdAt: true,
      memberships: { where: { userId: sess.userId }, select: { role: true } },
    },
  });
  if (!team || team.memberships.length === 0) {
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }

  const members = await listTeamMembers(team.id);
  return NextResponse.json({
    ok: true,
    team: {
      id: team.id,
      slug: team.slug,
      name: team.name,
      description: team.description,
      createdAt: team.createdAt.toISOString(),
      role: team.memberships[0]!.role,
    },
    members,
  });
}
