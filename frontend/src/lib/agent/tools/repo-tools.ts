import { prisma } from "@/lib/db/prisma";
import {
  listReposForUser,
  listReposForProject,
  attachRepoToProject,
  setProjectRepo,
} from "@/lib/repos/repos";
import type { Tool } from "./types";

type AvailableRepo = {
  id: string;
  fullName: string;
  defaultBranch: string;
  visibility: string;
  lang: string;
};

/**
 * List the user's connected GitHub/GitLab repos NOT yet attached to this
 * project. Use before attach_project_repo so the user can pick one via an
 * ```options``` block instead of the agent guessing a fullName.
 */
export const listAvailableReposTool: Tool<Record<string, never>, AvailableRepo[]> = {
  name: "list_available_repos",
  description:
    "List the user's connected repos that are NOT yet attached to this project. Use before attach_project_repo.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const [all, attached] = await Promise.all([
      listReposForUser(ctx.userId),
      listReposForProject(ctx.projectId),
    ]);
    const attachedIds = new Set(attached.map((r) => r.id));
    return {
      ok: true,
      output: all
        .filter((r) => !attachedIds.has(r.id))
        .map((r) => ({
          id: r.id,
          fullName: r.fullName,
          defaultBranch: r.defaultBranch,
          visibility: r.visibility,
          lang: r.lang,
        })),
    };
  },
};

export const attachProjectRepoTool: Tool<
  { repoId: string; asOnly?: boolean },
  { fullName: string }
> = {
  name: "attach_project_repo",
  description:
    "Attach a repo (id from list_available_repos) to this project. Pass asOnly=true to make it the " +
    "project's single active repo, detaching any others — use that when the user is switching repos, " +
    "not adding a second one.",
  inputSchema: {
    type: "object",
    properties: {
      repoId: { type: "string", description: "Repo id from list_available_repos." },
      asOnly: {
        type: "boolean",
        description: "If true, replaces the project's repo set with just this one. Default false.",
      },
    },
    required: ["repoId"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = input.asOnly
      ? await setProjectRepo(ctx.userId, ctx.projectId, input.repoId)
      : await attachRepoToProject(ctx.userId, ctx.projectId, input.repoId);
    if (!res.ok) return { ok: false, error: res.code };
    const repo = await prisma.repo.findUnique({
      where: { id: input.repoId },
      select: { fullName: true },
    });
    return { ok: true, output: { fullName: repo?.fullName ?? input.repoId } };
  },
};
