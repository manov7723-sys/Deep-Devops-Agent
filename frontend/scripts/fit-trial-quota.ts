/**
 * One-shot: rewrite the latest saved Terraform run to fit inside Azure's
 * 4-vCPU trial quota — removes availability zones (unsupported on trial subs)
 * and downgrades any oversized VM SKUs to Standard_B2s (2 vCPU), then trims
 * node counts so a system pool + tiny app pool fits in 4 vCPUs total:
 *
 *   system pool: 1 node × Standard_B2s = 2 vCPU
 *   app pool:    1 node × Standard_B2s = 2 vCPU
 *                                        ─────────
 *                                        4 vCPU ← exactly at cap
 *
 *   npx tsx scripts/fit-trial-quota.ts <envKey>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

async function main() {
  const envKey = process.argv[2] || "release";
  const { prisma } = await import("../src/lib/db/prisma");

  const runs = await prisma.tfRun.findMany({
    where: { envKey },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, name: true, sourceFiles: true },
  });

  for (const run of runs) {
    const files = run.sourceFiles as Record<string, string>;
    if (!files) continue;
    const out: Record<string, string> = {};
    let changed = false;

    for (const [path, content] of Object.entries(files)) {
      let next = content;
      // 1. Strip `zones = [...]` — trial subs don't support them.
      next = next.replace(/^\s*zones\s*=\s*\[[^\]]*\]\s*$/gm, "");
      // 2. Replace ANY vm_size with Standard_B2s.
      next = next.replace(/vm_size\s*=\s*"[^"]+"/g, 'vm_size                      = "Standard_B2s"');
      // 3. Trim node counts to fit 4-vCPU cap.
      next = next.replace(/node_count\s*=\s*\d+/g, "node_count                   = 1");
      next = next.replace(/min_count\s*=\s*\d+/g, "min_count                    = 1");
      next = next.replace(/max_count\s*=\s*\d+/g, "max_count                    = 2");
      if (next !== content) changed = true;
      out[path] = next;
    }
    if (changed) {
      await prisma.tfRun.update({ where: { id: run.id }, data: { sourceFiles: out as never } });
      console.log(`✓ Patched ${run.name}`);
    } else {
      console.log(`  ${run.name} already OK`);
    }
  }
  console.log("\nRerun the latest run — it now fits in the 4-vCPU trial quota with no zones.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
