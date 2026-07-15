/**
 * Nuclear patch: rewrite the LATEST run's main.tf to a trial-safe AKS config
 * by regenerating both node pool blocks. Handles cases where narrow regex
 * patches leave zones/vm_size/Spot behind because of subtle whitespace.
 *
 *   npx tsx scripts/nuke-bad-tf.ts <envKey>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const SAFE_SYSTEM_POOL = `  default_node_pool {
    name                         = "systempool"
    vm_size                      = "Standard_B2s"
    node_count                   = 1
    enable_auto_scaling          = true
    min_count                    = 1
    max_count                    = 2
    os_disk_size_gb              = 30
    os_disk_type                 = "Managed"
    max_pods                     = 50
    only_critical_addons_enabled = true
    tags                         = local.tags
  }`;

const SAFE_APP_POOL = `resource "azurerm_kubernetes_cluster_node_pool" "app" {
  name                  = "apppool"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.aks.id
  vm_size               = "Standard_B2s"
  enable_auto_scaling   = true
  min_count             = 1
  max_count             = 2
  node_labels = {
    role = "application"
    env  = "production"
  }
  tags = local.tags
}`;

async function main() {
  const envKey = process.argv[2] || "release";
  const { prisma } = await import("../src/lib/db/prisma");
  const run = await prisma.tfRun.findFirst({
    where: { envKey },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, sourceFiles: true },
  });
  if (!run) { console.error("no run"); process.exit(1); }

  const files = run.sourceFiles as Record<string, string>;
  const out: Record<string, string> = {};

  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith("main.tf")) { out[path] = content; continue; }
    let next = content;

    // Replace the entire default_node_pool { … } block inside the aks resource.
    next = next.replace(
      /  default_node_pool\s*\{[\s\S]*?^  \}/m,
      SAFE_SYSTEM_POOL,
    );

    // Replace the entire azurerm_kubernetes_cluster_node_pool "app" resource.
    next = next.replace(
      /resource\s+"azurerm_kubernetes_cluster_node_pool"\s+"app"\s*\{[\s\S]*?^\}/m,
      SAFE_APP_POOL,
    );

    out[path] = next;
  }

  await prisma.tfRun.update({ where: { id: run.id }, data: { sourceFiles: out as never } });
  console.log(`✓ Rewrote main.tf in run ${run.name}`);

  // Verify no residual bad values.
  const check = out["main.tf"] || "";
  const stillZones = check.includes('zones ');
  const stillM24 = check.includes('m24s_v3');
  const stillSpot = check.includes('"Spot"');
  const stillEphemeral = check.includes('Ephemeral');
  console.log(`  zones:     ${stillZones ? "STILL PRESENT ✗" : "gone ✓"}`);
  console.log(`  m24s_v3:   ${stillM24 ? "STILL PRESENT ✗" : "gone ✓"}`);
  console.log(`  Spot:      ${stillSpot ? "STILL PRESENT ✗" : "gone ✓"}`);
  console.log(`  Ephemeral: ${stillEphemeral ? "STILL PRESENT ✗" : "gone ✓"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
