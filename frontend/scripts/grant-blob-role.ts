/**
 * Grant the app's Service Principal the "Storage Blob Data Contributor" role on
 * the state storage account, so AAD-based blob access (what Terraform's azurerm
 * backend uses) works. Fully automatic:
 *   • SP object id  ← decoded from the SP's own client-credentials token (`oid`)
 *   • role write    ← performed with the USER's Owner token (OAuth refresh)
 * No Graph, no portal.
 *
 *   npx tsx scripts/grant-blob-role.ts <projectSlug> <envKey>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = val;
}

const BLOB_DATA_CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

function decodeOid(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
    return payload.oid ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const slug = process.argv[2];
  const envKey = process.argv[3];
  const clientId = process.env.AZURE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.AZURE_OAUTH_CLIENT_SECRET!;

  const { prisma } = await import("../src/lib/db/prisma");
  const { getAzureAccessToken } = await import("../src/lib/cloud/azure");

  const project = await prisma.project.findFirst({ where: { slug }, select: { id: true } });
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: project!.id, key: envKey } },
    select: {
      cloudProviderId: true,
      tfBackendAzureResourceGroup: true,
      tfBackendAzureStorageAccount: true,
    },
  });
  const cpId = env!.cloudProviderId!;
  const rg = env!.tfBackendAzureResourceGroup!;
  const sa = env!.tfBackendAzureStorageAccount!;
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cpId },
    select: { accountRef: true, accountId: true },
  });
  const sub = cp!.accountRef;
  const tenant = cp!.accountId!;

  // 1 — SP object id from its own client-credentials token.
  const spTokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://management.azure.com/.default",
    }),
  });
  const spTok = ((await spTokRes.json()) as { access_token?: string }).access_token;
  const spObjectId = spTok ? decodeOid(spTok) : null;
  if (!spObjectId) {
    console.error("Could not resolve the app's service-principal object id.");
    process.exit(1);
  }
  console.log(`SP object id: ${spObjectId}`);

  // 2 — USER (Owner) token to write the role assignment.
  const userTok = await getAzureAccessToken(cpId);
  if (!userTok.ok) {
    console.error(`Could not get an ARM token for the role write: ${userTok.error}`);
    process.exit(1);
  }

  const scope = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${sa}`;
  const name = (() => {
    const h = createHash("sha256").update(`${spObjectId}:${scope}:blob`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  })();
  const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=2022-04-01`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${userTok.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${BLOB_DATA_CONTRIBUTOR}`,
        principalId: spObjectId,
        principalType: "ServicePrincipal",
      },
    }),
  });
  const txt = await res.text();
  if (!res.ok && !/RoleAssignmentExists|already exists/i.test(txt)) {
    console.error(`Role assignment FAILED (${res.status}): ${txt.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`✓ "Storage Blob Data Contributor" granted to the app on ${sa}.`);
  console.log("  (RBAC can take ~1–2 min to propagate, then retry Terraform.)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
