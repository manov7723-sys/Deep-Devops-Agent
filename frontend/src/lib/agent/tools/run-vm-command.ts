import { Client } from "ssh2";
import { getOrCreateProjectDeployKeypair } from "@/lib/devops/deploy-keypair";
import type { Tool } from "./types";

type Input = {
  /** Host to SSH into — IP or DNS name of the VM. */
  host: string;
  /** SSH port. Default 22. */
  port?: number;
  /** SSH user. Default "deploy" (matches the user provision_proxmox_vm bakes in). */
  user?: string;
  /** The shell command to run. Executed via /bin/sh -c. */
  command: string;
  /** Max seconds to wait for the command to complete. Default 60. */
  timeoutSeconds?: number;
};

type Output = {
  host: string;
  user: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

const MAX_OUTPUT_CHARS = 8000;

function truncate(buf: string): { text: string; truncated: boolean } {
  if (buf.length <= MAX_OUTPUT_CHARS) return { text: buf, truncated: false };
  return { text: buf.slice(-MAX_OUTPUT_CHARS), truncated: true };
}

/**
 * Run a single shell command on a Proxmox (or any) VM over SSH using the
 * project's stored deploy keypair. The keypair is minted lazily on first use;
 * every VM that provision_proxmox_vm creates has this key pre-installed for
 * the "deploy" user, so no manual key setup is ever needed.
 *
 * Kept intentionally minimal: one command per call, captured stdout/stderr,
 * exit code, and a hard timeout. For multi-step orchestration (build here,
 * then here, then run this) the agent should call this tool multiple times
 * so each step's output shows up in the chat separately.
 */
export const runVmCommandTool: Tool<Input, Output> = {
  name: "run_vm_command",
  description:
    "Run a single shell command on a VM over SSH using the project's stored deploy keypair. " +
    "Use for: checking VM state (docker ps, systemctl status), tailing logs (journalctl -u app -n 100), " +
    "and one-off ops. For deployment workflows use deploy_to_proxmox_vm. The VM must have been created " +
    "with provision_proxmox_vm (so the deploy user + key are in cloud-init). Returns stdout, stderr, " +
    "and exit code; output is truncated to the last 8000 chars.",
  inputSchema: {
    type: "object",
    properties: {
      host: { type: "string", description: "VM host — IP or DNS name reachable from this server." },
      port: { type: "number", description: "SSH port. Default 22." },
      user: { type: "string", description: "SSH user. Default 'deploy'." },
      command: { type: "string", description: "Shell command to run (executed via /bin/sh -c)." },
      timeoutSeconds: { type: "number", description: "Max seconds to wait. Default 60, max 600." },
    },
    required: ["host", "command"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const host = input.host.trim();
    if (!host) return { ok: false, error: "host is required." };
    const command = input.command.trim();
    if (!command) return { ok: false, error: "command is required." };
    const port = input.port ?? 22;
    const user = input.user?.trim() || "deploy";
    const timeoutMs = Math.min(Math.max(input.timeoutSeconds ?? 60, 5), 600) * 1000;

    const { privateKey } = await getOrCreateProjectDeployKeypair(ctx.projectId);

    return await new Promise((resolve) => {
      const client = new Client();
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: { exitCode: number | null; error?: string }) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {}
        clearTimeout(timer);
        const so = truncate(stdout);
        const se = truncate(stderr);
        if (result.error) {
          resolve({ ok: false, error: result.error });
          return;
        }
        resolve({
          ok: true,
          output: {
            host,
            user,
            exitCode: result.exitCode,
            stdout: so.text,
            stderr: se.text,
            truncated: so.truncated || se.truncated,
          },
        });
      };

      const timer = setTimeout(() => {
        finish({ exitCode: null, error: `command timed out after ${timeoutMs / 1000}s` });
      }, timeoutMs);

      client.on("ready", () => {
        client.exec(command, (err, stream) => {
          if (err) {
            finish({ exitCode: null, error: `exec failed: ${err.message}` });
            return;
          }
          stream
            .on("close", (code: number | null) => finish({ exitCode: code ?? null }))
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            });
          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
        });
      });
      client.on("error", (err) => finish({ exitCode: null, error: `ssh error: ${err.message}` }));
      client.connect({
        host,
        port,
        username: user,
        privateKey,
        readyTimeout: Math.min(timeoutMs, 20_000),
      });
    });
  },
};
