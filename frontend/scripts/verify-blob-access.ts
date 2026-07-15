/**
 * Verify the SP can actually reach the state blob container via AAD (the exact
 * auth Terraform's azurerm backend uses). Confirms whether the Blob Data
 * Contributor role has propagated, and prints the SP oid the backend acts as.
 *
 *   npx tsx scripts/verify-blob-access.ts <projectSlug> <envKey>
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

function decode(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
}

async function main() {
  const slug = process.argv[2];
  const envKey = process.argv[3];
  const clientId = process.env.AZURE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.AZURE_OAUTH_CLIENT_SECRET!;

  const { prisma } = await import("../src/lib/db/prisma");
  const project = await prisma.project.findFirst({ where: { slug }, select: { id: true } });
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: project!.id, key: envKey } },
    select: {
      cloudProviderId: true,
      tfBackendAzureStorageAccount: true,
      tfBackendAzureContainer: true,
    },
  });
  const sa = env!.tfBackendAzureStorageAccount!;
  const container = env!.tfBackendAzureContainer!;
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: env!.cloudProviderId! },
    select: { accountRef: true, accountId: true },
  });
  const sub = cp!.accountRef;
  const tenant = cp!.accountId!;

  // SP token scoped to STORAGE (blob data plane audience).
  const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://storage.azure.com/.default",
    }),
  });
  const tok = ((await tokRes.json()) as { access_token?: string }).access_token;
  if (!tok) {
    console.error("Could not get a storage-scoped token.");
    process.exit(1);
  }
  const claims = decode(tok);
  console.log(`SP oid in token: ${claims.oid}`);
  console.log(`token audience:  ${claims.aud}`);

  // Try an AAD blob operation: list blobs in the container.
  const url = `https://${sa}.blob.core.windows.net/${container}?restype=container&comp=list`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2021-08-06" },
  });
  console.log(`\nBlob container access (${sub}): HTTP ${res.status}`);
  if (res.ok) {
    console.log("  ✓ AAD blob access WORKS — role has propagated. Retry Terraform now.");
  } else {
    const t = await res.text();
    console.log(`  ✗ ${t.slice(0, 200)}`);
    console.log("  → Role not propagated yet. Wait a few more minutes and re-run this.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
