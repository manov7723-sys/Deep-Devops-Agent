/**
 * One-shot: rename existing envs from alpha/beta/release → dev/staging/prod
 * across every table that stores env by key (Env, TfRun, ScheduledDeploy,
 * DeploymentRecord, DeployWatch).
 *
 *   npx tsx scripts/rename-envs-to-dev-staging-prod.ts        # dry run
 *   npx tsx scripts/rename-envs-to-dev-staging-prod.ts --apply
 *
 * Safety:
 *   - Detects collisions (a project already has BOTH an old key and its new
 *     name — e.g. someone made a "dev" env manually) and skips those, printing
 *     a warning. Nothing is renamed on those projects; fix by hand.
 *   - Env.name is only updated when it equals the old key literally (so
 *     "Alpha" won't be renamed to "dev" — only "alpha" → "dev").
 *   - Wrapped in a single transaction — either all rename operations land, or
 *     none do.
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

const RENAMES: Record<string, string> = {
  alpha: "dev",
  beta: "staging",
  release: "prod",
};

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../src/lib/db/prisma");

  console.log(apply ? "APPLY mode — rewriting env keys in the database." : "DRY-RUN — pass --apply to actually rename.");
  console.log("");

  // 1. Detect collisions per project: e.g. project has both `alpha` and `dev`.
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      slug: true,
      environments: { select: { id: true, key: true, name: true } },
    },
  });

  const collisions: Array<{ project: string; from: string; to: string; existingId: string }> = [];
  const renamePlan: Array<{ envId: string; project: string; fromKey: string; toKey: string; fromName: string; toName: string }> = [];

  for (const p of projects) {
    const byKey = new Map(p.environments.map((e) => [e.key, e]));
    for (const [oldKey, newKey] of Object.entries(RENAMES)) {
      const old = byKey.get(oldKey);
      if (!old) continue;
      const clash = byKey.get(newKey);
      if (clash) {
        collisions.push({ project: p.slug, from: oldKey, to: newKey, existingId: clash.id });
        continue;
      }
      // Only rename Env.name if it matches the old key literally (e.g. "alpha").
      // Preserves human-picked names like "Alpha" or "First-ring alpha".
      const nameShouldChange = old.name === oldKey;
      renamePlan.push({
        envId: old.id,
        project: p.slug,
        fromKey: oldKey,
        toKey: newKey,
        fromName: old.name,
        toName: nameShouldChange ? newKey : old.name,
      });
    }
  }

  if (collisions.length > 0) {
    console.log("⚠ COLLISIONS — these envs will NOT be renamed (destination already exists):");
    for (const c of collisions) console.log(`  ${c.project}: cannot rename "${c.from}" → "${c.to}" (project already has an env with that key, id=${c.existingId}). Fix manually if you want the merge.`);
    console.log("");
  }

  if (renamePlan.length === 0) {
    console.log("Nothing to rename — no envs with keys alpha/beta/release.");
    process.exit(0);
  }

  console.log("PLANNED RENAMES:");
  for (const r of renamePlan) {
    console.log(`  ${r.project} · env ${r.envId}: key "${r.fromKey}" → "${r.toKey}"${r.fromName !== r.toName ? `, name "${r.fromName}" → "${r.toName}"` : ""}`);
  }
  console.log(`\nTotal envs to rename: ${renamePlan.length}`);
  console.log("Also updates TfRun.envKey, ScheduledDeploy.envKey, DeploymentRecord.envKey, DeployWatch.envKey for the same (projectId, oldKey) pairs.");
  console.log("");

  if (!apply) {
    console.log("Dry run complete. Re-run with --apply to execute.");
    process.exit(0);
  }

  // 2. Execute — one transaction so it either fully lands or fully rolls back.
  const results = await prisma.$transaction(async (tx) => {
    let envCount = 0, tfRunCount = 0, schedCount = 0, deployRecCount = 0, deployWatchCount = 0;

    for (const r of renamePlan) {
      // Env row itself.
      await tx.env.update({
        where: { id: r.envId },
        data: { key: r.toKey, ...(r.fromName !== r.toName ? { name: r.toName } : {}) },
      });
      envCount++;

      // Denormalized env keys on run/deploy tables. Scoped by projectId
      // (fetched via the env row) so we never touch another project.
      const env = await tx.env.findUnique({ where: { id: r.envId }, select: { projectId: true } });
      if (!env) continue;

      const tfUp  = await tx.tfRun.updateMany({ where: { projectId: env.projectId, envKey: r.fromKey }, data: { envKey: r.toKey } });
      const scUp  = await tx.scheduledDeploy.updateMany({ where: { projectId: env.projectId, envKey: r.fromKey }, data: { envKey: r.toKey } });
      const drUp  = await tx.deploymentRecord.updateMany({ where: { projectId: env.projectId, envKey: r.fromKey }, data: { envKey: r.toKey } });
      const dwUp  = await tx.deployWatch.updateMany({ where: { projectId: env.projectId, envKey: r.fromKey }, data: { envKey: r.toKey } });
      tfRunCount += tfUp.count;
      schedCount += scUp.count;
      deployRecCount += drUp.count;
      deployWatchCount += dwUp.count;
    }
    return { envCount, tfRunCount, schedCount, deployRecCount, deployWatchCount };
  });

  console.log("✓ Rename complete.");
  console.log(`  Env rows renamed:            ${results.envCount}`);
  console.log(`  TfRun.envKey rows updated:   ${results.tfRunCount}`);
  console.log(`  ScheduledDeploy rows:        ${results.schedCount}`);
  console.log(`  DeploymentRecord rows:       ${results.deployRecCount}`);
  console.log(`  DeployWatch rows:            ${results.deployWatchCount}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
