/**
 * Check whether the Terraform azurerm backend (resource group + storage
 * account + container) exists in the target subscription, using the app's SP.
 *
 *   npx tsx scripts/check-azure-backend.ts <subscriptionId>
 *
 * Reads the env's stored backend names from the DB and probes ARM.
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
  const sub = process.argv[2];
  const tenant = process.env.AZURE_OAUTH_TENANT_ID_OVERRIDE || process.argv[3];
  const clientId = process.env.AZURE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.AZURE_OAUTH_CLIENT_SECRET!;

  const { prisma } = await import("../src/lib/db/prisma");
  const cp = await prisma.cloudProvider.findFirst({
    where: { kind: "azure", accountRef: sub },
    select: { accountId: true },
  });
  const tenantId = tenant || cp?.accountId;
  if (!tenantId) {
    console.error("No tenant id.");
    process.exit(1);
  }

  // Find the env(s) using this provider and read their azurerm backend names.
  const envs = await prisma.env.findMany({
    where: { cloudProvider: { accountRef: sub } },
    select: {
      key: true,
      tfBackendAzureResourceGroup: true,
      tfBackendAzureStorageAccount: true,
      tfBackendAzureContainer: true,
    },
  });

  // Client-credentials ARM token.
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://management.azure.com/.default",
  });
  const tokRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tok = ((await tokRes.json()) as { access_token?: string }).access_token;
  if (!tok) {
    console.error("Could not get ARM token.");
    process.exit(1);
  }
  const H = { Authorization: `Bearer ${tok}` };

  for (const e of envs) {
    const rg = e.tfBackendAzureResourceGroup;
    const sa = e.tfBackendAzureStorageAccount;
    const c = e.tfBackendAzureContainer;
    console.log(`\nEnv "${e.key}" backend:  rg=${rg}  storage=${sa}  container=${c}`);
    if (!rg || !sa) {
      console.log("  ⚠ backend not fully configured on this env.");
      continue;
    }
    const rgRes = await fetch(
      `https://management.azure.com/subscriptions/${sub}/resourcegroups/${rg}?api-version=2021-04-01`,
      { headers: H },
    );
    console.log(`  resource group "${rg}": ${rgRes.ok ? "EXISTS ✓" : `MISSING ✗ (${rgRes.status})`}`);
    const saRes = await fetch(
      `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${sa}?api-version=2023-01-01`,
      { headers: H },
    );
    console.log(`  storage account "${sa}": ${saRes.ok ? "EXISTS ✓" : `MISSING ✗ (${saRes.status})`}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
