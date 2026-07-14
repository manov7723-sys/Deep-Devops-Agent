import { prisma } from "@/lib/db/prisma";
import {
  listArtifactRegistries,
  createArtifactRegistry,
  setupGithubWif,
} from "@/lib/cloud/gcp-artifact-registry";
import { generateGarWorkflow } from "@/lib/ci/templates";
import type { Tool } from "./types";

async function gcpProviderId(projectId: string): Promise<string | null> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "gcp" },
    select: { id: true },
  });
  return cp?.id ?? null;
}

/* ── list existing registries ─────────────────────────────────────────────── */
export const listArtifactRegistriesTool: Tool<
  { location: string },
  { registries: Array<{ name: string; location: string }> }
> = {
  name: "list_artifact_registries",
  description:
    "List the project's existing GCP Artifact Registry docker repositories in a location (e.g. us-central1). " +
    "Use this when setting up a CI workflow and the user wants to PUSH to an EXISTING registry — show the list and let them pick.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string", description: "Artifact Registry location, e.g. us-central1." },
    },
    required: ["location"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const id = await gcpProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No GCP provider is connected to this project." };
    const res = await listArtifactRegistries(id, input.location);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: { registries: res.data.map((r) => ({ name: r.name, location: r.location })) },
    };
  },
};

/* ── create a new registry ────────────────────────────────────────────────── */
export const createArtifactRegistryTool: Tool<
  { location: string; repository: string },
  { name: string; location: string }
> = {
  name: "create_artifact_registry",
  description:
    "Create a new GCP Artifact Registry docker repository. Use when the user chose to CREATE a new registry for their CI workflow. " +
    "Pick a sensible location (default us-central1) and a repository name (e.g. the project slug). Idempotent.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string", description: "Location, e.g. us-central1." },
      repository: {
        type: "string",
        description: "Repository id (lowercase, hyphens), e.g. the app name.",
      },
    },
    required: ["location", "repository"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const id = await gcpProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No GCP provider is connected to this project." };
    const res = await createArtifactRegistry(id, input.location, input.repository);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { name: res.data.name, location: res.data.location } };
  },
};

/* ── keyless GitHub→GCP auth (WIF) ────────────────────────────────────────── */
export const setupGcpGithubWifTool: Tool<
  { repoFullName: string },
  { workloadIdentityProvider: string; serviceAccount: string }
> = {
  name: "setup_gcp_github_wif",
  description:
    "Set up KEYLESS GitHub→GCP auth (Workload Identity Federation) for one repo so GitHub Actions can push to Artifact Registry " +
    "with NO stored key. Creates/reuses a workload identity pool + OIDC provider (scoped to this repo), a service account with " +
    "Artifact Registry Writer, and the impersonation binding. Returns the provider + service account for generate_gar_workflow. " +
    "Needs the connected GCP identity to have IAM admin. Run this once before generate_gar_workflow.",
  inputSchema: {
    type: "object",
    properties: { repoFullName: { type: "string", description: 'GitHub repo as "owner/name".' } },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const id = await gcpProviderId(ctx.projectId);
    if (!id) return { ok: false, error: "No GCP provider is connected to this project." };
    const res = await setupGithubWif(id, input.repoFullName);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: {
        workloadIdentityProvider: res.data.workloadIdentityProvider,
        serviceAccount: res.data.serviceAccount,
      },
    };
  },
};

/* ── generate the workflow file ───────────────────────────────────────────── */
type GarGenInput = {
  workloadIdentityProvider: string;
  serviceAccount: string;
  location: string;
  repository: string;
  image: string;
  branch?: string;
};
export const generateGarWorkflowTool: Tool<
  GarGenInput,
  { files: Array<{ path: string; content: string }> }
> = {
  name: "generate_gar_workflow",
  description:
    "Generate the GitHub Actions workflow that builds the image and pushes it to GCP Artifact Registry over keyless WIF " +
    "(no secrets). Pass the workloadIdentityProvider + serviceAccount from setup_gcp_github_wif, plus the location, repository " +
    "and image name. Show the file, then commit it with write_repo_file.",
  inputSchema: {
    type: "object",
    properties: {
      workloadIdentityProvider: { type: "string", description: "From setup_gcp_github_wif." },
      serviceAccount: { type: "string", description: "From setup_gcp_github_wif." },
      location: { type: "string", description: "Artifact Registry location, e.g. us-central1." },
      repository: { type: "string", description: "Artifact Registry repository." },
      image: { type: "string", description: "Image name (e.g. the app name)." },
      branch: { type: "string", description: "Branch that triggers the build. Defaults to main." },
    },
    required: ["workloadIdentityProvider", "serviceAccount", "location", "repository", "image"],
    additionalProperties: false,
  },
  async execute(input) {
    const file = generateGarWorkflow({
      workloadIdentityProvider: input.workloadIdentityProvider,
      serviceAccount: input.serviceAccount,
      location: input.location,
      projectId: input.serviceAccount.split("@")[1]?.split(".")[0] ?? "",
      repository: input.repository,
      image: input.image,
      branch: input.branch || "main",
    });
    return { ok: true, output: { files: [file] } };
  },
};
