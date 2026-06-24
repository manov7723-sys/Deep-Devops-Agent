/**
 * apply_k8s_manifest — deploy a raw Kubernetes manifest straight to a connected
 * environment's cluster via `kubectl apply -f`. The counterpart to
 * run_helm_upgrade, but for plain YAML instead of a Helm chart.
 *
 * Flow:
 *   1. Resolve the project env + its stored kubeconfig.
 *   2. Write the manifest YAML to a tmp file (supports multi-doc `---` YAML).
 *   3. Run `kubectl apply -f <file> -n <namespace>` with the env's KUBECONFIG
 *      and AWS creds (so the EKS `aws eks get-token` exec plugin authenticates).
 *   4. Clean up the tempfiles regardless of outcome.
 *
 * Pairs with generate_k8s_manifest: generate the YAML, show it, then apply it.
 * Set dryRun=true for a server-side validation that changes nothing.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

type Input = {
  /** Env key whose connected cluster to apply to (e.g. "alpha"). */
  envKey: string;
  /** The manifest YAML to apply. Supports multiple docs separated by `---`. */
  manifest: string;
  /** Namespace for resources that don't declare one. Defaults to the env's namespace. */
  namespace?: string;
  /** When true, run `--dry-run=server` — validates against the cluster without applying. */
  dryRun?: boolean;
};

type Output = {
  envKey: string;
  namespace: string;
  dryRun: boolean;
  applied: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const MAX_MANIFEST_BYTES = 256 * 1024;

export const applyK8sManifestTool: Tool<Input, Output> = {
  name: "apply_k8s_manifest",
  description:
    "Apply a Kubernetes manifest (YAML) directly to a connected environment's cluster via " +
    "`kubectl apply -f`. Use this AFTER generate_k8s_manifest to actually DEPLOY the manifest to " +
    "the cluster (the env must have a cluster connected on the Clusters page). Supports multi-document " +
    "YAML (--- separated). Set dryRun=true first to validate server-side without changing anything. " +
    "Returns kubectl's output so the agent can confirm what was created/configured/unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Project env key whose cluster to deploy to (e.g. 'alpha')." },
      manifest: { type: "string", description: "Full manifest YAML to apply. Multiple docs may be separated by '---'." },
      namespace: { type: "string", description: "Namespace for resources without one. Defaults to the env's namespace." },
      dryRun: { type: "boolean", description: "If true, server-side dry run — validates without applying." },
    },
    required: ["envKey", "manifest"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!input.manifest?.trim()) {
      return { ok: false, error: "No manifest provided. Pass the YAML to apply." };
    }
    if (Buffer.byteLength(input.manifest, "utf8") > MAX_MANIFEST_BYTES) {
      return { ok: false, error: `Manifest too large (cap ${MAX_MANIFEST_BYTES} bytes).` };
    }

    // 1. Resolve project env.
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, namespace: true, key: true, cloudProviderId: true },
    });
    if (!env) {
      return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    }

    // 2. Resolve the env's kubeconfig (decrypted to a tempfile).
    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) {
      return {
        ok: false,
        error: `${kcfg.message} Connect a cluster for env "${input.envKey}" on the Clusters page first.`,
      };
    }

    const namespace = (input.namespace?.trim() || env.namespace || "default").trim();
    const workspace = await mkdtemp(join(tmpdir(), "dda-kapply-"));
    const file = join(workspace, "manifest.yaml");

    try {
      await writeFile(file, input.manifest, "utf8");
      // KUBECONFIG + AWS creds so the EKS exec auth plugin can mint a token.
      const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

      const args = ["apply", "-f", file, "-n", namespace];
      if (input.dryRun) args.push("--dry-run=server");

      const res = await runStage({
        command: "kubectl",
        args,
        cwd: workspace,
        env: execEnv,
        timeoutMs: 120_000,
      });

      if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
        return { ok: false, error: "`kubectl` isn't installed on the server. Install it on the runner host." };
      }

      const cmd = `kubectl apply -f manifest.yaml -n ${namespace}${input.dryRun ? " --dry-run=server" : ""}`;
      if (res.exitCode !== 0) {
        return {
          ok: false,
          error: `kubectl apply failed (exit ${res.exitCode}): ${res.stderr.slice(-600) || res.stdout.slice(-600)}`,
        };
      }

      return {
        ok: true,
        output: {
          envKey: env.key,
          namespace,
          dryRun: !!input.dryRun,
          applied: !input.dryRun,
          command: cmd,
          exitCode: res.exitCode,
          stdout: res.stdout.slice(-4_000),
          stderr: res.stderr.slice(-2_000),
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  },
};
