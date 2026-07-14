import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { listAzureResourceGroups, listAzureVnets } from "@/lib/cloud/azure-arm";

/**
 * GET /projects/[slug]/azure/networks
 *
 * Lists the connected subscription's resource groups and virtual networks (with
 * their subnets) so the AKS wizard can offer them as dropdowns. App-managed:
 * uses the Azure service-principal token stored on the CloudProvider + the ARM
 * REST API — NO local `az` CLI, no host login (works behind a mobile client).
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
    return NextResponse.json({
      ok: true,
      connected: false,
      resourceGroups: [],
      vnets: [],
      note: "Connect an Azure subscription on the Cloud providers page first.",
    });
  }

  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json({
      ok: true,
      connected: false,
      resourceGroups: [],
      vnets: [],
      note: tok.error,
    });
  }

  const groups = await listAzureResourceGroups(tok.accessToken, cp.accountRef);
  if (!groups.ok) {
    return NextResponse.json({
      ok: true,
      connected: true,
      resourceGroups: [],
      vnets: [],
      note: groups.error,
    });
  }
  const vnets = await listAzureVnets(tok.accessToken, cp.accountRef);

  return NextResponse.json({
    ok: true,
    connected: true,
    resourceGroups: groups.resourceGroups,
    vnets: vnets.ok ? vnets.vnets : [],
    note: vnets.ok ? undefined : vnets.error,
  });
}
