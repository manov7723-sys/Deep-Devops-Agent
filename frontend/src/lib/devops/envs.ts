/**
 * Env CRUD + repo wiring. The Env's cloud provider must belong to the project
 * OWNER (not the operating user) so all developers can target it. Repos being
 * wired must already be attached to the project via ProjectRepo.
 */
import type { Env } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";

export type EnvRow = {
  id: string;
  key: string;
  name: string;
  url: string | null;
  isProduction: boolean;
  autoDeploy: boolean;
  region: string | null;
  terraformWorkspace: string | null;
  promotionRank: number;
  cloudProviderId: string | null;
  /** Cloud of the env's provider (aws | azure | gcp | …) — for cloud-aware UI. */
  cloudKind: string | null;
  currentDeploymentId: string | null;
  /** Whether a kubeconfig is stored for this env. UI shows the appropriate
   *  affordance (Paste / Replace). The actual blob never leaves the server. */
  hasKubeconfig: boolean;
  namespace: string;
  createdAt: string;
  updatedAt: string;
};

function row(e: Env & { cloudProvider?: { kind: string } | null }): EnvRow {
  return {
    id: e.id,
    key: e.key,
    name: e.name,
    url: e.url,
    isProduction: e.isProduction,
    autoDeploy: e.autoDeploy,
    region: e.region,
    terraformWorkspace: e.terraformWorkspace,
    promotionRank: e.promotionRank,
    cloudProviderId: e.cloudProviderId,
    cloudKind: e.cloudProvider?.kind ?? null,
    currentDeploymentId: e.currentDeploymentId,
    hasKubeconfig: !!e.kubeconfigRef,
    namespace: e.namespace,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export async function listEnvs(projectId: string): Promise<EnvRow[]> {
  const rows = await prisma.env.findMany({
    where: { projectId },
    orderBy: [{ promotionRank: "asc" }, { createdAt: "asc" }],
    include: { cloudProvider: { select: { kind: true } } },
  });
  return rows.map(row);
}

export type CreateEnvArgs = {
  projectId: string;
  ownerId: string; // project owner — used to validate the cloud provider
  key: string;
  name: string;
  isProduction: boolean;
  autoDeploy: boolean;
  cloudProviderId?: string;
  region?: string;
  terraformWorkspace?: string;
  url?: string;
  promotionRank: number;
  kubeconfig?: string;
  namespace?: string;
};

export type CreateEnvResult =
  | { ok: true; env: EnvRow }
  | { ok: false; code: "duplicate_key" | "provider_not_project_owner" };

export async function createEnv(args: CreateEnvArgs): Promise<CreateEnvResult> {
  if (args.cloudProviderId) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { id: args.cloudProviderId, userId: args.ownerId },
      select: { id: true },
    });
    if (!cp) return { ok: false, code: "provider_not_project_owner" };
  }

  // Encrypt kubeconfig at create time if provided. Empty / undefined means
  // the env is created without cluster wiring — the owner can paste one
  // later from the edit modal.
  const kubeconfigRef =
    args.kubeconfig && args.kubeconfig.length > 0 ? encryptSecret(args.kubeconfig) : null;

  try {
    const created = await prisma.env.create({
      data: {
        projectId: args.projectId,
        key: args.key,
        name: args.name,
        isProduction: args.isProduction,
        autoDeploy: args.autoDeploy,
        cloudProviderId: args.cloudProviderId ?? null,
        region: args.region ?? null,
        terraformWorkspace: args.terraformWorkspace ?? null,
        url: args.url ?? null,
        promotionRank: args.promotionRank,
        kubeconfigRef,
        ...(args.namespace && { namespace: args.namespace }),
      },
    });
    return { ok: true, env: row(created) };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return { ok: false, code: "duplicate_key" };
    }
    throw err;
  }
}

export type UpdateEnvArgs = Partial<{
  name: string;
  isProduction: boolean;
  autoDeploy: boolean;
  cloudProviderId: string | null;
  region: string;
  terraformWorkspace: string;
  url: string | null;
  promotionRank: number;
  /** Raw kubeconfig YAML. Empty string clears the stored value; undefined keeps it. */
  kubeconfig: string;
  namespace: string;
}>;

export type UpdateEnvResult =
  | { ok: true; env: EnvRow }
  | { ok: false; code: "not_found" | "provider_not_project_owner" };

export async function updateEnv(
  projectId: string,
  ownerId: string,
  key: string,
  patch: UpdateEnvArgs,
): Promise<UpdateEnvResult> {
  const existing = await prisma.env.findUnique({
    where: { projectId_key: { projectId, key } },
    select: { id: true },
  });
  if (!existing) return { ok: false, code: "not_found" };

  if (patch.cloudProviderId) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { id: patch.cloudProviderId, userId: ownerId },
      select: { id: true },
    });
    if (!cp) return { ok: false, code: "provider_not_project_owner" };
  }

  // Encrypt kubeconfig before storing. Empty string explicitly clears the
  // stored value (sets kubeconfigRef back to null); `undefined` leaves it.
  const kubeconfigRef =
    patch.kubeconfig === undefined
      ? undefined
      : patch.kubeconfig.length === 0
        ? null
        : encryptSecret(patch.kubeconfig);

  const updated = await prisma.env.update({
    where: { id: existing.id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.isProduction !== undefined && { isProduction: patch.isProduction }),
      ...(patch.autoDeploy !== undefined && { autoDeploy: patch.autoDeploy }),
      ...(patch.cloudProviderId !== undefined && { cloudProviderId: patch.cloudProviderId }),
      ...(patch.region !== undefined && { region: patch.region }),
      ...(patch.terraformWorkspace !== undefined && { terraformWorkspace: patch.terraformWorkspace }),
      ...(patch.url !== undefined && { url: patch.url }),
      ...(patch.promotionRank !== undefined && { promotionRank: patch.promotionRank }),
      ...(kubeconfigRef !== undefined && { kubeconfigRef }),
      ...(patch.namespace !== undefined && { namespace: patch.namespace }),
    },
  });
  return { ok: true, env: row(updated) };
}

export type DeleteEnvResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "has_deployments" };

export async function deleteEnv(projectId: string, key: string): Promise<DeleteEnvResult> {
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId, key } },
    select: { id: true },
  });
  if (!env) return { ok: false, code: "not_found" };
  const deployments = await prisma.deployment.count({ where: { envId: env.id } });
  if (deployments > 0) return { ok: false, code: "has_deployments" };
  await prisma.env.delete({ where: { id: env.id } });
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────
// EnvRepo wiring
// ──────────────────────────────────────────────────────────────────

export type EnvRepoRow = {
  envRepoId: string;
  repoId: string;
  fullName: string;
  branch: string;
  autoDeploy: boolean;
};

export async function listEnvRepos(envId: string): Promise<EnvRepoRow[]> {
  const rows = await prisma.envRepo.findMany({
    where: { envId },
    orderBy: { createdAt: "asc" },
    include: { repo: { select: { id: true, fullName: true } } },
  });
  return rows.map((r) => ({
    envRepoId: r.id,
    repoId: r.repo.id,
    fullName: r.repo.fullName,
    branch: r.branch,
    autoDeploy: r.autoDeploy,
  }));
}

export type WireRepoResult =
  | { ok: true }
  | { ok: false; code: "repo_not_attached" | "already_wired" };

/** The repo must already be attached to the project (ProjectRepo). */
export async function wireRepoToEnv(
  projectId: string,
  envId: string,
  repoId: string,
  branch: string,
  autoDeploy: boolean,
): Promise<WireRepoResult> {
  const attached = await prisma.projectRepo.findUnique({
    where: { projectId_repoId: { projectId, repoId } },
    select: { id: true },
  });
  if (!attached) return { ok: false, code: "repo_not_attached" };

  try {
    await prisma.envRepo.create({ data: { envId, repoId, branch, autoDeploy } });
    return { ok: true };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return { ok: false, code: "already_wired" };
    }
    throw err;
  }
}

export async function unwireRepoFromEnv(envId: string, repoId: string): Promise<boolean> {
  const { count } = await prisma.envRepo.deleteMany({ where: { envId, repoId } });
  return count > 0;
}

export async function envBySlugAndKey(projectId: string, key: string) {
  return prisma.env.findUnique({
    where: { projectId_key: { projectId, key } },
  });
}

export type TfBackend = { bucket: string; region: string; table?: string };
export type SetTfBackendResult =
  | { ok: true; backend: { bucket: string | null; region: string | null; table: string | null } }
  | { ok: false; code: "not_found" };

/**
 * Set the Terraform remote-state backend (S3 bucket + region + optional
 * DynamoDB lock table) for an env. These are referenced in generated HCL so
 * every apply for this env shares the same remote state.
 */
export async function setEnvTfBackend(
  projectId: string,
  key: string,
  backend: TfBackend,
): Promise<SetTfBackendResult> {
  const env = await prisma.env.findUnique({ where: { projectId_key: { projectId, key } } });
  if (!env) return { ok: false, code: "not_found" };
  const updated = await prisma.env.update({
    where: { id: env.id },
    data: {
      tfBackendBucket: backend.bucket,
      tfBackendRegion: backend.region,
      tfBackendTable: backend.table ?? null,
    },
    select: { tfBackendBucket: true, tfBackendRegion: true, tfBackendTable: true },
  });
  return {
    ok: true,
    backend: {
      bucket: updated.tfBackendBucket,
      region: updated.tfBackendRegion,
      table: updated.tfBackendTable,
    },
  };
}
