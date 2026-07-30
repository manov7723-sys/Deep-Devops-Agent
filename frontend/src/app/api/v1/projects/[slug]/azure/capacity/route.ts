import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import {
  listAksSupportedVersions,
  listVmSkusInLocation,
} from "@/lib/cloud/azure-arm";
import { AKS_VM_SIZES, AKS_K8S_VERSIONS } from "@/lib/devops/aks";

/**
 * GET /projects/[slug]/azure/capacity?location=<region>
 *
 * Live-per-region wizard source. Given the region a user just picked, ask
 * ARM what THIS subscription can actually do there and return only that
 * subset. The AKS chat wizard binds its VM-size and K8s-version pickers to
 * this response so the user is only ever offered a choice the apply will
 * accept.
 *
 * WHY THIS EXISTS (2026-07):
 * A user's picker showed generic AKS defaults regardless of what their
 * subscription could actually provision. Trial subs in eastus can't create
 * B-series clusters, PAYG subs may or may not have zones on a given SKU, and
 * every one of those mismatches surfaces as a red 400 30-45s into a
 * terraform apply. Filtering the wizard at the source (instead of
 * auto-substituting on submit) means the user picks a value that WILL work,
 * with the reasoning visible: they see the shortened list rather than a
 * silent swap.
 *
 * Cheap-list philosophy: we don't return every SKU ARM knows about, only
 * the intersection of {app's curated small-tier list} and {what ARM
 * confirms exists here}. Curated list ships known-AKS-supported SKUs; ARM
 * confirms per-region quota. Both must agree.
 *
 * Falls back to the curated static lists on ARM failure or missing Azure
 * connection — the wizard still works, it just can't filter.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const location = url.searchParams.get("location")?.trim() || "";

  const fallback = {
    ok: true as const,
    location,
    source: "static" as const,
    vmSizes: AKS_VM_SIZES,
    kubernetesVersions: AKS_K8S_VERSIONS,
    note: undefined as string | undefined,
  };

  if (!location) return NextResponse.json(fallback);

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) {
    return NextResponse.json({
      ...fallback,
      note: "Azure isn't connected on this project — using built-in lists. Connect a subscription for live filtering.",
    });
  }
  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json({ ...fallback, note: `Azure token failed: ${tok.error}` });
  }

  // Two independent ARM calls; one failing doesn't invalidate the other.
  const [skus, versions] = await Promise.all([
    listVmSkusInLocation(tok.accessToken, cp.accountRef, location),
    listAksSupportedVersions(tok.accessToken, cp.accountRef, location),
  ]);

  let vmSizes: string[] = AKS_VM_SIZES;
  const notes: string[] = [];
  if (skus.ok) {
    const availableLower = new Set(skus.skus.map((s) => s.toLowerCase()));
    vmSizes = AKS_VM_SIZES.filter((s) => availableLower.has(s.toLowerCase()));
    if (vmSizes.length === 0) {
      // Nothing from the curated list is available — surface the top few
      // ARM-listed small D-series as a courtesy so the wizard isn't empty.
      const fallbackSmall = skus.skus
        .filter((s) => /^Standard_D[24]s?_v[35]$/i.test(s) || /^Standard_DS[24]_v2$/i.test(s))
        .slice(0, 6);
      vmSizes = fallbackSmall.length > 0 ? fallbackSmall : skus.skus.slice(0, 6);
      notes.push(
        `None of the curated AKS-friendly SKUs (${AKS_VM_SIZES.join(", ")}) are available in ${location} for this subscription. Showing the closest small D-series ARM offers.`,
      );
    }
  } else {
    notes.push(`SKU lookup failed: ${skus.error}. Falling back to the built-in list.`);
  }

  let kubernetesVersions: string[] = AKS_K8S_VERSIONS;
  if (versions.ok && versions.versions.length > 0) {
    kubernetesVersions = versions.versions.filter((v) => !v.isPreview).map((v) => v.version);
  } else if (!versions.ok) {
    notes.push(`Version lookup failed: ${versions.error}. Falling back to the built-in list.`);
  }

  return NextResponse.json({
    ok: true,
    location,
    source: skus.ok && versions.ok ? "live" : "mixed",
    vmSizes,
    kubernetesVersions,
    note: notes.length ? notes.join(" ") : undefined,
  });
}
