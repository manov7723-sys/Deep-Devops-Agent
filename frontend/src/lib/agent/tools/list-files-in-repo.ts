import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
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
 * Browse a directory in a connected GitHub repo. Pairs with read_github_file
 * for the chain "list a folder → pick the interesting file → read it". Uses
 * Phase B's resolveTokenForRepo so multi-account projects use the right
 * GitHub identity.
 */
export const listFilesInRepoTool: Tool<Input, Output> = {
  name: "list_files_in_repo",
  description:
    "List files and subfolders at a path inside a GitHub repo attached to the " +
    "current project. Use this to explore a repo before reading specific files. " +
    "Pass path=\"\" or path=\"/\" for the root. Only repos returned by " +
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

    const tok = await resolveTokenForRepo(repo.id);
    if (!tok.ok) {
      return { ok: false, error: `Cannot access ${input.repoFullName}: ${tok.message}` };
    }

    const ref = input.ref ?? repo.defaultBranch;
    const cleanPath = (input.path ?? "").replace(/^\/+|\/+$/g, "");
    const url = cleanPath
      ? `https://api.github.com/repos/${repo.fullName}/contents/${encodeURIComponent(cleanPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`
      : `https://api.github.com/repos/${repo.fullName}/contents?ref=${encodeURIComponent(ref)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tok.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      });
    } catch (err) {
      return {
        ok: false,
        error: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `GitHub returned ${res.status} listing ${repo.fullName}/${cleanPath || "/"}@${ref}: ${body.slice(0, 200)}`,
      };
    }

    const raw = (await res.json()) as unknown;
    // Contents API returns an array for dirs, an object for files. If a file
    // path was given, surface that as a single entry.
    const items: Entry[] = Array.isArray(raw)
      ? (raw as Array<{ name: string; path: string; type: string; size?: number }>).map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type === "dir" ? "dir" : "file",
          size: e.size,
        }))
      : [
          {
            name: (raw as { name: string }).name,
            path: (raw as { path: string }).path,
            type: "file",
            size: (raw as { size?: number }).size,
          },
        ];

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
