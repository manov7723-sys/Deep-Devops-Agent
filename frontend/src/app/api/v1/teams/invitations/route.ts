import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";

/**
 * GET /teams/invitations — pending invites the caller can act on.
 *
 * Aggregated across every project where the caller has owner/developer role
 * (since those are the same roles allowed to manage invites on a per-project
 * basis). Bare array — `useTeamPendingInvitations()` reads it directly.
 */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }

  // Caller's manage-rights, by project.
  const memberships = await prisma.membership.findMany({
    where: { userId: sess.userId, role: { in: ["owner", "developer"] } },
    select: { projectId: true, role: true },
  });
  const projectIds = memberships.map((m) => m.projectId);
  if (projectIds.length === 0) return NextResponse.json([]);

  const rows = await prisma.projectInvitation.findMany({
    where: { projectId: { in: projectIds }, status: "pending" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      invitedBy: { select: { name: true } },
      project: { select: { id: true, slug: true, name: true } },
    },
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      projectId: r.project.id,
      projectSlug: r.project.slug,
      projectName: r.project.name,
      email: r.email,
      role: r.role,
      status: r.status,
      invitedByName: r.invitedBy.name,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  );
}
