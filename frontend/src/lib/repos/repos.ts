/**
 * Repo registration + project attachment.
 *
 * Repos are owned at the User level (ownerId). Attaching to a project requires
 * developer+ membership AND ownership of the repo. Disconnect is soft-delete
 * (deletedAt) — retained for undo + audit per the schema header.
 */
import type { GitProvider, RepoKind, RepoVisibility } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type RepoRow = {
  id: string;
  oauthAccountId: string | null;
  /** Denormalized for UI: login of the connected account (GitHub/GitLab) this
   *  repo belongs to. Null for legacy rows (oauthAccountId null) or when the
   *  connected account has no `login` yet. */
  oauthAccountLogin: string | null;
  provider: GitProvider;
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
  provider: GitProvider;
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
    provider: r.provider,
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
  /** The connected git identity (OAuthAccount.id) this repo was discovered through. */
  oauthAccountId?: string | null;
  /** Git host of the repo. Defaults to github for existing callers. */
  provider?: GitProvider;
  /** Provider-native repo id (GitLab numeric project id). Null for GitHub. */
  providerRepoId?: string | null;
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
  // Last path segment is the display name — also correct for GitLab nested
  // groups ("group/sub/repo" → "repo").
  const name = args.fullName.split("/").pop()!;
  const provider = args.provider ?? "github";

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
        provider,
        providerRepoId: args.providerRepoId ?? null,
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
        // Refresh the provider-native id on re-discovery (repo may have been
        // renamed/transferred since the soft-deleted row was created).
        ...(args.providerRepoId ? { providerRepoId: args.providerRepoId } : {}),
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

  const legacyKey = {
    ownerId_provider_fullName: {
      ownerId: args.ownerId,
      provider,
      fullName: args.fullName,
    },
  };
  const existing = await prisma.repo.findUnique({ where: legacyKey });
  if (existing && !existing.deletedAt) return { ok: false, code: "duplicate" };
  const updated = await prisma.repo.upsert({
    where: legacyKey,
    create: {
      ownerId: args.ownerId,
      provider,
      providerRepoId: args.providerRepoId ?? null,
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
      ...(args.providerRepoId ? { providerRepoId: args.providerRepoId } : {}),
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

/**
 * Make `repoId` the project's SINGLE repo — used by "Change repo" in the GitHub
 * connection section so the new repo applies to the whole project. Detaches
 * every other repo and attaches this one, atomically. Idempotent: re-setting
 * the same repo is a no-op success.
 */
export async function setProjectRepo(
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

  await prisma.$transaction([
    prisma.projectRepo.deleteMany({ where: { projectId, repoId: { not: repoId } } }),
    prisma.projectRepo.upsert({
      where: { projectId_repoId: { projectId, repoId } },
      create: { projectId, repoId },
      update: {},
    }),
  ]);
  return { ok: true };
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
