import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";

/**
 * List blob containers inside a storage account. Requires `?rg=<name>` because
 * ARM's container list endpoint is scoped by resource group. Used by the tf-
 * state backend picker's cascading dropdowns.
 * Filters out Azure's reserved system containers ($logs, $blobchangefeed) since
 * they reject Terraform state writes.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; sa: string }> },
) {
  const { slug, sa } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const rg = url.searchParams.get("rg")?.trim();
  if (!rg) {
    return NextResponse.json(
      { ok: false, error: "Missing ?rg= query parameter." },
      { status: 400 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) return NextResponse.json({ ok: true, containers: [] });

  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json(
      { ok: false, error: `Couldn't authenticate to Azure: ${tok.error}` },
      { status: 502 },
    );
  }

  const listUrl =
    `https://management.azure.com/subscriptions/${cp.accountRef}` +
    `/resourceGroups/${encodeURIComponent(rg)}` +
    `/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(sa)}` +
    `/blobServices/default/containers?api-version=2023-01-01`;
  const res = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${tok.accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: `Azure returned ${res.status} listing containers.` },
      { status: 502 },
    );
  }
  const data = (await res.json().catch(() => ({}))) as { value?: Array<{ name: string }> };
  const containers = (data.value ?? [])
    .map((c) => c.name)
    // Reserved system containers can't hold Terraform state (they 403 on write).
    .filter((n) => !n.startsWith("$"));
  return NextResponse.json({ ok: true, containers });
}
