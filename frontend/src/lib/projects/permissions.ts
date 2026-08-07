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
import { headers } from "next/headers";
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
  | { ok: true; access: ProjectAccess }
  | { ok: false; status: 401 | 403 | 404; code?: "not_a_browser" };

/**
 * Server-side authorization gate for project routes.
 *
 * BROWSER-ONLY BY DEFAULT. Reads `Sec-Fetch-Site` from the ambient request via
 * next/headers — Next.js already gives us the current request's headers there,
 * so this covers all 188 project-gated API routes without touching any call
 * site.
 *
 * WHY: without this, a session cookie stolen from a browser — or a URL copied
 * out of DevTools into curl — could POST to /rds-connect and write arbitrary
 * K8s Secrets with attacker-supplied passwords. The user reproduced that leak
 * in 2026-08. Sec-Fetch-Site is set by every real browser fetch and forbidden
 * to page scripts, so requiring `same-origin` is a precise filter that curl
 * cannot pass without explicit spoofing — and even then it's rejected unless
 * the value matches exactly. `curl -H 'Sec-Fetch-Site: same-origin'` would
 * bypass this check; that's a known limitation of any header-based control and
 * why sensitive UI actions ALSO get server-side CSRF (see the reveal token in
 * env-viewer). This layer catches the naive attack, which is the vast majority.
 *
 * SSR EXEMPTION: server components that call this gate use next/headers's
 * built-in cookie/header access and don't emit their own Sec-Fetch-Site header
 * to themselves. Detecting an SSR context is `!headerStore.get("host")` in
 * practice — but the gate is now called from API route handlers only (the
 * SSR page-guard is requireProjectPage in page-guards.ts, a separate path),
 * so this concern doesn't apply here.
 */
export async function requireProjectAccess(
  slug: string,
  minRole: ProjectRole = "viewer",
): Promise<GateResult> {
  const h = await headers();
  const site = h.get("sec-fetch-site");
  if (site !== "same-origin") {
    // Reject before any DB lookup — no info about the project should leak
    // to a caller we've already decided isn't allowed to be here.
    return { ok: false, status: 403, code: "not_a_browser" };
  }
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
