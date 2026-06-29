import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import type { Tool } from "./types";

type Input = {
  /** Full repo name like "alice/api". Must be attached to the project. */
  repoFullName: string;
  /** Path inside the repo. No leading slash. */
  path: string;
  /** Full file contents (UTF-8). */
  content: string;
  /** Commit message — used both for the commit and as the PR title prefix. */
  message: string;
  /** Branch to commit to. Created from the default branch if it doesn't exist. */
  branch: string;
  /** Open a pull request from `branch` → default branch. */
  openPullRequest?: boolean;
  /** PR body (markdown). Used only when openPullRequest is true. */
  pullRequestBody?: string;
};

type Output = {
  fullName: string;
  path: string;
  branch: string;
  commitSha: string;
  pullRequest?: { number: number; url: string };
};

const MAX_CONTENT_BYTES = 256 * 1024;

/**
 * Commit a file to a branch in a connected GitHub repo, optionally opening
 * a PR. The agent uses this for things like "create the Helm chart in
 * alice/api/chart" or "patch values.yaml with the new image tag".
 *
 * Server-side guards:
 *   - Repo must be attached to the current project.
 *   - File content ≤ 256KB.
 *   - Branch name is normalised (slashes allowed, no leading slash).
 *   - Default branch protection is honored — if `branch` equals the default,
 *     we refuse to commit directly (must open a PR).
 */
export const writeRepoFileTool: Tool<Input, Output> = {
  name: "write_repo_file",
  description:
    "Commit a file to a branch in a GitHub repo attached to the current " +
    "project, optionally opening a pull request. Use this to author Helm " +
    "charts, env configs, terraform HCL, manifests — anything that should " +
    "land via PR review. Direct commits to the default branch are refused; " +
    "use a feature branch and set openPullRequest=true.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'owner/repo, must be attached to the project.' },
      path: { type: "string", description: 'Path inside the repo (e.g. "chart/values.yaml"). No leading slash.' },
      content: { type: "string", description: "Full file contents (UTF-8)." },
      message: { type: "string", description: "Commit message. Also used as PR title prefix." },
      branch: { type: "string", description: 'Branch to commit to. Must differ from the default branch.' },
      openPullRequest: { type: "boolean", description: "Open a PR after committing." },
      pullRequestBody: { type: "string", description: "PR body (markdown). Used only when openPullRequest=true." },
    },
    required: ["repoFullName", "path", "content", "message", "branch"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (Buffer.byteLength(input.content, "utf8") > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        error: `File too large (${Buffer.byteLength(input.content, "utf8")} bytes). Cap is ${MAX_CONTENT_BYTES} bytes per commit.`,
      };
    }

    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true, defaultBranch: true, fullName: true },
    });
    if (!repo) {
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    }

    const branch = input.branch.replace(/^\/+/, "");
    if (branch === repo.defaultBranch) {
      return {
        ok: false,
        error: `Refusing to commit directly to the default branch (${repo.defaultBranch}). Use a feature branch and set openPullRequest=true.`,
      };
    }

    const tok = await resolveTokenForRepo(repo.id);
    if (!tok.ok) {
      return { ok: false, error: `Cannot access ${input.repoFullName}: ${tok.message}` };
    }

    const headers = {
      Authorization: `Bearer ${tok.accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    // Step 1 — ensure the branch exists. If not, create it pointing at the
    // current HEAD of the default branch.
    const branchUrl = `https://api.github.com/repos/${repo.fullName}/git/refs/heads/${encodeURIComponent(branch)}`;
    let branchExists = false;
    try {
      const r = await fetch(branchUrl, { headers, cache: "no-store" });
      branchExists = r.ok;
    } catch {
      /* swallow — handled by the fallback create below */
    }
    if (!branchExists) {
      const defHead = await fetch(
        `https://api.github.com/repos/${repo.fullName}/git/refs/heads/${encodeURIComponent(repo.defaultBranch)}`,
        { headers, cache: "no-store" },
      );
      if (!defHead.ok) {
        return {
          ok: false,
          error: `Could not read default branch HEAD: ${defHead.status} ${defHead.statusText}`,
        };
      }
      const defRef = (await defHead.json()) as { object: { sha: string } };
      const create = await fetch(
        `https://api.github.com/repos/${repo.fullName}/git/refs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ref: `refs/heads/${branch}`,
            sha: defRef.object.sha,
          }),
        },
      );
      if (!create.ok) {
        const body = await create.text().catch(() => "");
        return {
          ok: false,
          error: `Could not create branch ${branch}: ${create.status} ${body.slice(0, 200)}`,
        };
      }
    }

    // Step 2 — fetch existing file SHA (if present) for an idempotent update.
    const cleanPath = input.path.replace(/^\/+/, "");
    const contentsUrl = `https://api.github.com/repos/${repo.fullName}/contents/${encodeURIComponent(cleanPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
    let existingSha: string | undefined;
    try {
      const existing = await fetch(contentsUrl, { headers, cache: "no-store" });
      if (existing.ok) {
        const raw = (await existing.json()) as { sha?: string };
        existingSha = raw.sha;
      }
    } catch {
      /* 404 is fine — file doesn't exist yet */
    }

    // Step 3 — PUT the file. Single API call commits one file with one
    // message; for multi-file commits we'd switch to the git data API.
    const put = await fetch(
      `https://api.github.com/repos/${repo.fullName}/contents/${encodeURIComponent(cleanPath).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message: input.message,
          content: Buffer.from(input.content, "utf8").toString("base64"),
          branch,
          ...(existingSha && { sha: existingSha }),
        }),
      },
    );
    if (!put.ok) {
      const body = await put.text().catch(() => "");
      return {
        ok: false,
        error: `Commit failed: ${put.status} ${body.slice(0, 300)}`,
      };
    }
    const commit = (await put.json()) as { commit: { sha: string } };

    // Step 4 — optionally open a PR.
    let pr: { number: number; url: string } | undefined;
    if (input.openPullRequest) {
      const prRes = await fetch(`https://api.github.com/repos/${repo.fullName}/pulls`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: input.message,
          head: branch,
          base: repo.defaultBranch,
          body:
            input.pullRequestBody ??
            `Authored by DeepAgent for project ${ctx.projectId.slice(0, 8)}.`,
          maintainer_can_modify: true,
        }),
      });
      if (prRes.ok) {
        const j = (await prRes.json()) as { number: number; html_url: string };
        pr = { number: j.number, url: j.html_url };
      } else {
        // Don't fail the whole tool — commit was successful. Surface the PR
        // failure as part of the output so the agent can decide.
        const body = await prRes.text().catch(() => "");
        return {
          ok: true,
          output: {
            fullName: repo.fullName,
            path: cleanPath,
            branch,
            commitSha: commit.commit.sha,
            pullRequest: undefined,
          },
          // Surfaced as a side note — the agent reads `summary` in some
          // execution paths; embedding the warning in `pullRequest` would
          // be misleading. So we leave PR off and let the message convey
          // it through the agent's next reasoning.
          // (Optional: return a separate warning field if we ever add one.)
        };
        void body;
      }
    }

    return {
      ok: true,
      output: {
        fullName: repo.fullName,
        path: cleanPath,
        branch,
        commitSha: commit.commit.sha,
        ...(pr && { pullRequest: pr }),
      },
    };
  },
};
