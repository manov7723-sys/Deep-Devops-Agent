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
 * Authorization gate for project API ROUTE HANDLERS.
 *
 * Also enforces browser-only access: reads `Sec-Fetch-Site` via next/headers
 * and rejects anything that isn't a same-origin fetch. That covers all 188
 * project-gated API routes without touching a call site.
 *
 * WHY: without it, a session cookie lifted from a browser — or a URL copied
 * out of DevTools into curl — could POST to /rds-connect and write arbitrary
 * K8s Secrets with attacker-supplied passwords. Reproduced in 2026-08.
 * Sec-Fetch-Site is set by every real browser fetch and is a forbidden header
 * for page scripts, so requiring `same-origin` is a precise filter curl can't
 * pass without deliberate spoofing. `curl -H 'Sec-Fetch-Site: same-origin'`
 * DOES bypass it — a known limit of any header-based control, and why the
 * credential-returning path (env-viewer) additionally requires a memory-only
 * reveal token. This layer stops the naive copy-a-URL attack, which is the
 * one users actually reproduce.
 *
 * DO NOT call this from a server component. Page renders are navigations, not
 * fetches: an address-bar hit sends `Sec-Fetch-Site: none`, which this
 * rejects. An earlier version of this comment claimed the SSR guard was "a
 * separate path" — it is not; requireProjectPage calls straight into here, so
 * adding the check 404'd every /p/[projectSlug]/* page. Server components must
 * use requireProjectPageAccess below.
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
  return requireProjectPageAccess(slug, minRole);
}

/**
 * The same authorization checks WITHOUT the browser-only gate — for server
 * components rendering /p/[projectSlug]/* pages.
 *
 * A page render is a navigation, not a fetch. Typing the URL or opening it in
 * a new tab sends `Sec-Fetch-Site: none`, and requiring `same-origin` there
 * turns every direct page load into a 404. The browser check belongs on API
 * routes, which are what a copied URL actually targets; a page render can only
 * happen in a browser by definition.
 *
 * Session + membership + role are still enforced here — this exempts ONLY the
 * transport check.
 */
export async function requireProjectPageAccess(
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
