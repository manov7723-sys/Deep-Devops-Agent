import { NextResponse } from "next/server";
import type { ResourceCategory } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

const CATEGORIES: ResourceCategory[] = ["compute", "network", "storage", "data"];

/**
 * GET /projects/[slug]/cloud?cat=compute&env=alpha|all
 *
 * Lists ManagedResource rows for the project filtered by category and
 * optionally by env. The badges + policy hint come from the resource's
 * free-form `attributes` JSON column.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const sp = new URL(req.url).searchParams;
  const cat = sp.get("cat") as ResourceCategory | null;
  const envFilter = sp.get("env") ?? "all";
  if (!cat || !CATEGORIES.includes(cat)) {
    return NextResponse.json({ ok: false, code: "bad_category" }, { status: 400 });
  }

  const projectId = gate.access.project.id;
  let envIdFilter: string | undefined;
  if (envFilter !== "all") {
    const env = await prisma.env.findFirst({
      where: { projectId, key: envFilter },
      select: { id: true },
    });
    if (!env) return NextResponse.json([]);
    envIdFilter = env.id;
  }

  const rows = await prisma.managedResource.findMany({
    where: { projectId, category: cat, ...(envIdFilter ? { envId: envIdFilter } : {}) },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { env: { select: { key: true } } },
    take: 100,
  });

  const items = rows.map((r) => {
    const attrs = (r.attributes ?? {}) as Record<string, unknown>;
    const badges = Array.isArray(attrs.badges) ? (attrs.badges as string[]).slice(0, 2) : [];
    const policy = typeof attrs.policy === "string" ? attrs.policy : undefined;
    return {
      id: r.id,
      category: r.category,
      name: r.name,
      type: r.type,
      region: r.region ?? "",
      env: r.env.key,
      status: r.status,
      badges: badges as [string, string] | string[],
      cpu: r.cpuPct ?? undefined,
      mem: r.memPct ?? undefined,
      policy,
    };
  });
  return NextResponse.json(items);
}
