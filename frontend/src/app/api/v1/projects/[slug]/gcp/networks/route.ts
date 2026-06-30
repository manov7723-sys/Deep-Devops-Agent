import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { listGcpNetworks, listGcpSubnetworks } from "@/lib/cloud/gcp-oauth";

/**
 * GET /projects/[slug]/gcp/networks?project=<gcpProjectId>&region=<location>
 *
 * Lists the VPC networks (and the chosen region's subnetworks) in the given GCP
 * project, so the GKE wizard can offer them as dropdowns ("reuse existing
 * network") instead of asking the user to type names. Uses the connected GCP
 * account's delegated token — the same source as /gcp/context. The client
 * filters subnetworks by the selected network.
 */

/** A GKE location can be a region (us-central1) or a zone (us-central1-a). */
function toRegion(location: string): string {
  const m = location.trim().match(/^([a-z]+-[a-z]+\d+)-[a-z]$/);
  return m ? m[1] : location.trim();
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim();
  const region = toRegion(url.searchParams.get("region") ?? "");
  if (!project) {
    return NextResponse.json({ ok: true, connected: false, networks: [], subnetworks: [], note: "Pick a GCP project first." });
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "gcp" },
    select: { id: true },
  });
  if (!cp) {
    return NextResponse.json({ ok: true, connected: false, networks: [], subnetworks: [], note: "No GCP provider on this project." });
  }

  const tok = await getGcpAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json({ ok: true, connected: false, networks: [], subnetworks: [], note: tok.error });
  }

  const netRes = await listGcpNetworks(tok.accessToken, project);
  if (!netRes.ok) {
    return NextResponse.json({ ok: true, connected: true, networks: [], subnetworks: [], note: netRes.error });
  }
  const subRes = region ? await listGcpSubnetworks(tok.accessToken, project, region) : null;

  return NextResponse.json({
    ok: true,
    connected: true,
    region,
    networks: netRes.networks,
    subnetworks: subRes?.ok ? subRes.subnetworks : [],
    note: subRes && !subRes.ok ? subRes.error : undefined,
  });
}
