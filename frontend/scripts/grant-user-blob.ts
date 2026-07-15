import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const BLOB = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

async function main() {
  const sub = "5a820100-3072-4fa7-a72d-495f6d5f0526";
  const rg = "rg-devops";
  const sa = "agentaccountsub";
  const { prisma } = await import("../src/lib/db/prisma");
  const { getAzureAccessToken } = await import("../src/lib/cloud/azure");

  const cp = await prisma.cloudProvider.findFirst({
    where: { kind: "azure", accountRef: sub },
    select: { id: true },
  });
  const tok = await getAzureAccessToken(cp!.id);
  if (!tok.ok) {
    console.error("token fail", tok.error);
    process.exit(1);
  }
  const claims = JSON.parse(Buffer.from(tok.accessToken.split(".")[1], "base64").toString("utf8"));
  console.log(`ARM token identity → oid=${claims.oid}  appid=${claims.appid || claims.azp || "(none)"}  upn=${claims.upn || claims.unique_name || "(none)"}`);
  const oid = claims.oid;

  const scope = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${sa}`;
  const h = createHash("sha256").update(`${oid}:${scope}:blob`).digest("hex");
  const name = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=2022-04-01`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${BLOB}`,
        principalId: oid,
      },
    }),
  });
  const t = await res.text();
  console.log(res.ok ? "✓ blob role granted to this identity" : /exists/i.test(t) ? "✓ already had it" : `✗ ${res.status} ${t.slice(0, 200)}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
