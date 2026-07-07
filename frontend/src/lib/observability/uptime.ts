/**
 * Uptime / synthetic monitoring — periodically HTTP-check deployed app URLs and
 * open/resolve an alert on downtime (which then flows to banner + email + Slack).
 *
 * A monitor goes DOWN only after DOWN_THRESHOLD consecutive failures (avoids
 * flapping on a single blip) and recovers on the next success.
 */
import { prisma } from "@/lib/db/prisma";
import type { UptimeMonitor } from "@prisma/client";
import { createAlert, patchAlertStatus } from "@/lib/agentops/alerts";
import { getCertExpiry, daysUntil } from "./cert-check";

const DOWN_THRESHOLD = 2; // consecutive fails before we call it down
const CHECK_TIMEOUT_MS = 15_000;
const MAX_HISTORY = 50; // keep the last N checks per monitor

export type CheckOutcome = { ok: boolean; status?: number; latencyMs?: number; error?: string };

/** Run a single HTTP check (no DB writes). */
export async function probe(url: string, method: string, expectedStatus: number): Promise<CheckOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: controller.signal, headers: { "User-Agent": "DeepAgent-Uptime/1" } });
    const latencyMs = Date.now() - start;
    const ok = res.status === expectedStatus;
    return { ok, status: res.status, latencyMs, error: ok ? undefined : `Expected ${expectedStatus}, got ${res.status}` };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const msg = e instanceof Error ? (e.name === "AbortError" ? `Timed out after ${CHECK_TIMEOUT_MS / 1000}s` : e.message) : "request failed";
    return { ok: false, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Check one monitor: probe, record history, update state, open/resolve alert. */
export async function checkMonitor(monitor: UptimeMonitor): Promise<CheckOutcome> {
  const outcome = await probe(monitor.url, monitor.method, monitor.expectedStatus);

  // Record + prune history.
  await prisma.uptimeCheck.create({
    data: { monitorId: monitor.id, ok: outcome.ok, status: outcome.status ?? null, latencyMs: outcome.latencyMs ?? null, error: outcome.error ?? null },
  });
  const old = await prisma.uptimeCheck.findMany({ where: { monitorId: monitor.id }, orderBy: { at: "desc" }, skip: MAX_HISTORY, select: { id: true } });
  if (old.length) await prisma.uptimeCheck.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });

  const consecutiveFails = outcome.ok ? 0 : monitor.consecutiveFails + 1;
  const sourceLabel = `uptime:${monitor.id}`;
  let alertOpen = monitor.alertOpen;

  if (!outcome.ok && consecutiveFails >= DOWN_THRESHOLD && !monitor.alertOpen) {
    // Transition → DOWN: raise an alert (needs an env to attach to).
    const env = await prisma.env.findFirst({ where: { projectId: monitor.projectId }, select: { id: true } });
    if (env) {
      await createAlert({
        projectId: monitor.projectId,
        envId: env.id,
        title: `${monitor.name} is DOWN`,
        detail: `Uptime check failed ${consecutiveFails}× for ${monitor.url}. ${outcome.error ?? ""}`.trim(),
        resource: monitor.url,
        sourceLabel,
        category: "Reliability",
        severity: "high",
        recommendation: "Check the app's pods/logs, the ingress/DNS, and that the service is listening. Ask the agent to investigate.",
      });
      alertOpen = true;
    }
  } else if (outcome.ok && monitor.alertOpen) {
    // Transition → UP: resolve the open alert.
    const open = await prisma.alert.findFirst({ where: { projectId: monitor.projectId, sourceLabel, status: { not: "resolved" } }, select: { id: true } });
    if (open) await patchAlertStatus(monitor.projectId, open.id, "resolved");
    alertOpen = false;
  }

  // ── TLS certificate expiry (https only) ─────────────────────────────────────
  const now = new Date();
  let certExpiresAt = monitor.certExpiresAt;
  let certAlertOpen = monitor.certAlertOpen;
  if (monitor.url.startsWith("https://")) {
    const exp = await getCertExpiry(monitor.url);
    if (exp) {
      certExpiresAt = exp;
      const left = daysUntil(exp, now);
      const certLabel = `uptime-cert:${monitor.id}`;
      if (left <= monitor.certDaysWarn && !monitor.certAlertOpen) {
        const env = await prisma.env.findFirst({ where: { projectId: monitor.projectId }, select: { id: true } });
        if (env) {
          await createAlert({
            projectId: monitor.projectId,
            envId: env.id,
            title: left < 0 ? `${monitor.name} — TLS certificate EXPIRED` : `${monitor.name} — TLS certificate expires in ${left} day${left === 1 ? "" : "s"}`,
            detail: `The certificate for ${monitor.url} ${left < 0 ? "has expired" : `expires on ${exp.toUTCString()} (${left} days)`}. Renew it before it lapses to avoid an outage.`,
            resource: monitor.url,
            sourceLabel: certLabel,
            category: "Security",
            severity: left <= 3 ? "high" : "medium",
            recommendation: "Renew/rotate the TLS certificate (or your cert-manager/ACME automation) before it expires.",
          });
          certAlertOpen = true;
        }
      } else if (left > monitor.certDaysWarn && monitor.certAlertOpen) {
        // Renewed → resolve.
        const open = await prisma.alert.findFirst({ where: { projectId: monitor.projectId, sourceLabel: certLabel, status: { not: "resolved" } }, select: { id: true } });
        if (open) await patchAlertStatus(monitor.projectId, open.id, "resolved");
        certAlertOpen = false;
      }
    }
  }

  await prisma.uptimeMonitor.update({
    where: { id: monitor.id },
    data: {
      lastOk: outcome.ok,
      lastStatus: outcome.status ?? null,
      lastLatencyMs: outcome.latencyMs ?? null,
      lastCheckedAt: now,
      consecutiveFails,
      alertOpen,
      certExpiresAt,
      certAlertOpen,
    },
  });

  return outcome;
}

/**
 * Global background runner — check EVERY due monitor across ALL projects. Used by
 * the in-process scheduler so uptime + cert checks run 24/7, with no browser open.
 */
export async function runAllDueUptimeChecks(now: Date): Promise<number> {
  const monitors = await prisma.uptimeMonitor.findMany({ where: { enabled: true } });
  let ran = 0;
  for (const m of monitors) {
    const due = !m.lastCheckedAt || now.getTime() - m.lastCheckedAt.getTime() >= m.intervalSec * 1000;
    if (!due) continue;
    try {
      await checkMonitor(m);
      ran++;
    } catch {
      /* best-effort */
    }
  }
  return ran;
}

/** Check every monitor in a project that is due (interval elapsed). Best-effort. */
export async function runDueUptimeChecks(projectId: string, now: Date): Promise<number> {
  const monitors = await prisma.uptimeMonitor.findMany({ where: { projectId, enabled: true } });
  let ran = 0;
  for (const m of monitors) {
    const due = !m.lastCheckedAt || now.getTime() - m.lastCheckedAt.getTime() >= m.intervalSec * 1000;
    if (!due) continue;
    try {
      await checkMonitor(m);
      ran++;
    } catch {
      /* best-effort */
    }
  }
  return ran;
}

/** Run all enabled monitors in a project immediately (the "Check now" button). */
export async function runAllNow(projectId: string): Promise<number> {
  const monitors = await prisma.uptimeMonitor.findMany({ where: { projectId, enabled: true } });
  let ran = 0;
  for (const m of monitors) {
    try {
      await checkMonitor(m);
      ran++;
    } catch {
      /* skip */
    }
  }
  return ran;
}
