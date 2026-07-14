/**
 * Amazon ECR helpers — list + create repositories.
 *
 * We shell out to the `aws` CLI through `runStage` (same model as
 * github-oidc / aws-onboard) so we don't pull in the AWS SDK. Read-only calls
 * (describe) don't need a scratch dir, but runStage requires a cwd so we use
 * the OS temp dir.
 */
import { tmpdir } from "node:os";
import { runStage } from "@/lib/runner/exec";

export type EcrRepo = {
  name: string;
  /** Full repository URI, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-api */
  uri: string;
  createdAt?: string;
};

async function aws(
  args: string[],
  env: Record<string, string>,
  region: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; notInstalled: boolean }> {
  const res = await runStage({
    command: "aws",
    args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
    cwd: tmpdir(),
    env: { ...env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    timeoutMs: 60_000,
  });
  const notInstalled =
    res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"));
  return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr, notInstalled };
}

/** List every ECR repository in the connected account/region. */
export async function listEcrRepos(opts: {
  awsEnv: Record<string, string>;
  region: string;
}): Promise<{ ok: true; repos: EcrRepo[] } | { ok: false; error: string }> {
  const res = await aws(["ecr", "describe-repositories"], opts.awsEnv, opts.region);
  if (!res.ok) {
    if (res.notInstalled) return { ok: false, error: "The aws CLI isn't available on the server." };
    return { ok: false, error: res.stderr.trim() || "Failed to list ECR repositories." };
  }
  try {
    const data = JSON.parse(res.stdout) as {
      repositories?: Array<{ repositoryName?: string; repositoryUri?: string; createdAt?: string }>;
    };
    const repos = (data.repositories ?? [])
      .filter((r) => r.repositoryName && r.repositoryUri)
      .map((r) => ({ name: r.repositoryName!, uri: r.repositoryUri!, createdAt: r.createdAt }));
    return { ok: true, repos };
  } catch {
    return { ok: false, error: "Couldn't parse the ECR repository list." };
  }
}

/** Create one ECR repository (idempotent — an existing repo is returned, not an error). */
export async function createEcrRepo(opts: {
  awsEnv: Record<string, string>;
  region: string;
  name: string;
}): Promise<{ ok: true; repo: EcrRepo; alreadyExisted: boolean } | { ok: false; error: string }> {
  const name = opts.name.toLowerCase();
  const res = await aws(
    [
      "ecr",
      "create-repository",
      "--repository-name",
      name,
      "--image-scanning-configuration",
      "scanOnPush=true",
    ],
    opts.awsEnv,
    opts.region,
  );
  if (res.ok) {
    try {
      const data = JSON.parse(res.stdout) as {
        repository?: { repositoryName?: string; repositoryUri?: string; createdAt?: string };
      };
      const r = data.repository;
      if (r?.repositoryName && r.repositoryUri) {
        return {
          ok: true,
          alreadyExisted: false,
          repo: { name: r.repositoryName, uri: r.repositoryUri, createdAt: r.createdAt },
        };
      }
    } catch {
      /* fall through to a describe */
    }
  }
  // Already exists (or we couldn't parse the create output) → describe it.
  if (res.stderr.includes("RepositoryAlreadyExistsException") || res.ok) {
    const desc = await aws(
      ["ecr", "describe-repositories", "--repository-names", name],
      opts.awsEnv,
      opts.region,
    );
    if (desc.ok) {
      try {
        const data = JSON.parse(desc.stdout) as {
          repositories?: Array<{
            repositoryName?: string;
            repositoryUri?: string;
            createdAt?: string;
          }>;
        };
        const r = data.repositories?.[0];
        if (r?.repositoryName && r.repositoryUri) {
          return {
            ok: true,
            alreadyExisted: true,
            repo: { name: r.repositoryName, uri: r.repositoryUri, createdAt: r.createdAt },
          };
        }
      } catch {
        /* fall through */
      }
    }
  }
  if (res.notInstalled) return { ok: false, error: "The aws CLI isn't available on the server." };
  return { ok: false, error: res.stderr.trim() || "Failed to create the ECR repository." };
}
