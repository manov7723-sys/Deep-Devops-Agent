import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { createTeamInvitation } from "@/lib/teams/teams";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum(["member", "lead"]).default("member"),
});

/**
 * POST /teams/[slug]/invitations — lead-only. Sends a magic-link email; the
 * accept surface is /auth/invite?token=…, the same page project invites use.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const { slug } = await ctx.params;
  const team = await prisma.team.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      memberships: { where: { userId: sess.userId }, select: { role: true } },
    },
  });
  if (!team || team.memberships.length === 0) {
    // 404 on both no-team and non-member: don't reveal team existence to
    // outsiders. A lead who genuinely gets this needs to check the slug.
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }
  if (team.memberships[0]!.role !== "lead") {
    return NextResponse.json(
      { ok: false, code: "not_lead", message: "Only a team lead can invite members." },
      { status: 403 },
    );
  }

  const parsed = InviteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const meta = extractRequestMeta(req);
  const res = await createTeamInvitation({
    teamId: team.id,
    teamName: team.name,
    invitedById: sess.userId,
    inviterName: sess.user.name,
    email: parsed.data.email,
    role: parsed.data.role,
    origin: req.headers.get("origin") ?? new URL(req.url).origin,
    requestedIp: meta.ipAddress,
  });
  if (!res.ok) {
    const status = res.code === "already_member" ? 409 : 400;
    const message =
      res.code === "already_member"
        ? "That user is already a member of this team."
        : "You can't invite yourself.";
    return NextResponse.json({ ok: false, code: res.code, message }, { status });
  }

  await audit({
    userId: sess.userId,
    action: "team.invitation_created",
    targetType: "team_invitation",
    targetId: res.invitationId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { teamSlug: slug, email: parsed.data.email, role: parsed.data.role },
  });

  return NextResponse.json({
    ok: true,
    invitationId: res.invitationId,
    expiresAt: res.expiresAt.toISOString(),
  });
}
