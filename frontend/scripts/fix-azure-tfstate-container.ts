/**
 * Fix a mis-configured azurerm state container: create a normal blob container
 * (default "tfstate") via the ARM management plane and repoint the env's
 * backend at it. Needed because the env was pointed at "$logs", a reserved
 * Azure system container that rejects state writes.
 *
 *   npx tsx scripts/fix-azure-tfstate-container.ts <projectSlug> <envKey> [containerName]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = val;
}

async function main() {
  const slug = process.argv[2];
  const envKey = process.argv[3];
  const container = process.argv[4] || "tfstate";
  if (!slug || !envKey) {
    console.error(
      "Usage: npx tsx scripts/fix-azure-tfstate-container.ts <projectSlug> <envKey> [container]",
    );
    process.exit(1);
  }

  const { prisma } = await import("../src/lib/db/prisma");
  const { getAzureAccessToken } = await import("../src/lib/cloud/azure");

  const project = await prisma.project.findFirst({ where: { slug }, select: { id: true } });
  if (!project) {
    console.error(`Project ${slug} not found.`);
    process.exit(1);
  }
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: project.id, key: envKey } },
    select: {
      id: true,
      cloudProviderId: true,
      tfBackendAzureResourceGroup: true,
      tfBackendAzureStorageAccount: true,
      tfBackendAzureContainer: true,
    },
  });
  if (!env?.cloudProviderId) {
    console.error(`Env ${envKey} has no cloud provider.`);
    process.exit(1);
  }
  const rg = env.tfBackendAzureResourceGroup;
  const sa = env.tfBackendAzureStorageAccount;
  console.log(`Current backend: rg=${rg}  storage=${sa}  container=${env.tfBackendAzureContainer}`);
  if (!rg || !sa) {
    console.error("Backend resource group / storage account not set on the env.");
    process.exit(1);
  }

  const cp = await prisma.cloudProvider.findUnique({
    where: { id: env.cloudProviderId },
    select: { accountRef: true },
  });
  const sub = cp?.accountRef;
  const tok = await getAzureAccessToken(env.cloudProviderId);
  if (!tok.ok) {
    console.error(`Could not get ARM token: ${tok.error}`);
    process.exit(1);
  }

  // Create the container via ARM management plane (Contributor can do this).
  const url =
    `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Storage/storageAccounts/${sa}/blobServices/default/containers/${container}` +
    `?api-version=2023-01-01`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { publicAccess: "None" } }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`Creating container "${container}" failed (${res.status}): ${t.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✓ Container "${container}" ready in ${sa}.`);

  await prisma.env.update({
    where: { id: env.id },
    data: { tfBackendAzureContainer: container },
  });
  console.log(`✓ Env "${envKey}" backend now points at container "${container}".`);
  console.log("\nRetry the Terraform apply.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
