/**
 * Project CRUD + member listing/mutations. Reads use minimum-role gating,
 * writes call requireProjectAccess(slug, 'developer') or 'owner' as needed.
 */
import type { ProjectRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { generateUniqueSlug } from "./slug";

export type ProjectListItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  colorHue: number;
  health: "ok" | "warn" | "danger";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  myRole: ProjectRole;
  envCount: number;
  repoCount: number;
  cloud: string[];
};

/** Projects the user is a member of (any role), newest first. The summary
 *  carries env/repo counts + cloud-kind labels so list screens don't need to
 *  fan out per-project queries. */
export async function listProjectsForUser(userId: string): Promise<ProjectListItem[]> {
  const rows = await prisma.membership.findMany({
    where: { userId, project: { deletedAt: null } },
    orderBy: { project: { updatedAt: "desc" } },
    select: {
      role: true,
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          colorHue: true,
          health: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { environments: true, projectRepos: true } },
          environments: { select: { cloudProvider: { select: { kind: true } } } },
        },
      },
    },
  });
  return rows.map((r) => {
    const kinds = new Set<string>();
    for (const env of r.project.environments) {
      if (env.cloudProvider) kinds.add(env.cloudProvider.kind);
    }
    return {
      id: r.project.id,
      slug: r.project.slug,
      name: r.project.name,
      description: r.project.description,
      colorHue: r.project.colorHue,
      health: r.project.health,
      archivedAt: r.project.archivedAt?.toISOString() ?? null,
      createdAt: r.project.createdAt.toISOString(),
      updatedAt: r.project.updatedAt.toISOString(),
      myRole: r.role,
      envCount: r.project._count.environments,
      repoCount: r.project._count.projectRepos,
      cloud: [...kinds],
    };
  });
}

export type CreateProjectArgs = {
  ownerId: string;
  name: string;
  description: string;
  colorHue: number;
  /** The cloud this project targets ("aws"|"gcp"|"azure"); locks the Connect-provider UI. */
  cloud?: string | null;
};

/**
 * Create + owner-membership in one transaction. Slug is generated from the
 * name with deterministic collision suffixing.
 */
export async function createProject(args: CreateProjectArgs): Promise<{ id: string; slug: string }> {
  const slug = await generateUniqueSlug(args.name);
  const created = await prisma.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: {
        slug,
        ownerId: args.ownerId,
        name: args.name,
        description: args.description,
        colorHue: args.colorHue,
        cloud: args.cloud ?? null,
      },
      select: { id: true, slug: true },
    });
    await tx.membership.create({
      data: {
        projectId: p.id,
        userId: args.ownerId,
        role: "owner",
      },
    });
    await tx.projectSetting.create({
      data: { projectId: p.id },
    });
    return p;
  });
  return created;
}

export type UpdateProjectArgs = Partial<{
  name: string;
  description: string;
  colorHue: number;
}>;

export async function updateProject(projectId: string, patch: UpdateProjectArgs) {
  const data: Prisma.ProjectUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.colorHue !== undefined) data.colorHue = patch.colorHue;
  await prisma.project.update({ where: { id: projectId }, data });
}

/**
 * Soft-archive: sets archivedAt; pipelines & agents should treat archived
 * projects as read-only. Reversible via `unarchiveProject`.
 */
export async function archiveProject(projectId: string): Promise<{ archivedAt: string }> {
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { archivedAt: new Date() },
    select: { archivedAt: true },
  });
  return { archivedAt: updated.archivedAt!.toISOString() };
}

export async function unarchiveProject(projectId: string): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { archivedAt: null },
  });
}

export type DeleteProjectResult = { ok: true; deletedAt: string };

/**
 * Soft-delete: sets deletedAt. `listProjectsForUser` already filters these
 * out, so the project disappears from listings but rows stay for audit/undo.
 */
export async function softDeleteProject(projectId: string): Promise<DeleteProjectResult> {
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date() },
    select: { deletedAt: true },
  });
  return { ok: true, deletedAt: updated.deletedAt!.toISOString() };
}

export type TransferProjectResult =
  | { ok: true; newOwner: { id: string; name: string; email: string } }
  | {
      ok: false;
      code:
        | "user_not_found"
        | "already_owner"
        | "self_transfer";
    };

/**
 * Reassign Project.ownerId AND make the recipient an `owner` membership in
 * the same transaction so existing owner-gated queries keep working. The
 * previous owner is demoted to `developer` so they retain write access.
 */
export async function transferProject(args: {
  projectId: string;
  currentOwnerId: string;
  newOwnerEmail: string;
}): Promise<TransferProjectResult> {
  const recipient = await prisma.user.findUnique({
    where: { email: args.newOwnerEmail.toLowerCase().trim() },
    select: { id: true, name: true, email: true },
  });
  if (!recipient) return { ok: false, code: "user_not_found" };
  if (recipient.id === args.currentOwnerId) return { ok: false, code: "self_transfer" };

  const existing = await prisma.membership.findUnique({
    where: { projectId_userId: { projectId: args.projectId, userId: recipient.id } },
    select: { role: true },
  });
  if (existing?.role === "owner") return { ok: false, code: "already_owner" };

  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: args.projectId },
      data: { ownerId: recipient.id },
    });
    // demote prior owner to developer (still has write access)
    await tx.membership.update({
      where: {
        projectId_userId: { projectId: args.projectId, userId: args.currentOwnerId },
      },
      data: { role: "developer" },
    });
    // upsert recipient as owner
    if (existing) {
      await tx.membership.update({
        where: { projectId_userId: { projectId: args.projectId, userId: recipient.id } },
        data: { role: "owner" },
      });
    } else {
      await tx.membership.create({
        data: {
          projectId: args.projectId,
          userId: recipient.id,
          role: "owner",
        },
      });
    }
  });

  return { ok: true, newOwner: recipient };
}

export type ProjectStats = {
  memberCount: number;
  pendingInvitations: number;
};

export async function projectStats(projectId: string): Promise<ProjectStats> {
  const [memberCount, pendingInvitations] = await Promise.all([
    prisma.membership.count({ where: { projectId } }),
    prisma.projectInvitation.count({ where: { projectId, status: "pending" } }),
  ]);
  return { memberCount, pendingInvitations };
}

export type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: ProjectRole;
  joinedAt: string;
};

export async function listMembers(projectId: string): Promise<MemberRow[]> {
  const rows = await prisma.membership.findMany({
    where: { projectId },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    select: {
      id: true,
      role: true,
      joinedAt: true,
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  });
  return rows.map((r) => ({
    membershipId: r.id,
    userId: r.user.id,
    name: r.user.name,
    email: r.user.email,
    avatarUrl: r.user.avatarUrl,
    role: r.role,
    joinedAt: r.joinedAt.toISOString(),
  }));
}

export type ChangeRoleResult =
  | { ok: true }
  | { ok: false; code: "not_a_member" | "last_owner" | "cannot_demote_owner" };

/**
 * Change a member's role. Demoting the last owner is rejected to prevent
 * orphaning the project. The "owner" role itself is non-assignable via API.
 */
export async function changeMemberRole(
  projectId: string,
  targetUserId: string,
  newRole: "developer" | "viewer",
): Promise<ChangeRoleResult> {
  const current = await prisma.membership.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    select: { role: true },
  });
  if (!current) return { ok: false, code: "not_a_member" };
  if (current.role === "owner") return { ok: false, code: "cannot_demote_owner" };
  await prisma.membership.update({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    data: { role: newRole },
  });
  return { ok: true };
}

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; code: "not_a_member" | "cannot_remove_owner" };

export async function removeMember(
  projectId: string,
  targetUserId: string,
): Promise<RemoveMemberResult> {
  const current = await prisma.membership.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    select: { role: true },
  });
  if (!current) return { ok: false, code: "not_a_member" };
  if (current.role === "owner") return { ok: false, code: "cannot_remove_owner" };
  await prisma.membership.delete({
    where: { projectId_userId: { projectId, userId: targetUserId } },
  });
  return { ok: true };
}
