import { prisma } from "@/lib/db/prisma";
import {
  listAcr,
  createAcr,
  setupGithubFederatedCredential,
  setupAcrSecretPush,
  repairAcrSecretPush,
  discoverAcrPushWorkflows,
  findAcrResourceGroup,
  rerunLatestFailedWorkflow,
} from "@/lib/cloud/azure-acr";
import { generateAcrWorkflow } from "@/lib/ci/templates";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import type { Tool } from "./types";

/**
 * The error `resolveSp` returns when the Azure connection is OAuth (no client
 * secret stored). Detected here so we can automatically switch to the secret-
 * based ACR push path instead of dead-ending the user on "reconnect as SP".
 */
const NEEDS_SP_ERROR = /Keyless ACR setup needs a SERVICE-PRINCIPAL Azure connection/i;

async function azureProviderId(projectId: string): Promise<string | null> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true },
  });
  return cp?.id ?? null;
}

export const listAcrTool: Tool<
  Record<string, never>,
  { registries: Array<{ name: string; resourceGroup: string; loginServer: string }> }
> = {
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

export const createAcrTool: Tool<
  { resourceGroup: string; name: string; location?: string },
  { name: string; loginServer: string }
> = {
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

type SetupOidcOutput =
  | { mode: "keyless"; clientId: string; tenantId: string; subscriptionId: string }
  | { mode: "secret"; registry: string; loginServer: string; secretPrefix: string; note: string };

export const setupAzureGithubOidcTool: Tool<
  { repoFullName: string; acrName: string; resourceGroup: string; branch?: string },
  SetupOidcOutput
> = {
  name: "setup_azure_github_oidc",
  description:
    "Set up GitHub → ACR push auth for one repo + ACR. Prefers KEYLESS OIDC (azure/login + federated credential, no stored " +
    "secret) when the Azure connection is a Service Principal with Graph permission. If the connection is an OAuth sign-in " +
    "(which can't create AD apps), AUTOMATICALLY falls back to enabling the ACR admin user and storing its credentials as " +
    "GitHub Actions secrets — the workflow uses docker login instead. Returns { mode: 'keyless' | 'secret' } plus the fields " +
    "generate_acr_workflow needs for that mode. Run this once before generate_acr_workflow.",
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
    const branch = input.branch || "main";

    // Try keyless first — the "right" answer when the Azure connection can do it.
    const keyless = await setupGithubFederatedCredential(
      id,
      input.repoFullName,
      input.acrName,
      input.resourceGroup,
      branch,
    );
    if (keyless.ok) {
      return {
        ok: true,
        output: {
          mode: "keyless",
          clientId: keyless.data.clientId,
          tenantId: keyless.data.tenantId,
          subscriptionId: keyless.data.subscriptionId,
        },
      };
    }
    // If keyless failed for reasons OTHER than "OAuth connection can't do Graph",
    // surface that error — don't silently mask a real Graph/ARM problem.
    if (!NEEDS_SP_ERROR.test(keyless.error)) {
      return { ok: false, error: keyless.error };
    }

    // OAuth connection — fall back to secret-based push. Enable ACR admin, fetch
    // creds, set them as GitHub secrets. Then the workflow uses docker login.
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true },
    });
    if (!repo)
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    const gh = await resolveTokenForRepo(repo.id);
    if (!gh.ok)
      return {
        ok: false,
        error: `Could not resolve a GitHub token to store the ACR credentials: ${gh.message}`,
      };

    const secret = await setupAcrSecretPush(
      id,
      gh.accessToken,
      input.repoFullName,
      input.resourceGroup,
      input.acrName,
    );
    if (!secret.ok) return { ok: false, error: secret.error };

    return {
      ok: true,
      output: {
        mode: "secret",
        registry: secret.data.registry,
        loginServer: secret.data.loginServer,
        secretPrefix: secret.data.secretPrefix,
        note:
          "ACR admin credentials stored as GitHub Actions secrets. The workflow will push via docker login. " +
          "This is the intended path for OAuth-connected Azure — do NOT tell the user to reconnect anything.",
      },
    };
  },
};

type AcrGenInput = {
  mode?: "keyless" | "secret";
  registry: string;
  image: string;
  branch?: string;
  clientId?: string;
  tenantId?: string;
  subscriptionId?: string;
  secretPrefix?: string;
};
export const generateAcrWorkflowTool: Tool<
  AcrGenInput,
  { files: Array<{ path: string; content: string }> }
> = {
  name: "generate_acr_workflow",
  description:
    "Generate the GitHub Actions workflow that builds the image and pushes it to Azure Container Registry. Pick `mode` based " +
    "on what setup_azure_github_oidc returned: 'keyless' → pass clientId/tenantId/subscriptionId (workflow uses azure/login " +
    "over OIDC, no stored secret); 'secret' → pass secretPrefix (workflow uses docker login with the ACR admin creds stored " +
    "as GitHub Actions secrets). Show the file, then commit it with write_repo_file.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["keyless", "secret"],
        description: "Match the mode returned by setup_azure_github_oidc. Default 'keyless'.",
      },
      registry: { type: "string", description: "ACR name (without .azurecr.io)." },
      image: { type: "string", description: "Image name." },
      branch: { type: "string", description: "Branch that triggers the build. Defaults to main." },
      clientId: { type: "string", description: "Keyless mode only. From setup_azure_github_oidc." },
      tenantId: { type: "string", description: "Keyless mode only. From setup_azure_github_oidc." },
      subscriptionId: {
        type: "string",
        description: "Keyless mode only. From setup_azure_github_oidc.",
      },
      secretPrefix: {
        type: "string",
        description: "Secret mode only. From setup_azure_github_oidc.",
      },
    },
    required: ["registry", "image"],
    additionalProperties: false,
  },
  async execute(input) {
    const mode = input.mode ?? "keyless";
    if (mode === "keyless" && (!input.clientId || !input.tenantId || !input.subscriptionId)) {
      return {
        ok: false,
        error:
          "Keyless mode needs clientId, tenantId and subscriptionId (from setup_azure_github_oidc).",
      };
    }
    if (mode === "secret" && !input.secretPrefix) {
      return { ok: false, error: "Secret mode needs secretPrefix (from setup_azure_github_oidc)." };
    }
    const file = generateAcrWorkflow({
      mode,
      registry: input.registry,
      image: input.image,
      branch: input.branch || "main",
      clientId: input.clientId,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      secretPrefix: input.secretPrefix,
    });
    return { ok: true, output: { files: [file] } };
  },
};

type RepairInput = {
  repoFullName: string;
  /**
   * ACR name to refresh. Omit to auto-discover every ACR the repo's workflows
   * push to and refresh them all — the normal path when the agent is reacting
   * to a docker/login-action failure and doesn't want the user to name it.
   */
  acrName?: string;
  /** Resource group the ACR is in. Auto-resolved from listAcr if omitted. */
  resourceGroup?: string;
  /** Trigger a rerun of the failed CI workflow after fixing secrets. Default true. */
  rerunFailed?: boolean;
};
type RepairOutput = {
  repaired: Array<{
    registry: string;
    secretPrefix: string;
    secretNames: string[];
    workflowPath: string | null;
  }>;
  reruns: Array<{ workflowFile: string; note: string; runId: number | null }>;
  steps: string[];
};

export const repairAzureAcrPushAuthTool: Tool<RepairInput, RepairOutput> = {
  name: "repair_azure_acr_push_auth",
  description:
    "Self-heal a failing ACR CI push. Call this when a build-and-push-acr.yml run failed with docker/login-action's " +
    "'Username and password required' or when the workflow log contains the DEEPAGENT_ACR_SECRETS_MISSING marker — " +
    "one of the three ACR_*_LOGIN_SERVER / _USERNAME / _PASSWORD GitHub secrets is missing or empty. This tool " +
    "reads the repo's .github/workflows to find every ACR the workflows push to, rotates and refreshes the admin " +
    "credential for each, rewrites the three GitHub Actions secrets under the exact prefix each workflow references, " +
    "and re-runs the failed jobs — all with zero user input. Idempotent; safe to call any time.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'GitHub repo as "owner/name". The one whose CI is failing.',
      },
      acrName: {
        type: "string",
        description:
          "ACR to refresh. Omit to auto-discover from the repo's workflows and fix all of them.",
      },
      resourceGroup: {
        type: "string",
        description: "Resource group of the ACR. Auto-resolved from listAcr if omitted.",
      },
      rerunFailed: {
        type: "boolean",
        description: "Re-run the latest failed run of the affected workflow. Default true.",
      },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const id = await azureProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No Azure provider is connected to this project." };

    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true },
    });
    if (!repo)
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    const gh = await resolveTokenForRepo(repo.id);
    if (!gh.ok) return { ok: false, error: `Could not resolve a GitHub token: ${gh.message}` };

    // Discover which ACRs the workflows already reference so the fix targets
    // the exact secret prefix on-repo. Falls back to `acrName` from input.
    const discover = await discoverAcrPushWorkflows(gh.accessToken, input.repoFullName);
    if (!discover.ok) return { ok: false, error: discover.error };
    const steps: string[] = [];

    // Build the set of ACRs to repair — either the one the caller named, or
    // everything the repo's workflows push to (deduped by ACR name).
    let targets: Array<{
      registry: string;
      workflowPath: string | null;
      secretPrefix: string | null;
    }> = [];
    if (input.acrName) {
      const found = discover.data.find(
        (d) => d.registry.toLowerCase() === input.acrName!.toLowerCase(),
      );
      targets = [
        {
          registry: input.acrName,
          workflowPath: found?.workflowPath ?? null,
          secretPrefix: found?.secretPrefix ?? null,
        },
      ];
    } else {
      const dedup = new Map<
        string,
        { registry: string; workflowPath: string; secretPrefix: string }
      >();
      for (const d of discover.data) if (!dedup.has(d.registry)) dedup.set(d.registry, d);
      targets = [...dedup.values()].map((d) => ({
        registry: d.registry,
        workflowPath: d.workflowPath,
        secretPrefix: d.secretPrefix,
      }));
    }
    if (targets.length === 0) {
      return {
        ok: false,
        error:
          "No ACR push workflow found on the repo, and no acrName was provided — nothing to repair. Run the deploy flow first.",
      };
    }

    const repaired: RepairOutput["repaired"] = [];
    for (const t of targets) {
      let rgName: string | null = input.resourceGroup ?? null;
      if (!rgName) {
        const lookup = await findAcrResourceGroup(id, t.registry);
        if (!lookup.ok)
          return { ok: false, error: `Couldn't look up ACR "${t.registry}": ${lookup.error}` };
        rgName = lookup.data;
      }
      if (!rgName) {
        return {
          ok: false,
          error: `ACR "${t.registry}" isn't in the connected Azure subscription. Reconnect Azure or pass resourceGroup.`,
        };
      }
      const fix = await repairAcrSecretPush(
        id,
        gh.accessToken,
        input.repoFullName,
        rgName,
        t.registry,
      );
      if (!fix.ok)
        return { ok: false, error: `Refreshing "${t.registry}" secrets failed: ${fix.error}` };
      steps.push(
        `Refreshed ACR "${t.registry}" admin credential and rewrote ${fix.data.secretNames.length} GitHub secrets.`,
      );
      repaired.push({
        registry: t.registry,
        secretPrefix: t.secretPrefix ?? fix.data.secretNames[0].replace(/_LOGIN_SERVER$/, ""),
        secretNames: fix.data.secretNames,
        workflowPath: t.workflowPath,
      });
    }

    // Trigger reruns on the workflows we just healed so the user doesn't have
    // to push an empty commit or click "Re-run failed jobs" in the GitHub UI.
    const reruns: RepairOutput["reruns"] = [];
    if (input.rerunFailed !== false) {
      const seen = new Set<string>();
      for (const r of repaired) {
        const file = r.workflowPath ? r.workflowPath.split("/").pop() : null;
        if (!file || seen.has(file)) continue;
        seen.add(file);
        const rr = await rerunLatestFailedWorkflow(gh.accessToken, input.repoFullName, file);
        if (!rr.ok) {
          reruns.push({ workflowFile: file, note: `Rerun failed: ${rr.error}`, runId: null });
        } else {
          reruns.push({ workflowFile: file, note: rr.data.note, runId: rr.data.rerunRunId });
          if (rr.data.rerunRunId) steps.push(`Re-ran ${file} (run ${rr.data.rerunRunId}).`);
        }
      }
    }

    return { ok: true, output: { repaired, reruns, steps } };
  },
};
