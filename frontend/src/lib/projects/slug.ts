/**
 * Slugify a project name and resolve collisions deterministically:
 * "Northwind API" -> "northwind-api", or "northwind-api-2" if taken.
 */
import { prisma } from "@/lib/db/prisma";

const MAX_SLUG_LEN = 60;

export function baseSlug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, MAX_SLUG_LEN) || "project";
}

export async function generateUniqueSlug(name: string): Promise<string> {
  const base = baseSlug(name);
  // Fast-path: try the base slug first.
  const existing = await prisma.project.findUnique({
    where: { slug: base },
    select: { id: true },
  });
  if (!existing) return base;

  // Pull all conflicting slugs in one query, find the lowest free suffix.
  const conflicts = await prisma.project.findMany({
    where: { slug: { startsWith: `${base}-` } },
    select: { slug: true },
  });
  const used = new Set<string>([base, ...conflicts.map((c) => c.slug)]);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("slug_exhausted");
}
