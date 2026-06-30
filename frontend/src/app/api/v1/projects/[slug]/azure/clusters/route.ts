import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { listAksClusters } from "@/lib/cloud/azure-arm";

/**
 * GET /projects/[slug]/azure/clusters
 *
 * Lists the connected subscription's AKS clusters (name + resource group +
 * location) so the Clusters page can offer "pick a resource group → pick a
 * cluster" dropdowns. App-managed: stored Azure token + ARM REST, no `az`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) {
    return NextResponse.json({ ok: true, connected: false, clusters: [], note: "Connect an Azure subscription on the Cloud providers page first." });
  }

  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json({ ok: true, connected: false, clusters: [], note: tok.error });
  }

  const res = await listAksClusters(tok.accessToken, cp.accountRef);
  if (!res.ok) {
    return NextResponse.json({ ok: true, connected: true, clusters: [], note: res.error });
  }
  return NextResponse.json({ ok: true, connected: true, clusters: res.clusters });
}
