/**
 * Next.js instrumentation — runs once when the server starts. We use it to boot
 * the in-process background scheduler (uptime + cert checks). Node runtime only
 * (the scheduler uses node APIs); never runs on the edge or during the browser.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("@/lib/scheduler/scheduler");
  startScheduler();
}
