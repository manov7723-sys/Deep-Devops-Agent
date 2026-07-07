/**
 * Cost evaluation + budget-breach alerting.
 *
 * Fetches live spend (account = subscription, project = resource group), stores
 * a monthly CostSnapshot (preserving the user-set budget), and — when the
 * project's spend reaches its budget — fires an alert through the normal
 * pipeline (banner + email). Auto-resolves when spend drops back under budget.
 *
 * Today this covers Azure (Cost Management); AWS/GCP fetchers slot in the same
 * way. Keyed by sourceLabel `cost:budget:<YYYY-MM>` so it never duplicates.
 */
import { prisma } from "@/lib/db/prisma";
import { getAzureCost, getAzureClusterCost, getAzureCostByService, forecastFromMtd } from "@/lib/cloud/azure-cost";
import { aksClusterFromEnv } from "@/lib/cloud/azure-monitor";
import { getAwsCost, getAwsCostByService } from "@/lib/cloud/aws-cost";
import { getGcpCost } from "@/lib/cloud/gcp-cost";
import { upsertSnapshot, getLatestSnapshot } from "./cost";
import { createAlert, patchAlertStatus } from "@/lib/agentops/alerts";

export type CostEval = {
  ok: true;
  accountCents: number;
  projectCents: number;
  forecastCents: number;
  budgetCents: number | null;
  currency: string;
  breached: boolean;
} | { ok: false; error: string };

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const REFRESH_MS = 30 * 60 * 1000; // don't hit the billing API more than every 30 min

/**
 * Throttled cost eval for the live poller: re-fetch live cost (and re-check the
 * budget) only if the latest snapshot is stale. Best-effort; never throws.
 */
export async function maybeEvaluateProjectCost(projectId: string, now: Date): Promise<void> {
  try {
    const latest = await prisma.costSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (latest && now.getTime() - latest.createdAt.getTime() < REFRESH_MS) return;
    await evaluateProjectCost(projectId, now);
  } catch {
    /* best-effort */
  }
}

/** Fetch + store project/account cost and raise/clear the budget alert. */
export async function evaluateProjectCost(projectId: string, now: Date): Promise<CostEval> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: { in: ["azure", "aws", "gcp"] } },
    select: { id: true, kind: true, resourceGroup: true, costDatasetId: true },
  });
  if (!cp) return { ok: false, error: "No cloud provider connected to this project." };

  let totalCents: number;
  let currency: string;
  let projectCents: number;
  if (cp.kind === "azure") {
    const account = await getAzureCost(cp.id);
    if (!account.ok) return { ok: false, error: account.error };
    totalCents = account.totalCents;
    currency = account.currency;
    // Project cost = ONLY the connected AKS cluster (its node resource group).
    const env = await prisma.env.findFirst({ where: { projectId, cloudProviderId: cp.id }, select: { id: true } });
    const clusterName = env ? await aksClusterFromEnv(env.id) : null;
    if (clusterName) {
      const cl = await getAzureClusterCost(cp.id, clusterName);
      projectCents = cl.ok ? cl.totalCents : account.totalCents;
    } else if (cp.resourceGroup) {
      const rg = await getAzureCost(cp.id, cp.resourceGroup);
      projectCents = rg.ok ? rg.totalCents : account.totalCents;
    } else {
      projectCents = account.totalCents;
    }
  } else if (cp.kind === "aws") {
    // AWS — account-level via Cost Explorer (project filtering by tags later).
    const account = await getAwsCost(cp.id, now);
    if (!account.ok) return { ok: false, error: account.error };
    totalCents = account.totalCents;
    currency = account.currency;
    projectCents = account.totalCents;
  } else {
    // GCP — from the Cloud Billing → BigQuery export (set up via /cost/gcp-setup).
    if (!cp.costDatasetId) {
      return { ok: false, error: "GCP cost isn't set up. Click “Prepare GCP for cost”, then enable Billing → BigQuery export in the console." };
    }
    const account = await getGcpCost(cp.id, cp.costDatasetId, now);
    if (!account.ok) return { ok: false, error: account.error };
    totalCents = account.totalCents;
    currency = account.currency;
    projectCents = account.totalCents;
  }

  const periodStart = monthStart(now);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const forecastCents = forecastFromMtd(projectCents, { day: now.getUTCDate(), daysInMonth });

  // Preserve any user-set budget across the ETL replace.
  const prev = await getLatestSnapshot(projectId);
  const budgetCents = prev?.budgetCents ?? null;

  await upsertSnapshot({
    projectId,
    periodStart,
    totalCents: projectCents,
    forecastCents,
    budgetCents: budgetCents ?? undefined,
    byEnv: [],
    byService: [],
  });

  // Budget breach → alert (needs a budget + an env to attach the alert to).
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const sourceLabel = `cost:budget:${ym}`;
  const breached = budgetCents != null && budgetCents > 0 && projectCents >= budgetCents;

  const env = await prisma.env.findFirst({ where: { projectId }, select: { id: true } });
  const open = await prisma.alert.findFirst({
    where: { projectId, sourceLabel, status: { not: "resolved" } },
    select: { id: true },
  });

  if (breached && !open && env) {
    const sym = currency === "INR" ? "₹" : currency === "USD" ? "$" : `${currency} `;
    const money = (c: number) => `${sym}${(c / 100).toFixed(2)}`;

    // Auto-analysis: WHY did it cross? Pull the top cost drivers by service.
    let drivers: Array<{ service: string; cents: number }> = [];
    try {
      const bd =
        cp.kind === "azure" ? await getAzureCostByService(cp.id) :
        cp.kind === "aws" ? await getAwsCostByService(cp.id, now) : null;
      if (bd?.ok) drivers = bd.services.slice(0, 5);
    } catch { /* report still useful without the breakdown */ }

    const report = drivers.length
      ? "\n\nWhy it crossed — top cost drivers this month:\n" +
        drivers.map((d) => `• ${d.service}: ${money(d.cents)}${totalCents > 0 ? ` (${Math.round((d.cents / totalCents) * 100)}%)` : ""}`).join("\n")
      : "";
    const top = drivers[0];

    await createAlert({
      projectId,
      envId: env.id,
      title: `Budget exceeded — ${money(projectCents)} of ${money(budgetCents!)} this month`,
      detail:
        `This project's month-to-date cloud spend (${money(projectCents)}) has reached its budget (${money(budgetCents!)}). ` +
        `Forecast month-end: ${money(forecastCents)}.${report}`,
      resource: "Cloud cost",
      sourceLabel,
      category: "Compliance",
      severity: "high",
      recommendation: top
        ? `Your biggest cost driver is ${top.service} (${money(top.cents)}). Right-size or remove idle ${top.service} resources first, then ask the agent to “analyse cost optimization” for a full plan.`
        : "Review the cost breakdown and ask the agent to analyse cost optimizations (idle resources, oversized nodes, unused volumes).",
    });
  } else if (!breached && open) {
    await patchAlertStatus(projectId, open.id, "resolved");
  }

  return {
    ok: true,
    accountCents: totalCents,
    projectCents,
    forecastCents,
    budgetCents,
    currency,
    breached,
  };
}
