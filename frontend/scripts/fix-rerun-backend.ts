/**
 * Repoint the persisted sourceBackend of past Terraform runs away from the
 * reserved "$logs" container to the real "tfstate" container, so Rerun (which
 * replays the saved backend snapshot, NOT the env's current config) stops
 * hitting the $logs system container that rejects all writes.
 *
 *   npx tsx scripts/fix-rerun-backend.ts <projectSlug> <envKey> [container]
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
  const container = process.argv[4] || "tfstate";
  const { prisma } = await import("../src/lib/db/prisma");

  const project = await prisma.project.findFirst({ where: { slug }, select: { id: true } });
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: project!.id, key: envKey } },
    select: {
      id: true,
      tfBackendAzureResourceGroup: true,
      tfBackendAzureStorageAccount: true,
      tfBackendAzureContainer: true,
    },
  });
  console.log(
    `Env backend (source of truth): rg=${env!.tfBackendAzureResourceGroup} sa=${env!.tfBackendAzureStorageAccount} container=${env!.tfBackendAzureContainer}\n`,
  );

  const runs = await prisma.tfRun.findMany({
    where: { envId: env!.id },
    select: { id: true, name: true, sourceBackend: true },
  });

  let fixed = 0;
  for (const r of runs) {
    const b = r.sourceBackend as Record<string, unknown> | null;
    if (!b || b.kind !== "azurerm") continue;
    const before = b.container;
    const next = {
      ...b,
      resourceGroup: env!.tfBackendAzureResourceGroup ?? b.resourceGroup,
      storageAccount: env!.tfBackendAzureStorageAccount ?? b.storageAccount,
      container,
    };
    if (JSON.stringify(before) === JSON.stringify(container) && b.container === container) continue;
    await prisma.tfRun.update({
      where: { id: r.id },
      data: { sourceBackend: next as never },
    });
    console.log(`  ${r.name}: container "${before}" → "${container}"`);
    fixed++;
  }
  console.log(`\n✓ Updated ${fixed} run(s). Reruns will now use the "${container}" container.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
