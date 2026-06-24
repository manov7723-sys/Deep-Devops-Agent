/**
 * CloudProvider — User-owned cloud account hookup. Stores STS role ARN +
 * externalId for cross-account trust (no long-lived keys). Per the schema,
 * `roleArn` and `externalId` are plain columns; treat them as sensitive but
 * not at the AES-encrypted-secret tier.
 */
import type { CloudKind, HealthStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type CloudProviderRow = {
  id: string;
  kind: CloudKind;
  name: string;
  accountRef: string;
  accountId: string | null;
  region: string;
  status: HealthStatus;
  hasRoleArn: boolean;
  /** True when AWS access key + secret are stored in Vault for this provider. */
  hasVaultCreds: boolean;
  createdAt: string;
};

function row(r: {
  id: string;
  kind: CloudKind;
  name: string;
  accountRef: string;
  accountId: string | null;
  region: string;
  status: HealthStatus;
  roleArn: string | null;
  credVaultPath: string | null;
  createdAt: Date;
}): CloudProviderRow {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    accountRef: r.accountRef,
    accountId: r.accountId,
    region: r.region,
    status: r.status,
    hasRoleArn: !!r.roleArn,
    hasVaultCreds: !!r.credVaultPath,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listProvidersForUser(userId: string): Promise<CloudProviderRow[]> {
  const rows = await prisma.cloudProvider.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(row);
}

/** ISOLATION: providers that belong to this project (the per-project list). */
export async function listProvidersForProject(projectId: string): Promise<CloudProviderRow[]> {
  const rows = await prisma.cloudProvider.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(row);
}

export type CreateProviderArgs = {
  userId: string;
  /** ISOLATION: the project this provider belongs to. */
  projectId?: string;
  kind: CloudKind;
  name: string;
  accountRef: string;
  accountId?: string;
  region: string;
  roleArn?: string;
  externalId?: string;
};

export async function createProvider(args: CreateProviderArgs): Promise<CloudProviderRow> {
  const created = await prisma.cloudProvider.create({
    data: {
      userId: args.userId,
      projectId: args.projectId ?? null,
      kind: args.kind,
      name: args.name,
      accountRef: args.accountRef,
      accountId: args.accountId ?? null,
      region: args.region,
      roleArn: args.roleArn ?? null,
      externalId: args.externalId ?? null,
    },
  });
  return row(created);
}

export type UpdateProviderArgs = Partial<{
  name: string;
  region: string;
  roleArn: string;
  externalId: string;
}>;

export type UpdateProviderResult =
  | { ok: true; provider: CloudProviderRow }
  | { ok: false; code: "not_found" };

export async function updateProvider(
  userId: string,
  id: string,
  patch: UpdateProviderArgs,
): Promise<UpdateProviderResult> {
  const existing = await prisma.cloudProvider.findFirst({ where: { id, userId } });
  if (!existing) return { ok: false, code: "not_found" };
  const updated = await prisma.cloudProvider.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.region !== undefined && { region: patch.region }),
      ...(patch.roleArn !== undefined && { roleArn: patch.roleArn }),
      ...(patch.externalId !== undefined && { externalId: patch.externalId }),
    },
  });
  return { ok: true, provider: row(updated) };
}

export type DeleteProviderResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "in_use" };

/** Reject delete if any Env currently points at this provider. */
export async function deleteProvider(userId: string, id: string): Promise<DeleteProviderResult> {
  const existing = await prisma.cloudProvider.findFirst({ where: { id, userId } });
  if (!existing) return { ok: false, code: "not_found" };
  const inUse = await prisma.env.count({ where: { cloudProviderId: id } });
  if (inUse > 0) return { ok: false, code: "in_use" };
  await prisma.cloudProvider.delete({ where: { id } });
  return { ok: true };
}

/** Fetch a provider scoped to its owner (returns null if missing/not owned). */
export async function getProviderForUser(userId: string, id: string) {
  return prisma.cloudProvider.findFirst({ where: { id, userId } });
}

/**
 * Record (or clear) the Vault path where this provider's AWS keys live.
 * Pass null to mark the provider as having no stored long-lived keys.
 */
export async function setProviderCredVaultPath(
  userId: string,
  id: string,
  vaultPath: string | null,
): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
  const existing = await prisma.cloudProvider.findFirst({ where: { id, userId } });
  if (!existing) return { ok: false, code: "not_found" };
  await prisma.cloudProvider.update({
    where: { id },
    data: { credVaultPath: vaultPath },
  });
  return { ok: true };
}
