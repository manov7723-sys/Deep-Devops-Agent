"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type ApiError } from "@/lib/api/client";
import type { SeedRepo } from "@/lib/legacy-types";

/** Local catalog — repositories already attached to one or more projects. */
export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: () => api.get<SeedRepo[]>("/repos"),
    staleTime: 60_000,
  });
}

/**
 * Live list of the caller's GitHub repositories via the GitHub API.
 * Used by the project-create wizard so users can pick *any* of their
 * actual repos, not just those already imported. Distinct error codes
 * surface via the `ApiError.details` body returned by the route:
 *
 *   github_not_connected      — no OAuthAccount(provider=github) yet
 *   github_scope_insufficient — connected but without `repo` scope
 *   github_<status>           — upstream GitHub error
 */
export type GitHubRepoRow = {
  id: string;
  name: string;
  fullName: string;
  lang: string;
  kind: "public" | "private";
  defaultBranch: string;
  htmlUrl: string;
  pushedAt: string | null;
};

export function useGitHubRepos(enabled = true, accountId?: string | null) {
  return useQuery<GitHubRepoRow[], ApiError>({
    queryKey: ["integrations", "github", "repos", accountId ?? "default"],
    queryFn: () =>
      api.get<GitHubRepoRow[]>(
        "/integrations/github/repos",
        accountId ? { accountId } : undefined,
      ),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Who the caller is on GitHub — used for the "Connected as <login>" banner. */
export type GitHubMe = {
  accountId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  providerAccountId: string;
};

export function useGitHubMe(enabled = true, accountId?: string | null) {
  return useQuery<GitHubMe, ApiError>({
    queryKey: ["integrations", "github", "me", accountId ?? "default"],
    queryFn: async () => {
      const res = await api.get<{ ok: boolean } & GitHubMe>(
        "/integrations/github/me",
        accountId ? { accountId } : undefined,
      );
      return {
        accountId: res.accountId,
        login: res.login,
        name: res.name,
        avatarUrl: res.avatarUrl,
        profileUrl: res.profileUrl,
        providerAccountId: res.providerAccountId,
      };
    },
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}
