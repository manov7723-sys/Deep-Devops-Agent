/**
 * Strip availability-zone attributes from the latest run's saved Terraform so a
 * Rerun works on subscriptions/regions that don't support zones.
 *   npx tsx scripts/patch-run-remove-zones.ts <envKey>
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
  const run = await prisma.tfRun.findFirst({
    where: { envKey },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, sourceFiles: true },
  });
  if (!run) {
    console.error("No run found.");
    process.exit(1);
  }
  const files = run.sourceFiles as unknown as Record<string, string>;
  let changed = 0;
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    // Remove any line that assigns zones = ["1", "2", "3"] (system + user pools).
    const next = content
      .split("\n")
      .filter((l) => !/^\s*zones\s*=\s*\[/.test(l))
      .join("\n");
    if (next !== content) changed++;
    out[path] = next;
  }
  await prisma.tfRun.update({ where: { id: run.id }, data: { sourceFiles: out as never } });
  console.log(`✓ Patched run "${run.name}" — removed zones from ${changed} file(s).`);
  console.log("Rerun this run; the cluster will create without availability zones.");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
