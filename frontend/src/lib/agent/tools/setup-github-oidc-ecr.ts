import { prisma } from "@/lib/db/prisma";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { setupGithubOidcEcr } from "@/lib/cloud/github-oidc";
import type { Tool } from "./types";

type Input = {
  /** owner/repo — must be attached to the current project. */
  repoFullName: string;
  /** ECR repository name. Defaults to the repo's short name (lowercased). */
  ecrRepoName?: string;
  /** IAM role name. Defaults to "gha-ecr-<ecrRepoName>". */
  roleName?: string;
  /** AWS region for the ECR repo. Defaults to the connected account's region. */
  region?: string;
};

type Output = {
  roleArn: string;
  ecrRepositoryUri: string;
  ecrRepositoryName: string;
  region: string;
  accountId: string;
  oidcProviderArn: string;
  steps: string[];
};

/**
 * Find the AWS CloudProvider this project should use. Prefers a provider linked
 * to one of the project's envs, then falls back to the project's own AWS
 * provider directly (CloudProvider.projectId) — NOT a reverse lookup through
 * envs, which returns null whenever no env has cloudProviderId set yet (e.g. a
 * cluster connected via the kubeconfig-paste fallback never back-links it).
 */
async function resolveAwsProviderId(projectId: string): Promise<string | null> {
  const env = await prisma.env.findFirst({
    where: { projectId, cloudProvider: { kind: "aws" } },
    select: { cloudProviderId: true },
    orderBy: { createdAt: "asc" },
  });
  if (env?.cloudProviderId) return env.cloudProviderId;

  const cp = await prisma.cloudProvider.findFirst({
    where: { kind: "aws", projectId },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return cp?.id ?? null;
}

/** "owner/My_Repo.api" -> "my-repo-api" — a valid ECR/lowercase image name. */
function defaultEcrName(repoFullName: string): string {
  const short = repoFullName.split("/").pop() ?? repoFullName;
  return (
    short
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 200) || "app"
  );
}

/**
 * Provision the AWS side of a keyless GitHub Actions → ECR pipeline: the OIDC
 * identity provider, a repo-scoped IAM role, an ECR push policy, and the ECR
 * repository. Returns the role ARN + ECR URI the agent injects into the
 * generated GitHub Actions workflow (no AWS secrets ever stored in the repo).
 */
export const setupGithubOidcEcrTool: Tool<Input, Output> = {
  name: "setup_github_oidc_ecr",
  description:
    "Provision the AWS side of a keyless GitHub Actions -> Amazon ECR pipeline using OIDC. " +
    "Creates (idempotently) the GitHub OIDC identity provider, an IAM role whose trust policy " +
    "is scoped to ONLY this repo's Actions runs, an inline policy granting ECR push + " +
    "eks:DescribeCluster/ListClusters (read-only, so the SAME role can run " +
    "'aws eks update-kubeconfig' in the CD workflow), and the ECR repository. Returns the role " +
    "ARN and ECR repository URI to put into the workflow's configure-aws-credentials step. Call " +
    "this BEFORE writing the .github/workflows file so you can inject the real values. Re-run " +
    "safely (put-role-policy overwrites) — use this to REFRESH the role's policy on an existing " +
    "role that predates the EKS-describe grant. Requires an AWS account connected on the " +
    "project's Cloud providers tab. The repo must be attached to the current project.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: "owner/repo, must be attached to the current project.",
      },
      ecrRepoName: {
        type: "string",
        description: "ECR repository name. Defaults to the repo's short name, lowercased.",
      },
      roleName: {
        type: "string",
        description: 'IAM role name. Defaults to "gha-ecr-<ecrRepoName>".',
      },
      region: {
        type: "string",
        description: "AWS region (e.g. us-east-1). Defaults to the connected account's region.",
      },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true },
    });
    if (!repo) {
      return {
        ok: false,
        error: `Repo "${input.repoFullName}" isn't attached to this project. Use list_project_repos to see attached repos.`,
      };
    }

    const providerId = await resolveAwsProviderId(ctx.projectId);
    if (!providerId) {
      return {
        ok: false,
        error:
          "No AWS account is connected to this project. Connect one on the Cloud providers tab first.",
      };
    }

    const resolved = await resolveAwsExecEnv(providerId);
    if (!resolved.ok) {
      return { ok: false, error: resolved.message };
    }

    const region = (input.region ?? resolved.region).trim();
    const ecrRepoName = (
      input.ecrRepoName?.trim() || defaultEcrName(input.repoFullName)
    ).toLowerCase();
    const roleName = input.roleName?.trim() || `gha-ecr-${ecrRepoName}`.slice(0, 64);

    const result = await setupGithubOidcEcr({
      awsEnv: resolved.env,
      region,
      repoFullName: input.repoFullName,
      ecrRepoName,
      roleName,
    });

    if (!result.ok) {
      const detail = result.stderr ? ` Details: ${result.stderr}` : "";
      return { ok: false, error: `${result.message}${detail}` };
    }

    return {
      ok: true,
      output: {
        roleArn: result.roleArn,
        ecrRepositoryUri: result.ecrRepositoryUri,
        ecrRepositoryName: result.ecrRepositoryName,
        region: result.region,
        accountId: result.accountId,
        oidcProviderArn: result.oidcProviderArn,
        steps: result.steps,
      },
    };
  },
};
