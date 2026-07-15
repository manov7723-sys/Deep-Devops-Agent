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
  const sub = "5a820100-3072-4fa7-a72d-495f6d5f0526";
  const tenant = "f98ed8f4-9548-4806-b07e-0eae8776215b";
  const cid = process.env.AZURE_OAUTH_CLIENT_ID!;
  const cs = process.env.AZURE_OAUTH_CLIENT_SECRET!;
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cid, client_secret: cs, grant_type: "client_credentials", scope: "https://management.azure.com/.default" }),
  });
  const tok = ((await r.json()) as { access_token?: string }).access_token!;
  const H = { Authorization: `Bearer ${tok}` };

  // List all resources in rg-devops
  const res = await fetch(`https://management.azure.com/subscriptions/${sub}/resourceGroups/rg-devops/resources?api-version=2021-04-01`, { headers: H });
  const j = (await res.json()) as { value?: Array<{ name: string; type: string }> };
  console.log("Resources in rg-devops:");
  for (const r of j.value ?? []) console.log(`  ${r.type}  ${r.name}`);

  // Specifically the AKS cluster "dev"
  const aks = await fetch(`https://management.azure.com/subscriptions/${sub}/resourceGroups/rg-devops/providers/Microsoft.ContainerService/managedClusters/dev?api-version=2024-05-01`, { headers: H });
  if (aks.ok) {
    const a = (await aks.json()) as { properties?: { provisioningState?: string; powerState?: { code?: string } } };
    console.log(`\nAKS "dev": provisioningState=${a.properties?.provisioningState}  power=${a.properties?.powerState?.code}`);
  } else {
    console.log(`\nAKS "dev": NOT found (HTTP ${aks.status})`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
