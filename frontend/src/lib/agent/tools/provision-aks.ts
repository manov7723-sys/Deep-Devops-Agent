import { prisma } from "@/lib/db/prisma";
import { buildAksTerraform, type AksSpec } from "@/lib/devops/aks";
import { startTerraformRun } from "@/lib/devops/terraform-run";
import { writeRepoFileTool } from "./write-repo-file";
import type { Tool } from "./types";

type Input = {
  envKey: string;
  name: string;
  /** Azure region, e.g. "eastus". */
  location?: string;
  /** Resource group name (created when createResourceGroup, else referenced). */
  resourceGroup: string;
  createResourceGroup?: boolean;
  /** Existing subnet resource id to place nodes in. Omit for AKS-managed networking. */
  vnetSubnetId?: string;
  kubernetesVersion?: string;
  vmSize?: string;
  desiredNodes?: number;
  minNodes?: number;
  maxNodes?: number;
  /** Security posture (Portal "Authentication + Authorization" step). */
  privateCluster?: boolean;
  azureRbac?: boolean;
  disableLocalAccounts?: boolean;
  workloadIdentity?: boolean;
  /** Optional application node pool (Portal "Add node pool" step). */
  appNodePool?: boolean;
  appVmSize?: string;
  appSpot?: boolean;
  appMinNodes?: number;
  appMaxNodes?: number;
  /** Optional Azure Storage remote-state backend. All three or none. */
  stateResourceGroup?: string;
  stateStorageAccount?: string;
  stateContainer?: string;
  /** The three execution modes from the infra playbook. */
  mode: "push" | "apply" | "push_and_apply";
  /** Required when mode includes push. */
  repoFullName?: string;
  /** GitHub folder for the generated files (push modes). Defaults to terraform/aks/<name>. */
  path?: string;
};

type Output = {
  cluster: string;
  fileCount: number;
  mode: string;
  runId?: string;
  pullRequest?: { number: number; url: string };
  committed?: string[];
  note: string;
};

/**
 * Deterministically provision an AKS cluster from a spec. The agent supplies
 * only the answers to the Azure-Portal-style questions (subscription/env,
 * resource group, region, node pool, security profile, optional app pool,
 * optional remote state) — this tool builds the complete Terraform via the
 * same generator the AKS static form uses, then PUSHES it to a repo and/or
 * APPLIES it for real. Matches the three infra execution modes.
 */
export const provisionAksTool: Tool<Input, Output> = {
  name: "provision_aks",
  description:
    "Create an AKS cluster from a spec. Use this for ANY AKS request instead of hand-writing " +
    "Terraform — it deterministically generates the full resource-group + AKS + node-pool + " +
    "security config, then per `mode`: pushes it to a repo as a PR ('push'), runs terraform " +
    "apply ('apply'), or both ('push_and_apply'). Ask the Azure-Portal-style questions first: " +
    "env, cluster name, resource group (create new or reuse), location, K8s version, VM size, " +
    "node counts, VNet (default or existing subnet id), security profile (Azure RBAC / disable " +
    "local accounts / workload identity / private cluster), optional app node pool, and mode.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose Azure creds to use, e.g. 'release'." },
      name: { type: "string", description: "Cluster name (lowercase letters, digits, hyphens; start with a letter)." },
      location: { type: "string", description: "Azure region. Default eastus." },
      resourceGroup: { type: "string", description: "Resource group (created if createResourceGroup=true, else must exist)." },
      createResourceGroup: { type: "boolean", description: "Create a new resource group. Default true." },
      vnetSubnetId: { type: "string", description: "Full resource id of an existing subnet to place nodes in. Omit for AKS-managed networking." },
      kubernetesVersion: { type: "string", description: "K8s version, e.g. '1.30'." },
      vmSize: { type: "string", description: "System node VM size, e.g. 'Standard_D4s_v3'." },
      desiredNodes: { type: "number", description: "System node desired count. Default 2." },
      minNodes: { type: "number", description: "System node min count. Default 2." },
      maxNodes: { type: "number", description: "System node max count. Default 5." },
      privateCluster: { type: "boolean", description: "Private API server (no public endpoint). Default false." },
      azureRbac: { type: "boolean", description: "Entra ID + Azure RBAC for Kubernetes authorization. Default true." },
      disableLocalAccounts: { type: "boolean", description: "Force Entra ID only (disable local admin accounts). Default false." },
      workloadIdentity: { type: "boolean", description: "OIDC issuer + workload identity for pods. Default true." },
      appNodePool: { type: "boolean", description: "Add an application node pool alongside the system pool. Default true." },
      appVmSize: { type: "string", description: "App pool VM size." },
      appSpot: { type: "boolean", description: "Use spot VMs for the app pool. Default true." },
      appMinNodes: { type: "number", description: "App pool min nodes." },
      appMaxNodes: { type: "number", description: "App pool max nodes." },
      stateResourceGroup: { type: "string", description: "Remote-state Storage Account resource group (optional)." },
      stateStorageAccount: { type: "string", description: "Remote-state Storage Account name (optional)." },
      stateContainer: { type: "string", description: "Remote-state blob container (optional). Provide all three or none." },
      mode: { type: "string", enum: ["push", "apply", "push_and_apply"], description: "Execution mode the user chose." },
      repoFullName: { type: "string", description: "owner/repo to push to (required for push modes)." },
      path: { type: "string", description: "GitHub folder for the files. Default terraform/aks/<name>." },
    },
    required: ["envKey", "name", "resourceGroup", "mode"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!/^[a-z][a-z0-9-]{1,38}$/.test(input.name)) {
      return { ok: false, error: "Invalid cluster name. Use lowercase letters, digits, hyphens; start with a letter." };
    }
    const wantsPush = input.mode === "push" || input.mode === "push_and_apply";
    const wantsApply = input.mode === "apply" || input.mode === "push_and_apply";
    if (wantsPush && !input.repoFullName) {
      return { ok: false, error: "repoFullName is required for push modes." };
    }

    const env = await prisma.env.findUnique({
      where: { projectId_key: { projectId: ctx.projectId, key: input.envKey } },
      select: {
        id: true,
        key: true,
        cloudProviderId: true,
        tfBackendAzureResourceGroup: true,
        tfBackendAzureStorageAccount: true,
        tfBackendAzureContainer: true,
      },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    if (wantsApply && !env.cloudProviderId) {
      return { ok: false, error: `Env "${input.envKey}" has no cloud provider connected — connect Azure before applying.` };
    }

    // Backend resolution: explicit inputs win; otherwise fall back to whatever
    // the env has stored via the Connection page's tf-backend section.
    const explicitComplete = !!(input.stateResourceGroup && input.stateStorageAccount && input.stateContainer);
    const explicitPartial =
      !explicitComplete && (input.stateResourceGroup || input.stateStorageAccount || input.stateContainer);
    if (explicitPartial) {
      return {
        ok: false,
        error:
          "Remote state requires all three of stateResourceGroup, stateStorageAccount, stateContainer — or omit all three to use the env's saved backend (or local state).",
      };
    }
    const backend = explicitComplete
      ? {
          resourceGroup: input.stateResourceGroup!,
          storageAccount: input.stateStorageAccount!,
          container: input.stateContainer!,
        }
      : env.tfBackendAzureStorageAccount && env.tfBackendAzureContainer
        ? {
            resourceGroup: env.tfBackendAzureResourceGroup ?? undefined,
            storageAccount: env.tfBackendAzureStorageAccount,
            container: env.tfBackendAzureContainer,
          }
        : null;

    const spec: AksSpec = {
      name: input.name,
      location: (input.location ?? "eastus").trim(),
      kubernetesVersion: input.kubernetesVersion ?? "1.33",
      vmSize: input.vmSize ?? "Standard_D4s_v3",
      desiredNodes: input.desiredNodes ?? 2,
      minNodes: input.minNodes ?? 2,
      maxNodes: input.maxNodes ?? 5,
      resourceGroup: input.resourceGroup,
      createResourceGroup: input.createResourceGroup ?? true,
      vnetSubnetId: input.vnetSubnetId?.trim() || undefined,
      privateCluster: input.privateCluster ?? false,
      azureRbac: input.azureRbac ?? true,
      disableLocalAccounts: input.disableLocalAccounts ?? false,
      workloadIdentity: input.workloadIdentity ?? true,
      appNodePool: input.appNodePool ?? true,
      appVmSize: input.appVmSize,
      appSpot: input.appSpot ?? true,
      appMinNodes: input.appMinNodes,
      appMaxNodes: input.appMaxNodes,
      ...(backend
        ? {
            stateResourceGroup: backend.resourceGroup,
            stateStorageAccount: backend.storageAccount,
            stateContainer: backend.container,
          }
        : {}),
    };
    if (spec.maxNodes < spec.minNodes || spec.desiredNodes < spec.minNodes || spec.desiredNodes > spec.maxNodes) {
      return { ok: false, error: "Node counts must satisfy min ≤ desired ≤ max." };
    }

    const files = buildAksTerraform(spec);
    const fileCount = Object.keys(files).length;

    let pullRequest: { number: number; url: string } | undefined;
    const committed: string[] = [];
    if (wantsPush) {
      const base = (input.path ?? `terraform/aks/${input.name}`).replace(/^\/+|\/+$/g, "");
      const branch = `infra/aks-${input.name}`;
      let first = true;
      for (const [rel, content] of Object.entries(files)) {
        const filename = rel.split("/").pop() || rel;
        const res = await writeRepoFileTool.execute(
          {
            repoFullName: input.repoFullName!,
            path: `${base}/${filename}`,
            content,
            branch,
            message: `Add AKS cluster ${input.name} (Terraform)`,
            openPullRequest: first,
            pullRequestBody: `Deterministic AKS blueprint for \`${input.name}\` in ${spec.location} (resource group \`${spec.resourceGroup}\`).`,
          },
          ctx,
        );
        if (!res.ok) return { ok: false, error: `Push failed on ${base}/${filename}: ${res.error}` };
        committed.push(`${base}/${filename}`);
        if (first && res.output.pullRequest) pullRequest = res.output.pullRequest;
        first = false;
      }
    }

    let runId: string | undefined;
    if (wantsApply) {
      const run = startTerraformRun({
        projectId: ctx.projectId,
        envId: env.id,
        envKey: env.key,
        cloudProviderId: env.cloudProviderId,
        name: `aks-${input.name}-apply`,
        action: "apply",
        files,
        backend: backend
          ? {
              kind: "azurerm",
              resourceGroup: backend.resourceGroup ?? "",
              storageAccount: backend.storageAccount,
              container: backend.container,
            }
          : null,
        stack: `aks-${input.name}`,
      });
      runId = run.id;
    }

    const bits: string[] = [`Generated ${fileCount} AKS Terraform files for "${input.name}".`];
    if (pullRequest) bits.push(`Opened PR #${pullRequest.number}: ${pullRequest.url}`);
    else if (committed.length) bits.push(`Committed ${committed.length} files.`);
    if (runId) bits.push(`Started terraform apply (run ${runId}) — track it on the Infrastructure tab (AKS takes ~10–15 min).`);

    return {
      ok: true,
      output: { cluster: input.name, fileCount, mode: input.mode, runId, pullRequest, committed, note: bits.join(" ") },
    };
  },
};
