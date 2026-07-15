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
  const { prisma } = await import("../src/lib/db/prisma");
  const runs = await prisma.tfRun.findMany({
    where: { envKey: "release" },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { name: true, createdAt: true, sourceBackend: true, cloudProviderId: true },
  });
  for (const r of runs) {
    console.log(`${r.createdAt.toISOString()}  ${r.name}`);
    console.log(`   backend: ${JSON.stringify(r.sourceBackend)}`);
    console.log(`   cloudProviderId: ${r.cloudProviderId}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
