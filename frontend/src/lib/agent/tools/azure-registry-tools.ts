import { prisma } from "@/lib/db/prisma";
import { listAcr, createAcr, setupGithubFederatedCredential } from "@/lib/cloud/azure-acr";
import { generateAcrWorkflow } from "@/lib/ci/templates";
import type { Tool } from "./types";

async function azureProviderId(projectId: string): Promise<string | null> {
  const cp = await prisma.cloudProvider.findFirst({ where: { projectId, kind: "azure" }, select: { id: true } });
  return cp?.id ?? null;
}

export const listAcrTool: Tool<Record<string, never>, { registries: Array<{ name: string; resourceGroup: string; loginServer: string }> }> = {
  name: "list_acr",
  description:
    "List the project's existing Azure Container Registries. Use when setting up a CI workflow and the user wants to push to an EXISTING ACR — show the list and let them pick.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const id = await azureProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No Azure provider is connected to this project." };
    const res = await listAcr(id);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { registries: res.data } };
  },
};

export const createAcrTool: Tool<{ resourceGroup: string; name: string; location?: string }, { name: string; loginServer: string }> = {
  name: "create_acr",
  description:
    "Create a new Azure Container Registry (Basic SKU). Use when the user chose to CREATE a new registry. ACR names are global, " +
    "lowercase, alphanumeric only. Pick a resource group that exists (list_azure_resource_groups) and a location (default eastus).",
  inputSchema: {
    type: "object",
    properties: {
      resourceGroup: { type: "string", description: "Existing resource group." },
      name: { type: "string", description: "Globally-unique ACR name (lowercase alphanumeric)." },
      location: { type: "string", description: "Azure region. Defaults to eastus." },
    },
    required: ["resourceGroup", "name"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const id = await azureProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No Azure provider is connected to this project." };
    const res = await createAcr(id, input.resourceGroup, input.name, input.location || "eastus");
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { name: res.data.name, loginServer: res.data.loginServer } };
  },
};

export const setupAzureGithubOidcTool: Tool<{ repoFullName: string; acrName: string; resourceGroup: string; branch?: string }, { clientId: string; tenantId: string; subscriptionId: string }> = {
  name: "setup_azure_github_oidc",
  description:
    "Set up KEYLESS GitHub→Azure auth for one repo + ACR so GitHub Actions can push with NO secret: creates/reuses an AD app + " +
    "service principal, adds a federated credential (scoped to this repo+branch), and grants AcrPush on the ACR. Returns the " +
    "client/tenant/subscription ids for generate_acr_workflow. Requires a SERVICE-PRINCIPAL Azure connection with Graph permission. " +
    "Run this once before generate_acr_workflow.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'GitHub repo as "owner/name".' },
      acrName: { type: "string", description: "The ACR to grant push to." },
      resourceGroup: { type: "string", description: "The ACR's resource group." },
      branch: { type: "string", description: "Branch that triggers the build. Defaults to main." },
    },
    required: ["repoFullName", "acrName", "resourceGroup"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const id = await azureProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No Azure provider is connected to this project." };
    const res = await setupGithubFederatedCredential(id, input.repoFullName, input.acrName, input.resourceGroup, input.branch || "main");
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: res.data };
  },
};

type AcrGenInput = { clientId: string; tenantId: string; subscriptionId: string; registry: string; image: string; branch?: string };
export const generateAcrWorkflowTool: Tool<AcrGenInput, { files: Array<{ path: string; content: string }> }> = {
  name: "generate_acr_workflow",
  description:
    "Generate the GitHub Actions workflow that builds the image and pushes it to Azure Container Registry over keyless OIDC " +
    "(azure/login, no secret). Pass the client/tenant/subscription from setup_azure_github_oidc, the ACR name and image name. " +
    "Show the file, then commit it with write_repo_file.",
  inputSchema: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "From setup_azure_github_oidc." },
      tenantId: { type: "string", description: "From setup_azure_github_oidc." },
      subscriptionId: { type: "string", description: "From setup_azure_github_oidc." },
      registry: { type: "string", description: "ACR name (without .azurecr.io)." },
      image: { type: "string", description: "Image name." },
      branch: { type: "string", description: "Branch that triggers the build. Defaults to main." },
    },
    required: ["clientId", "tenantId", "subscriptionId", "registry", "image"],
    additionalProperties: false,
  },
  async execute(input) {
    const file = generateAcrWorkflow({
      clientId: input.clientId,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      registry: input.registry,
      image: input.image,
      branch: input.branch || "main",
    });
    return { ok: true, output: { files: [file] } };
  },
};
