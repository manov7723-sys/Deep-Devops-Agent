/**
 * Project invitations. Backed by ProjectInvitation rows + a MagicLink for the
 * accept token. The plaintext token goes into the email link; only the SHA-256
 * hash is persisted (MagicLink.tokenHash). Accept = consume the token, mark
 * the invitation accepted, create a Membership.
 */
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { issueMagicLink, consumeMagicLink, lookupMagicLink } from "@/lib/auth/magic-link";
import { sendEmail } from "@/lib/email/transport";
import { findUserByEmail } from "@/lib/auth/users";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type InvitationRow = {
  id: string;
  email: string;
  role: ProjectRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedByName: string;
  expiresAt: string;
  createdAt: string;
};

export async function listInvitations(projectId: string): Promise<InvitationRow[]> {
  const rows = await prisma.projectInvitation.findMany({
    where: { projectId, status: "pending" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      invitedBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status,
    invitedByName: r.invitedBy.name,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

export type CreateInvitationArgs = {
  projectId: string;
  projectName: string;
  projectSlug: string;
  invitedById: string;
  inviterName: string;
  email: string;
  role: "developer" | "viewer";
  origin: string;
  requestedIp?: string | null;
};

export type CreateInvitationResult =
  | { ok: true; invitationId: string; expiresAt: Date }
  | { ok: false; code: "already_member" | "already_invited" };

/**
 * Idempotent within a project: re-inviting the same email reuses the
 * pending row (refreshes its TTL and MagicLink). A user who already holds
 * a Membership is rejected with `already_member`.
 */
export async function createInvitation(args: CreateInvitationArgs): Promise<CreateInvitationResult> {
  const email = args.email.trim().toLowerCase();

  // If the email already corresponds to a member, refuse.
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    const membership = await prisma.membership.findUnique({
      where: { projectId_userId: { projectId: args.projectId, userId: existingUser.id } },
      select: { id: true },
    });
    if (membership) return { ok: false, code: "already_member" };
  }

  // Mint the magic link first — its hash is what the email carries.
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

  // Upsert pending invitation. The (projectId, email) unique constraint
  // guarantees one live invite per address per project.
  const invitation = await prisma.projectInvitation.upsert({
    where: { projectId_email: { projectId: args.projectId, email } },
    create: {
      projectId: args.projectId,
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

  const link = `${args.origin}/auth/invite?token=${token}`;
  await sendEmail({
    to: email,
    subject: `You're invited to ${args.projectName} on DeepAgent`,
    text: [
      `${args.inviterName} invited you to join "${args.projectName}" as ${args.role} on DeepAgent.`,
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

export async function revokeInvitation(projectId: string, invitationId: string): Promise<boolean> {
  const { count } = await prisma.projectInvitation.updateMany({
    where: { id: invitationId, projectId, status: "pending" },
    data: { status: "revoked" },
  });
  return count > 0;
}

export type InvitationPreviewRow = {
  invitationId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  inviterName: string;
  role: ProjectRole;
  invitedEmail: string;
  expiresAt: Date;
};

/** Preview an invitation by token (does NOT consume it). */
export async function previewInvitationByToken(token: string): Promise<InvitationPreviewRow | null> {
  // We can't lookup MagicLink by token alone without consuming, but we can
  // look it up by hash (the lookup function does that).
  const { lookupMagicLink } = await import("@/lib/auth/magic-link");
  const ml = await lookupMagicLink(token, "invite");
  if (!ml.ok) return null;
  const invitation = await prisma.projectInvitation.findFirst({
    where: { magicLinkId: ml.id, status: "pending" },
    select: {
      id: true,
      role: true,
      email: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
      project: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!invitation) return null;
  return {
    invitationId: invitation.id,
    projectId: invitation.project.id,
    projectName: invitation.project.name,
    projectSlug: invitation.project.slug,
    inviterName: invitation.invitedBy.name,
    role: invitation.role,
    invitedEmail: invitation.email,
    expiresAt: invitation.expiresAt,
  };
}

export type AcceptInvitationResult =
  | { ok: true; projectSlug: string; role: ProjectRole }
  | {
      ok: false;
      code: "not_found" | "expired" | "consumed" | "email_mismatch" | "already_member";
    };

/**
 * Validate the token, check email match + membership, then consume + create
 * Membership atomically. The token is consumed ONLY when we're committing —
 * a wrong-user accept attempt does NOT burn the invitation link.
 */
export async function acceptInvitation(
  token: string,
  acceptingUserId: string,
  acceptingUserEmail: string,
): Promise<AcceptInvitationResult> {
  // 1. Peek at the token without consuming it.
  const looked = await lookupMagicLink(token, "invite");
  if (!looked.ok) return { ok: false, code: looked.reason };

  const invitation = await prisma.projectInvitation.findFirst({
    where: { magicLinkId: looked.id, status: "pending" },
    select: {
      id: true,
      projectId: true,
      email: true,
      role: true,
      project: { select: { slug: true } },
    },
  });
  if (!invitation) return { ok: false, code: "not_found" };

  // 2. Email check — wrong account doesn't burn the link.
  if (invitation.email.toLowerCase() !== acceptingUserEmail.toLowerCase()) {
    return { ok: false, code: "email_mismatch" };
  }

  // 3. Already a member? Consume + mark accepted so the link can't be re-tried.
  const existing = await prisma.membership.findUnique({
    where: { projectId_userId: { projectId: invitation.projectId, userId: acceptingUserId } },
    select: { id: true },
  });
  if (existing) {
    await consumeMagicLink(token, "invite");
    await prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", acceptedAt: new Date(), acceptedUserId: acceptingUserId },
    });
    return { ok: false, code: "already_member" };
  }

  // 4. Commit: consume the token, create the membership, mark accepted.
  const consumed = await consumeMagicLink(token, "invite");
  if (!consumed.ok) {
    // Race: someone else consumed it between peek and now. Reflect the new state.
    return { ok: false, code: consumed.reason };
  }
  await prisma.$transaction([
    prisma.membership.create({
      data: {
        projectId: invitation.projectId,
        userId: acceptingUserId,
        role: invitation.role,
        invitedById: null,
      },
    }),
    prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", acceptedAt: new Date(), acceptedUserId: acceptingUserId },
    }),
  ]);
  return { ok: true, projectSlug: invitation.project.slug, role: invitation.role };
}
