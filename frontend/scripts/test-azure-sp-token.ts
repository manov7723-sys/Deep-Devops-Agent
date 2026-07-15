/**
 * Test whether agnet-app can authenticate to the new tenant/subscription via
 * client-credentials (its own client id + secret) — the Graph-free SP path.
 *
 *   npx tsx scripts/test-azure-sp-token.ts <tenantId> <subscriptionId>
 *
 * If this prints subscriptions, we can wire agnet-app as the SP for the
 * provider row and Terraform will authenticate with no Graph consent needed.
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
  const tenant = process.argv[2];
  const sub = process.argv[3];
  const clientId = process.env.AZURE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.AZURE_OAUTH_CLIENT_SECRET!;

  console.log(`Testing client-credentials for app ${clientId}`);
  console.log(`  tenant:       ${tenant}`);
  console.log(`  subscription: ${sub}\n`);

  // 1 — client-credentials token for ARM.
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://management.azure.com/.default",
  });
  const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokJson = (await tokRes.json()) as { access_token?: string; error_description?: string };
  if (!tokRes.ok || !tokJson.access_token) {
    console.error(`  ✗ Token request failed: ${tokJson.error_description || tokRes.status}`);
    process.exit(1);
  }
  console.log("  ✓ Got an ARM access token via client-credentials.\n");

  // 2 — can it SEE the subscription? (needs a Contributor/Reader role assignment)
  const subRes = await fetch(
    `https://management.azure.com/subscriptions/${sub}?api-version=2020-01-01`,
    { headers: { Authorization: `Bearer ${tokJson.access_token}` } },
  );
  if (subRes.ok) {
    const s = (await subRes.json()) as { displayName?: string; state?: string };
    console.log(`  ✓ Subscription visible: ${s.displayName} (${s.state})`);
    console.log("\n  SP path is READY — the app already has a role on this subscription.");
  } else {
    console.log(`  ⚠ Token works, but subscription not visible yet (HTTP ${subRes.status}).`);
    console.log(
      "\n  → Assign agnet-app the 'Contributor' role on the subscription, then re-run.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
