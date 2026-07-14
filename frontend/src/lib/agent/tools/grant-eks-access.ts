import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { grantEksAccess, parseEksClusterRef } from "@/lib/cloud/eks-access";
import type { Tool } from "./types";

/**
 * Grant an IAM role Kubernetes access to an env's EKS cluster — the agent's tool
 * for the thing it used to (wrongly) call a "manual step". Uses EKS Access
 * Entries via the app's stored AWS creds; no aws-auth editing, no human.
 */
export const grantEksAccessTool: Tool<
  {
    envKey: string;
    roleArn: string;
    accessLevel?: "edit" | "admin";
    namespaces?: string[];
    roleName?: string;
  },
  { clusterName: string; roleArn: string; accessLevel: string; steps: string[] }
> = {
  name: "grant_eks_access",
  description:
    "Grant an IAM role Kubernetes access to an env's EKS cluster via EKS Access Entries (the modern AWS API — NOT aws-auth editing). Use this to fix an 'Unauthorized' / 'must be logged in to the server' deploy failure by granting the deploy role (e.g. the GitHub-Actions AWS_ROLE_ARN, or the app's own role) access. It handles the cluster auth-mode gate, creates the access entry, associates the policy, and adds eks:DescribeCluster automatically. The app CAN do this — NEVER tell the user to edit aws-auth or that it's a manual step.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env whose EKS cluster to grant access on (from list_deploy_targets).",
      },
      roleArn: {
        type: "string",
        description: "IAM role ARN to grant (e.g. arn:aws:iam::<acct>:role/gha-ecr-<repo>).",
      },
      accessLevel: {
        type: "string",
        enum: ["edit", "admin"],
        description:
          "'edit' = namespace-scoped least-privilege (default); 'admin' = cluster-admin.",
      },
      namespaces: {
        type: "array",
        items: { type: "string" },
        description: "Namespaces for 'edit' scope (default ['default']).",
      },
      roleName: {
        type: "string",
        description:
          "Role NAME (not ARN) to also give eks:DescribeCluster. Defaults to the name from roleArn.",
      },
    },
    required: ["envKey", "roleArn"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, kubeconfigRef: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `No env "${input.envKey}" in this project.` };
    if (!env.kubeconfigRef)
      return { ok: false, error: `Env "${input.envKey}" has no connected cluster.` };
    if (!env.cloudProviderId)
      return {
        ok: false,
        error: `Env "${input.envKey}" isn't linked to an AWS account — link one on the cluster/env first.`,
      };

    let kubeconfig: string;
    try {
      kubeconfig = decryptSecret(env.kubeconfigRef);
    } catch {
      return { ok: false, error: "Couldn't read the env's stored kubeconfig." };
    }

    const ref = parseEksClusterRef(kubeconfig);
    if (!ref) {
      return {
        ok: false,
        error: `Env "${input.envKey}" doesn't look like an EKS cluster (no EKS cluster ARN in its kubeconfig). Access Entries are EKS-only.`,
      };
    }

    const creds = await resolveAwsExecEnv(env.cloudProviderId);
    if (!creds.ok) return { ok: false, error: creds.message };

    const roleName = input.roleName?.trim() || input.roleArn.split("/").pop() || undefined;
    const res = await grantEksAccess({
      awsEnv: creds.env,
      region: ref.region,
      clusterName: ref.clusterName,
      roleArn: input.roleArn.trim(),
      accessLevel: input.accessLevel,
      namespaces: input.namespaces,
      roleName,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `${res.message}${res.stderr ? ` — ${res.stderr.slice(-200)}` : ""}`,
      };
    }
    return {
      ok: true,
      output: {
        clusterName: res.clusterName,
        roleArn: res.roleArn,
        accessLevel: input.accessLevel ?? "edit",
        steps: res.steps,
      },
    };
  },
};
