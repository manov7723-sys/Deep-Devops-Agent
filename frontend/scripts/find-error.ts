import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}
async function main() {
  const { prisma } = await import("../src/lib/db/prisma");
  const r = await prisma.tfRun.findFirst({ where: { envKey: "release" }, orderBy: { createdAt: "desc" }, select: { name: true, status: true, errorMessage: true, stages: true } });
  console.log("Run:", r!.name, "status:", r!.status, "err:", r!.errorMessage);
  const stages = r!.stages as Array<{name: string; status: string; logs?: string; exitCode?: number}>;
  for (const s of stages) {
    console.log(`\n=== ${s.name} (${s.status}) exit=${s.exitCode ?? "?"} ===`);
    const logs = s.logs || "";
    // Extract any "Error:" blocks
    const errors = logs.match(/Error:[\s\S]{0,600}/g) || [];
    for (const e of errors) console.log("ERROR:", e.slice(0, 600));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
