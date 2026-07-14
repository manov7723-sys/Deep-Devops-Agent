/**
 * EKS cluster discovery — list the EKS clusters in an AWS region using the
 * project's stored AWS credentials (via the `aws` CLI), so the Clusters page can
 * offer "pick a region → pick a cluster" instead of typing a name. App-managed:
 * the stored creds are passed as env vars, no host login.
 */
import { tmpdir } from "node:os";
import { runStage } from "@/lib/runner/exec";

const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
  .filter(Boolean)
  .join(":");

export type EksCluster = { name: string; status?: string; version?: string };

export async function listEksClusters(
  credEnv: Record<string, string>,
  region: string,
): Promise<{ ok: true; clusters: EksCluster[] } | { ok: false; code: string; error: string }> {
  const env = { ...credEnv, PATH, AWS_REGION: region, AWS_DEFAULT_REGION: region };

  const list = await runStage({
    command: "aws",
    args: ["eks", "list-clusters", "--region", region, "--output", "json"],
    cwd: tmpdir(),
    env,
    timeoutMs: 30_000,
  });
  if (list.exitCode !== 0) {
    const missing =
      list.exitCode === -1 && (list.stderr.includes("ENOENT") || list.stderr.includes("[exec]"));
    return {
      ok: false,
      code: missing ? "cli_not_installed" : "list_failed",
      error: missing
        ? "The `aws` CLI isn't on the server's PATH. Install it on the runner host."
        : list.stderr.slice(-500) ||
          "aws eks list-clusters failed (check the region and that the AWS creds have eks:ListClusters).",
    };
  }

  let names: string[] = [];
  try {
    names = (JSON.parse(list.stdout).clusters ?? []) as string[];
  } catch {
    names = [];
  }

  // Enrich with status + version (best-effort, in parallel, bounded).
  const clusters = await Promise.all(
    names.slice(0, 40).map(async (name): Promise<EksCluster> => {
      const d = await runStage({
        command: "aws",
        args: ["eks", "describe-cluster", "--name", name, "--region", region, "--output", "json"],
        cwd: tmpdir(),
        env,
        timeoutMs: 20_000,
      });
      if (d.exitCode !== 0) return { name };
      try {
        const c = JSON.parse(d.stdout).cluster as { status?: string; version?: string };
        return { name, status: c?.status, version: c?.version };
      } catch {
        return { name };
      }
    }),
  );

  return { ok: true, clusters };
}
