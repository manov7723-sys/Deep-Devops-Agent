/**
 * Bridge CloudWatch alarm state into the app's Alerts section.
 *
 * CloudWatch alarms live in AWS; to surface them in-app we poll their state
 * (describe-alarms) and mirror firing alarms into the Alert table: an alarm in
 * ALARM → an open Alert; back to OK → that Alert resolved. Alerts are keyed by
 * sourceLabel `cw:<alarmName>` so we never duplicate.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { createAlert, patchAlertStatus } from "@/lib/agentops/alerts";
import { describeEksAlarmStates, type AlarmState } from "@/lib/cloud/cloudwatch";

export type SyncResult =
  | { ok: true; firing: number; opened: number; resolved: number; alarms: AlarmState[] }
  | { ok: false; error: string };

export async function syncEksAlarmsToAlerts(opts: {
  projectId: string;
  envId: string;
  cloudProviderId: string;
  clusterName: string;
  region?: string;
}): Promise<SyncResult> {
  const resolved = await resolveAwsExecEnv(opts.cloudProviderId);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  const region = (opts.region || resolved.region).trim();

  const states = await describeEksAlarmStates(resolved.env, region, opts.clusterName);
  if (!states.ok) return { ok: false, error: states.error };

  const existing = await prisma.alert.findMany({
    where: { projectId: opts.projectId, envId: opts.envId, sourceLabel: { startsWith: "cw:" } },
    select: { id: true, sourceLabel: true, status: true },
  });

  let opened = 0;
  let resolvedCount = 0;
  for (const a of states.alarms) {
    const label = `cw:${a.name}`;
    const open = existing.find((e) => e.sourceLabel === label && e.status !== "resolved");
    if (a.state === "ALARM" && !open) {
      const isStatus = /-status-/.test(a.name);
      await createAlert({
        projectId: opts.projectId,
        envId: opts.envId,
        title: a.name,
        detail: `CloudWatch alarm "${a.name}" is in ALARM for EKS cluster ${opts.clusterName}.`,
        resource: "EKS cluster",
        sourceLabel: label,
        category: isStatus ? "Reliability" : "Performance",
        severity: "high",
        recommendation: isStatus
          ? "A worker node failed its EC2 status check — investigate or replace the node."
          : "A node/cluster resource crossed its threshold — check load and scale if needed.",
      });
      opened++;
    } else if (a.state === "OK" && open) {
      await patchAlertStatus(opts.projectId, open.id, "resolved");
      resolvedCount++;
    }
  }
  return { ok: true, firing: states.alarms.filter((s) => s.state === "ALARM").length, opened, resolved: resolvedCount, alarms: states.alarms };
}
