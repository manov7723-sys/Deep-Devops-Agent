/**
 * list_repo_branches — enumerate the branches on a repo attached to this
 * project. The deploy pipeline uses this so the agent can ask the user which
 * branch to wire CI/CD to (existing branch OR a new one), instead of silently
 * defaulting to the repo's default branch. Reuses the repo's stored OAuth
 * token — no user-facing GitHub prompt.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import type { Tool } from "./types";

type Input = { repoFullName: string };
type Output = { branches: string[]; defaultBranch: string };

export const listRepoBranchesTool: Tool<Input, Output> = {
  name: "list_repo_branches",
  description:
    "List the branches on a GitHub repo attached to this project, plus the repo's default branch. Use this " +
    "in the deploy pipeline BEFORE calling deploy_my_app: ask the user in ONE ```options``` block which branch " +
    "the CI/CD workflow should trigger from — the returned branches plus a 'Create new: <name>' option — and " +
    "pass their answer as the `branch` field to deploy_my_app. If the user picks a new name that isn't in the " +
    "returned list, deploy_my_app auto-creates it off the default branch before pushing.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'GitHub repo as "owner/name" (must be attached to this project).',
      },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true, defaultBranch: true },
    });
    if (!repo)
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };

    const tok = await resolveTokenForRepo(repo.id);
    const fallback: Output = {
      branches: repo.defaultBranch ? [repo.defaultBranch] : [],
      defaultBranch: repo.defaultBranch || "main",
    };
    if (!tok.ok) return { ok: true, output: fallback };

    try {
      const res = await fetch(
        `https://api.github.com/repos/${input.repoFullName}/branches?per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${tok.accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          cache: "no-store",
        },
      );
      if (!res.ok) return { ok: true, output: fallback };
      const rows = (await res.json().catch(() => [])) as Array<{ name?: string }>;
      const branches = rows.map((b) => b.name).filter((n): n is string => !!n);
      return {
        ok: true,
        output: {
          branches: branches.length ? branches : fallback.branches,
          defaultBranch: repo.defaultBranch || branches[0] || "main",
        },
      };
    } catch {
      return { ok: true, output: fallback };
    }
  },
};
