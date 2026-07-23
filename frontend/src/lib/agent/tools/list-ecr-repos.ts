import { prisma } from "@/lib/db/prisma";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { listEcrRepos } from "@/lib/cloud/ecr";
import type { Tool } from "./types";

type Input = {
  /** AWS region to list. Defaults to the connected account's region. */
  region?: string;
};

type Output = {
  region: string;
  repos: Array<{ name: string; uri: string }>;
  count: number;
};

/**
 * The AWS CloudProvider this project uses — prefer one linked to a project
 * env, then fall back to the project's own AWS provider directly
 * (CloudProvider.projectId) — NOT a reverse lookup through envs, which
 * returns null whenever no env has cloudProviderId set yet (e.g. a cluster
 * connected via the kubeconfig-paste fallback never back-links it).
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

/**
 * List the ECR repositories that already exist in the project's connected AWS
 * account. The deploy flow uses this to offer the user their existing repos as
 * clickable choices (one per service) instead of always creating new ones.
 */
export const listEcrReposTool: Tool<Input, Output> = {
  name: "list_ecr_repos",
  description:
    "List the Amazon ECR (container registry) repositories in the project's connected AWS account. " +
    "Use this in the deploy flow to show the user the registries they already have so they can pick one " +
    "per service (frontend/backend) — or decide to auto-create a new one. Returns each repo's name + URI.",
  inputSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        description: "AWS region (e.g. us-east-1). Defaults to the connected account's region.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const providerId = await resolveAwsProviderId(ctx.projectId);
    if (!providerId) {
      return {
        ok: false,
        error:
          "No AWS account is connected to this project. Connect one on the Cloud providers tab first.",
      };
    }
    const resolved = await resolveAwsExecEnv(providerId);
    if (!resolved.ok) return { ok: false, error: resolved.message };

    const region = (input.region ?? resolved.region).trim();
    const res = await listEcrRepos({ awsEnv: resolved.env, region });
    if (!res.ok) return { ok: false, error: res.error };

    return {
      ok: true,
      output: {
        region,
        repos: res.repos.map((r) => ({ name: r.name, uri: r.uri })),
        count: res.repos.length,
      },
    };
  },
};
