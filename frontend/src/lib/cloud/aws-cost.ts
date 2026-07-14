/**
 * AWS spend via Cost Explorer (`aws ce get-cost-and-usage`) using the env's
 * stored credentials. Cost Explorer is a global service — always us-east-1.
 * Account cost = whole account, month-to-date (project filtering by cost-
 * allocation tags can be layered on later).
 */
import { runStage } from "@/lib/runner/exec";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";

export type CostResult =
  { ok: true; totalCents: number; currency: string } | { ok: false; error: string };
export type ServiceCost = { service: string; cents: number };

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function getAwsCost(cloudProviderId: string, now: Date): Promise<CostResult> {
  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, error: resolved.message };

  const start = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const end = ymd(new Date(now.getTime() + 24 * 60 * 60 * 1000)); // Cost Explorer End is exclusive

  const res = await runStage({
    command: "aws",
    args: [
      "ce",
      "get-cost-and-usage",
      "--time-period",
      `Start=${start},End=${end}`,
      "--granularity",
      "MONTHLY",
      "--metrics",
      "UnblendedCost",
      "--region",
      "us-east-1",
      "--output",
      "json",
      "--no-cli-pager",
    ],
    cwd: process.cwd(),
    env: { ...resolved.env, AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1" },
    timeoutMs: 30_000,
  });

  if (res.exitCode !== 0) {
    if (res.exitCode === -1 && res.stderr.includes("ENOENT"))
      return { ok: false, error: "`aws` CLI isn't installed on the server." };
    return {
      ok: false,
      error: (res.stderr.trim() || res.stdout.trim()).slice(-300) || "Cost Explorer query failed.",
    };
  }

  try {
    const data = JSON.parse(res.stdout) as {
      ResultsByTime?: Array<{ Total?: { UnblendedCost?: { Amount?: string; Unit?: string } } }>;
    };
    const total = data.ResultsByTime?.[0]?.Total?.UnblendedCost;
    const value = Number(total?.Amount ?? "0") || 0;
    return { ok: true, totalCents: Math.round(value * 100), currency: total?.Unit ?? "USD" };
  } catch {
    return { ok: false, error: "Couldn't parse the Cost Explorer output." };
  }
}

/** Month-to-date cost grouped by AWS service (top drivers), for the breach report. */
export async function getAwsCostByService(
  cloudProviderId: string,
  now: Date,
): Promise<{ ok: true; services: ServiceCost[] } | { ok: false; error: string }> {
  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  const start = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const end = ymd(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  const res = await runStage({
    command: "aws",
    args: [
      "ce",
      "get-cost-and-usage",
      "--time-period",
      `Start=${start},End=${end}`,
      "--granularity",
      "MONTHLY",
      "--metrics",
      "UnblendedCost",
      "--group-by",
      "Type=DIMENSION,Key=SERVICE",
      "--region",
      "us-east-1",
      "--output",
      "json",
      "--no-cli-pager",
    ],
    cwd: process.cwd(),
    env: { ...resolved.env, AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1" },
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.exitCode !== 0)
    return {
      ok: false,
      error: (res.stderr.trim() || res.stdout.trim()).slice(-300) || "Cost Explorer query failed.",
    };
  try {
    const data = JSON.parse(res.stdout) as {
      ResultsByTime?: Array<{
        Groups?: Array<{ Keys?: string[]; Metrics?: { UnblendedCost?: { Amount?: string } } }>;
      }>;
    };
    const groups = data.ResultsByTime?.[0]?.Groups ?? [];
    const services = groups
      .map((g) => ({
        service: g.Keys?.[0] ?? "Unknown",
        cents: Math.round((Number(g.Metrics?.UnblendedCost?.Amount ?? "0") || 0) * 100),
      }))
      .filter((s) => s.cents > 0)
      .sort((a, b) => b.cents - a.cents);
    return { ok: true, services };
  } catch {
    return { ok: false, error: "Couldn't parse the Cost Explorer output." };
  }
}
