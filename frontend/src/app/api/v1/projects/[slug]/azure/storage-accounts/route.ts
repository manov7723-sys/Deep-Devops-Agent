import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";

/**
 * List Storage Accounts in this project's Azure subscription. When `?rg=<name>`
 * is provided, scopes the listing to that resource group — used by the tf-state
 * backend picker's cascading dropdowns (Resource Group → Storage Account →
 * Blob Container). Uses the project's stored Azure creds (SP or OAuth); no
 * host CLI. Returns `[]` if the provider isn't Azure or has no subscription id.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) return NextResponse.json({ ok: true, storageAccounts: [] });

  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json(
      { ok: false, error: `Couldn't authenticate to Azure: ${tok.error}` },
      { status: 502 },
    );
  }

  const url = new URL(req.url);
  const rg = url.searchParams.get("rg")?.trim();
  const listUrl = rg
    ? `https://management.azure.com/subscriptions/${cp.accountRef}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`
    : `https://management.azure.com/subscriptions/${cp.accountRef}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`;

  const res = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${tok.accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: `Azure returned ${res.status} listing storage accounts.` },
      { status: 502 },
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    value?: Array<{ name: string; location: string; id: string }>;
  };
  const storageAccounts = (data.value ?? []).map((s) => ({
    name: s.name,
    location: s.location,
    // Extract RG from the full resource id: /subscriptions/x/resourceGroups/foo/...
    resourceGroup: s.id.split("/resourceGroups/")[1]?.split("/")[0] ?? "",
  }));
  return NextResponse.json({ ok: true, storageAccounts });
}
