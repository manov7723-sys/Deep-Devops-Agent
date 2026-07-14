import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
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
  /** Open a pull request from `branch` → `targetBranch` (default: repo default). */
  openPullRequest?: boolean;
  /**
   * Base branch the PR targets. Defaults to the repo's default branch. Pass a
   * different branch when you want CI/CD to trigger from a non-default branch
   * (e.g. the branch the user selected in the deploy-config form).
   */
  targetBranch?: string;
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
    "Commit a file to a branch in a GitHub or GitLab repo attached to the " +
    "current project, optionally opening a pull request (GitHub) / merge " +
    "request (GitLab). Use this to author Helm charts, env configs, terraform " +
    "HCL, manifests — anything that should land via review. Direct commits to " +
    "the default branch are refused; use a feature branch and set " +
    "openPullRequest=true.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'owner/repo, must be attached to the project.' },
      path: { type: "string", description: 'Path inside the repo (e.g. "chart/values.yaml"). No leading slash.' },
      content: { type: "string", description: "Full file contents (UTF-8)." },
      message: { type: "string", description: "Commit message. Also used as PR title prefix." },
      branch: { type: "string", description: 'Branch to commit to. Must differ from the default branch.' },
      openPullRequest: { type: "boolean", description: "Open a PR after committing." },
      targetBranch: { type: "string", description: "PR base branch. Defaults to the repo's default branch." },
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
    const targetBranch = (input.targetBranch || repo.defaultBranch).replace(/^\/+/, "");
    if (branch === targetBranch) {
      return {
        ok: false,
        error: `Refusing to commit directly to the target branch (${targetBranch}). Use a feature branch for the commit and open a PR into ${targetBranch}.`,
      };
    }

    const resolved = await resolveRepoClient(repo.id);
    if (!resolved.ok) {
      return { ok: false, error: `Cannot access ${input.repoFullName}: ${resolved.message}` };
    }
    const client = resolved.client;
    const cleanPath = input.path.replace(/^\/+/, "");

    // Step 1 — ensure the branch exists (created off the target branch so a
    // non-default target branch gets the new commits on top of it, not from
    // the repo default).
    try {
      await client.ensureBranch(branch, targetBranch);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `Could not create branch ${branch}.` };
    }

    // Step 2 — commit the file (create or update).
    let commitSha: string;
    try {
      const c = await client.commitFiles({ branch, message: input.message, files: [{ path: cleanPath, content: input.content }] });
      commitSha = c.commitSha;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `Commit failed: ${err.message}` : "Commit failed." };
    }

    // Step 3 — optionally open a pull request (GitHub) / merge request (GitLab).
    // NB: `openChangeRequest` is idempotent — HTTP 422 (a PR already exists) is
    // resolved server-side into a lookup that returns the existing open PR, so
    // this catch only fires on real errors (auth expired, no diff yet, etc.).
    // We now RETURN the error instead of swallowing it, because a silent
    // failure here means the agent tells the user "PR opened" with no link.
    let pr: { number: number; url: string } | undefined;
    if (input.openPullRequest) {
      try {
        pr = await client.openChangeRequest({
          sourceBranch: branch,
          targetBranch,
          title: input.message,
          body: input.pullRequestBody ?? `Authored by DeepAgent for project ${ctx.projectId.slice(0, 8)}.`,
        });
      } catch (err) {
        return {
          ok: false,
          error:
            `Committed ${cleanPath} to ${branch}, but opening the PR into ${targetBranch} failed: ` +
            (err instanceof Error ? err.message : "unknown error") +
            `. Retry, or open the PR manually from ${branch} → ${targetBranch}.`,
        };
      }
    }

    return {
      ok: true,
      output: {
        fullName: repo.fullName,
        path: cleanPath,
        branch,
        commitSha,
        ...(pr && { pullRequest: pr }),
      },
    };
  },
};
