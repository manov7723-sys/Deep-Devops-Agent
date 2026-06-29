import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

type Input = {
  envKey: string;
  /** Pod name. Use list_kubernetes_resources(kind="pods") first to find it. */
  podName: string;
  namespace?: string;
  /** Container name when the pod has multiple containers. */
  container?: string;
  /** Number of lines to return from the end. Default 200, max 1000. */
  lines?: number;
  /** Fetch logs from a previously terminated container instance instead of current. */
  previous?: boolean;
};

type Output = {
  envKey: string;
  podName: string;
  namespace: string;
  container?: string;
  lines: number;
  truncated: boolean;
  logs: string;
};

const MAX_LINES = 1000;
const MAX_BYTES = 32 * 1024;

/**
 * Read pod logs from the env's cluster. Read-only — won't kill or restart.
 * Capped at 1000 lines / 32KB output so a chatty container can't blow up
 * the LLM context. Use `previous=true` to inspect a crashed container.
 */
export const getKubernetesLogsTool: Tool<Input, Output> = {
  name: "get_kubernetes_logs",
  description:
    "Fetch logs from a pod in the env's cluster. Use after list_kubernetes_resources(kind='pods') " +
    "identifies a pod of interest. Pass previous=true to read logs from a crashed/restarted " +
    "container instance. Capped at 1000 lines / 32KB output.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: 'Env key, e.g. "alpha".' },
      podName: { type: "string", description: "Exact pod name as returned by list_kubernetes_resources." },
      namespace: { type: "string", description: "Namespace. Defaults to env's namespace." },
      container: { type: "string", description: "Container name for multi-container pods." },
      lines: { type: "number", description: "Last N lines. Default 200, max 1000." },
      previous: { type: "boolean", description: "Read logs from the previously terminated container instance." },
    },
    required: ["envKey", "podName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, namespace: true, cloudProviderId: true },
    });
    if (!env) {
      return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    }

    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) {
      return { ok: false, error: kcfg.message };
    }
    const childEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

    const namespace = input.namespace ?? env.namespace ?? "default";
    const lines = Math.min(Math.max(input.lines ?? 200, 1), MAX_LINES);
    const args = [
      "logs",
      input.podName,
      "-n", namespace,
      `--tail=${lines}`,
    ];
    if (input.container) args.push("-c", input.container);
    if (input.previous) args.push("--previous");

    try {
      const res = await runStage({
        command: "kubectl",
        args,
        cwd: process.cwd(),
        env: childEnv,
        timeoutMs: 20_000,
      });

      if (res.exitCode !== 0) {
        return {
          ok: false,
          error: `kubectl logs failed: ${res.stderr.slice(-500)}`,
        };
      }

      const raw = res.stdout;
      const truncated = raw.length > MAX_BYTES;
      const logs = truncated ? raw.slice(raw.length - MAX_BYTES) : raw;

      return {
        ok: true,
        output: {
          envKey: input.envKey,
          podName: input.podName,
          namespace,
          container: input.container,
          lines,
          truncated,
          logs,
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};
