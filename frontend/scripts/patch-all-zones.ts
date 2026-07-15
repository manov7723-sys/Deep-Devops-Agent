import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}
async function main() {
  const { prisma } = await import("../src/lib/db/prisma");
  const runs = await prisma.tfRun.findMany({ where: { envKey: "release" }, select: { id: true, name: true, sourceFiles: true } });
  let patched = 0;
  for (const run of runs) {
    const files = run.sourceFiles as unknown as Record<string, string> | null;
    if (!files) continue;
    const out: Record<string, string> = {}; let changed = false;
    for (const [p, c] of Object.entries(files)) {
      const next = c.split("\n").filter((l) => !/^\s*zones\s*=\s*\[/.test(l)).join("\n");
      if (next !== c) changed = true; out[p] = next;
    }
    if (changed) { await prisma.tfRun.update({ where: { id: run.id }, data: { sourceFiles: out as never } }); patched++; }
  }
  console.log(`Patched ${patched}/${runs.length} run(s) to remove availability zones.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
