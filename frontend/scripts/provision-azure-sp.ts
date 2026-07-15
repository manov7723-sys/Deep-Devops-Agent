/**
 * One-shot: provision (or repair) the hybrid Service Principal for an Azure
 * OAuth provider directly from its STORED refresh token — no reconnect needed.
 *
 *   npx tsx scripts/provision-azure-sp.ts <subscriptionId>
 *
 * On success it writes spClientId + spClientSecretEnc onto the CloudProvider
 * row, which is exactly what a fresh "Sign in with Microsoft" would have done
 * when AZURE_OAUTH_GRAPH_ENABLED=true. On failure it prints the precise Azure
 * error (missing Graph consent, not-Owner, etc.) so we know what to fix.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env.local into process.env BEFORE importing anything that reads env.
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let val = m[2].trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = val;
}

async function main() {
  const sub = process.argv[2];
  if (!sub) {
    console.error("Usage: npx tsx scripts/provision-azure-sp.ts <subscriptionId>");
    process.exit(1);
  }

  const { prisma } = await import("../src/lib/db/prisma");
  const { decryptSecret, encryptSecret } = await import("../src/lib/auth/crypto");
  const { getAzureAccessToken } = await import("../src/lib/cloud/azure");
  const { autoProvisionSpFromOAuth } = await import("../src/lib/cloud/azure-provision-sp");

  const cp = await prisma.cloudProvider.findFirst({
    where: { kind: "azure", accountRef: sub },
    select: { id: true, name: true, accountRef: true, accountId: true, externalId: true },
  });
  if (!cp) {
    console.error(`No Azure provider found for subscription ${sub}.`);
    process.exit(1);
  }
  console.log(`Provider: ${cp.name}  (id=${cp.id})`);
  console.log(`  subscription: ${cp.accountRef}`);
  console.log(`  tenant:       ${cp.accountId}`);

  if (!cp.externalId) {
    console.error("Provider has no stored refresh token — reconnect via Sign in with Microsoft.");
    process.exit(1);
  }
  if (!cp.accountId) {
    console.error("Provider has no tenant id — reconnect and pass the Tenant ID.");
    process.exit(1);
  }

  // ARM token (user-delegated) — needed to write the Contributor role assignment.
  console.log("\nMinting ARM token from the stored refresh token…");
  const arm = await getAzureAccessToken(cp.id, cp.accountId);
  if (!arm.ok) {
    console.error(`  FAILED to get ARM token: ${arm.error}`);
    process.exit(1);
  }
  console.log("  ARM token OK.");

  const refreshToken = decryptSecret(cp.externalId);

  console.log("\nProvisioning the Service Principal via Microsoft Graph…");
  const sp = await autoProvisionSpFromOAuth({
    oauthRefreshToken: refreshToken,
    userArmAccessToken: arm.accessToken,
    tenantId: cp.accountId,
    subscriptionId: cp.accountRef,
    displayNameHint: `deepagent-${cp.accountRef.slice(0, 8)}`,
  });

  if (!sp.ok) {
    console.error(`\n  ✗ SP provisioning FAILED:\n    ${sp.error}\n`);
    console.error("  Fix the above in the Azure portal, then re-run this script.");
    process.exit(1);
  }

  await prisma.cloudProvider.update({
    where: { id: cp.id },
    data: {
      spClientId: sp.data.clientId,
      spClientSecretEnc: encryptSecret(sp.data.clientSecret),
    },
  });

  console.log(`\n  ✓ Service Principal provisioned and stored.`);
  console.log(`    app:      ${sp.data.appDisplayName}`);
  console.log(`    clientId: ${sp.data.clientId}`);
  console.log(`\nTerraform will now authenticate as this SP against subscription ${cp.accountRef}.`);
  console.log("Re-run the Terraform apply from the Infra tab.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
