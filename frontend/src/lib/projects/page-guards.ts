import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import type { ProjectRole } from "@prisma/client";
import { requireProjectAccess, type ProjectAccess } from "./permissions";

/**
 * Server-side gate used by every /p/[projectSlug]/* page. Mirrors the
 * route-handler gate (`requireProjectAccess`) and converts its result
 * to the right Next.js navigation primitive:
 *   401 → redirect to /auth/login?next=<current path>
 *   403 → notFound() (the project exists but the user can't see it;
 *         per DECISIONS.md, the surface must not differentiate)
 *   404 → notFound()
 */
export async function requireProjectPage(
  slug: string,
  nextPath: string,
  minRole: ProjectRole = "viewer",
): Promise<ProjectAccess> {
  const gate = await requireProjectAccess(slug, minRole);
  if (!gate.ok) {
    if (gate.status === 401) {
      redirect(`/auth/login?next=${encodeURIComponent(nextPath)}` as Route);
    }
    notFound();
  }
  return gate.access;
}
