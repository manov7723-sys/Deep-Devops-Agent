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

  // 1. vCPU quota in eastus
  const usage = await fetch(`https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Compute/locations/eastus/usages?api-version=2023-07-01`, { headers: H });
  const uj = (await usage.json()) as { value?: Array<{ name: { value: string }; currentValue: number; limit: number }> };
  const totalCores = uj.value?.find((u) => u.name.value === "cores");
  console.log(`Regional vCPU quota (eastus): ${totalCores?.currentValue}/${totalCores?.limit} used`);
  const families = (uj.value ?? []).filter((u) => /Family/.test(u.name.value) && u.limit > 0);
  console.log(`\nVM families WITH quota (limit > 0):`);
  for (const f of families.slice(0, 30)) console.log(`  ${f.name.value}: ${f.currentValue}/${f.limit}`);

  // 2. Candidate small sizes — check restrictions
  const candidates = ["Standard_D2s_v3", "Standard_D2as_v4", "Standard_D2s_v5", "Standard_B2s", "Standard_A2_v2", "Standard_DS2_v2", "Standard_D2as_v5"];
  const skuRes = await fetch(`https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq 'eastus'`, { headers: H });
  const skuJson = (await skuRes.json()) as { value?: Array<{ name: string; resourceType: string; restrictions?: Array<{ reasonCode: string }> }> };
  const vms = (skuJson.value ?? []).filter((s) => s.resourceType === "virtualMachines");
  console.log(`\nCandidate small VM sizes (available = no restrictions):`);
  for (const c of candidates) {
    const sku = vms.find((s) => s.name === c);
    if (!sku) { console.log(`  ${c}: NOT in region`); continue; }
    const restricted = (sku.restrictions ?? []).length > 0;
    console.log(`  ${c}: ${restricted ? "RESTRICTED (" + sku.restrictions!.map((x) => x.reasonCode).join(",") + ")" : "AVAILABLE ✓"}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
