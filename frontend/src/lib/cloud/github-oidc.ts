/**
 * GitHub Actions → ECR over OIDC, the keyless way.
 *
 * For a GitHub Actions workflow to push to ECR WITHOUT storing long-lived AWS
 * keys as repo secrets, three things must exist in the customer's AWS account:
 *
 *   1. An IAM OIDC identity provider for `token.actions.githubusercontent.com`
 *      (one per account — shared across every repo).
 *   2. An IAM role whose TRUST policy only lets *this* repo's Actions runs
 *      assume it (sub = `repo:OWNER/REPO:*`), with an inline policy granting
 *      ECR push to one repository.
 *   3. The ECR repository itself.
 *
 * The workflow then uses `aws-actions/configure-aws-credentials@v4` with
 * `role-to-assume: <roleArn>` and `id-token: write` — no secrets at all.
 *
 * We shell out to the `aws` CLI through `runStage` (same model as
 * aws-onboard / list-ec2-instances) so we don't pull in the AWS SDK. Every
 * step is idempotent: we look before we create, and re-running updates the
 * trust + permission policies in place.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStage } from "@/lib/runner/exec";

/** GitHub's OIDC issuer — the `url` of the IAM identity provider. */
const GITHUB_OIDC_ISSUER = "token.actions.githubusercontent.com";
/** The audience GitHub mints tokens for when targeting AWS STS. */
const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";
/**
 * GitHub's well-known certificate thumbprints. AWS no longer validates the
 * thumbprint for this library-backed IdP, but `create-open-id-connect-provider`
 * still requires the argument, so we pass the published values.
 */
const GITHUB_OIDC_THUMBPRINTS = [
  "6938fd4d98bab03faadb97b34396831e3780aea1",
  "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
];

export type GithubOidcSetupInput = {
  /** Ready-to-use AWS credential env from resolveAwsExecEnv(). */
  awsEnv: Record<string, string>;
  /** AWS region the ECR repo lives in. */
  region: string;
  /** GitHub repo "owner/repo" — scopes the role's trust policy. */
  repoFullName: string;
  /** ECR repository name to create/use (e.g. "my-api"). */
  ecrRepoName: string;
  /** IAM role name to create/use (e.g. "gha-ecr-my-api"). */
  roleName: string;
  /**
   * Optional git ref filter for the trust policy `sub`. Defaults to `*`
   * (any branch/tag/PR). Pass e.g. "ref:refs/heads/main" to lock it down.
   */
  subjectFilter?: string;
};

export type GithubOidcSetupResult =
  | {
      ok: true;
      accountId: string;
      region: string;
      /** ARN of the IAM role the workflow assumes via OIDC. */
      roleArn: string;
      /** ARN of the IAM OIDC identity provider. */
      oidcProviderArn: string;
      /** Full ECR repository URI: <acct>.dkr.ecr.<region>.amazonaws.com/<name>. */
      ecrRepositoryUri: string;
      ecrRepositoryName: string;
      /** Human-readable trail of what we created vs. reused. */
      steps: string[];
    }
  | { ok: false; code: GithubOidcErrorCode; message: string; stderr?: string };

export type GithubOidcErrorCode =
  | "cli_not_installed"
  | "creds_missing"
  | "bad_input"
  | "aws_error";

/** Run one `aws` CLI invocation with the resolved creds + region. */
async function aws(
  args: string[],
  env: Record<string, string>,
  region: string,
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; notInstalled: boolean }> {
  const res = await runStage({
    command: "aws",
    args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
    cwd,
    env: { ...env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    timeoutMs: 60_000,
  });
  const notInstalled =
    res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"));
  return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr, notInstalled };
}

/** Validate + normalise "owner/repo". */
function parseRepo(full: string): { owner: string; repo: string } | null {
  const m = full.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Create (or reconcile) the OIDC provider + repo-scoped role + ECR repo so a
 * GitHub Actions workflow can push images keylessly. Idempotent — safe to call
 * again; it updates policies in place rather than erroring on "already exists".
 */
export async function setupGithubOidcEcr(
  input: GithubOidcSetupInput,
): Promise<GithubOidcSetupResult> {
  const parsed = parseRepo(input.repoFullName);
  if (!parsed) {
    return { ok: false, code: "bad_input", message: `"${input.repoFullName}" is not a valid owner/repo.` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{1,255}$/.test(input.ecrRepoName)) {
    return { ok: false, code: "bad_input", message: `Invalid ECR repository name "${input.ecrRepoName}".` };
  }
  if (!/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(input.roleName)) {
    return { ok: false, code: "bad_input", message: `Invalid IAM role name "${input.roleName}".` };
  }

  const { region, awsEnv } = input;
  const subject = input.subjectFilter?.trim() || "*";
  const steps: string[] = [];
  const workdir = await mkdtemp(join(tmpdir(), "dda-oidc-"));

  try {
    // 0 — Who are we? Need the account id for ARNs + the ECR URI.
    const ident = await aws(["sts", "get-caller-identity"], awsEnv, region, workdir);
    if (ident.notInstalled) {
      return { ok: false, code: "cli_not_installed", message: "The `aws` CLI isn't on the server's PATH." };
    }
    if (!ident.ok) {
      const lower = ident.stderr.toLowerCase();
      if (lower.includes("unable to locate credentials") || lower.includes("no credentials")) {
        return { ok: false, code: "creds_missing", message: "No usable AWS credentials for this account." };
      }
      return { ok: false, code: "aws_error", message: "sts get-caller-identity failed.", stderr: tail(ident.stderr) };
    }
    let accountId: string;
    try {
      accountId = (JSON.parse(ident.stdout) as { Account: string }).Account;
    } catch {
      return { ok: false, code: "aws_error", message: "Could not parse caller identity." };
    }

    const oidcProviderArn = `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_ISSUER}`;
    const roleArn = `arn:aws:iam::${accountId}:role/${input.roleName}`;
    const ecrRepositoryUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${input.ecrRepoName}`;

    // 1 — Ensure the GitHub OIDC identity provider exists (account-wide).
    const listProviders = await aws(["iam", "list-open-id-connect-providers"], awsEnv, region, workdir);
    if (!listProviders.ok) {
      return { ok: false, code: "aws_error", message: "iam list-open-id-connect-providers failed.", stderr: tail(listProviders.stderr) };
    }
    const providerExists = listProviders.stdout.includes(GITHUB_OIDC_ISSUER);
    if (providerExists) {
      steps.push(`OIDC provider for ${GITHUB_OIDC_ISSUER} already present — reused.`);
    } else {
      const create = await aws(
        [
          "iam", "create-open-id-connect-provider",
          "--url", `https://${GITHUB_OIDC_ISSUER}`,
          "--client-id-list", GITHUB_OIDC_AUDIENCE,
          "--thumbprint-list", ...GITHUB_OIDC_THUMBPRINTS,
        ],
        awsEnv, region, workdir,
      );
      // A concurrent run may have created it — treat "already exists" as success.
      if (!create.ok && !create.stderr.includes("EntityAlreadyExists")) {
        return { ok: false, code: "aws_error", message: "Could not create the GitHub OIDC provider.", stderr: tail(create.stderr) };
      }
      steps.push(create.ok ? `Created OIDC provider for ${GITHUB_OIDC_ISSUER}.` : "OIDC provider already existed.");
    }

    // 2 — Trust policy: only this repo's Actions runs may assume the role.
    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: oidcProviderArn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: { [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE },
            StringLike: {
              [`${GITHUB_OIDC_ISSUER}:sub`]: `repo:${parsed.owner}/${parsed.repo}:${subject}`,
            },
          },
        },
      ],
    };
    const trustPath = join(workdir, "trust.json");
    await writeFile(trustPath, JSON.stringify(trustPolicy), "utf8");

    const getRole = await aws(["iam", "get-role", "--role-name", input.roleName], awsEnv, region, workdir);
    if (getRole.ok) {
      // Role exists — reconcile its trust policy so the repo scope is current.
      const upd = await aws(
        ["iam", "update-assume-role-policy", "--role-name", input.roleName, "--policy-document", `file://${trustPath}`],
        awsEnv, region, workdir,
      );
      if (!upd.ok) {
        return { ok: false, code: "aws_error", message: "Could not update the role's trust policy.", stderr: tail(upd.stderr) };
      }
      steps.push(`IAM role ${input.roleName} already existed — trust policy refreshed.`);
    } else if (getRole.stderr.includes("NoSuchEntity")) {
      const created = await aws(
        [
          "iam", "create-role",
          "--role-name", input.roleName,
          "--assume-role-policy-document", `file://${trustPath}`,
          "--description", `GitHub Actions OIDC push to ECR for ${input.repoFullName}`,
          "--max-session-duration", "3600",
        ],
        awsEnv, region, workdir,
      );
      if (!created.ok) {
        return { ok: false, code: "aws_error", message: "Could not create the IAM role.", stderr: tail(created.stderr) };
      }
      steps.push(`Created IAM role ${input.roleName}.`);
    } else {
      return { ok: false, code: "aws_error", message: "iam get-role failed.", stderr: tail(getRole.stderr) };
    }

    // 3 — Inline permission policy: ECR auth (account-wide) + push to one repo.
    const permPolicy = {
      Version: "2012-10-17",
      Statement: [
        { Sid: "EcrAuthToken", Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
        {
          Sid: "EcrPushPull",
          Effect: "Allow",
          Action: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:CompleteLayerUpload",
            "ecr:InitiateLayerUpload",
            "ecr:PutImage",
            "ecr:UploadLayerPart",
            "ecr:BatchGetImage",
            "ecr:GetDownloadUrlForLayer",
          ],
          Resource: `arn:aws:ecr:${region}:${accountId}:repository/${input.ecrRepoName}`,
        },
      ],
    };
    const permPath = join(workdir, "perm.json");
    await writeFile(permPath, JSON.stringify(permPolicy), "utf8");
    const putPolicy = await aws(
      [
        "iam", "put-role-policy",
        "--role-name", input.roleName,
        "--policy-name", "ecr-push",
        "--policy-document", `file://${permPath}`,
      ],
      awsEnv, region, workdir,
    );
    if (!putPolicy.ok) {
      return { ok: false, code: "aws_error", message: "Could not attach the ECR push policy.", stderr: tail(putPolicy.stderr) };
    }
    steps.push(`Attached ECR push policy to ${input.roleName}.`);

    // 4 — Ensure the ECR repository exists.
    const describe = await aws(
      ["ecr", "describe-repositories", "--repository-names", input.ecrRepoName],
      awsEnv, region, workdir,
    );
    if (describe.ok) {
      steps.push(`ECR repository ${input.ecrRepoName} already existed — reused.`);
    } else if (describe.stderr.includes("RepositoryNotFoundException")) {
      const createRepo = await aws(
        [
          "ecr", "create-repository",
          "--repository-name", input.ecrRepoName,
          "--image-scanning-configuration", "scanOnPush=true",
          "--image-tag-mutability", "MUTABLE",
        ],
        awsEnv, region, workdir,
      );
      if (!createRepo.ok) {
        return { ok: false, code: "aws_error", message: "Could not create the ECR repository.", stderr: tail(createRepo.stderr) };
      }
      steps.push(`Created ECR repository ${input.ecrRepoName} (scan-on-push enabled).`);
    } else {
      return { ok: false, code: "aws_error", message: "ecr describe-repositories failed.", stderr: tail(describe.stderr) };
    }

    return {
      ok: true,
      accountId,
      region,
      roleArn,
      oidcProviderArn,
      ecrRepositoryUri,
      ecrRepositoryName: input.ecrRepoName,
      steps,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

function tail(s: string): string {
  return s.slice(-1_000);
}
