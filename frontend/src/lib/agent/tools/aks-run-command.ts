import { prisma } from "@/lib/db/prisma";
import { aksRunCommand } from "@/lib/cloud/azure-aks-run";
import type { Tool } from "./types";

type Input = {
  /** The command to run on the cluster, e.g. "kubectl get pods -A". */
  command: string;
  /** The AKS cluster name. */
  clusterName: string;
  /** Optional — auto-detected from the cluster name if omitted. */
  resourceGroup?: string;
};

type Output = {
  exitCode: number;
  logs: string;
};

/** Find the Azure provider for THIS project (per-project isolation). */
async function resolveAzureProvider(
  projectId: string,
): Promise<{ id: string; subscriptionId: string } | null> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true, accountRef: true },
    orderBy: { createdAt: "desc" },
  });
  return cp ? { id: cp.id, subscriptionId: cp.accountRef } : null;
}

/**
 * Operate an AKS cluster without a kubeconfig, via Azure's `runCommand` action.
 * Azure runs the command inside the cluster and returns the output, so this
 * works over the project's connected Azure account (OAuth or service principal)
 * even when the kubeconfig can't be fetched (e.g. personal-account owners).
 */
export const aksRunCommandTool: Tool<Input, Output> = {
  name: "aks_run_command",
  description:
    "Run a kubectl or helm command on an Azure AKS cluster WITHOUT a kubeconfig, via Azure's run-command API. " +
    "Use this to operate AKS clusters: 'kubectl get pods -A', 'kubectl get nodes', 'kubectl scale deploy/web --replicas=3', " +
    "'kubectl logs ...', 'helm list -A'. Requires an Azure account connected on the Cloud providers tab. " +
    "Provide just the cluster name and the command — the resource group is auto-detected. Each call runs in an " +
    "ephemeral in-cluster pod and may take 10–30 seconds.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The command to run on the cluster, e.g. 'kubectl get pods -A' or 'helm list -A'.",
      },
      clusterName: {
        type: "string",
        description: "The AKS cluster name (e.g. 'dev-cluster123').",
      },
      resourceGroup: {
        type: "string",
        description:
          "Optional — the cluster's resource group. Auto-detected from the cluster name if omitted.",
      },
    },
    required: ["command", "clusterName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const prov = await resolveAzureProvider(ctx.projectId);
    if (!prov) {
      return {
        ok: false,
        error:
          "No Azure account is connected to this project. Connect one with 'Sign in with Microsoft' on the Cloud providers tab first.",
      };
    }
    const res = await aksRunCommand(
      prov.id,
      prov.subscriptionId,
      input.resourceGroup ?? "",
      input.clusterName,
      input.command,
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { exitCode: res.exitCode, logs: res.logs } };
  },
};
