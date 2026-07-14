/**
 * run_helm_upgrade — the agent's deploy primitive for Phase 2.
 *
 * Flow:
 *   1. Resolve env's kubeconfig (Phase 1.3).
 *   2. Clone the repo containing the Helm chart into a tmp workspace,
 *      shallow-only, with the repo's bound OAuth token.
 *   3. Run `helm upgrade --install <release> <chartPath>` with the env's
 *      KUBECONFIG and the user-supplied --set overrides + namespace.
 *   4. Tail wait via `--wait --timeout=Xs` so a failed rollout surfaces here
 *      rather than in a separate verify step.
 *   5. Clean up the workspace + kubeconfig tempfile regardless of outcome.
 *
 * Refuses repos not attached to the project — same guard as
 * write_repo_file and read_github_file.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

type Input = {
  /** Env key — must have a kubeconfig wired (paste it from env settings). */
  envKey: string;
  /** Repo containing the Helm chart. Must be attached to the project. */
  repoFullName: string;
  /** Path inside the repo to the chart directory (defaults to "chart"). */
  chartPath?: string;
  /** Helm release name. Stable per app per env (e.g. "api"). */
  releaseName: string;
  /** Image repository (e.g. ghcr.io/org/api). Used for --set image.repository. */
  imageRepository?: string;
  /** Image tag (commit SHA, semver, etc.). Used for --set image.tag. */
  imageTag?: string;
  /**
   * Extra `--set key=value` overrides. The agent uses this for everything
   * else: replicas, env vars, ingress hostnames, resources.
   */
  setValues?: Record<string, string>;
  /** Rollout wait timeout in seconds. Default 300. */
  timeoutSeconds?: number;
  /** Branch or ref to clone before running helm. Defaults to repo default branch. */
  ref?: string;
};

type Output = {
  envKey: string;
  releaseName: string;
  namespace: string;
  chartPath: string;
  ref: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

const DEFAULT_TIMEOUT_SECONDS = 300;

export const runHelmUpgradeTool: Tool<Input, Output> = {
  name: "run_helm_upgrade",
  description:
    "Deploy an application to the env's Kubernetes cluster via `helm upgrade --install`. " +
    "The chart must live in a repo attached to this project (default location: <repo>/chart). " +
    "Image repo + tag are passed via --set image.repository / image.tag. Any other Helm " +
    "values can be overridden via setValues. The tool waits for rollout (default 5 min) " +
    "and returns the full helm stdout/stderr so failures are visible to the agent.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Project env key (e.g. 'alpha')." },
      repoFullName: { type: "string", description: "owner/repo where the chart lives." },
      chartPath: {
        type: "string",
        description: 'Path to the chart directory inside the repo. Defaults to "chart".',
      },
      releaseName: { type: "string", description: "Helm release name (stable per app per env)." },
      imageRepository: {
        type: "string",
        description: "Image repo URL — sets image.repository in values.",
      },
      imageTag: {
        type: "string",
        description: "Image tag (sha / version) — sets image.tag in values.",
      },
      setValues: {
        type: "object",
        description: "Additional Helm `--set` overrides as key/value pairs.",
        additionalProperties: { type: "string" },
      },
      timeoutSeconds: {
        type: "number",
        description: "Rollout wait timeout in seconds. Default 300.",
      },
      ref: {
        type: "string",
        description: "Branch / ref to clone for the chart. Defaults to default branch.",
      },
    },
    required: ["envKey", "repoFullName", "releaseName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // 1. Resolve project env.
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, namespace: true, key: true, cloudProviderId: true },
    });
    if (!env) {
      return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    }

    // 2. Resolve repo + token.
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
      return { ok: false, error: `Cannot access ${repo.fullName}: ${resolved.message}` };
    }

    // 3. Resolve kubeconfig.
    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) {
      return { ok: false, error: kcfg.message };
    }

    const ref = input.ref ?? repo.defaultBranch;
    const chartPathInRepo = (input.chartPath ?? "chart").replace(/^\/+|\/+$/g, "") || "chart";
    const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

    // 4. Spin a workspace, clone the repo (shallow, single branch).
    const workspace = await mkdtemp(join(tmpdir(), "dda-helm-"));
    const repoDir = join(workspace, "repo");
    try {
      const cloneUrl = resolved.client.cloneUrlWithToken();
      const clone = await runStage({
        command: "git",
        args: ["clone", "--depth=1", "--branch", ref, "--single-branch", cloneUrl, repoDir],
        cwd: workspace,
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 60_000,
      });
      if (clone.exitCode !== 0) {
        return {
          ok: false,
          error: `git clone failed: ${clone.stderr.slice(-500) || clone.stdout.slice(-500)}`,
        };
      }

      // 5. Assemble the helm command.
      const args = [
        "upgrade",
        "--install",
        input.releaseName,
        join(repoDir, chartPathInRepo),
        "--namespace",
        env.namespace,
        "--create-namespace",
        "--wait",
        "--timeout",
        `${timeoutSeconds}s`,
      ];
      if (input.imageRepository) args.push("--set", `image.repository=${input.imageRepository}`);
      if (input.imageTag) args.push("--set", `image.tag=${input.imageTag}`);
      for (const [k, v] of Object.entries(input.setValues ?? {})) {
        // Helm --set treats commas and quotes as splits; we don't try to
        // escape here — agent should pass clean values. Any user-typed
        // value with commas should go through --values not --set.
        args.push("--set", `${k}=${v}`);
      }

      // EKS kubeconfigs authenticate via an `aws eks get-token` exec plugin,
      // which needs the aws CLI on PATH + AWS creds + HOME. kubeExecEnv layers
      // those (host creds + the env's provider creds) on top of KUBECONFIG.
      const helmEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
      const helm = await runStage({
        command: "helm",
        args,
        cwd: workspace,
        env: helmEnv,
        timeoutMs: (timeoutSeconds + 30) * 1000, // helm timeout + buffer
      });

      return {
        ok: true,
        output: {
          envKey: env.key,
          releaseName: input.releaseName,
          namespace: env.namespace,
          chartPath: chartPathInRepo,
          ref,
          command: `helm ${args.join(" ")}`,
          exitCode: helm.exitCode,
          stdout: helm.stdout.slice(-4000),
          stderr: helm.stderr.slice(-4000),
          durationMs: helm.durationMs,
        },
      };
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};
