/**
 * Next.js instrumentation — runs once when the server starts. We use it to boot
 * the in-process background scheduler (uptime + cert checks). Node runtime only
 * (the scheduler uses node APIs); never runs on the edge or during the browser.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // All Node-only startup (IPv4-first DNS + the scheduler) lives in a separate
  // file so the Edge bundle never statically sees node: imports.
  await import("./instrumentation-node");
}
