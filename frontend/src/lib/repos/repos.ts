/**
 * Repo registration + project attachment.
 *
 * Repos are owned at the User level (ownerId). Attaching to a project requires
 * developer+ membership AND ownership of the repo. Disconnect is soft-delete
 * (deletedAt) — retained for undo + audit per the schema header.
 */
import type { RepoKind, RepoVisibility } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type RepoRow = {
  id: string;
  oauthAccountId: string | null;
  /** Denormalized for UI: GitHub login of the connected account this repo
   *  belongs to. Null for legacy rows (oauthAccountId null) or when the
   *  connected account has no `login` yet. */
  oauthAccountLogin: string | null;
  fullName: string;
  name: string;
  description: string | null;
  lang: string;
  kind: RepoKind;
  defaultBranch: string;
  visibility: RepoVisibility;
  openIssues: number;
  openPrs: number;
  lastCommitSha: string | null;
  lastCommitAt: string | null;
  createdAt: string;
};

type RepoWithAccount = {
  id: string;
  oauthAccountId: string | null;
  oauthAccount: { login: string | null } | null;
  fullName: string;
  name: string;
  description: string | null;
  lang: string;
  kind: RepoKind;
  defaultBranch: string;
  visibility: RepoVisibility;
  openIssues: number;
  openPrs: number;
  lastCommitSha: string | null;
  lastCommitAt: Date | null;
  createdAt: Date;
};

function row(r: RepoWithAccount): RepoRow {
  return {
    id: r.id,
    oauthAccountId: r.oauthAccountId,
    oauthAccountLogin: r.oauthAccount?.login ?? null,
    fullName: r.fullName,
    name: r.name,
    description: r.description,
    lang: r.lang,
    kind: r.kind,
    defaultBranch: r.defaultBranch,
    visibility: r.visibility,
    openIssues: r.openIssues,
    openPrs: r.openPrs,
    lastCommitSha: r.lastCommitSha,
    lastCommitAt: r.lastCommitAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listReposForUser(userId: string): Promise<RepoRow[]> {
  const rows = await prisma.repo.findMany({
    where: { ownerId: userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { oauthAccount: { select: { login: true } } },
  });
  return rows.map(row);
}

export type CreateRepoArgs = {
  ownerId: string;
  /** The connected GitHub identity (OAuthAccount.id) this repo was discovered through. */
  oauthAccountId?: string | null;
  fullName: string;
  description: string;
  lang: string;
  kind: RepoKind;
  defaultBranch: string;
  visibility: RepoVisibility;
};

export type CreateRepoResult =
  | { ok: true; repo: RepoRow }
  | { ok: false; code: "duplicate" };

/**
 * Idempotent. When `oauthAccountId` is provided, identity is
 * `(oauthAccountId, fullName)` — so the same repo path under two different
 * connected GitHub identities can coexist. Otherwise falls back to the
 * legacy `(ownerId, fullName)` constraint.
 */
export async function createRepo(args: CreateRepoArgs): Promise<CreateRepoResult> {
  const name = args.fullName.split("/").pop()!;

  // Prefer (oauthAccountId, fullName) when we have one — that matches the
  // real GitHub identity-scoping reality.
  if (args.oauthAccountId) {
    const existing = await prisma.repo.findUnique({
      where: {
        oauthAccountId_fullName: {
          oauthAccountId: args.oauthAccountId,
          fullName: args.fullName,
        },
      },
    });
    if (existing && !existing.deletedAt) return { ok: false, code: "duplicate" };
    const upserted = await prisma.repo.upsert({
      where: {
        oauthAccountId_fullName: {
          oauthAccountId: args.oauthAccountId,
          fullName: args.fullName,
        },
      },
      create: {
        ownerId: args.ownerId,
        oauthAccountId: args.oauthAccountId,
        fullName: args.fullName,
        name,
        description: args.description,
        lang: args.lang,
        kind: args.kind,
        defaultBranch: args.defaultBranch,
        visibility: args.visibility,
      },
      update: {
        deletedAt: null,
        ownerId: args.ownerId,
        description: args.description,
        lang: args.lang,
        kind: args.kind,
        defaultBranch: args.defaultBranch,
        visibility: args.visibility,
      },
      include: { oauthAccount: { select: { login: true } } },
    });
    return { ok: true, repo: row(upserted) };
  }

  const existing = await prisma.repo.findUnique({
    where: { ownerId_fullName: { ownerId: args.ownerId, fullName: args.fullName } },
  });
  if (existing && !existing.deletedAt) return { ok: false, code: "duplicate" };
  const updated = await prisma.repo.upsert({
    where: { ownerId_fullName: { ownerId: args.ownerId, fullName: args.fullName } },
    create: {
      ownerId: args.ownerId,
      fullName: args.fullName,
      name,
      description: args.description,
      lang: args.lang,
      kind: args.kind,
      defaultBranch: args.defaultBranch,
      visibility: args.visibility,
    },
    update: {
      deletedAt: null,
      description: args.description,
      lang: args.lang,
      kind: args.kind,
      defaultBranch: args.defaultBranch,
      visibility: args.visibility,
    },
    include: { oauthAccount: { select: { login: true } } },
  });
  return { ok: true, repo: row(updated) };
}

export type DisconnectResult =
  | { ok: true }
  | { ok: false; code: "not_found" };

export async function disconnectRepo(userId: string, repoId: string): Promise<DisconnectResult> {
  const { count } = await prisma.repo.updateMany({
    where: { id: repoId, ownerId: userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return count > 0 ? { ok: true } : { ok: false, code: "not_found" };
}

// ──────────────────────────────────────────────────────────────────
// Project ↔ Repo attachment
// ──────────────────────────────────────────────────────────────────

export type AttachRepoResult =
  | { ok: true }
  | { ok: false; code: "repo_not_yours" | "repo_not_found" | "already_attached" };

export async function attachRepoToProject(
  attachingUserId: string,
  projectId: string,
  repoId: string,
): Promise<AttachRepoResult> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!repo) return { ok: false, code: "repo_not_found" };
  if (repo.ownerId !== attachingUserId) return { ok: false, code: "repo_not_yours" };

  try {
    await prisma.projectRepo.create({ data: { projectId, repoId } });
    return { ok: true };
  } catch (err) {
    // P2002 unique constraint → already attached.
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return { ok: false, code: "already_attached" };
    }
    throw err;
  }
}

export async function detachRepoFromProject(projectId: string, repoId: string): Promise<boolean> {
  const { count } = await prisma.projectRepo.deleteMany({ where: { projectId, repoId } });
  return count > 0;
}

export async function listReposForProject(projectId: string): Promise<RepoRow[]> {
  const rows = await prisma.projectRepo.findMany({
    where: { projectId, repo: { deletedAt: null } },
    orderBy: { addedAt: "desc" },
    select: {
      repo: {
        include: { oauthAccount: { select: { login: true } } },
      },
    },
  });
  return rows.map((r) => row(r.repo));
}
