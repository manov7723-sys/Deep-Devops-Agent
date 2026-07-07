/**
 * Deploy watchdog — keeps watching apps AFTER they deploy. Every scheduler tick
 * it checks each registered app's health; if one that was healthy stays
 * unhealthy for THRESHOLD consecutive checks (cautious ~5 min), it auto-rolls it
 * back to the previous version and notifies. Rolls back once, then cools down.
 *
 * Self-contained health probe (via listKubernetesResourcesTool) so this module
 * does NOT import deploy.ts — avoids a circular dependency (deploy.ts registers
 * watches here on a successful deploy).
 */
import { prisma } from "@/lib/db/prisma";
import { listKubernetesResourcesTool } from "@/lib/agent/tools/list-kubernetes-resources";
import { rollbackDeployment } from "./rollback";
import { recordDeployment, specFromRecord } from "./deploy-history";
import { sanitizeAppName } from "./deploy-manifest";
import { emailProjectMembers } from "@/lib/agentops/alerts";
import { postEventToChatOps } from "@/lib/integrations/chatops";

const THRESHOLD = 5; // consecutive unhealthy checks before auto-rollback (~5 min at 60s ticks)
const COOLDOWN_MS = 10 * 60_000; // don't re-trigger within 10 min of a rollback

/** Register/refresh an app for watching after a successful deploy. Resets counters. */
export async function registerWatch(
  projectId: string,
  createdById: string | null,
  envKey: string,
  appName: string,
  namespace: string,
): Promise<void> {
  const app = sanitizeAppName(appName);
  await prisma.deployWatch
    .upsert({
      where: { projectId_envKey_appName_namespace: { projectId, envKey, appName: app, namespace } },
      create: { projectId, createdById, envKey, appName: app, namespace, enabled: true },
      update: { enabled: true, consecutiveUnhealthy: 0, autoRolledBackAt: null, createdById, lastHealthyAt: new Date() },
    })
    .catch(() => {}); // best-effort — never fail a deploy over the watch row
}

type HealthProbe = { state: "unreachable" } | { state: "absent" } | { state: "present"; healthy: boolean };

async function probe(projectId: string, userId: string, envKey: string, appName: string, namespace: string): Promise<HealthProbe> {
  const res = await listKubernetesResourcesTool.execute({ envKey, kind: "deployments", namespace }, { projectId, userId });
  if (!res.ok) return { state: "unreachable" };
  const dep = res.output.items.find((i) => i.name === appName);
  if (!dep) return { state: "absent" };
  const [r, t] = (dep.ready ?? "0/0").split("/").map((n) => Number(n) || 0);
  return { state: "present", healthy: t > 0 && r >= t };
}

/** Check every enabled watch; auto-roll-back apps that have been unhealthy too long. */
export async function runDeployWatchdog(now: Date): Promise<number> {
  const watches = await prisma.deployWatch.findMany({ where: { enabled: true }, take: 200 });
  let acted = 0;

  for (const w of watches) {
    const userId = w.createdById ?? "";
    const h = await probe(w.projectId, userId, w.envKey, w.appName, w.namespace);

    // Cluster unreachable → skip this tick entirely (don't count it against the app).
    if (h.state === "unreachable") continue;

    // App is gone (deleted) → stop watching it; recreating it via rollback would be wrong.
    if (h.state === "absent") {
      await prisma.deployWatch.update({ where: { id: w.id }, data: { enabled: false, lastCheckedAt: now } }).catch(() => {});
      continue;
    }

    if (h.healthy) {
      await prisma.deployWatch
        .update({ where: { id: w.id }, data: { consecutiveUnhealthy: 0, lastHealthyAt: now, lastCheckedAt: now } })
        .catch(() => {});
      continue;
    }

    // Unhealthy.
    const count = w.consecutiveUnhealthy + 1;
    const inCooldown = w.autoRolledBackAt != null && now.getTime() - w.autoRolledBackAt.getTime() < COOLDOWN_MS;
    if (count < THRESHOLD || inCooldown) {
      await prisma.deployWatch.update({ where: { id: w.id }, data: { consecutiveUnhealthy: count, lastCheckedAt: now } }).catch(() => {});
      continue;
    }

    // Threshold reached → auto-roll-back.
    const rb = await rollbackDeployment(w.projectId, w.envKey, w.appName, { namespace: w.namespace });
    if (rb.ok) {
      acted++;
      await prisma.deployWatch
        .update({ where: { id: w.id }, data: { consecutiveUnhealthy: 0, autoRolledBackAt: now, lastCheckedAt: now } })
        .catch(() => {});

      // Record it on the Deployments page (reuse the last known spec for image/port).
      const last = await prisma.deploymentRecord.findFirst({
        where: { projectId: w.projectId, envKey: w.envKey, appName: w.appName, namespace: w.namespace, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      const spec = last
        ? specFromRecord(last)
        : { appName: w.appName, image: "(unknown)", namespace: w.namespace, replicas: 1, containerPort: 8080, env: [], expose: false };
      await recordDeployment(w.projectId, w.createdById, { envKey: w.envKey }, spec, "rolled_back", "Watchdog auto-rollback: app was unhealthy for 5+ minutes.", "watchdog");

      const note = `"${w.appName}" in ${w.envKey} was unhealthy for 5+ minutes, so the watchdog AUTOMATICALLY ROLLED IT BACK to the previous version.`;
      await postEventToChatOps(w.projectId, "🛟", `Watchdog rolled back ${w.appName} → ${w.envKey}`, note).catch(() => {});
      await emailProjectMembers(w.projectId, `🛟 Watchdog rolled back — ${w.appName} → ${w.envKey}`, note).catch(() => {});
    } else {
      // No previous revision to revert to → stop retrying every tick; notify once.
      await prisma.deployWatch.update({ where: { id: w.id }, data: { enabled: false, lastCheckedAt: now } }).catch(() => {});
      const note = `"${w.appName}" in ${w.envKey} has been unhealthy for 5+ minutes but the watchdog could NOT auto-roll-back (${rb.error}). Check the pod logs — it has no previous good version to revert to.`;
      await postEventToChatOps(w.projectId, "⚠️", `Watchdog: ${w.appName} unhealthy, no rollback`, note).catch(() => {});
      await emailProjectMembers(w.projectId, `⚠️ ${w.appName} unhealthy — no version to roll back to`, note).catch(() => {});
    }
  }

  return acted;
}
