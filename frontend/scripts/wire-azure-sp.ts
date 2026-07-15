/**
 * Wire agnet-app (this deployment's own app registration) as the Service
 * Principal for an Azure OAuth provider row, so Terraform authenticates via
 * SP client-credentials against the CORRECT subscription — no reconnect, no
 * host `az cli` fallback.
 *
 *   npx tsx scripts/wire-azure-sp.ts <subscriptionId>
 *
 * Sets spClientId + spClientSecretEnc from AZURE_OAUTH_CLIENT_ID/SECRET.
 * Leaves externalId (the OAuth refresh token) intact, so delegated ops still
 * work; getDecryptedAzureCreds prefers the SP columns for Terraform.
 * Requires the app to already hold a role (e.g. Contributor) on the sub.
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
  if (!sub) {
    console.error("Usage: npx tsx scripts/wire-azure-sp.ts <subscriptionId>");
    process.exit(1);
  }
  const clientId = process.env.AZURE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.AZURE_OAUTH_CLIENT_SECRET!;

  const { prisma } = await import("../src/lib/db/prisma");
  const { encryptSecret } = await import("../src/lib/auth/crypto");

  const cp = await prisma.cloudProvider.findFirst({
    where: { kind: "azure", accountRef: sub },
    select: { id: true, name: true, accountId: true },
  });
  if (!cp) {
    console.error(`No Azure provider found for subscription ${sub}.`);
    process.exit(1);
  }

  await prisma.cloudProvider.update({
    where: { id: cp.id },
    data: {
      spClientId: clientId,
      spClientSecretEnc: encryptSecret(clientSecret),
      status: "ok",
    },
  });

  console.log(`✓ Wired SP into provider "${cp.name}" (${cp.id})`);
  console.log(`    subscription: ${sub}`);
  console.log(`    tenant:       ${cp.accountId}`);
  console.log(`    spClientId:   ${clientId}`);
  console.log(`\nTerraform will now authenticate as this app against ${sub}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
