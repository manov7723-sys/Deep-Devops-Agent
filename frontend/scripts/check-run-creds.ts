/**
 * Show exactly which env vars the Terraform runner will hand the azurerm
 * backend/provider for an env's cloud provider — i.e. whether ARM_CLIENT_ID
 * (Service Principal) is being set, or nothing (→ Terraform falls back to az CLI).
 *
 *   npx tsx scripts/check-run-creds.ts <projectSlug> <envKey>
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
  const { prisma } = await import("../src/lib/db/prisma");
  const { getDecryptedCloudCreds } = await import("../src/lib/runner/creds");
  const { getDecryptedAzureCreds } = await import("../src/lib/cloud/azure");

  const project = await prisma.project.findFirst({ where: { slug }, select: { id: true } });
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: project!.id, key: envKey } },
    select: { cloudProviderId: true },
  });
  const cpId = env!.cloudProviderId!;
  console.log(`cloudProviderId: ${cpId}\n`);

  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cpId },
    select: { spClientId: true, spClientSecretEnc: true, roleArn: true, externalId: true, accountId: true, accountRef: true },
  });
  console.log("Provider row:");
  console.log(`  spClientId:        ${cp!.spClientId ?? "(null)"}`);
  console.log(`  spClientSecretEnc: ${cp!.spClientSecretEnc ? "(set)" : "(null)"}`);
  console.log(`  accountId(tenant): ${cp!.accountId}`);
  console.log(`  accountRef(sub):   ${cp!.accountRef}\n`);

  const azCreds = await getDecryptedAzureCreds(cpId);
  console.log(`getDecryptedAzureCreds: ${azCreds.ok ? "OK" : `FAIL (${azCreds.error})`}`);

  const creds = await getDecryptedCloudCreds(cpId);
  if (!creds.ok) {
    console.log(`getDecryptedCloudCreds FAILED: ${creds.message}`);
    process.exit(1);
  }
  console.log("\nEnv vars handed to Terraform:");
  for (const k of Object.keys(creds.env)) {
    const v = creds.env[k];
    const masked = /SECRET|KEY|TOKEN/i.test(k) ? "***" : v;
    console.log(`  ${k} = ${masked}`);
  }
  if (!creds.env.ARM_CLIENT_ID) {
    console.log("\n  ⚠ ARM_CLIENT_ID NOT set → Terraform will use host az CLI, NOT the SP.");
  } else {
    console.log("\n  ✓ ARM_CLIENT_ID set → Terraform should auth as the SP.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
