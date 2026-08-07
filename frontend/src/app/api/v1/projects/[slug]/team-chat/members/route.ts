import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * People in the project's chat = everyone with a Membership.
 *
 * Kept as its own tiny endpoint (rather than folded into the /chat/messages
 * GET) because the member list rarely changes — the client can cache it and
 * only refetch on membership events, keeping the 3s poll payload light.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const members = await prisma.membership.findMany({
    where: { projectId: gate.access.project.id },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    select: {
      role: true,
      joinedAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });

  return NextResponse.json({
    ok: true,
    members: members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
  });
}
