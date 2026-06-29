/**
 * Per-project Integration connectors (credential auth type).
 *
 * The oauth auth type is reserved for the OAuth phase; this module only
 * handles credential-mode wiring (api keys, webhook URLs, role arns).
 * Each IntegrationCredential.valueRef is AES-256-GCM ciphertext via the
 * shared crypto helper — never the plaintext value.
 */
import type { IntegrationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";

/**
 * Look up an integration by provider for a project and return its decrypted
 * credentials as a `{key: value}` map plus the integration metadata. Returns
 * `null` when no integration is connected for that provider.
 *
 * Used by the observability + alerts code paths to reach upstream Grafana,
 * Prometheus, PagerDuty, etc. via the credentials the project owner stored.
 */
export async function getIntegrationCredentials(
  projectId: string,
  provider: string,
): Promise<{
  integration: { id: string; name: string; status: IntegrationStatus };
  credentials: Record<string, string>;
} | null> {
  const integration = await prisma.integration.findFirst({
    where: { projectId, provider },
    include: {
      credentials: { select: { key: true, valueRef: true, isSecret: true } },
    },
  });
  if (!integration) return null;
  // `valueRef` is always AES-GCM ciphertext (see `createIntegration` — non-
  // secret values are encrypted at rest too, so isSecret is a UI hint only).
  const out: Record<string, string> = {};
  for (const c of integration.credentials) {
    try {
      out[c.key] = decryptSecret(c.valueRef);
    } catch {
      // Skip a credential that can't be decrypted (wrong key domain / rotated).
    }
  }
  return {
    integration: { id: integration.id, name: integration.name, status: integration.status },
    credentials: out,
  };
}

export type IntegrationRow = {
  id: string;
  provider: string;
  name: string;
  icon: string;
  description: string;
  authType: "oauth" | "credential";
  status: IntegrationStatus;
  connectedByName: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  credentialKeys: Array<{ key: string; isSecret: boolean }>;
};

export async function listIntegrationsForProject(projectId: string): Promise<IntegrationRow[]> {
  const rows = await prisma.integration.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      connectedBy: { select: { name: true } },
      credentials: { select: { key: true, isSecret: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    name: r.name,
    icon: r.icon,
    description: r.description,
    authType: r.authType,
    status: r.status,
    connectedByName: r.connectedBy?.name ?? null,
    connectedAt: r.connectedAt?.toISOString() ?? null,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    credentialKeys: r.credentials.map((c) => ({ key: c.key, isSecret: c.isSecret })),
  }));
}

export type CreateIntegrationArgs = {
  projectId: string;
  connectedById: string;
  provider: string;
  name: string;
  icon: string;
  description: string;
  credentials: Array<{ key: string; value: string; isSecret?: boolean }>;
};

export type CreateIntegrationResult =
  | { ok: true; id: string }
  | { ok: false; code: "duplicate_provider" };

export async function createIntegration(args: CreateIntegrationArgs): Promise<CreateIntegrationResult> {
  const existing = await prisma.integration.findUnique({
    where: { projectId_provider: { projectId: args.projectId, provider: args.provider } },
    select: { id: true },
  });
  if (existing) return { ok: false, code: "duplicate_provider" };

  const created = await prisma.integration.create({
    data: {
      projectId: args.projectId,
      provider: args.provider,
      name: args.name,
      icon: args.icon,
      description: args.description,
      authType: "credential",
      status: "connected",
      connectedById: args.connectedById,
      connectedAt: new Date(),
      credentials: {
        create: args.credentials.map((c) => ({
          key: c.key,
          valueRef: encryptSecret(c.value),
          isSecret: c.isSecret ?? true,
        })),
      },
    },
    select: { id: true },
  });
  return { ok: true, id: created.id };
}

export type UpdateIntegrationArgs = Partial<{
  name: string;
  description: string;
  status: IntegrationStatus;
  credentials: Array<{ key: string; value: string; isSecret?: boolean }>;
}>;

export type UpdateIntegrationResult =
  | { ok: true }
  | { ok: false; code: "not_found" };

/**
 * Updates name/status atomically. If credentials are present, those keys
 * are upserted (existing rows for those keys are replaced with new ciphertext).
 * Keys not present in the payload are LEFT ALONE.
 */
export async function updateIntegration(
  projectId: string,
  id: string,
  patch: UpdateIntegrationArgs,
): Promise<UpdateIntegrationResult> {
  const existing = await prisma.integration.findFirst({ where: { id, projectId }, select: { id: true } });
  if (!existing) return { ok: false, code: "not_found" };

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const data: Prisma.IntegrationUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.status !== undefined) {
    data.status = patch.status;
    if (patch.status === "connected") data.lastSyncedAt = new Date();
  }
  if (Object.keys(data).length > 0) {
    ops.push(prisma.integration.update({ where: { id }, data }));
  }

  if (patch.credentials) {
    for (const c of patch.credentials) {
      ops.push(
        prisma.integrationCredential.upsert({
          where: { integrationId_key: { integrationId: id, key: c.key } },
          create: {
            integrationId: id,
            key: c.key,
            valueRef: encryptSecret(c.value),
            isSecret: c.isSecret ?? true,
          },
          update: {
            valueRef: encryptSecret(c.value),
            isSecret: c.isSecret ?? true,
          },
        }),
      );
    }
  }

  if (ops.length > 0) await prisma.$transaction(ops);
  return { ok: true };
}

export type DeleteIntegrationResult =
  | { ok: true }
  | { ok: false; code: "not_found" };

export async function deleteIntegration(
  projectId: string,
  id: string,
): Promise<DeleteIntegrationResult> {
  const existing = await prisma.integration.findFirst({ where: { id, projectId } });
  if (!existing) return { ok: false, code: "not_found" };
  // Cascade deletes IntegrationCredential rows (onDelete: Cascade on the FK).
  await prisma.integration.delete({ where: { id } });
  return { ok: true };
}
