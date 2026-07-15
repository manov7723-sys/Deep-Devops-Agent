import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}
async function main() {
  const { prisma } = await import("../src/lib/db/prisma");
  const r = await prisma.tfRun.findFirst({ where: { envKey: "release" }, orderBy: { createdAt: "desc" }, select: { name: true, status: true, sourceFiles: true, stages: true } });
  console.log("Run:", r!.name, "status:", r!.status);
  const files = r!.sourceFiles as Record<string, string>;
  for (const [p, c] of Object.entries(files)) {
    if (p.endsWith(".tf")) {
      const zones = (c.match(/zones\s*=\s*\[[^\]]*\]/g) || []).slice(0, 3);
      const nodeCounts = c.match(/(?:min_count|max_count|node_count)\s*=\s*\d+/g) || [];
      const vmSize = c.match(/vm_size\s*=\s*"[^"]+"/g) || [];
      console.log(`\n${p}:`);
      console.log(`  zones: ${zones.join(" | ") || "(none)"}`);
      console.log(`  vm_size: ${vmSize.join(", ")}`);
      console.log(`  node counts: ${nodeCounts.join(", ")}`);
    }
  }
  const stages = r!.stages as Array<{name: string; status: string; logs?: string}>;
  const applyLog = stages.find((s) => s.name === "apply")?.logs || "";
  const lastError = applyLog.match(/Error:[^\n]*/g)?.slice(-3) || [];
  console.log(`\nLast 3 errors: ${lastError.join(" | ")}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
