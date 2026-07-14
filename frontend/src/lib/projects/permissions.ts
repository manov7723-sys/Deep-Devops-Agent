/**
 * Server-side authorization gate for project routes.
 *
 * Role rank: owner > developer > viewer. Endpoints declare the minimum role
 * required; non-members get 404 (per DECISIONS.md: "do not disclose").
 *
 * Permission matrix (from DECISIONS.md):
 *   view              → any role
 *   manage            → owner | developer
 *   transfer / delete → owner only
 */
import type { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession, type LoadedSession } from "@/lib/auth/session";

const RANK: Record<ProjectRole, number> = { owner: 3, developer: 2, viewer: 1 };

export type ProjectAccess = {
  session: LoadedSession;
  project: {
    id: string;
    slug: string;
    name: string;
    description: string;
    colorHue: number;
    health: "ok" | "warn" | "danger";
    cloud: string | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    ownerId: string;
  };
  role: ProjectRole;
};

export type GateResult =
  { ok: true; access: ProjectAccess } | { ok: false; status: 401 | 403 | 404 };

export async function requireProjectAccess(
  slug: string,
  minRole: ProjectRole = "viewer",
): Promise<GateResult> {
  const session = await getActiveSession();
  if (!session) return { ok: false, status: 401 };

  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      colorHue: true,
      health: true,
      cloud: true,
      archivedAt: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      ownerId: true,
    },
  });
  if (!project || project.deletedAt) return { ok: false, status: 404 };

  const membership = await prisma.membership.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: session.userId } },
    select: { role: true },
  });
  // Non-members get 404 — the route surface must not differentiate
  // "no such project" from "you can't see this one".
  if (!membership) return { ok: false, status: 404 };

  if (RANK[membership.role] < RANK[minRole]) {
    return { ok: false, status: 403 };
  }

  return {
    ok: true,
    access: {
      session,
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: project.description,
        colorHue: project.colorHue,
        health: project.health,
        cloud: project.cloud,
        archivedAt: project.archivedAt,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        ownerId: project.ownerId,
      },
      role: membership.role,
    },
  };
}
