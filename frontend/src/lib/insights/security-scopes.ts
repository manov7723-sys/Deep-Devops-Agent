/**
 * Cloud security scopes (SG / IAM role / KMS key / secret store / network policy)
 * and their bindings to specific environments.
 *
 * A scope belongs to a CloudProvider (and therefore to a User). Binding ties
 * the scope to a project Env, gated by project membership.
 */
import type { CloudSecurityScope, EnvSecurityBinding, SecurityScopeKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type ScopeRow = {
  id: string;
  cloudProviderId: string;
  cloudProviderName: string;
  kind: SecurityScopeKind;
  name: string;
  ref: string | null;
  createdAt: string;
};

function scopeRow(s: CloudSecurityScope & { cloudProvider: { name: string } }): ScopeRow {
  return {
    id: s.id,
    cloudProviderId: s.cloudProviderId,
    cloudProviderName: s.cloudProvider.name,
    kind: s.kind,
    name: s.name,
    ref: s.ref,
    createdAt: s.createdAt.toISOString(),
  };
}

export async function listScopesForProvider(
  userId: string,
  providerId: string,
): Promise<ScopeRow[] | null> {
  const prov = await prisma.cloudProvider.findFirst({
    where: { id: providerId, userId },
    select: { id: true },
  });
  if (!prov) return null;
  const rows = await prisma.cloudSecurityScope.findMany({
    where: { cloudProviderId: providerId },
    orderBy: { createdAt: "desc" },
    include: { cloudProvider: { select: { name: true } } },
  });
  return rows.map(scopeRow);
}

export type CreateScopeArgs = {
  userId: string;
  cloudProviderId: string;
  kind: SecurityScopeKind;
  name: string;
  ref?: string;
};

export type CreateScopeResult =
  | { ok: true; scope: ScopeRow }
  | { ok: false; code: "provider_not_found" };

export async function createScope(args: CreateScopeArgs): Promise<CreateScopeResult> {
  const prov = await prisma.cloudProvider.findFirst({
    where: { id: args.cloudProviderId, userId: args.userId },
    select: { id: true },
  });
  if (!prov) return { ok: false, code: "provider_not_found" };

  const created = await prisma.cloudSecurityScope.create({
    data: {
      cloudProviderId: args.cloudProviderId,
      kind: args.kind,
      name: args.name,
      ref: args.ref ?? null,
    },
    include: { cloudProvider: { select: { name: true } } },
  });
  return { ok: true, scope: scopeRow(created) };
}

export async function deleteScope(userId: string, scopeId: string): Promise<boolean> {
  // Ownership goes Provider → User; verify before delete.
  const scope = await prisma.cloudSecurityScope.findFirst({
    where: { id: scopeId, cloudProvider: { userId } },
    select: { id: true },
  });
  if (!scope) return false;
  await prisma.cloudSecurityScope.delete({ where: { id: scopeId } });
  return true;
}

// ──────────────────────────────────────────────────────────────────
// Env bindings
// ──────────────────────────────────────────────────────────────────

export type BindingRow = {
  bindingId: string;
  envKey: string;
  scopeId: string;
  scopeName: string;
  scopeKind: SecurityScopeKind;
};

function bindingRow(
  b: EnvSecurityBinding & {
    env: { key: string };
    scope: { name: string; kind: SecurityScopeKind };
  },
): BindingRow {
  return {
    bindingId: b.id,
    envKey: b.env.key,
    scopeId: b.scopeId,
    scopeName: b.scope.name,
    scopeKind: b.scope.kind,
  };
}

export async function listBindingsForProject(projectId: string): Promise<BindingRow[]> {
  const rows = await prisma.envSecurityBinding.findMany({
    where: { env: { projectId } },
    orderBy: { createdAt: "desc" },
    include: {
      env: { select: { key: true } },
      scope: { select: { name: true, kind: true } },
    },
  });
  return rows.map(bindingRow);
}

export type BindResult =
  | { ok: true; binding: BindingRow }
  | { ok: false; code: "scope_not_found" | "already_bound" };

/**
 * The scope must belong to the project owner (so all project members can
 * reference it). Idempotent via the (envId, scopeId) unique constraint.
 */
export async function bindScopeToEnv(
  projectOwnerId: string,
  envId: string,
  scopeId: string,
): Promise<BindResult> {
  const scope = await prisma.cloudSecurityScope.findFirst({
    where: { id: scopeId, cloudProvider: { userId: projectOwnerId } },
    select: { id: true },
  });
  if (!scope) return { ok: false, code: "scope_not_found" };

  try {
    const created = await prisma.envSecurityBinding.create({
      data: { envId, scopeId },
      include: {
        env: { select: { key: true } },
        scope: { select: { name: true, kind: true } },
      },
    });
    return { ok: true, binding: bindingRow(created) };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return { ok: false, code: "already_bound" };
    }
    throw err;
  }
}

export async function unbindScopeFromEnv(envId: string, scopeId: string): Promise<boolean> {
  const { count } = await prisma.envSecurityBinding.deleteMany({ where: { envId, scopeId } });
  return count > 0;
}
