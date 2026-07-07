/**
 * GCP cost — the agent-automatable parts + the BigQuery cost reader.
 *
 * GCP has no direct spend API, so actual cost comes from a Cloud Billing →
 * BigQuery export. The app can:
 *   - prepareGcpForCost: enable the BigQuery API + create the dataset (the steps
 *     that DO have APIs). The one step with no API — toggling the billing export
 *     in the console — stays manual (Google provides no programmatic path).
 *   - getGcpCost: once the export is on, query the billing table for MTD spend.
 *
 * All via REST with the stored OAuth token (the user's own identity, so no extra
 * IAM grant needed to read their own data).
 */
import { prisma } from "@/lib/db/prisma";
import { getGcpAccessToken } from "./gcp";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

async function resolve(cloudProviderId: string): Promise<Res<{ token: string; project: string }>> {
  const cp = await prisma.cloudProvider.findUnique({ where: { id: cloudProviderId }, select: { kind: true, accountRef: true } });
  if (cp?.kind !== "gcp") return { ok: false, error: "Not a GCP provider." };
  const project = cp.accountRef?.trim();
  if (!project) return { ok: false, error: "GCP provider has no project id." };
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  return { ok: true, data: { token: tok.accessToken, project } };
}

async function gapi<T = Record<string, unknown>>(token: string, url: string, method = "GET", body?: unknown): Promise<Res<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching GCP: ${e instanceof Error ? e.message : "error"}` };
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: { message?: string } }) : ({} as T);
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

/** Enable the BigQuery API + create the export dataset. The billing-export
 *  toggle itself has no API and stays manual. */
export async function prepareGcpForCost(cloudProviderId: string, datasetId: string, location: string): Promise<Res<{ project: string; datasetId: string }>> {
  const r = await resolve(cloudProviderId);
  if (!r.ok) return r;
  const { token, project } = r.data;

  // 1 — enable the BigQuery API (idempotent).
  const enable = await gapi(token, `https://serviceusage.googleapis.com/v1/projects/${project}/services/bigquery.googleapis.com:enable`, "POST", {});
  if (!enable.ok && !/already enabled|ALREADY_EXISTS/i.test(enable.error)) return enable;

  // 2 — create the dataset (ignore ALREADY_EXISTS).
  const ds = await gapi(token, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets`, "POST", {
    datasetReference: { datasetId, projectId: project },
    location,
    description: "Cloud Billing export — created by DeepAgent cost automation.",
  });
  if (!ds.ok && !/already exists|Already Exists|duplicate/i.test(ds.error)) return ds;

  return { ok: true, data: { project, datasetId } };
}

/** Find the billing-export table in the dataset (gcp_billing_export_*). */
async function findBillingTable(token: string, project: string, datasetId: string): Promise<Res<string>> {
  const list = await gapi<{ tables?: Array<{ tableReference?: { tableId?: string } }> }>(
    token,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables?maxResults=1000`,
  );
  if (!list.ok) return list;
  const tables = (list.data.tables ?? []).map((t) => t.tableReference?.tableId ?? "");
  // Prefer the detailed (resource) export; fall back to standard.
  const detailed = tables.find((t) => t.startsWith("gcp_billing_export_resource_v1_"));
  const standard = tables.find((t) => t.startsWith("gcp_billing_export_v1_"));
  const table = detailed || standard;
  if (!table) return { ok: false, error: "No billing-export table yet. Enable Billing → BigQuery export in the console; the table appears within a few hours." };
  return { ok: true, data: table };
}

export type GcpCostResult = { ok: true; totalCents: number; currency: string } | { ok: false; error: string };

/** Month-to-date GCP spend from the billing export (net of credits). */
export async function getGcpCost(cloudProviderId: string, datasetId: string, now: Date): Promise<GcpCostResult> {
  const r = await resolve(cloudProviderId);
  if (!r.ok) return r;
  const { token, project } = r.data;

  const tbl = await findBillingTable(token, project, datasetId);
  if (!tbl.ok) return tbl;

  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const query = `
    SELECT
      SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS total,
      ANY_VALUE(currency) AS currency
    FROM \`${project}.${datasetId}.${tbl.data}\`
    WHERE usage_start_time >= TIMESTAMP('${monthStart}')`;

  const job = await gapi<{ jobComplete?: boolean; rows?: Array<{ f?: Array<{ v?: string }> }> }>(
    token,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,
    "POST",
    { query, useLegacySql: false, timeoutMs: 20000 },
  );
  if (!job.ok) return job;
  // BigQuery can return jobComplete=false (still running) with no rows — don't
  // silently report $0 in that case.
  if (job.data.jobComplete === false) {
    return { ok: false, error: "The BigQuery cost query didn't finish in time. Try refreshing again in a moment." };
  }
  const row = job.data.rows?.[0]?.f ?? [];
  const value = Number(row[0]?.v ?? "0") || 0;
  const currency = row[1]?.v ?? "USD";
  return { ok: true, totalCents: Math.round(value * 100), currency };
}

/** All table ids in a dataset (empty array on any error). */
async function listTables(token: string, project: string, datasetId: string): Promise<string[]> {
  const list = await gapi<{ tables?: Array<{ tableReference?: { tableId?: string } }> }>(
    token,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables?maxResults=1000`,
  );
  if (!list.ok) return [];
  return (list.data.tables ?? []).map((t) => t.tableReference?.tableId ?? "").filter(Boolean);
}

/** All dataset ids in a project (empty array on any error). */
async function listDatasets(token: string, project: string): Promise<string[]> {
  const list = await gapi<{ datasets?: Array<{ datasetReference?: { datasetId?: string } }> }>(
    token,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets?maxResults=1000`,
  );
  if (!list.ok) return [];
  return (list.data.datasets ?? []).map((d) => d.datasetReference?.datasetId ?? "").filter(Boolean);
}

export type GcpCostDiag =
  | { stage: "ok"; totalCents: number; currency: string; table: string; message: string }
  | { stage: "auth" | "no_dataset" | "no_export" | "error"; message: string; details?: { project: string; datasetId: string; tablesInDataset: string[]; otherDatasets: string[] } };

/**
 * Diagnose the GCP cost setup so the user knows exactly where they are:
 *   auth       — can't reach GCP / token problem
 *   no_dataset — the BigQuery dataset doesn't exist (run "Prepare GCP for cost")
 *   no_export  — dataset exists but no billing-export table yet (enable the
 *                console toggle; the table + data appear within a few hours)
 *   ok         — the export is live; returns the month-to-date spend
 */
export async function verifyGcpCost(cloudProviderId: string, datasetId: string, now: Date): Promise<GcpCostDiag> {
  const r = await resolve(cloudProviderId);
  if (!r.ok) return { stage: "auth", message: r.error };
  const { token, project } = r.data;

  // 1 — dataset exists?
  const ds = await gapi(token, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}`);
  if (!ds.ok) {
    if (/not found|404/i.test(ds.error)) {
      return { stage: "no_dataset", message: `BigQuery dataset "${datasetId}" doesn't exist yet. Click "Prepare GCP for cost" to create it.` };
    }
    return { stage: "error", message: ds.error };
  }

  // 2 — billing-export table present?
  const tbl = await findBillingTable(token, project, datasetId);
  if (!tbl.ok) {
    const [tablesInDataset, allDatasets] = await Promise.all([listTables(token, project, datasetId), listDatasets(token, project)]);
    const otherDatasets = allDatasets.filter((d) => d !== datasetId);
    const tablesLine = tablesInDataset.length
      ? `Tables currently in "${datasetId}": ${tablesInDataset.join(", ")}.`
      : `Dataset "${datasetId}" is empty (no tables yet).`;
    const otherLine = otherDatasets.length
      ? ` Other datasets in project ${project}: ${otherDatasets.join(", ")} — if your billing export points at one of these, set THAT as the dataset id here.`
      : "";
    return {
      stage: "no_export",
      message:
        `Looking in project ${project}, dataset "${datasetId}" — but no billing-export table (gcp_billing_export_v1_*) is there. ${tablesLine}${otherLine} ` +
        `Either the export was just enabled (data lands in a few hours) or the console export points at a different project/dataset than this one.`,
      details: { project, datasetId, tablesInDataset, otherDatasets },
    };
  }

  // 3 — query the spend.
  const cost = await getGcpCost(cloudProviderId, datasetId, now);
  if (!cost.ok) return { stage: "error", message: cost.error };
  const sym = cost.currency === "INR" ? "₹" : cost.currency === "USD" ? "$" : `${cost.currency} `;
  return {
    stage: "ok",
    totalCents: cost.totalCents,
    currency: cost.currency,
    table: tbl.data,
    message:
      cost.totalCents > 0
        ? `GCP cost is working — month-to-date ${sym}${(cost.totalCents / 100).toFixed(2)} from ${tbl.data}.`
        : `Export is connected (table ${tbl.data}), but this month's spend is ${sym}0.00 so far — if you expect charges, data may still be landing (a few-hour delay after enabling the export).`,
  };
}
