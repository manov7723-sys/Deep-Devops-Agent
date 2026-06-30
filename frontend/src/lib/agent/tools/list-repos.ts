import { prisma } from "@/lib/db/prisma";
import type { Tool } from "./types";

type Output = Array<{
  fullName: string;
  defaultBranch: string;
  visibility: string;
  lang: string;
  kind: string;
  connectedAs: string | null;
  description: string | null;
}>;

/**
 * List the repos attached to the current project. Lets the agent answer
 * questions like "what repos are in this project?" without guessing.
 */
export const listReposTool: Tool<Record<string, never>, Output> = {
  name: "list_project_repos",
  description:
    "List every GitHub repository attached to the current DeepAgent project. " +
    "Returns the repo's fullName, default branch, language, visibility, and which " +
    "connected GitHub identity (`connectedAs`) the agent should use for it.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx) {
    const rows = await prisma.projectRepo.findMany({
      where: { projectId: ctx.projectId, repo: { deletedAt: null } },
      select: {
        repo: {
          select: {
            fullName: true,
            defaultBranch: true,
            visibility: true,
            lang: true,
            kind: true,
            description: true,
            oauthAccount: { select: { login: true } },
          },
        },
      },
    });
    return {
      ok: true,
      output: rows.map((r) => ({
        fullName: r.repo.fullName,
        defaultBranch: r.repo.defaultBranch,
        visibility: r.repo.visibility,
        lang: r.repo.lang,
        kind: r.repo.kind,
        description: r.repo.description,
        connectedAs: r.repo.oauthAccount?.login ?? null,
      })),
    };
  },
};
