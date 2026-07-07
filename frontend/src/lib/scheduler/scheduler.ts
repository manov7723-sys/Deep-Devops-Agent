/**
 * In-process background scheduler. Runs inside the server process so periodic
 * checks (uptime + TLS cert expiry) happen 24/7 — even with no browser open —
 * for as long as the server is running. Started once from instrumentation.
 *
 * Extensible: add more due-based jobs to the tick (scheduled scans, cost checks).
 */
import { runAllDueUptimeChecks } from "@/lib/observability/uptime";
import { runDueScheduledDeploys } from "@/lib/devops/scheduled-deploy";
import { runDeployWatchdog } from "@/lib/devops/deploy-watch";

const TICK_MS = 60_000; // evaluate what's due once a minute
let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;
  // eslint-disable-next-line no-console
  console.log("[scheduler] started — uptime + cert checks, scheduled deploys, and the deploy watchdog run every 60s in the background");

  const tick = async () => {
    try {
      const now = new Date();
      const ran = await runAllDueUptimeChecks(now);
      if (ran > 0) {
        // eslint-disable-next-line no-console
        console.log(`[scheduler] ran ${ran} uptime check${ran === 1 ? "" : "s"}`);
      }
      const deployed = await runDueScheduledDeploys(now);
      if (deployed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[scheduler] ran ${deployed} scheduled deploy${deployed === 1 ? "" : "s"}`);
      }
      const rolledBack = await runDeployWatchdog(now);
      if (rolledBack > 0) {
        // eslint-disable-next-line no-console
        console.log(`[scheduler] watchdog auto-rolled-back ${rolledBack} app${rolledBack === 1 ? "" : "s"}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[scheduler] tick error:", e instanceof Error ? e.message : e);
    }
  };

  // First run shortly after boot, then on the interval.
  setTimeout(tick, 10_000);
  const handle = setInterval(tick, TICK_MS);
  // Don't keep the process alive just for the timer (lets build/exit finish).
  if (typeof handle.unref === "function") handle.unref();
}
