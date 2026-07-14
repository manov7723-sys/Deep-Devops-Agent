import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname, normalize, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

/** PATH additions so the `docker` / `git` binaries are found on dev + container hosts. */
const EXTRA_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
];

type Input = {
  /** owner/repo — must be attached to the current project. */
  repoFullName: string;
  /**
   * The candidate files to drop into the repo before building — at minimum the
   * Dockerfile, plus any sidecars it needs (nginx.conf, .dockerignore). Same
   * shape generate_dockerfile returns.
   */
  files: Array<{ path: string; content: string }>;
  /** Dockerfile path within the build context. Defaults to "Dockerfile". */
  dockerfilePath?: string;
  /** Branch / ref to clone. Defaults to the repo's default branch. */
  ref?: string;
};

type Output = {
  built: boolean;
  exitCode: number;
  /** Tail of the build log — the agent reads this to fix a failing Dockerfile. */
  log: string;
};

const DEFAULT_TIMEOUT_MS = 8 * 60_000;

/** Reject path traversal / absolute paths so a file can't escape the workspace. */
function safeRelPath(p: string): string | null {
  const clean = p.replace(/^\/+/, "");
  if (isAbsolute(clean)) return null;
  const norm = normalize(clean);
  if (norm.startsWith("..") || norm.split(/[\\/]/).includes("..")) return null;
  return norm;
}

/**
 * Build the candidate Dockerfile against a real checkout of the repo and report
 * whether it builds. This is the safety net that lets the agent handle ANY
 * application — for stacks without a vetted template it writes the Dockerfile
 * itself, then calls this to PROVE it builds (and reads `log` to fix it on
 * failure) before opening a PR. Uses no LLM tokens — it's a `docker build`.
 *
 * Clones to a throwaway workspace, overlays the candidate files, runs
 * `docker build`, then removes the image + workspace. Requires git + docker on
 * the runner host.
 */
export const verifyDockerBuildTool: Tool<Input, Output> = {
  name: "verify_docker_build",
  description:
    "Verify that a candidate Dockerfile actually builds against the repo's real code, WITHOUT committing " +
    "anything. Clones the repo to a temp dir, drops in the provided files (Dockerfile + any sidecars), runs " +
    "`docker build`, and returns whether it succeeded plus the build log tail. Use this for any repo — " +
    "especially stacks with no vetted template — to confirm the Dockerfile works before opening a PR. If it " +
    "fails, read the returned `log`, fix the Dockerfile, and verify again. Requires docker on the server.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: "owner/repo, must be attached to the project." },
      files: {
        type: "array",
        description:
          "Files to write into the build context before building (Dockerfile + sidecars).",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path within the repo, no leading slash." },
            content: { type: "string", description: "Full file contents." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      dockerfilePath: {
        type: "string",
        description: 'Dockerfile path in the context. Defaults to "Dockerfile".',
      },
      ref: {
        type: "string",
        description: "Branch / ref to clone. Defaults to the repo's default branch.",
      },
    },
    required: ["repoFullName", "files"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      return { ok: false, error: "No files provided to verify. Pass at least the Dockerfile." };
    }
    const dockerfilePath = safeRelPath(input.dockerfilePath ?? "Dockerfile");
    if (!dockerfilePath) {
      return { ok: false, error: `Invalid dockerfilePath "${input.dockerfilePath}".` };
    }
    if (!input.files.some((f) => safeRelPath(f.path) === dockerfilePath)) {
      return {
        ok: false,
        error: `The files array must include the Dockerfile at "${dockerfilePath}".`,
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

    const resolved = await resolveRepoClient(repo.id);
    if (!resolved.ok) {
      return { ok: false, error: `Cannot access ${input.repoFullName}: ${resolved.message}` };
    }

    const ref = input.ref ?? repo.defaultBranch;
    const pathEnv = [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":");
    const workspace = await mkdtemp(join(tmpdir(), "dda-dockerbuild-"));
    const repoDir = join(workspace, "repo");
    // Unique-ish throwaway tag without Date.now/random (unavailable): derive from ids.
    const imageTag = `dda-verify-${repo.id.slice(0, 8)}-${ctx.projectId.slice(0, 8)}`.toLowerCase();

    try {
      // 1 — shallow clone (token-embedded URL, provider-aware).
      const cloneUrl = resolved.client.cloneUrlWithToken();
      const clone = await runStage({
        command: "git",
        args: ["clone", "--depth=1", "--branch", ref, "--single-branch", cloneUrl, repoDir],
        cwd: workspace,
        env: { PATH: pathEnv, GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 90_000,
      });
      if (clone.exitCode !== 0) {
        if (
          clone.exitCode === -1 &&
          (clone.stderr.includes("ENOENT") || clone.stderr.includes("[exec]"))
        ) {
          return { ok: false, error: "`git` isn't installed on the server." };
        }
        return {
          ok: false,
          error: `git clone failed: ${clone.stderr.slice(-500) || clone.stdout.slice(-500)}`,
        };
      }

      // 2 — overlay the candidate files (creating subdirs as needed).
      for (const f of input.files) {
        const rel = safeRelPath(f.path);
        if (!rel) return { ok: false, error: `Invalid file path "${f.path}".` };
        const abs = join(repoDir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.content, "utf8");
      }

      // 3 — docker build. We tag a throwaway image, then remove it in finally.
      const build = await runStage({
        command: "docker",
        args: ["build", "-f", dockerfilePath, "-t", imageTag, "."],
        cwd: repoDir,
        env: { PATH: pathEnv, DOCKER_BUILDKIT: "1", HOME: process.env.HOME ?? workspace },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      if (
        build.exitCode === -1 &&
        (build.stderr.includes("ENOENT") || build.stderr.includes("[exec]"))
      ) {
        return {
          ok: false,
          error:
            "`docker` isn't installed / not running on the server. Cannot verify the build here.",
        };
      }

      const log = (build.stderr + "\n" + build.stdout).trim().slice(-4_000);
      return {
        ok: true,
        output: {
          built: build.exitCode === 0,
          exitCode: build.exitCode,
          log: build.timedOut
            ? `${log}\n[verify] build timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`
            : log,
        },
      };
    } finally {
      // Best-effort cleanup: remove the throwaway image + the workspace.
      await runStage({
        command: "docker",
        args: ["image", "rm", "-f", imageTag],
        cwd: workspace,
        env: { PATH: pathEnv },
        timeoutMs: 30_000,
      }).catch(() => {});
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  },
};
