/**
 * repair_cd_kubeconfig — the fully-agentic recovery for the CD-workflow class
 * of failure the user hit repeatedly: env's stored kubeconfig points at the
 * wrong cluster (or a cluster on the wrong cloud) and the runner's kubectl
 * can't authenticate. Every step is server-side; no user clicks required.
 *
 *   1. Ensure the env is wired to the RIGHT cluster:
 *      - Azure env → list AKS clusters on the connected subscription; if
 *        exactly one, connect it; if none, error clearly; if many, ask via
 *        the returned candidates list.
 *      - AWS env  → same shape with EKS clusters (future).
 *      - GCP env  → same shape with GKE clusters (future).
 *      Writes the resulting kubeconfig back to env.kubeconfigRef.
 *   2. Push the fresh kubeconfig to the repo's KUBECONFIG_B64 GitHub secret so
 *      the CD workflow reads a valid config.
 *   3. Trigger a rerun of the latest FAILED CD workflow run so the fix takes
 *      effect without an empty commit.
 *
 * The agent's failure-recovery playbook calls this on
 * failureKind='cd_no_aws_creds' | 'cd_no_gcp_creds' — the two failure kinds
 * that mean "wrong-cloud kubeconfig in the repo secret." No user prompt.
 */
import { prisma } from "@/lib/db/prisma";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import {
  getAksKubeconfig,
  getSubscriptionTenant,
  listAksClusters,
} from "@/lib/cloud/azure-arm";
import { updateEnv } from "@/lib/devops/envs";
import { setEnvKubeconfigSecret } from "@/lib/devops/deploy";
import { rerunLatestFailedWorkflow } from "@/lib/cloud/azure-acr";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import type { Tool } from "./types";

type Input = {
  repoFullName: string;
  envKey: string;
  /**
   * Which CD workflow file to rerun after the fix. Defaults to "deploy.yml".
   * The agent should pass the exact file name deploy_my_app reported earlier
   * (e.g. "deploy-frontend.yml" in a monorepo).
   */
  cdWorkflowFile?: string;
};

type Output = {
  steps: string[];
  connected: { cluster: string; resourceGroup: string; loginServer?: string } | null;
  candidates?: Array<{ name: string; resourceGroup: string; location: string }>;
  secretUpdated: boolean;
  reran: { runId: number | null; note: string } | null;
};

export const repairCdKubeconfigTool: Tool<Input, Output> = {
  name: "repair_cd_kubeconfig",
  description:
    "Fully-agentic recovery for a failed CD workflow when wait_for_workflow_run classifies it as " +
    "failureKind='cd_no_aws_creds' or 'cd_no_gcp_creds' (kubectl in the runner can't authenticate — root cause: " +
    "the env is wired to a cluster on a cloud the project doesn't have credentials for, so the KUBECONFIG_B64 " +
    "secret decodes to a config with an exec-plugin that never resolves). This tool auto-connects the right " +
    "cluster on the env's connected cloud, rewrites the KUBECONFIG_B64 secret from that fresh kubeconfig, and " +
    "reruns the failed CD workflow. Zero user prompts. Call it as soon as failureKind matches; do NOT ask the " +
    "user to reconnect anything.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'GitHub repo as "owner/name" (the one whose CD is failing).' },
      envKey: { type: "string", description: "Env key from list_deploy_targets — the env whose kubeconfig is stale/wrong-cloud." },
      cdWorkflowFile: { type: "string", description: 'CD workflow file to rerun after fixing (default "deploy.yml").' },
    },
    required: ["repoFullName", "envKey"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const steps: string[] = [];

    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProvider: { select: { id: true, kind: true, accountRef: true } } },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    if (!env.cloudProvider) return { ok: false, error: `Env "${input.envKey}" has no connected cloud provider.` };

    // Right now we only fully automate Azure/AKS — that's the shape hitting the
    // user. AWS/GCP land the same way when their listers are wired.
    if (env.cloudProvider.kind !== "azure") {
      return {
        ok: false,
        error: `repair_cd_kubeconfig currently only auto-repairs Azure/AKS envs; env is on "${env.cloudProvider.kind}".`,
      };
    }
    if (!env.cloudProvider.accountRef) {
      return { ok: false, error: "Azure provider has no subscription id — reconnect Azure on the connection page." };
    }

    // 1 — find the AKS cluster on the connected subscription.
    const tok0 = await getAzureAccessToken(env.cloudProvider.id);
    if (!tok0.ok) return { ok: false, error: `Azure auth failed: ${tok0.error}` };
    // Personal-account owners need a tenant-scoped token to fetch cluster creds;
    // list works either way but scoping upfront avoids a second call.
    let accessToken = tok0.accessToken;
    const tenantId = await getSubscriptionTenant(tok0.accessToken, env.cloudProvider.accountRef);
    if (tenantId) {
      const scoped = await getAzureAccessToken(env.cloudProvider.id, tenantId);
      if (scoped.ok) accessToken = scoped.accessToken;
    }
    const list = await listAksClusters(accessToken, env.cloudProvider.accountRef);
    if (!list.ok) return { ok: false, error: `Couldn't list AKS clusters: ${list.error}` };
    if (list.clusters.length === 0) {
      return {
        ok: false,
        error: "No AKS clusters exist on this Azure subscription. Create one via chat 'create an AKS cluster' first.",
      };
    }
    // Multiple clusters — need a user choice. Return the candidates so the
    // agent can ask a single ```options``` question; on the retry the caller
    // will pass ?clusterName= (future) or the user picks up in chat.
    if (list.clusters.length > 1) {
      return {
        ok: true,
        output: {
          steps: [`Found ${list.clusters.length} AKS clusters — need the user to pick.`],
          connected: null,
          candidates: list.clusters,
          secretUpdated: false,
          reran: null,
        },
      };
    }
    const pick = list.clusters[0];
    steps.push(`Found one AKS cluster on the subscription: "${pick.name}" in resource group "${pick.resourceGroup}" (${pick.location}).`);

    // 2 — mint a kubeconfig via ARM and store it on the env.
    const kc = await getAksKubeconfig(
      accessToken,
      env.cloudProvider.accountRef,
      pick.resourceGroup,
      pick.name,
      env.cloudProvider.id,
    );
    if (!kc.ok) return { ok: false, error: `Couldn't fetch AKS kubeconfig: ${kc.error}` };
    steps.push(`Fetched a ${kc.mode}-credential kubeconfig from ARM.`);

    const owner = await prisma.project.findUnique({ where: { id: ctx.projectId }, select: { ownerId: true } });
    if (!owner?.ownerId) return { ok: false, error: "Project has no owner." };
    const upd = await updateEnv(ctx.projectId, owner.ownerId, input.envKey, { kubeconfig: kc.kubeconfig });
    if (!upd.ok) return { ok: false, error: `Couldn't save the kubeconfig on env "${input.envKey}": ${upd.code}` };
    steps.push(`Stored the fresh AKS kubeconfig on env "${input.envKey}".`);

    // 3 — push the fresh kubeconfig to GitHub as KUBECONFIG_B64 so the on-repo
    //     CD workflow reads it. This is the step that actually unblocks CI.
    const push = await setEnvKubeconfigSecret(ctx.projectId, input.repoFullName, input.envKey);
    if (!push.ok) return { ok: false, error: `Couldn't rewrite KUBECONFIG_B64 on ${input.repoFullName}: ${push.error}` };
    steps.push(`Rewrote KUBECONFIG_B64 on ${input.repoFullName} from the new kubeconfig.`);

    // 4 — rerun the failed CD workflow so the user doesn't have to click.
    const gh = await (async () => {
      const repo = await prisma.repo.findFirst({
        where: { fullName: input.repoFullName, deletedAt: null, projectRepos: { some: { projectId: ctx.projectId } } },
        select: { id: true },
      });
      if (!repo) return null;
      return resolveTokenForRepo(repo.id);
    })();
    let reran: { runId: number | null; note: string } | null = null;
    if (gh && gh.ok) {
      const file = input.cdWorkflowFile || "deploy.yml";
      const rr = await rerunLatestFailedWorkflow(gh.accessToken, input.repoFullName, file);
      if (rr.ok) {
        reran = { runId: rr.data.rerunRunId, note: rr.data.note };
        if (rr.data.rerunRunId) steps.push(`Re-ran ${file} (run ${rr.data.rerunRunId}).`);
        else steps.push(rr.data.note);
      } else {
        steps.push(`Rerun of ${file} failed: ${rr.error}`);
        reran = { runId: null, note: `Rerun failed: ${rr.error}` };
      }
    }

    return {
      ok: true,
      output: {
        steps,
        connected: { cluster: pick.name, resourceGroup: pick.resourceGroup },
        secretUpdated: true,
        reran,
      },
    };
  },
};
