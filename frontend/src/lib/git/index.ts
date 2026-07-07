/**
 * resolveRepoClient — the factory the repo tools call. Loads the Repo row,
 * resolves a fresh token (repo-token.ts handles GitLab's 2h refresh), and hands
 * back the right provider client. Callers use one interface; the GitHub-vs-GitLab
 * REST differences live in ./github and ./gitlab.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { gitlabBaseUrl } from "@/lib/oauth/providers";
import type { GitRepoClient } from "./types";
import { GithubRepoClient } from "./github";
import { GitlabRepoClient } from "./gitlab";

export type { GitRepoClient, GitEntry, GitProviderKind } from "./types";

export type ResolveRepoClient =
  | {
      ok: true;
      client: GitRepoClient;
      account: { id: string; login: string | null; providerAccountId: string; userId: string };
    }
  | { ok: false; code: string; message: string };

export async function resolveRepoClient(repoId: string): Promise<ResolveRepoClient> {
  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: { id: true, provider: true, fullName: true, defaultBranch: true, providerRepoId: true },
  });
  if (!repo) return { ok: false, code: "repo_not_found", message: "Repo not found." };

  const tok = await resolveTokenForRepo(repoId);
  if (!tok.ok) return { ok: false, code: tok.code, message: tok.message };

  if (repo.provider === "gitlab") {
    const webBase = (tok.providerBaseUrl || gitlabBaseUrl()).replace(/\/+$/, "");
    const client = new GitlabRepoClient({
      token: tok.accessToken,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      apiBase: tok.apiBase,
      projectId: repo.providerRepoId,
      webBase,
    });
    return { ok: true, client, account: tok.account };
  }

  const client = new GithubRepoClient({
    token: tok.accessToken,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    apiBase: tok.apiBase,
  });
  return { ok: true, client, account: tok.account };
}
