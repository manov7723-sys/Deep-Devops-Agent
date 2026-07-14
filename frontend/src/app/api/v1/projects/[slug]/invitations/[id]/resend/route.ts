import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createInvitation } from "@/lib/projects/invitations";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/invitations/[id]/resend
 *
 * Re-issue a fresh magic link for a pending invitation and re-email the
 * invitee. Reuses `createInvitation` which is idempotent on (projectId,
 * email): it rotates the magic-link token, resets TTL, and upserts the
 * ProjectInvitation row. The new token invalidates the old one (the prior
 * MagicLink hash is replaced).
 *
 * Developer+ gated, matching the original send-invite path.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const invite = await prisma.projectInvitation.findFirst({
    where: { id, projectId: gate.access.project.id },
    select: { id: true, email: true, role: true, status: true },
  });
  if (!invite) {
    return NextResponse.json(
      { ok: false, code: "not_found", message: "Invitation not found." },
      { status: 404 },
    );
  }
  if (invite.status !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        code: "not_pending",
        message:
          invite.status === "accepted"
            ? "That invitation has already been accepted."
            : "That invitation isn't pending anymore.",
      },
      { status: 409 },
    );
  }

  const meta = extractRequestMeta(req);
  const inviter = await prisma.user.findUnique({
    where: { id: gate.access.session.userId },
    select: { name: true },
  });
  const origin = new URL(req.url).origin;

  // ProjectInvitation.role excludes "owner" at insert time (see /teams POST
  // + /projects/[slug]/invitations POST schemas), so the narrowing here is
  // safe; we just need to convince TS the Prisma enum is the smaller union.
  if (invite.role === "owner") {
    return NextResponse.json({ ok: false, code: "invalid_invite_role" }, { status: 500 });
  }
  const res = await createInvitation({
    projectId: gate.access.project.id,
    projectName: gate.access.project.name,
    projectSlug: gate.access.project.slug,
    email: invite.email,
    role: invite.role,
    invitedById: gate.access.session.userId,
    inviterName: inviter?.name ?? "A teammate",
    origin,
    requestedIp: meta.ipAddress,
  });
  if (!res.ok) {
    // already_member shouldn't happen mid-resend, but surface gracefully.
    return NextResponse.json(
      {
        ok: false,
        code: res.code,
        message:
          res.code === "already_member"
            ? "That user has already joined this project."
            : "Could not resend invitation.",
      },
      { status: 409 },
    );
  }

  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.invitation_created",
    targetType: "invitation",
    targetId: res.invitationId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { email: invite.email, role: invite.role, resend: true },
  });

  return NextResponse.json({
    ok: true,
    invitationId: res.invitationId,
    expiresAt: res.expiresAt.toISOString(),
  });
}
