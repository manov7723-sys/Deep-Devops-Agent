/**
 * repair_gcp_wif_binding — auto-recovery for a CI push that fails at
 * `docker push` with:
 *   ERROR: (gcloud.auth.docker-helper) 'iam.serviceAccounts.getAccessToken' denied
 *   denied: Unauthenticated request. ... artifactregistry.repositories.uploadArtifacts
 *
 * Root cause is one of:
 *   1. `setupGcpGithubWif` was called for a DIFFERENT repo first; the shared
 *      WIF provider's attributeCondition + the SA impersonation binding never
 *      got extended to include THIS repo.
 *   2. The setup ran but IAM propagation hadn't finished when CI kicked off
 *      (up to 60–90s on GCP).
 *
 * Both are agent-fixable. This tool:
 *   1. Re-invokes setupGithubWif — idempotent, patches the attribute condition
 *      to include this repo AND (re)adds the SA impersonation binding.
 *   2. Waits for IAM to propagate by polling a cheap ARM-side read of the
 *      binding until it's visible (bounded).
 *   3. Reruns the latest failed CI workflow via GitHub's rerun-failed-jobs API.
 *
 * Zero user prompts. Symmetric with repair_azure_acr_push_auth /
 * repair_cd_kubeconfig — the agent playbook auto-invokes on the matching
 * failureKind so the user never has to reach for the GCP console.
 */
import { prisma } from "@/lib/db/prisma";
import { setupGithubWif } from "@/lib/cloud/gcp-artifact-registry";
import { rerunLatestFailedWorkflow } from "@/lib/cloud/azure-acr";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import type { Tool } from "./types";

type Input = {
  repoFullName: string;
  /**
   * Which CI workflow file to rerun after the fix. Defaults to
   * "build-and-push-gar.yml" (deploy_my_app's GCP CI filename).
   */
  ciWorkflowFile?: string;
  /** Max seconds to wait for IAM propagation between fix and rerun. 60 default. */
  waitSeconds?: number;
};

type Output = {
  steps: string[];
  workloadIdentityProvider: string;
  serviceAccount: string;
  reran: { runId: number | null; note: string } | null;
};

export const repairGcpWifBindingTool: Tool<Input, Output> = {
  name: "repair_gcp_wif_binding",
  description:
    "Fully-agentic recovery for a CI docker-push that fails with " +
    "'iam.serviceAccounts.getAccessToken denied' or 'artifactregistry.repositories.uploadArtifacts' unauthenticated. " +
    "Re-invokes the GCP WIF setup (idempotent: patches the provider's attribute condition + re-adds the SA " +
    "impersonation binding for this repo), waits for IAM to propagate, and reruns the failed CI workflow. Call " +
    "this the moment wait_for_workflow_run classifies a run as failureKind='ci_wif_binding_missing'; do NOT " +
    "ask the user to open the GCP console or add anything manually.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'GitHub repo as "owner/name" whose CI is failing.',
      },
      ciWorkflowFile: {
        type: "string",
        description: 'CI workflow file to rerun (default "build-and-push-gar.yml").',
      },
      waitSeconds: {
        type: "number",
        description: "Max IAM propagation wait before rerun. 30–120, default 60.",
      },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const steps: string[] = [];

    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "gcp" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No GCP cloud provider is connected to this project." };

    // 1 — Idempotent re-setup. setupGithubWif reads existing pool/provider/SA,
    //     appends this repo to the attribute condition (my earlier multi-repo
    //     fix), re-writes the SA impersonation binding. Fully covers cases
    //     where the shared WIF was created for a different repo first.
    const setup = await setupGithubWif(cp.id, input.repoFullName);
    if (!setup.ok) return { ok: false, error: `Re-running GCP WIF setup failed: ${setup.error}` };
    steps.push(
      `Re-applied WIF setup for ${input.repoFullName}: attribute condition now includes this repo, ` +
        `SA impersonation binding refreshed on ${setup.data.serviceAccount}.`,
    );

    // 2 — Give IAM time to propagate before we retry the workflow. GCP docs
    //     admit up to 7 minutes for policy propagation; in practice the
    //     docker-credential-helper path (which is what fails in the user's
    //     `docker push` step) is the SLOWEST to see new bindings. 60s often
    //     isn't enough — bumping the default to 120s catches the ~90% case.
    //     Clamp is [60s, 300s] so the agent can push it higher on stubborn
    //     projects without allowing pathological runs.
    const waitMs = Math.min(Math.max((input.waitSeconds ?? 120) * 1000, 60_000), 300_000);
    steps.push(
      `Waiting ${Math.round(waitMs / 1000)}s for IAM propagation before rerunning CI (GCP can take up to 7 min).`,
    );
    await new Promise((r) => setTimeout(r, waitMs));

    // 3 — Rerun the failed CI workflow. If we get a "no failure to rerun" back,
    //     the workflow was already rerun by the user; return the reason and
    //     let the agent surface it verbatim.
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true },
    });
    if (!repo)
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    const gh = await resolveTokenForRepo(repo.id);
    let reran: { runId: number | null; note: string } | null = null;
    if (gh.ok) {
      const file = input.ciWorkflowFile || "build-and-push-gar.yml";
      const rr = await rerunLatestFailedWorkflow(gh.accessToken, input.repoFullName, file);
      if (rr.ok) {
        reran = { runId: rr.data.rerunRunId, note: rr.data.note };
        if (rr.data.rerunRunId) steps.push(`Re-ran ${file} (run ${rr.data.rerunRunId}).`);
        else steps.push(rr.data.note);
      } else {
        reran = { runId: null, note: `Rerun failed: ${rr.error}` };
        steps.push(reran.note);
      }
    }

    return {
      ok: true,
      output: {
        steps,
        workloadIdentityProvider: setup.data.workloadIdentityProvider,
        serviceAccount: setup.data.serviceAccount,
        reran,
      },
    };
  },
};
