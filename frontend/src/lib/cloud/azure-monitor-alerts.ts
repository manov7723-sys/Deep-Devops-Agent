/**
 * Bridge Azure Monitor (AKS) alert state into the app's Alerts section — the
 * Azure counterpart of cloudwatch-alerts.ts. We read which of our AKS metric
 * alerts are firing and mirror them into the Alert table: Fired → an open
 * Alert; cleared → that Alert resolved. Keyed by sourceLabel `az:<alertName>`
 * so we never duplicate. Creating an Alert also fires the banner + email.
 */
import { prisma } from "@/lib/db/prisma";
import { createAlert, patchAlertStatus } from "@/lib/agentops/alerts";
import { describeAksAlertStates, type AzureAlarmState } from "./azure-monitor";

export type AzureSyncResult =
  | { ok: true; firing: number; opened: number; resolved: number; alarms: AzureAlarmState[] }
  | { ok: false; error: string };

export async function syncAksAlarmsToAlerts(opts: {
  projectId: string;
  envId: string;
  cloudProviderId: string;
  clusterName: string;
  resourceGroup?: string;
}): Promise<AzureSyncResult> {
  const states = await describeAksAlertStates(
    opts.cloudProviderId,
    opts.clusterName,
    opts.resourceGroup,
  );
  if (!states.ok) return { ok: false, error: states.error };

  const existing = await prisma.alert.findMany({
    where: { projectId: opts.projectId, envId: opts.envId, sourceLabel: { startsWith: "az:" } },
    select: { id: true, sourceLabel: true, status: true },
  });

  let opened = 0;
  let resolvedCount = 0;
  for (const a of states.alarms) {
    const label = `az:${a.name}`;
    const open = existing.find((e) => e.sourceLabel === label && e.status !== "resolved");
    if (a.state === "ALARM" && !open) {
      await createAlert({
        projectId: opts.projectId,
        envId: opts.envId,
        title: a.name,
        detail: `Azure Monitor alert "${a.name}" is firing for AKS cluster ${opts.clusterName}.`,
        resource: "AKS cluster",
        sourceLabel: label,
        category: "Performance",
        severity: "high",
        recommendation:
          "A node/cluster metric crossed its threshold — check load and scale the node pool if needed.",
      });
      opened++;
    } else if (a.state === "OK" && open) {
      await patchAlertStatus(opts.projectId, open.id, "resolved");
      resolvedCount++;
    }
  }

  return {
    ok: true,
    firing: states.alarms.filter((s) => s.state === "ALARM").length,
    opened,
    resolved: resolvedCount,
    alarms: states.alarms,
  };
}
