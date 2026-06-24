import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
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
 * Read a file from one of the project's connected GitHub repos. Uses the
 * OAuth token bound to the repo via Phase B's oauthAccountId, so a project
 * pulling from `@alice` and another pulling from `@alice-acme` each speak
 * to GitHub with the correct identity.
 *
 * Refuses to read repos that aren't attached to the current project so a
 * prompt-injection attempt can't pivot to other repos the user owns.
 */
export const readGithubFileTool: Tool<Input, Output> = {
  name: "read_github_file",
  description:
    "Read the contents of a single file from a GitHub repository attached to " +
    "the current project. Use this to inspect code, configs, or manifests. " +
    "Only repos returned by `list_project_repos` are accessible. UTF-8 text only " +
    "— binary files (images, archives) will be rejected.",
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

    const tok = await resolveTokenForRepo(repo.id);
    if (!tok.ok) {
      return {
        ok: false,
        error: `Cannot access ${input.repoFullName}: ${tok.message}`,
      };
    }

    const ref = input.ref ?? repo.defaultBranch;
    const cleanPath = input.path.replace(/^\/+/, "");
    const url = `https://api.github.com/repos/${repo.fullName}/contents/${encodeURIComponent(cleanPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`;

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
      return { ok: false, error: `Network error fetching file: ${err instanceof Error ? err.message : "unknown"}` };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `GitHub returned ${res.status} fetching ${repo.fullName}/${cleanPath}@${ref}: ${body.slice(0, 200)}`,
      };
    }

    const raw = (await res.json()) as {
      type?: string;
      encoding?: string;
      content?: string;
      size?: number;
      sha?: string;
    };
    if (raw.type !== "file") {
      return {
        ok: false,
        error: `${cleanPath} isn't a file (got ${raw.type}). Use the GitHub contents endpoint directly for trees.`,
      };
    }
    if (raw.encoding !== "base64" || !raw.content) {
      return {
        ok: false,
        error: `Unexpected GitHub encoding (${raw.encoding}).`,
      };
    }

    const buf = Buffer.from(raw.content, "base64");
    if (buf.length > MAX_BYTES * 4) {
      return {
        ok: false,
        error: `File is ${buf.length} bytes — too large to read inline. Cap is ${MAX_BYTES} bytes.`,
      };
    }
    // Defend against binaries — check for NUL byte in the first 8KB.
    const slice = buf.subarray(0, Math.min(buf.length, 8192));
    if (slice.includes(0x00)) {
      return { ok: false, error: "File appears to be binary — refusing to read." };
    }

    const text = buf.toString("utf8");
    const capped = text.length > MAX_BYTES;
    return {
      ok: true,
      output: {
        fullName: repo.fullName,
        path: cleanPath,
        ref,
        content: capped ? text.slice(0, MAX_BYTES) : text,
        truncated: capped,
        byteSize: buf.length,
      },
    };
  },
};
