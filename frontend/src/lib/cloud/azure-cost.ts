/**
 * Azure spend via the Cost Management query API (ARM REST + the stored token).
 * Works with the normal connection (needs Cost Management Reader) — no SP/Graph.
 *
 * Account cost  = whole subscription, month-to-date.
 * Project cost  = scoped to a resource group (the project's cluster RG), MTD.
 */
import { prisma } from "@/lib/db/prisma";
import { getAzureAccessToken } from "./azure";
import { listAksClusters } from "./azure-arm";

const ARM = "https://management.azure.com";

export type CostResult =
  { ok: true; totalCents: number; currency: string } | { ok: false; error: string };

async function subscriptionOf(cloudProviderId: string): Promise<string | null> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, accountRef: true },
  });
  return cp?.kind === "azure" ? (cp.accountRef?.trim() ?? null) : null;
}

/**
 * Month-to-date actual cost. Scope = subscription (account) or, if
 * resourceGroup is given, just that RG (project). Returns the total in cents +
 * the billing currency.
 */
export async function getAzureCost(
  cloudProviderId: string,
  resourceGroup?: string,
): Promise<CostResult> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sub = await subscriptionOf(cloudProviderId);
  if (!sub) return { ok: false, error: "No Azure subscription on the provider." };

  const scope = resourceGroup
    ? `/subscriptions/${sub}/resourceGroups/${resourceGroup}`
    : `/subscriptions/${sub}`;

  let res: Response;
  try {
    res = await fetch(
      `${ARM}${scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ActualCost",
          timeframe: "MonthToDate",
          dataset: {
            granularity: "None",
            aggregation: { totalCost: { name: "Cost", function: "Sum" } },
          },
        }),
      },
    );
  } catch (e) {
    return {
      ok: false,
      error: `Network error reaching Azure Cost Management: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  const text = await res.text();
  const data = text
    ? (JSON.parse(text) as {
        properties?: { columns?: Array<{ name?: string }>; rows?: unknown[][] };
        error?: { message?: string };
      })
    : {};
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }

  const cols = data.properties?.columns ?? [];
  const rows = data.properties?.rows ?? [];
  const costIdx = cols.findIndex((c) => (c.name ?? "").toLowerCase().includes("cost"));
  const curIdx = cols.findIndex((c) => (c.name ?? "").toLowerCase().includes("currency"));
  if (rows.length === 0) return { ok: true, totalCents: 0, currency: "USD" };
  const row = rows[0];
  const value = Number(row[costIdx >= 0 ? costIdx : 0]) || 0;
  const currency = (curIdx >= 0 ? String(row[curIdx]) : "USD") || "USD";
  return { ok: true, totalCents: Math.round(value * 100), currency };
}

/**
 * Cost of just the CONNECTED AKS cluster — its node resource group (the `MC_*`
 * group AKS creates for the cluster's VMs/disks/LB, where the real spend is).
 * Falls back to the cluster's own RG if the node RG can't be resolved.
 */
export async function getAzureClusterCost(
  cloudProviderId: string,
  clusterName: string,
): Promise<CostResult & { resourceGroup?: string }> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sub = await subscriptionOf(cloudProviderId);
  if (!sub) return { ok: false, error: "No Azure subscription on the provider." };

  // Use the proven lister to find the cluster's resource group.
  const list = await listAksClusters(tok.accessToken, sub);
  if (!list.ok) return { ok: false, error: list.error };
  const cluster = list.clusters.find((c) => c.name === clusterName);
  if (!cluster)
    return { ok: false, error: `AKS cluster "${clusterName}" not found in the subscription.` };

  // GET the cluster for its node resource group (where the VMs/disks/LB cost lives).
  let nodeRg: string | undefined;
  try {
    const r = await fetch(
      `${ARM}/subscriptions/${sub}/resourceGroups/${cluster.resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}?api-version=2024-05-01`,
      { headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" } },
    );
    if (r.ok) {
      const d = (await r.json().catch(() => ({}))) as {
        properties?: { nodeResourceGroup?: string };
      };
      nodeRg = d.properties?.nodeResourceGroup;
    }
  } catch {
    /* fall back to the cluster's own RG */
  }

  const rg = nodeRg || cluster.resourceGroup;
  const cost = await getAzureCost(cloudProviderId, rg);
  if (!cost.ok) return cost;
  return { ...cost, resourceGroup: rg };
}

export type ServiceCost = { service: string; cents: number };

/** Month-to-date cost grouped by service (top drivers), for the breach report. */
export async function getAzureCostByService(
  cloudProviderId: string,
  resourceGroup?: string,
): Promise<{ ok: true; services: ServiceCost[] } | { ok: false; error: string }> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sub = await subscriptionOf(cloudProviderId);
  if (!sub) return { ok: false, error: "No Azure subscription." };
  const scope = resourceGroup
    ? `/subscriptions/${sub}/resourceGroups/${resourceGroup}`
    : `/subscriptions/${sub}`;

  let res: Response;
  try {
    res = await fetch(
      `${ARM}${scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ActualCost",
          timeframe: "MonthToDate",
          dataset: {
            granularity: "None",
            aggregation: { totalCost: { name: "Cost", function: "Sum" } },
            grouping: [{ type: "Dimension", name: "ServiceName" }],
          },
        }),
      },
    );
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : "error"}` };
  }
  const data = (await res.json().catch(() => ({}))) as {
    properties?: { columns?: Array<{ name?: string }>; rows?: unknown[][] };
    error?: { message?: string };
  };
  if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
  const cols = data.properties?.columns ?? [];
  const ci = cols.findIndex((c) => (c.name ?? "").toLowerCase().includes("cost"));
  const si = cols.findIndex((c) => (c.name ?? "").toLowerCase().includes("service"));
  const services = (data.properties?.rows ?? [])
    .map((r) => ({
      service: String(r[si >= 0 ? si : 1] ?? "Unknown"),
      cents: Math.round((Number(r[ci >= 0 ? ci : 0]) || 0) * 100),
    }))
    .filter((s) => s.cents > 0)
    .sort((a, b) => b.cents - a.cents);
  return { ok: true, services };
}

/** Naive linear month forecast from month-to-date spend (no extra API call). */
export function forecastFromMtd(
  totalCents: number,
  now: { day: number; daysInMonth: number },
): number {
  if (now.day <= 0) return totalCents;
  return Math.round((totalCents / now.day) * now.daysInMonth);
}
