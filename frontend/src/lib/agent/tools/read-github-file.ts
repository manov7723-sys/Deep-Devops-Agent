import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import type { Tool } from "./types";

type Input = {
  /** Full repo name on GitHub, e.g. "alice/api". MUST be attached to the current project. */
  repoFullName: string;
  /** Path inside the repo, e.g. "src/index.ts". No leading slash. */
  path: string;
  /** Optional ref (branch / tag / commit). Defaults to the repo's default branch. */
  ref?: string;
};

type Output = {
  fullName: string;
  path: string;
  ref: string;
  /** UTF-8 decoded content. Capped at 64KB; binaries are rejected. */
  content: string;
  truncated: boolean;
  byteSize: number;
};

const MAX_BYTES = 64 * 1024;

/**
 * Read a file from one of the project's connected GitHub or GitLab repos.
 * Goes through resolveRepoClient, which binds to the repo's OAuth identity and
 * (for GitLab) refreshes the token, so each project speaks to the right host
 * with the correct identity.
 *
 * Refuses to read repos that aren't attached to the current project so a
 * prompt-injection attempt can't pivot to other repos the user owns.
 */
export const readGithubFileTool: Tool<Input, Output> = {
  name: "read_github_file",
  description:
    "Read the contents of a single file from a GitHub or GitLab repository " +
    "attached to the current project. Use this to inspect code, configs, or " +
    "manifests. Only repos returned by `list_project_repos` are accessible. " +
    "UTF-8 text only — binary files (images, archives) will be rejected.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description:
          'Full GitHub name like "owner/repo". Must be a repo attached to the current project.',
      },
      path: {
        type: "string",
        description: 'Path inside the repo, e.g. "src/index.ts". No leading slash.',
      },
      ref: {
        type: "string",
        description: "Optional branch, tag, or commit SHA. Defaults to the repo's default branch.",
      },
    },
    required: ["repoFullName", "path"],
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
        error: `Repo "${input.repoFullName}" isn't attached to this project. Use list_project_repos to see which repos are available.`,
      };
    }

    const resolved = await resolveRepoClient(repo.id);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `Cannot access ${input.repoFullName}: ${resolved.message}`,
      };
    }

    const ref = input.ref ?? repo.defaultBranch;
    const cleanPath = input.path.replace(/^\/+/, "");

    let content: string | null;
    try {
      content = await resolved.client.readFile(cleanPath, ref);
    } catch (err) {
      return {
        ok: false,
        error: `Could not read ${repo.fullName}/${cleanPath}@${ref}: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
    if (content === null) {
      return {
        ok: false,
        error: `${cleanPath} not found in ${repo.fullName}@${ref} (or it's a directory, not a file).`,
      };
    }

    // Binary guard — a NUL character in decoded text means it isn't UTF-8 text.
    if (/\x00/.test(content)) {
      return { ok: false, error: "File appears to be binary — refusing to read." };
    }
    const byteSize = Buffer.byteLength(content, "utf8");
    if (byteSize > MAX_BYTES * 4) {
      return {
        ok: false,
        error: `File is ${byteSize} bytes — too large to read inline. Cap is ${MAX_BYTES} bytes.`,
      };
    }

    const capped = content.length > MAX_BYTES;
    return {
      ok: true,
      output: {
        fullName: repo.fullName,
        path: cleanPath,
        ref,
        content: capped ? content.slice(0, MAX_BYTES) : content,
        truncated: capped,
        byteSize,
      },
    };
  },
};
