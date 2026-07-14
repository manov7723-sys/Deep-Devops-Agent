import { prisma } from "@/lib/db/prisma";
import { listEnvs, createEnv, updateEnv, deleteEnv, type EnvRow } from "@/lib/devops/envs";
import type { Tool } from "./types";

async function projectOwnerId(projectId: string): Promise<string> {
  const p = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { ownerId: true },
  });
  return p.ownerId;
}

export const listEnvironmentsTool: Tool<Record<string, never>, EnvRow[]> = {
  name: "list_environments",
  description:
    "List the project's environments (staging, production, …) with their key, namespace and whether they're production.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    return { ok: true, output: await listEnvs(ctx.projectId) };
  },
};

export const createEnvironmentTool: Tool<
  {
    key: string;
    name: string;
    isProduction?: boolean;
    autoDeploy?: boolean;
    namespace?: string;
    region?: string;
  },
  EnvRow
> = {
  name: "create_environment",
  description:
    "Create a new project environment (e.g. staging, production). Ask the user for the key/name and whether " +
    "it's production if not obvious from context — everything else has sane defaults. Cluster wiring happens " +
    "separately via the cluster-connect or an eks/gke/aks/proxmox create flow, not here.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Lowercase slug, e.g. 'staging'." },
      name: { type: "string", description: "Display name, e.g. 'Staging'." },
      isProduction: {
        type: "boolean",
        description: "Production envs require deploy approval by default.",
      },
      autoDeploy: {
        type: "boolean",
        description: "Auto-deploy on push. Defaults to true for non-prod, false for prod.",
      },
      namespace: {
        type: "string",
        description: "Kubernetes namespace. Defaults to the key if omitted.",
      },
      region: { type: "string", description: "Optional cloud region label." },
    },
    required: ["key", "name"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const [ownerId, existing] = await Promise.all([
      projectOwnerId(ctx.projectId),
      listEnvs(ctx.projectId),
    ]);
    const isProduction = input.isProduction ?? false;
    const res = await createEnv({
      projectId: ctx.projectId,
      ownerId,
      key: input.key,
      name: input.name,
      isProduction,
      autoDeploy: input.autoDeploy ?? !isProduction,
      namespace: input.namespace,
      region: input.region,
      promotionRank: existing.length,
    });
    if (!res.ok) return { ok: false, error: res.code };
    return { ok: true, output: res.env };
  },
};

export const updateEnvironmentTool: Tool<
  {
    key: string;
    name?: string;
    isProduction?: boolean;
    autoDeploy?: boolean;
    namespace?: string;
    region?: string;
  },
  EnvRow
> = {
  name: "update_environment",
  description:
    "Update an existing environment's name, production flag, auto-deploy, namespace, or region.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "The environment's key." },
      name: { type: "string" },
      isProduction: { type: "boolean" },
      autoDeploy: { type: "boolean" },
      namespace: { type: "string" },
      region: { type: "string" },
    },
    required: ["key"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const ownerId = await projectOwnerId(ctx.projectId);
    const { key, ...patch } = input;
    const res = await updateEnv(ctx.projectId, ownerId, key, patch);
    if (!res.ok) return { ok: false, error: res.code };
    return { ok: true, output: res.env };
  },
};

export const deleteEnvironmentTool: Tool<{ key: string }, { deleted: true }> = {
  name: "delete_environment",
  description:
    "Delete an environment. Fails if it has deployment history — confirm with the user first since this can't be undone.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await deleteEnv(ctx.projectId, input.key);
    if (!res.ok) return { ok: false, error: res.code };
    return { ok: true, output: { deleted: true } };
  },
};
