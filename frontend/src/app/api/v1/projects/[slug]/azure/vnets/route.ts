import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { azureContext, armGet } from "@/lib/agent/tools/azure-helpers";

/**
 * GET /projects/[slug]/azure/vnets?location=<region>
 *
 * Lists Azure Virtual Networks (and their subnets) in the project's connected
 * Azure subscription — same pattern as /aws/vpcs powers the AWS peering/EC2
 * pickers. Powers the Azure VM wizard's VNet + subnet dropdowns.
 *
 * Filters by `location` when given (case-insensitive), since the Azure VM
 * launcher needs to enforce "VNet must be in the VM's region."
 */
type AzureVnet = {
  name: string;
  location: string;
  resourceGroup: string;
  addressSpace: string[];
  subnets: Array<{ name: string; addressPrefix: string }>;
};

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const azure = await azureContext(gate.access.project.id);
  if (!azure.ok) {
    return NextResponse.json({ ok: true, connected: false, vnets: [] as AzureVnet[], note: azure.error });
  }

  const url = new URL(req.url);
  const locationFilter = url.searchParams.get("location")?.trim().toLowerCase() ?? null;

  const path = `/subscriptions/${azure.ctx.subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-11-01`;
  const res = await armGet(azure.ctx.accessToken, path);
  if (!res.ok) {
    return NextResponse.json({ ok: true, connected: true, vnets: [], note: res.error });
  }

  const data = res.data as {
    value?: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        addressSpace?: { addressPrefixes?: string[] };
        subnets?: Array<{ name: string; properties?: { addressPrefix?: string } }>;
      };
    }>;
  };

  const all: AzureVnet[] = (data.value ?? []).map((v) => ({
    name: v.name,
    location: (v.location ?? "").toLowerCase(),
    resourceGroup: v.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "",
    addressSpace: v.properties?.addressSpace?.addressPrefixes ?? [],
    subnets: (v.properties?.subnets ?? []).map((s) => ({
      name: s.name,
      addressPrefix: s.properties?.addressPrefix ?? "",
    })),
  }));

  const vnets = locationFilter ? all.filter((v) => v.location === locationFilter) : all;
  return NextResponse.json({ ok: true, connected: true, location: locationFilter, vnets });
}
