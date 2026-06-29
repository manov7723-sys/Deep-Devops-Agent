/**
 * Runner primitive — Phase 1.
 *
 * Spawns a child process (kubectl, helm, terraform, git, docker) inline on
 * the Next.js host. Streams stdout/stderr, enforces a timeout, returns a
 * structured result so callers can persist exit code + logs to a
 * PipelineStage row.
 *
 * Phase 4 swaps the body for `docker run --rm` against a sandboxed runner
 * image. The function signature is intentionally simple so that change is a
 * drop-in replacement — callers don't move.
 *
 * Security warning (Phase 1 only):
 *   - Runs as the Next.js server's UNIX user.
 *   - No filesystem isolation. Cleans up cwd via the caller.
 *   - No CPU/memory cgroup.
 *   - Do NOT expose to multi-tenant workloads until Phase 4 lands.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export type RunStageResult = {
  exitCode: number;
  /** Captured stdout. Capped at MAX_BUFFER_BYTES; older content is truncated. */
  stdout: string;
  /** Captured stderr. Same cap. */
  stderr: string;
  /** True iff the process was killed by us because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** Wall-clock duration in milliseconds, from spawn to exit. */
  durationMs: number;
};

export type RunStageArgs = {
  /** Binary or absolute path. Usually `kubectl` / `helm` / `terraform` / `git`. */
  command: string;
  args: string[];
  /** Working directory. The caller is responsible for creating + cleaning. */
  cwd: string;
  /**
   * Environment variables injected into the child. Process.env is NOT
   * inherited automatically — pass anything the binary needs (PATH,
   * KUBECONFIG, AWS_*, GITHUB_TOKEN, …). PATH defaults to the host's PATH if
   * not provided.
   */
  env?: Record<string, string>;
  /** Per-chunk callback for streaming logs to clients in real time. */
  onLog?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * Hard kill the process after this many milliseconds. Defaults to 5 min.
   * Tune per stage type (terraform apply is slower than kubectl get).
   */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel the run from the outside. */
  signal?: AbortSignal;
  /**
   * Max bytes captured per stream (tail-truncated past this). Defaults to 32KB,
   * which suits log streaming. Commands whose stdout is parsed as structured
   * output (e.g. `kubectl get … -o json`) must raise this, or truncation
   * corrupts the payload.
   */
  maxBufferBytes?: number;
};

const MAX_BUFFER_BYTES = 32 * 1024; // 32KB per stream — matches PipelineStage.logs cap.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function runStage(args: RunStageArgs): Promise<RunStageResult> {
  return new Promise<RunStageResult>((resolve, reject) => {
    const startedAtMs = Date.now();
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // PATH is critical for the runner to find binaries; everything else
      // is opt-in via args.env so we don't leak secrets from the parent.
      // The strict `NodeJS.ProcessEnv` type insists on a NODE_ENV key in
      // strict-typed envs (Next's `globals.d.ts`); cast through `unknown`
      // because we genuinely don't want the host's NODE_ENV inherited.
      const childEnv = {
        PATH: process.env.PATH ?? "",
        ...(args.env ?? {}),
      } as unknown as NodeJS.ProcessEnv;
      child = spawn(args.command, args.args, {
        cwd: args.cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }) as ChildProcessByStdio<null, Readable, Readable>;
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const onLog = args.onLog;
    const capBytes = args.maxBufferBytes ?? MAX_BUFFER_BYTES;
    function appendCapped(buf: string, chunk: string): string {
      const merged = buf + chunk;
      if (merged.length <= capBytes) return merged;
      return merged.slice(merged.length - capBytes);
    }

    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stdout = appendCapped(stdout, s);
      onLog?.(s, "stdout");
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr = appendCapped(stderr, s);
      onLog?.(s, "stderr");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* swallow */
      }
    }, timeoutMs);

    const abortHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* swallow */
      }
    };
    args.signal?.addEventListener("abort", abortHandler, { once: true });

    function settle(result: RunStageResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    }

    child.on("error", (err) => {
      // ENOENT / EACCES on the binary itself surfaces here.
      settle({
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[exec] ${err.message}`,
        timedOut: false,
        durationMs: Date.now() - startedAtMs,
      });
    });

    child.on("close", (code) => {
      settle({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAtMs,
      });
    });
  });
}
