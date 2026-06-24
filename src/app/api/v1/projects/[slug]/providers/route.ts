import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/providers?env=alpha|all
 *
 * Returns one row per CloudProvider attached to any environment in this
 * project. `services` is the count of ManagedResource rows on that provider
 * inside the project; `envs` lists the env keys it backs.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });
  const projectId = gate.access.project.id;

  const envFilter = new URL(req.url).searchParams.get("env") ?? "all";

  // Pull every env on the project (so we can list/filter by key) and the
  // provider linked to each one.
  const envs = await prisma.env.findMany({
    where: { projectId },
    select: { id: true, key: true, cloudProviderId: true },
  });

  // Group envs by providerId so we can list which envs each provider backs.
  const envsByProvider = new Map<string, string[]>();
  for (const e of envs) {
    if (!e.cloudProviderId) continue;
    const arr = envsByProvider.get(e.cloudProviderId) ?? [];
    arr.push(e.key);
    envsByProvider.set(e.cloudProviderId, arr);
  }

  // ISOLATION: list the providers that BELONG to this project (not just those
  // bound to an env). The env filter narrows to providers backing a given env.
  const projectProviders = await prisma.cloudProvider.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      kind: true,
      name: true,
      accountRef: true,
      region: true,
      status: true,
      credVaultPath: true,
    },
  });
  const providers =
    envFilter === "all"
      ? projectProviders
      : projectProviders.filter((p) => (envsByProvider.get(p.id) ?? []).includes(envFilter));
  if (providers.length === 0) return NextResponse.json([]);
  const providerIds = providers.map((p) => p.id);

  // Count ManagedResources per provider on this project (so the card
  // shows accurate "N services").
  const resourceCounts = await prisma.managedResource.groupBy({
    by: ["cloudProviderId"],
    where: { projectId, cloudProviderId: { in: providerIds } },
    _count: { _all: true },
  });
  const countByProvider = new Map(
    resourceCounts.map((r) => [r.cloudProviderId ?? "", r._count._all]),
  );

  const items = providers.map((p) => ({
    id: p.kind, // legacy: card uses kind ("aws", "gcp", …) as visual id
    providerId: p.id,
    kind: p.kind,
    name: p.name,
    account: p.accountRef,
    region: p.region,
    status: p.status,
    // True when AWS access key + secret are stored in Vault for this provider.
    hasVaultCreds: !!p.credVaultPath,
    envs: envsByProvider.get(p.id) ?? [],
    services: countByProvider.get(p.id) ?? 0,
    spend: "—", // monthly spend joins CostByService — left as placeholder
  }));
  items.sort((a, b) => b.services - a.services);
  return NextResponse.json(items);
}
