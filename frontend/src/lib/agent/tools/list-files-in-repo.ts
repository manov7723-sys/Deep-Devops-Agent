import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import type { Tool } from "./types";

type Input = {
  /** Full repo name like "alice/api". Must be attached to the current project. */
  repoFullName: string;
  /** Folder path inside the repo. Empty string or "/" = root. */
  path?: string;
  /** Branch / tag / commit. Defaults to the repo's default branch. */
  ref?: string;
};

type Entry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
};

type Output = {
  fullName: string;
  path: string;
  ref: string;
  entries: Entry[];
};

/**
 * Browse a directory in a connected GitHub or GitLab repo. Pairs with
 * read_github_file for the chain "list a folder → pick the interesting file →
 * read it". Goes through resolveRepoClient, so it works for either provider and
 * multi-account projects use the right identity.
 */
export const listFilesInRepoTool: Tool<Input, Output> = {
  name: "list_files_in_repo",
  description:
    "List files and subfolders at a path inside a GitHub or GitLab repo attached " +
    "to the current project. Use this to explore a repo before reading specific " +
    'files. Pass path="" or path="/" for the root. Only repos returned by ' +
    "list_project_repos are accessible.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'Full GitHub name "owner/repo", must be attached to this project.',
      },
      path: {
        type: "string",
        description: 'Path inside the repo. "" or "/" for root. No leading slash on subpaths.',
      },
      ref: {
        type: "string",
        description: "Optional branch / tag / commit SHA. Defaults to the repo's default branch.",
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
      select: { id: true, defaultBranch: true, fullName: true },
    });
    if (!repo) {
      return {
        ok: false,
        error: `Repo "${input.repoFullName}" isn't attached to this project.`,
      };
    }

    const resolved = await resolveRepoClient(repo.id);
    if (!resolved.ok) {
      return { ok: false, error: `Cannot access ${input.repoFullName}: ${resolved.message}` };
    }

    const ref = input.ref ?? repo.defaultBranch;
    const cleanPath = (input.path ?? "").replace(/^\/+|\/+$/g, "");

    let items: Entry[];
    try {
      const entries = await resolved.client.listFiles(cleanPath, ref);
      items = entries.map((e) => ({ name: e.name, path: e.path, type: e.type }));
    } catch (err) {
      return {
        ok: false,
        error: `Could not list ${repo.fullName}/${cleanPath || "/"}@${ref}: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    items.sort((a, b) => {
      // Dirs first, then alpha.
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      ok: true,
      output: {
        fullName: repo.fullName,
        path: cleanPath || "/",
        ref,
        entries: items.slice(0, 200),
      },
    };
  },
};
