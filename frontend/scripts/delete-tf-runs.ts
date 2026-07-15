/**
 * Delete all Terraform runs for an env — clean slate.
 *   npx tsx scripts/delete-tf-runs.ts <projectSlug> <envKey>
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
  const slug = process.argv[2];
  const envKey = process.argv[3];
  const { prisma } = await import("../src/lib/db/prisma");
  const project = await prisma.project.findFirst({ where: { slug }, select: { id: true } });
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: project!.id, key: envKey } },
    select: { id: true },
  });
  const res = await prisma.tfRun.deleteMany({ where: { envId: env!.id } });
  console.log(`✓ Deleted ${res.count} Terraform run(s) for ${slug}/${envKey}.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
