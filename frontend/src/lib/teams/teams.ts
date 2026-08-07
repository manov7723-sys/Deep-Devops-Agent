/**
 * Teams — the "who can create projects and invite people" layer.
 *
 * A Team owns Projects. Only a team's `lead` can create projects under it and
 * invite new members. Members inherit access to the team's projects; per-
 * project role granularity still lives in Membership on Project.
 *
 * Slug generation, invitation flow and audit shape mirror the equivalents on
 * Project so consumers behave the same way. The invite-by-email path reuses
 * MagicLink (purpose: "invite") — the same token machinery already emails
 * project invitations, and having one accept surface avoids the trap of two
 * subtly-different flows.
 */
import { prisma } from "@/lib/db/prisma";
import type { TeamRole } from "@prisma/client";
import { issueMagicLink } from "@/lib/auth/magic-link";
import { sendEmail } from "@/lib/email/transport";
import { findUserByEmail } from "@/lib/auth/users";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SLUG_MAX = 60;

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

async function generateUniqueTeamSlug(name: string): Promise<string> {
  const base = slugify(name) || "team";
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const collision = await prisma.team.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!collision) return candidate;
    candidate = `${base}-${i}`;
  }
  // Fall back to a unique suffix rather than throwing — collisions above 99
  // shouldn't happen in practice, but if they do we still return something.
  return `${base}-${Date.now().toString(36).slice(-6)}`;
}

export type TeamSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  role: TeamRole;
  memberCount: number;
  projectCount: number;
  createdAt: string;
};

/**
 * Every team the user is a member of, with their role in each. Ordered so
 * teams they LEAD come first — that's the actionable set (they can create
 * projects, invite people); membership is otherwise.
 */
export async function listTeamsForUser(userId: string): Promise<TeamSummary[]> {
  const rows = await prisma.teamMembership.findMany({
    where: { userId },
    select: {
      role: true,
      team: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          createdAt: true,
          _count: { select: { memberships: true, projects: true } },
        },
      },
    },
  });
  return rows
    .map((r) => ({
      id: r.team.id,
      slug: r.team.slug,
      name: r.team.name,
      description: r.team.description,
      role: r.role,
      memberCount: r.team._count.memberships,
      projectCount: r.team._count.projects,
      createdAt: r.team.createdAt.toISOString(),
    }))
    .sort((a, b) => {
      // leads first, then by name
      if (a.role !== b.role) return a.role === "lead" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export type CreateTeamArgs = {
  ownerId: string;
  name: string;
  description?: string;
};

/** Create + first membership (creator = lead) in one transaction. */
export async function createTeam(args: CreateTeamArgs): Promise<{ id: string; slug: string }> {
  const slug = await generateUniqueTeamSlug(args.name);
  return prisma.$transaction(async (tx) => {
    const team = await tx.team.create({
      data: {
        slug,
        name: args.name,
        description: args.description ?? "",
        ownerId: args.ownerId,
      },
      select: { id: true, slug: true },
    });
    await tx.teamMembership.create({
      data: { teamId: team.id, userId: args.ownerId, role: "lead" },
    });
    return team;
  });
}

/** Gate helper: is this user a lead of the team identified by slug? */
export async function isTeamLead(userId: string, teamSlug: string): Promise<boolean> {
  const t = await prisma.team.findUnique({
    where: { slug: teamSlug },
    select: { memberships: { where: { userId }, select: { role: true } } },
  });
  return t?.memberships[0]?.role === "lead";
}

export type TeamMemberRow = {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  joinedAt: string;
};

export async function listTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const rows = await prisma.teamMembership.findMany({
    where: { teamId },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    select: {
      role: true,
      joinedAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });
  return rows.map((r) => ({
    userId: r.user.id,
    email: r.user.email,
    name: r.user.name,
    role: r.role,
    joinedAt: r.joinedAt.toISOString(),
  }));
}

export type CreateTeamInvitationArgs = {
  teamId: string;
  teamName: string;
  invitedById: string;
  inviterName: string;
  email: string;
  role: TeamRole;
  origin: string;
  requestedIp?: string | null;
};

export type CreateTeamInvitationResult =
  | { ok: true; invitationId: string; expiresAt: Date }
  | { ok: false; code: "already_member" | "self_invite" };

/**
 * Idempotent: re-inviting the same email refreshes the pending row and issues
 * a new magic link. A user who already holds a TeamMembership is rejected
 * with `already_member`; self-invites are blocked outright so a lead can't
 * accidentally reset their own row.
 */
export async function createTeamInvitation(
  args: CreateTeamInvitationArgs,
): Promise<CreateTeamInvitationResult> {
  const email = args.email.trim().toLowerCase();

  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    if (existingUser.id === args.invitedById) return { ok: false, code: "self_invite" };
    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: args.teamId, userId: existingUser.id } },
      select: { id: true },
    });
    if (membership) return { ok: false, code: "already_member" };
  }

  const { token, expiresAt } = await issueMagicLink({
    userId: existingUser?.id ?? null,
    email,
    purpose: "invite",
    ttlMs: INVITE_TTL_MS,
    requestedIp: args.requestedIp,
  });
  const magicLinkRow = await prisma.magicLink.findFirst({
    where: { email, purpose: "invite" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  const invitation = await prisma.teamInvitation.upsert({
    where: { team_email_unique: { teamId: args.teamId, email } },
    create: {
      teamId: args.teamId,
      email,
      role: args.role,
      status: "pending",
      invitedById: args.invitedById,
      magicLinkId: magicLinkRow?.id,
      expiresAt,
    },
    update: {
      role: args.role,
      status: "pending",
      invitedById: args.invitedById,
      magicLinkId: magicLinkRow?.id,
      expiresAt,
      acceptedAt: null,
      acceptedUserId: null,
    },
    select: { id: true },
  });

  // The URL points at /auth/invite?token=… — the SAME accept page that
  // handles project invites, so users see one flow regardless of which kind.
  const link = `${args.origin}/auth/invite?token=${token}`;
  await sendEmail({
    to: email,
    subject: `You're invited to the ${args.teamName} team on DeepAgent`,
    text: [
      `${args.inviterName} invited you to join the "${args.teamName}" team on DeepAgent as ${args.role}.`,
      "",
      "As a team member you get access to the team's existing projects and can be added to new ones.",
      "",
      "Open the link below to accept. It expires in 7 days and can be used only once:",
      "",
      link,
      "",
      "If you didn't expect this, you can ignore the email.",
    ].join("\n"),
  });

  return { ok: true, invitationId: invitation.id, expiresAt };
}

export type AcceptTeamInvitationResult =
  | { ok: true; teamSlug: string; teamName: string; role: TeamRole }
  | { ok: false; code: "expired" | "used" | "revoked" | "email_mismatch" | "already_member" | "not_found" };

/**
 * Accept a team invitation. Caller must be signed in AND their email must
 * match the invited address — a mismatch 403s rather than silently creating
 * a membership for the wrong identity.
 *
 * MagicLink handling is deferred to the shared consumer at the caller site
 * (the accept ROUTE already calls consumeMagicLink). This function assumes
 * that check passed and just does the DB updates.
 */
export async function acceptTeamInvitationByEmail(args: {
  email: string;
  userId: string;
}): Promise<AcceptTeamInvitationResult> {
  const email = args.email.trim().toLowerCase();
  const invite = await prisma.teamInvitation.findFirst({
    where: { email, status: "pending" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      teamId: true,
      role: true,
      expiresAt: true,
      team: { select: { slug: true, name: true } },
    },
  });
  if (!invite) return { ok: false, code: "not_found" };
  if (invite.expiresAt.getTime() < Date.now()) return { ok: false, code: "expired" };

  const already = await prisma.teamMembership.findUnique({
    where: { teamId_userId: { teamId: invite.teamId, userId: args.userId } },
    select: { id: true },
  });
  if (already) {
    // Still mark the invite accepted so it disappears from pending lists.
    await prisma.teamInvitation.update({
      where: { id: invite.id },
      data: { status: "accepted", acceptedAt: new Date(), acceptedUserId: args.userId },
    });
    return { ok: false, code: "already_member" };
  }

  await prisma.$transaction([
    prisma.teamMembership.create({
      data: { teamId: invite.teamId, userId: args.userId, role: invite.role },
    }),
    prisma.teamInvitation.update({
      where: { id: invite.id },
      data: { status: "accepted", acceptedAt: new Date(), acceptedUserId: args.userId },
    }),
  ]);

  return { ok: true, teamSlug: invite.team.slug, teamName: invite.team.name, role: invite.role };
}
