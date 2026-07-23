import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";

/**
 * GET /projects/[slug]/azure/vm-sizes?location=<region>
 *
 * Live-query the user's Azure subscription to figure out which VM sizes they
 * can ACTUALLY provision in the picked region. Answers "why can't I create a
 * B1s?" definitively — cross-references two ARM APIs:
 *
 *   1. resourceSkus                   — is this SKU available in the region,
 *                                        or capacity-restricted?
 *   2. locations/{loc}/usages         — does the user have vCPU quota in the
 *                                        SKU's family?
 *
 * Returns:
 *   available:   Array<{ vmSize, family, vCPUs, memoryGB, monthlyCostEstimate }>
 *   unavailable: Array<{ vmSize, family, reason: "no_quota" | "region_restricted" | "not_in_region" }>
 *
 * The wizard's size dropdown reads this so users can't pick a size they'll
 * hit a 409 on. Cached ~5min in-memory because Azure quotas rarely change
 * within a session.
 */

// Curated shortlist — only lightweight VM sizes suitable for OpenVPN. No
// point showing 32-vCPU machines when even 1 vCPU is overkill for OpenVPN.
// Each entry lists the family key ARM returns in the usages API so we can
// look up quota by family. Costs are approximate ($/mo, on-demand, US regions).
// `reliability` is a heuristic — higher = more likely to actually deploy.
// Azure's resourceSkus API reports subscription/quota restrictions but does
// NOT surface real-time datacenter capacity, so a SKU can show "available"
// and still 409 at create-time with "SkuNotAvailable". B-series is chronically
// capacity-constrained in busy regions (eastus, centralus). D-series is
// almost always deployable. We use reliability as a tiebreaker so the
// recommender never picks a chronically-flaky B-series over a rock-solid
// D-series when both fit the user's quota.
const CANDIDATE_SIZES: Array<{
  vmSize: string;
  family: string; // Matches "name.value" from the usages API
  vCPUs: number;
  memoryGB: number;
  monthlyCost: number;
  reliability: number; // 0..10, higher = more likely to actually deploy
  notes?: string;
}> = [
  // B-series v1 (cheapest, but chronically capacity-constrained)
  { vmSize: "Standard_B1s",   family: "standardBSFamily",     vCPUs: 1, memoryGB: 1,  monthlyCost: 8,   reliability: 3, notes: "cheapest, often capacity-constrained" },
  { vmSize: "Standard_B1ms",  family: "standardBSFamily",     vCPUs: 1, memoryGB: 2,  monthlyCost: 15,  reliability: 4 },
  { vmSize: "Standard_B2s",   family: "standardBSFamily",     vCPUs: 2, memoryGB: 4,  monthlyCost: 30,  reliability: 5 },
  { vmSize: "Standard_B2ms",  family: "standardBSFamily",     vCPUs: 2, memoryGB: 8,  monthlyCost: 60,  reliability: 5 },
  // B-series v2 (also capacity-constrained; often 0-quota by default)
  { vmSize: "Standard_B2ats_v2", family: "standardBasv2Family", vCPUs: 2, memoryGB: 1, monthlyCost: 15, reliability: 4 },
  { vmSize: "Standard_B2als_v2", family: "standardBasv2Family", vCPUs: 2, memoryGB: 4, monthlyCost: 30, reliability: 4 },
  // D-series v3/v5 (nearly always deployable — recommender's sweet spot)
  { vmSize: "Standard_D2s_v3",   family: "standardDSv3Family",   vCPUs: 2, memoryGB: 8, monthlyCost: 70, reliability: 9, notes: "reliable, widely available" },
  { vmSize: "Standard_D2s_v5",   family: "standardDSv5Family",   vCPUs: 2, memoryGB: 8, monthlyCost: 70, reliability: 9 },
  { vmSize: "Standard_D2as_v5",  family: "standardDASv5Family",  vCPUs: 2, memoryGB: 8, monthlyCost: 65, reliability: 9 },
  { vmSize: "Standard_D2ads_v5", family: "standardDADSv5Family", vCPUs: 2, memoryGB: 8, monthlyCost: 85, reliability: 8 },
  // Older DS-series v2 (near-universal default quota, widest compat)
  { vmSize: "Standard_DS1_v2", family: "standardDSv2Family", vCPUs: 1, memoryGB: 3.5, monthlyCost: 50,  reliability: 10, notes: "widest compat, always available" },
  { vmSize: "Standard_DS2_v2", family: "standardDSv2Family", vCPUs: 2, memoryGB: 7,   monthlyCost: 100, reliability: 10 },
];

// Simple in-process cache keyed by "<subscriptionId>::<location>". Azure quotas
// don't change every second; refresh every 5 minutes is fine for a dropdown.
const CACHE = new Map<string, { at: number; payload: unknown }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

type SkuRestriction = {
  type?: string;
  values?: string[];
  reasonCode?: string;
};
type SkuItem = {
  name?: string;
  resourceType?: string;
  locations?: string[];
  restrictions?: SkuRestriction[];
};

type UsageItem = {
  currentValue?: number;
  limit?: number;
  name?: { value?: string; localizedValue?: string };
};

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const location = url.searchParams.get("location")?.trim();
  if (!location) {
    return NextResponse.json(
      { ok: false, code: "location_required", message: "location query param is required." },
      { status: 400 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp) {
    return NextResponse.json({ ok: true, available: [], unavailable: [], note: "No Azure provider on this project." });
  }
  const subscriptionId = cp.accountRef?.trim();
  if (!subscriptionId) {
    return NextResponse.json({ ok: true, available: [], unavailable: [], note: "Azure provider has no subscription id." });
  }

  const cacheKey = `${subscriptionId}::${location}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, ...(cached.payload as Record<string, unknown>), cached: true });
  }

  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) {
    return NextResponse.json({ ok: true, available: [], unavailable: [], note: `Azure auth: ${tok.error}` });
  }
  const token = tok.accessToken;

  // ── Fetch resourceSkus (SKUs available in the region + restrictions) ──
  // Filter server-side by location for a smaller payload.
  const skusUrl =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=` +
    encodeURIComponent(`location eq '${location}'`);
  let skusRes: Response;
  try {
    skusRes = await fetch(skusUrl, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "network_error", message: `Reaching Azure ARM: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
  if (!skusRes.ok) {
    const body = await skusRes.text().catch(() => "");
    return NextResponse.json({ ok: false, code: "skus_failed", message: `resourceSkus API returned ${skusRes.status}: ${body.slice(0, 300)}` }, { status: 502 });
  }
  const skusJson = (await skusRes.json().catch(() => ({}))) as { value?: SkuItem[] };
  const skus = skusJson.value ?? [];
  // Build a map: vmSize name → { available: bool, restrictionReason?: string }
  const skuStatus = new Map<string, { available: boolean; reason?: string }>();
  for (const s of skus) {
    if (s.resourceType !== "virtualMachines" || !s.name) continue;
    const restr = s.restrictions ?? [];
    if (restr.length === 0) {
      skuStatus.set(s.name, { available: true });
      continue;
    }
    // NotAvailableForSubscription = capacity-restricted for us specifically
    const reason = restr[0]?.reasonCode ?? "restricted";
    skuStatus.set(s.name, { available: false, reason });
  }

  // ── Fetch usages (quota per family in this region) ──
  const usagesUrl =
    `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/providers/Microsoft.Compute/locations/${encodeURIComponent(location)}/usages?api-version=2021-07-01`;
  let usagesRes: Response;
  try {
    usagesRes = await fetch(usagesUrl, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "network_error", message: `Reaching Azure ARM usages: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
  if (!usagesRes.ok) {
    const body = await usagesRes.text().catch(() => "");
    return NextResponse.json({ ok: false, code: "usages_failed", message: `usages API returned ${usagesRes.status}: ${body.slice(0, 300)}` }, { status: 502 });
  }
  const usagesJson = (await usagesRes.json().catch(() => ({}))) as { value?: UsageItem[] };
  const usages = usagesJson.value ?? [];

  // Build family → { available: cores } map. Family names in the usages API
  // are case-insensitive; normalise to lower for matching.
  const familyQuota = new Map<string, { limit: number; used: number }>();
  for (const u of usages) {
    const name = u.name?.value;
    if (!name) continue;
    familyQuota.set(name.toLowerCase(), {
      limit: u.limit ?? 0,
      used: u.currentValue ?? 0,
    });
  }

  // ── Cross-reference ──
  const available: Array<{
    vmSize: string;
    family: string;
    vCPUs: number;
    memoryGB: number;
    monthlyCost: number;
    reliability: number;
    notes?: string;
    quotaRemaining: number;
  }> = [];
  const unavailable: Array<{
    vmSize: string;
    family: string;
    vCPUs: number;
    reason: "not_in_region" | "region_restricted" | "no_quota" | "capacity_flaky";
    detail: string;
  }> = [];

  for (const cand of CANDIDATE_SIZES) {
    const skuInfo = skuStatus.get(cand.vmSize);
    if (!skuInfo) {
      unavailable.push({
        vmSize: cand.vmSize,
        family: cand.family,
        vCPUs: cand.vCPUs,
        reason: "not_in_region",
        detail: `${cand.vmSize} isn't offered in ${location}.`,
      });
      continue;
    }
    if (!skuInfo.available) {
      unavailable.push({
        vmSize: cand.vmSize,
        family: cand.family,
        vCPUs: cand.vCPUs,
        reason: "region_restricted",
        detail: `${cand.vmSize} capacity restricted (${skuInfo.reason ?? "restricted"}). Try another region.`,
      });
      continue;
    }
    const q = familyQuota.get(cand.family.toLowerCase());
    const limit = q?.limit ?? 0;
    const used = q?.used ?? 0;
    const remaining = Math.max(0, limit - used);
    if (remaining < cand.vCPUs) {
      unavailable.push({
        vmSize: cand.vmSize,
        family: cand.family,
        vCPUs: cand.vCPUs,
        reason: "no_quota",
        detail: `Quota ${used}/${limit} cores in ${cand.family} — need ${cand.vCPUs}. Request an increase in Azure Portal → Usage + quotas.`,
      });
      continue;
    }
    available.push({
      ...cand,
      quotaRemaining: remaining,
    });
  }

  // Final pass — remove "flaky" sizes when a reliable alternative exists.
  // Azure's resourceSkus API says B-series has no restrictions but the VMs
  // still 409 with SkuNotAvailable at create time in busy regions. So if
  // ANY reliability >= 7 size is available, drop everything below 7 into
  // the unavailable section with a clear explanation. Users only see sizes
  // that WILL actually deploy.
  const hasReliable = available.some((s) => s.reliability >= 7);
  const FLAKY_THRESHOLD = 7;
  const stableAvailable: typeof available = [];
  for (const s of available) {
    if (hasReliable && s.reliability < FLAKY_THRESHOLD) {
      unavailable.push({
        vmSize: s.vmSize,
        family: s.family,
        vCPUs: s.vCPUs,
        reason: "capacity_flaky",
        detail: `${s.vmSize} shows as available in Azure's API but is chronically capacity-constrained in ${location} — hidden in favour of D-series which actually deploys.`,
      });
    } else {
      stableAvailable.push(s);
    }
  }

  // Sort remaining available list: reliability desc, cost asc.
  stableAvailable.sort((a, b) => {
    if (b.reliability !== a.reliability) return b.reliability - a.reliability;
    return a.monthlyCost - b.monthlyCost;
  });
  const recommendedVmSize = stableAvailable[0]?.vmSize ?? null;

  const payload = {
    location,
    available: stableAvailable,
    unavailable,
    recommendedVmSize,
  };
  CACHE.set(cacheKey, { at: Date.now(), payload });

  return NextResponse.json({ ok: true, ...payload });
}
