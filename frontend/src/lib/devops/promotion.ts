/**
 * Environment promotion — move the EXACT version running in one env up to the
 * next (dev → staging → prod), without rebuilding. "What's in an env" is read
 * LIVE from each cluster (getLiveDeployments), so it reflects what's actually
 * running regardless of how it was deployed. A promotion re-deploys that same
 * image/config to the target env — through the approval gate (createDeployApproval),
 * so prod promotions still need sign-off.
 */
import { listEnvs } from "@/lib/devops/envs";
import { getLiveDeployments } from "./live-deployments";
import { createDeployApproval } from "./deploy-approval";
import { type DeploySpec } from "./deploy-manifest";

// `connected` = a cluster is wired to this env. ALL project envs are shown as
// columns (so the dev → staging → prod pipeline is visible before every stage
// has a cluster); `connected` tells the UI which ones can actually run/receive
// an app and which need a cluster connected first.
export type EnvCol = { key: string; name: string; isProduction: boolean; connected: boolean };
export type AppVersions = {
  app: string;
  versions: Record<string, { image: string; ready: string }>;
};
export type EnvDiag = { env: string; ok: boolean; count: number; error?: string };

/** Build the app × env version matrix from the LIVE deployments in each connected cluster. */
export async function getPromotionMatrix(
  projectId: string,
  nsFilter?: string,
): Promise<{
  envs: EnvCol[];
  apps: AppVersions[];
  namespaces: string[];
  namespace: string;
  diag: EnvDiag[];
  note?: string;
}> {
  const envs = await listEnvs(projectId);
  // Columns = every environment, in pipeline order (listEnvs sorts by
  // promotionRank). Un-connected envs still show as promotion TARGETS so the
  // whole pipeline is visible; `connected` flags which can run/receive apps.
  const envCols: EnvCol[] = envs.map((e) => ({
    key: e.key,
    name: e.name,
    isProduction: e.isProduction,
    connected: e.hasKubeconfig,
  }));

  const ns = (nsFilter || "all").trim() || "all";
  // Live versions can only be read from envs that actually have a cluster.
  const connected = envs.filter((e) => e.hasKubeconfig);
  const perEnv = await Promise.all(
    connected.map(async (e) => ({ env: e, live: await getLiveDeployments(projectId, e.key, ns) })),
  );

  const map = new Map<string, AppVersions>();
  const nsSet = new Set<string>();
  const diag: EnvDiag[] = [];
  let anyReachable = false;
  for (const { env, live } of perEnv) {
    if (!live.ok) {
      diag.push({ env: env.key, ok: false, count: 0, error: live.error });
      continue;
    }
    anyReachable = true;
    diag.push({ env: env.key, ok: true, count: live.deployments.length });
    for (const d of live.deployments) {
      nsSet.add(d.namespace);
      let av = map.get(d.name);
      if (!av) {
        av = { app: d.name, versions: {} };
        map.set(d.name, av);
      }
      av.versions[env.key] = { image: d.image, ready: `${d.ready}/${d.replicas}` };
    }
  }

  const apps = [...map.values()].sort((a, b) => a.app.localeCompare(b.app));
  const note =
    envs.length === 0
      ? "No environments yet. Create one on the Environments page."
      : connected.length === 0
        ? "No environment has a cluster connected yet. Connect one on the Connection page to read running versions and promote."
        : !anyReachable
          ? "Couldn't reach any connected cluster right now."
          : undefined;
  return { envs: envCols, apps, namespaces: [...nsSet].sort(), namespace: ns, diag, note };
}

/** Promote an app's currently-running version from one env to another — as a pending deploy approval. */
export async function promoteApp(
  projectId: string,
  appName: string,
  fromEnvKey: string,
  toEnvKey: string,
  nsFilter?: string,
): Promise<{ ok: true; approvalId: string; image: string } | { ok: false; error: string }> {
  if (!fromEnvKey || !toEnvKey || fromEnvKey === toEnvKey)
    return { ok: false, error: "Pick a different source and target environment." };

  const envs = await listEnvs(projectId);
  const source = envs.find((e) => e.key === fromEnvKey);
  const target = envs.find((e) => e.key === toEnvKey);
  if (!source) return { ok: false, error: `Source env "${fromEnvKey}" not found.` };
  if (!source.hasKubeconfig)
    return {
      ok: false,
      error: `Source env "${source.name}" has no cluster connected — connect one on the Connection page first.`,
    };
  if (!target) return { ok: false, error: `Target env "${toEnvKey}" not found.` };
  // Un-connected targets are selectable in the UI on purpose; this is where we
  // give the clear, actionable message instead of silently failing.
  if (!target.hasKubeconfig)
    return {
      ok: false,
      error: `Connect a cluster to "${target.name}" on the Connection page before promoting to it.`,
    };

  const live = await getLiveDeployments(projectId, source.key, nsFilter || "all");
  if (!live.ok) return { ok: false, error: `Couldn't read ${fromEnvKey}: ${live.error}` };
  const d = live.deployments.find((x) => x.name === appName);
  if (!d) return { ok: false, error: `"${appName}" isn't running in ${fromEnvKey} to promote.` };

  // Promote into the SAME namespace the app runs in on the source cluster —
  // "move this exact workload to the other cluster, unchanged" — rather than the
  // target env's default namespace. The namespace is created on the target
  // cluster if it doesn't exist yet (handled in applyK8sManifestTool).
  const namespace = (d.namespace || target.namespace || "default").trim();
  const spec: DeploySpec = {
    appName: d.name,
    image: d.image,
    namespace,
    replicas: Math.max(1, d.replicas),
    containerPort: Math.max(1, d.containerPort),
    env: d.env,
    expose: false,
  };

  const { approvalId } = await createDeployApproval(
    projectId,
    { envKey: target.key, envId: target.id, namespace, isProduction: target.isProduction },
    spec,
    "manual",
  );
  return { ok: true, approvalId, image: d.image };
}
