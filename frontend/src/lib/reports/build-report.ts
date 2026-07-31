/**
 * Assemble one namespace's daily report and render it as email HTML.
 *
 * Combines two sources:
 *   • Kubernetes  — what is deployed, replica health, restarts, images.
 *   • Prometheus  — CPU, memory, request rate, error rate, p95 latency.
 *
 * Prometheus is OPTIONAL by design. A cluster without the monitoring stack
 * still produces a useful report (health, restarts, images, rollouts); the
 * metrics columns are simply absent, with one line saying why. Refusing to
 * send in that case would punish exactly the clusters that most need
 * visibility.
 */
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { findPrometheus, appMetrics, type AppMetrics } from "./prometheus";
import type { DiscoveredNamespace, DiscoveredApp } from "./discover-apps";

export type AppReportRow = DiscoveredApp & { metrics: AppMetrics | null };

export type NamespaceReport = {
  namespace: string;
  envKey: string;
  cloud: string;
  clusterReachable: boolean;
  note?: string;
  apps: AppReportRow[];
  /** False when the monitoring stack wasn't found — drives the "no metrics" note. */
  hasPrometheus: boolean;
  generatedAt: string;
  /** Rolled-up counts for the subject line and the summary strip. */
  totals: { apps: number; healthy: number; degraded: number; restarts: number };
};

/** Gather metrics for one namespace's apps and fold them into a report. */
export async function buildNamespaceReport(
  ns: DiscoveredNamespace,
  generatedAt: Date,
): Promise<NamespaceReport> {
  const base: NamespaceReport = {
    namespace: ns.namespace,
    envKey: ns.envKey,
    cloud: ns.cloud,
    clusterReachable: ns.clusterReachable,
    note: ns.note,
    apps: ns.apps.map((a) => ({ ...a, metrics: null })),
    hasPrometheus: false,
    generatedAt: generatedAt.toISOString(),
    totals: {
      apps: ns.apps.length,
      healthy: ns.apps.filter((a) => a.health === "healthy").length,
      degraded: ns.apps.filter((a) => a.health === "degraded").length,
      restarts: ns.apps.reduce((sum, a) => sum + a.restarts, 0),
    },
  };

  if (!ns.clusterReachable || ns.apps.length === 0) return base;

  const kcfg = await getKubeconfigForEnv(ns.envId).catch(() => null);
  if (!kcfg || !kcfg.ok) return base;

  try {
    const execEnv = await kubeExecEnv(kcfg.handle.path, null);
    const prom = await findPrometheus({ kubeconfigPath: kcfg.handle.path, execEnv });
    if (!prom) return base;

    const apps = await Promise.all(
      ns.apps.map(async (a) => ({
        ...a,
        metrics: await appMetrics({
          kubeconfigPath: kcfg.handle.path,
          execEnv,
          prom,
          namespace: ns.namespace,
          app: a.name,
        }),
      })),
    );
    return { ...base, apps, hasPrometheus: true };
  } catch {
    return base;
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}

// ── HTML rendering ────────────────────────────────────────────────────
// Email HTML, not web HTML: tables for layout and inline styles only. Gmail
// and Outlook strip <style> blocks and ignore flex/grid, so anything clever
// here renders as an unstyled column of text.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (v: number | null, digits = 2, suffix = "") =>
  v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${suffix}`;

function appRow(a: AppReportRow, showMetrics: boolean): string {
  const healthy = a.health === "healthy";
  const healthCell = `<span style="color:${healthy ? "#1a7f37" : "#cf222e"};font-weight:600">${
    healthy ? "Healthy" : "Degraded"
  }</span>`;
  // Restarts are the single most actionable number in the report — a
  // crash-looping pod is invisible in "replicas ready" once it stabilises,
  // so highlight any non-zero count rather than letting it blend in.
  const restartCell =
    a.restarts > 0
      ? `<span style="color:#bc4c00;font-weight:600">${a.restarts}</span>`
      : `${a.restarts}`;

  const metricCells = showMetrics
    ? `
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${fmt(a.metrics?.cpuCores ?? null, 3)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${fmt(a.metrics?.memoryMiB ?? null, 0, " MiB")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${fmt(a.metrics?.requestRate ?? null, 2, "/s")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${
        a.metrics?.errorRate === null || a.metrics?.errorRate === undefined
          ? "—"
          : `${(a.metrics.errorRate * 100).toFixed(2)}%`
      }</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${fmt(a.metrics?.p95Seconds ?? null, 3, "s")}</td>`
    : "";

  return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2;font-family:ui-monospace,monospace">${esc(a.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${healthCell}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${a.readyReplicas}/${a.replicas}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eaeef2">${restartCell}</td>${metricCells}
    </tr>`;
}

/** Render one namespace section — used standalone and inside the digest. */
export function renderNamespaceSection(r: NamespaceReport): string {
  if (!r.clusterReachable) {
    return `<div style="margin:0 0 24px">
      <h2 style="margin:0 0 6px;font-size:18px">${esc(r.namespace)}</h2>
      <p style="margin:0;color:#cf222e;font-size:14px">Cluster unreachable — ${esc(r.note ?? "no detail")}</p>
    </div>`;
  }
  if (r.apps.length === 0) {
    return `<div style="margin:0 0 24px">
      <h2 style="margin:0 0 6px;font-size:18px">${esc(r.namespace)}</h2>
      <p style="margin:0;color:#57606a;font-size:14px">No applications deployed by the agent in this namespace.</p>
    </div>`;
  }

  const showMetrics = r.hasPrometheus;
  const metricHeads = showMetrics
    ? `<th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">CPU</th>
       <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Memory</th>
       <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Req/s</th>
       <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Errors</th>
       <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">p95</th>`
    : "";

  return `<div style="margin:0 0 32px">
    <h2 style="margin:0 0 4px;font-size:18px">${esc(r.namespace)}</h2>
    <p style="margin:0 0 12px;color:#57606a;font-size:13px">
      ${esc(r.cloud.toUpperCase())} · env <strong>${esc(r.envKey)}</strong> ·
      ${r.totals.apps} app${r.totals.apps === 1 ? "" : "s"} ·
      ${r.totals.healthy} healthy${r.totals.degraded > 0 ? ` · <span style="color:#cf222e">${r.totals.degraded} degraded</span>` : ""}
      ${r.totals.restarts > 0 ? ` · <span style="color:#bc4c00">${r.totals.restarts} restart${r.totals.restarts === 1 ? "" : "s"}</span>` : ""}
    </p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f6f8fa">
          <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Application</th>
          <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Status</th>
          <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Ready</th>
          <th align="left" style="padding:8px 10px;border-bottom:2px solid #d0d7de">Restarts</th>
          ${metricHeads}
        </tr>
      </thead>
      <tbody>${r.apps.map((a) => appRow(a, showMetrics)).join("")}</tbody>
    </table>
    ${
      showMetrics
        ? ""
        : `<p style="margin:10px 0 0;color:#57606a;font-size:12px">
             Metrics unavailable — no Prometheus found in this cluster. Install the
             monitoring stack from the Observability page to include CPU, memory,
             request rate, errors and latency.
           </p>`
    }
  </div>`;
}

/** Full email document for ONE namespace. */
export function renderReportEmail(r: NamespaceReport, projectName: string): { subject: string; html: string } {
  const day = new Date(r.generatedAt).toISOString().slice(0, 10);
  // Lead the subject with what's wrong, if anything — a subject that always
  // reads the same gets filtered out mentally within a week.
  const alarm =
    r.totals.degraded > 0
      ? `${r.totals.degraded} degraded — `
      : r.totals.restarts > 0
        ? `${r.totals.restarts} restarts — `
        : "";
  const subject = `[${projectName}] ${alarm}${r.namespace} daily report · ${day}`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#ffffff;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <div style="max-width:760px;margin:0 auto">
    <p style="margin:0 0 4px;color:#57606a;font-size:12px;text-transform:uppercase;letter-spacing:.04em">
      ${esc(projectName)} · Daily application report
    </p>
    <h1 style="margin:0 0 20px;font-size:22px">${esc(r.namespace)}</h1>
    ${renderNamespaceSection(r)}
    <hr style="border:0;border-top:1px solid #eaeef2;margin:24px 0" />
    <p style="margin:0;color:#57606a;font-size:12px">
      Generated ${esc(new Date(r.generatedAt).toUTCString())} by DeepAgent.
      Manage recipients on the project's Reports tab.
    </p>
  </div>
</body></html>`;
  return { subject, html };
}
