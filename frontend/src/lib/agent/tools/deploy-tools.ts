/**
 * Deploy-My-App agent tools — let the conversational agent run the whole flow
 * (not just the UI wizard): find deployable envs, pick a pushed image from the
 * registry, deploy it, and watch the rollout. Thin wrappers over the shared
 * orchestration in @/lib/devops/deploy (+ registry-images), so the tools and the
 * wizard behave identically.
 */
import type { Tool } from "./types";
import { listDeployTargets, runDeploy, deployStatus, setEnvKubeconfigSecret, type DeployTarget } from "@/lib/devops/deploy";
import { createDeployApproval } from "@/lib/devops/deploy-approval";
import { sanitizeAppName, type DeploySpec } from "@/lib/devops/deploy-manifest";
import { listProjectRegistryImages, type RegistryImage } from "@/lib/cloud/registry-images";
import { buildCdFiles } from "@/lib/devops/cd-files";
import { writeRepoFileTool } from "./write-repo-file";
import { waitForWorkflowRun, type WorkflowRun } from "@/lib/github/workflow-runs";

// ── list_deploy_targets ──────────────────────────────────────────────────────
export const listDeployTargetsTool: Tool<Record<string, never>, { targets: DeployTarget[] }> = {
  name: "list_deploy_targets",
  description:
    "List the project's environments that can be deployed to (those with a Kubernetes cluster connected). " +
    "Use this first to find the envKey and namespace to deploy an app to.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const targets = await listDeployTargets(ctx.projectId);
    return { ok: true, output: { targets } };
  },
};

// ── list_registry_images ─────────────────────────────────────────────────────
export const listRegistryImagesTool: Tool<Record<string, never>, { cloud: string; images: RegistryImage[]; note?: string }> = {
  name: "list_registry_images",
  description:
    "List container images and tags already pushed to the project's connected cloud registry (AWS ECR, " +
    "GCP Artifact Registry, or Azure ACR). Use this to find the image reference to deploy. Returns pullable " +
    "image references like 'registry/repo:tag'.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const res = await listProjectRegistryImages(ctx.projectId);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { cloud: res.cloud, images: res.images, note: res.note } };
  },
};

// ── deploy_app ───────────────────────────────────────────────────────────────
type DeployInput = {
  envKey: string;
  appName: string;
  image: string;
  containerPort?: number;
  replicas?: number;
  env?: Array<{ key: string; value: string }>;
  expose?: boolean;
  host?: string;
  namespace?: string;
  dryRun?: boolean;
  autoRollback?: boolean;
};

export const deployAppTool: Tool<DeployInput, {
  applied: boolean;
  dryRun: boolean;
  resources: string[];
  namespace: string;
  appName: string;
  envKey: string;
  pendingApproval?: boolean;
  approvalId?: string;
  message?: string;
}> = {
  name: "deploy_app",
  description:
    "Submit a container-image deploy for approval (it does NOT deploy immediately). Builds the intended " +
    "Deployment + Service (+ Ingress) and creates a PENDING approval; a human approves it on the Approvals page, " +
    "which then runs the deploy. Use list_deploy_targets to get the envKey and list_registry_images to get the " +
    "image. Set dryRun=true to validate against the cluster WITHOUT creating an approval. After a human approves, " +
    "poll deployment_status to confirm the rollout. Tell the user the deploy is waiting for approval — do NOT " +
    "claim it's live yet.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose cluster to deploy to (from list_deploy_targets)." },
      appName: { type: "string", description: "App / resource name (lowercase DNS label, e.g. 'my-app')." },
      image: { type: "string", description: "Full image reference, e.g. 'registry/my-app:tag' (from list_registry_images)." },
      containerPort: { type: "number", description: "Port the app listens on. Default 8080." },
      replicas: { type: "number", description: "Number of replicas. Default 1." },
      env: {
        type: "array",
        description: "Environment variables for the container.",
        items: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
      expose: { type: "boolean", description: "Expose publicly via an Ingress (requires host)." },
      host: { type: "string", description: "Public host for the Ingress, e.g. 'app.example.com'." },
      namespace: { type: "string", description: "Target namespace. Defaults to the env's namespace." },
      dryRun: { type: "boolean", description: "Validate server-side without applying." },
      autoRollback: { type: "boolean", description: "Auto-revert to the previous version if the new rollout doesn't become healthy. Default TRUE — only set false if the user explicitly asks to disable auto-rollback." },
    },
    required: ["envKey", "appName", "image"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!input.image?.trim()) return { ok: false, error: "An image reference is required." };

    const targets = await listDeployTargets(ctx.projectId);
    const target = targets.find((t) => t.envKey === input.envKey);
    if (!target) {
      const avail = targets.map((t) => t.envKey).join(", ") || "none";
      return { ok: false, error: `No deployable env "${input.envKey}". Connect a cluster first. Available: ${avail}.` };
    }
    if (input.expose && !(input.host || "").trim()) {
      return { ok: false, error: "A host is required to expose the app publicly." };
    }

    const namespace = (input.namespace || "").trim() || target.namespace;
    const spec: DeploySpec = {
      appName: input.appName,
      image: input.image,
      namespace,
      replicas: Math.max(1, input.replicas ?? 1),
      containerPort: Math.max(1, input.containerPort ?? 8080),
      env: input.env ?? [],
      expose: !!input.expose,
      host: input.host,
    };

    // dryRun = validate against the cluster now (no approval, no change).
    if (input.dryRun) {
      const res = await runDeploy(
        { projectId: ctx.projectId, userId: ctx.userId },
        { envKey: target.envKey, envId: target.envId, namespace },
        spec,
        { dryRun: true, autoRollback: input.autoRollback },
      );
      if (!res.ok) return { ok: false, error: res.error };
      return {
        ok: true,
        output: { applied: false, dryRun: true, resources: res.resources, namespace, appName: sanitizeAppName(spec.appName), envKey: target.envKey },
      };
    }

    // Real deploy → APPROVAL GATE. Create a pending approval; a human runs it from the Approvals page.
    const { approvalId } = await createDeployApproval(
      ctx.projectId,
      { envKey: target.envKey, envId: target.envId, namespace, isProduction: target.isProduction },
      spec,
      "agent",
    );
    return {
      ok: true,
      output: {
        applied: false,
        dryRun: false,
        resources: [],
        namespace,
        appName: sanitizeAppName(spec.appName),
        envKey: target.envKey,
        pendingApproval: true,
        approvalId,
        message: `Deploy of "${sanitizeAppName(spec.appName)}" to ${target.envKey} was submitted for approval. It will run once a human approves it on the Approvals page. Do not claim it is live yet.`,
      },
    };
  },
};

// ── wait_for_workflow_run ────────────────────────────────────────────────────
export const waitForWorkflowRunTool: Tool<
  { repoFullName: string; workflowFile?: string; branch?: string; timeoutSeconds?: number },
  {
    done: boolean;
    status: string;
    conclusion: string | null;
    headSha: string;
    htmlUrl: string;
    /**
     * On conclusion="failure", a classified reason so the agent can self-heal
     * without asking the user. "acr_secrets_missing" → call
     * repair_azure_acr_push_auth(repoFullName) — it re-syncs the ACR admin
     * secrets and re-runs the failed jobs automatically.
     */
    failureKind: WorkflowRun["failureKind"];
    failureHint: string | null;
    run: WorkflowRun | null;
  }
> = {
  name: "wait_for_workflow_run",
  description:
    "Wait for the latest GitHub Actions run of a workflow to finish — use this to block on the CI build+push " +
    "workflow BEFORE writing/deploying the CD side. Pass workflowFile (e.g. 'build-and-push.yml') to target the " +
    "CI workflow. Returns done=true with conclusion 'success'/'failure' when finished; if it returns done=false " +
    "(still running after the timeout), call again to keep waiting. On success, call list_registry_images to get " +
    "the freshly pushed image, then write_cd_files / deploy_app with it. " +
    "ON FAILURE: check `failureKind`. failureKind='acr_secrets_missing' → the ACR docker-login secrets on the " +
    "repo are missing/empty; call repair_azure_acr_push_auth(repoFullName) IMMEDIATELY (do NOT ask the user), " +
    "then wait_for_workflow_run again — the repair rewrites the secrets and re-triggers the failed jobs.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'The repo as "owner/name".' },
      workflowFile: { type: "string", description: "Workflow file name to watch, e.g. 'build-and-push.yml'. Omit for the latest run of any workflow." },
      branch: { type: "string", description: "Branch to watch. Defaults to the repo's default branch." },
      timeoutSeconds: { type: "number", description: "Max seconds to wait this call (10–300, default 240)." },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await waitForWorkflowRun(ctx.projectId, input.repoFullName, {
      workflowFile: input.workflowFile,
      branch: input.branch,
      timeoutMs: input.timeoutSeconds ? input.timeoutSeconds * 1000 : undefined,
    });
    if (!res.ok) return { ok: false, error: res.error };
    const run = res.data.run;
    return {
      ok: true,
      output: {
        done: res.data.done,
        status: run?.status ?? "unknown",
        conclusion: run?.conclusion ?? null,
        headSha: run?.headSha ?? "",
        htmlUrl: run?.htmlUrl ?? "",
        failureKind: run?.failureKind ?? null,
        failureHint: run?.failureHint ?? null,
        run,
      },
    };
  },
};

// ── write_cd_files ───────────────────────────────────────────────────────────
type WriteCdInput = {
  repoFullName: string;
  envKey: string;
  appName: string;
  image: string;
  containerPort?: number;
  replicas?: number;
  env?: Array<{ key: string; value: string }>;
  expose?: boolean;
  host?: string;
  namespace?: string;
  branch?: string;
  /** Repo folder the manifests live in (the CD workflow applies from here). Ask the user; default "k8s". */
  manifestPath?: string;
  /** Write ONLY the deploy workflow (.github/workflows/deploy.yml), not the manifest — use when the manifests were already created interactively via generate_k8s_manifest. */
  writeWorkflowOnly?: boolean;
};

export const writeCdFilesTool: Tool<WriteCdInput, {
  files: string[];
  branch: string;
  pullRequest?: { number: number; url: string };
}> = {
  name: "write_cd_files",
  description:
    "Write the CD (deploy) files into the repo and open a PR: the Kubernetes manifest (k8s/manifest.yaml) " +
    "and the deploy workflow (.github/workflows/deploy.yml) that applies it. Use this AFTER the CI build+push " +
    "workflow is in place (generate_ecr/gar/acr_workflow) so the pipeline is complete: CI builds & pushes the " +
    "image, then this CD workflow deploys it. The deploy workflow needs a KUBECONFIG_B64 repo secret to reach " +
    "the cluster. Pass the same image/port/env you'd use for deploy_app.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'The repo as "owner/name".' },
      envKey: { type: "string", description: "Env key whose namespace the app deploys into (from list_deploy_targets)." },
      appName: { type: "string", description: "App / resource name (lowercase DNS label)." },
      image: { type: "string", description: "Full image reference the CI workflow pushes, e.g. 'registry/app:tag'." },
      containerPort: { type: "number", description: "Port the app listens on. Default 8080." },
      replicas: { type: "number", description: "Number of replicas. Default 1." },
      env: {
        type: "array",
        description: "Environment variables for the container.",
        items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"], additionalProperties: false },
      },
      expose: { type: "boolean", description: "Add an Ingress (requires host)." },
      host: { type: "string", description: "Public host for the Ingress." },
      namespace: { type: "string", description: "Target namespace. Defaults to the env's namespace." },
      branch: { type: "string", description: "Branch to commit on. Default 'deploy/<app>'." },
      manifestPath: { type: "string", description: "Repo folder the manifests live in (the CD workflow applies from here). Ask the user; default 'k8s'." },
      writeWorkflowOnly: { type: "boolean", description: "Write ONLY the deploy workflow (not the manifest) — use when the manifests were created interactively." },
    },
    required: ["repoFullName", "envKey", "appName", "image"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!input.image?.trim()) return { ok: false, error: "An image reference is required." };
    if (input.expose && !(input.host || "").trim()) return { ok: false, error: "A host is required to expose the app publicly." };

    const targets = await listDeployTargets(ctx.projectId);
    const target = targets.find((t) => t.envKey === input.envKey);
    const namespace = (input.namespace || "").trim() || target?.namespace || "default";

    const spec: DeploySpec = {
      appName: input.appName,
      image: input.image,
      namespace,
      replicas: Math.max(1, input.replicas ?? 1),
      containerPort: Math.max(1, input.containerPort ?? 8080),
      env: input.env ?? [],
      expose: !!input.expose,
      host: input.host,
    };

    const files = buildCdFiles(spec, input.manifestPath).filter((f) => (input.writeWorkflowOnly ? f.path.includes(".github/") : true));
    const branch = (input.branch || `deploy/${sanitizeAppName(input.appName)}`).trim();
    const prBody =
      "CD files generated by DeepAgent.\n\n" +
      "- `k8s/manifest.yaml` — Deployment + Service" +
      (spec.expose ? " + Ingress" : "") +
      "\n- `.github/workflows/deploy.yml` — applies the manifest to the cluster.\n\n" +
      "Set the repo secret `KUBECONFIG_B64` (base64 of your kubeconfig) so the deploy workflow can reach the cluster.";

    const committed: string[] = [];
    let pullRequest: { number: number; url: string } | undefined;
    let first = true;
    for (const f of files) {
      const res = await writeRepoFileTool.execute(
        {
          repoFullName: input.repoFullName,
          path: f.path,
          content: f.content,
          branch,
          message: "Add CD deploy files (DeepAgent)",
          openPullRequest: first,
          pullRequestBody: prBody,
        },
        ctx,
      );
      if (!res.ok) return { ok: false, error: `Failed writing ${f.path}: ${res.error}` };
      committed.push(f.path);
      if (res.output.pullRequest) pullRequest = res.output.pullRequest;
      first = false;
    }

    return { ok: true, output: { files: committed, branch, pullRequest } };
  },
};

// ── set_kubeconfig_secret ────────────────────────────────────────────────────
export const setKubeconfigSecretTool: Tool<{ repoFullName: string; envKey: string }, { secret: string }> = {
  name: "set_kubeconfig_secret",
  description:
    "Set the repo's KUBECONFIG_B64 GitHub Actions secret from the env's stored kubeconfig, so the CD deploy " +
    "workflow can reach the cluster with no manual setup. Call this after write_cd_files when using the CD " +
    "workflow to deploy. The value is the base64 kubeconfig; for GKE/EKS exec kubeconfigs the token can expire — " +
    "re-run to refresh, or deploy server-side with deploy_app instead.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'The repo as "owner/name".' },
      envKey: { type: "string", description: "Env key whose kubeconfig to publish (from list_deploy_targets)." },
    },
    required: ["repoFullName", "envKey"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await setEnvKubeconfigSecret(ctx.projectId, input.repoFullName, input.envKey);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { secret: res.secret } };
  },
};

// ── deployment_status ────────────────────────────────────────────────────────
export const deploymentStatusTool: Tool<
  { envKey: string; appName: string; namespace?: string },
  { found: boolean; ready: string; healthy: boolean; pods: Array<{ name: string; status: string; ready: string }> }
> = {
  name: "deployment_status",
  description:
    "Check the rollout health of a deployed app: returns the Deployment ready count and its Pods' statuses. " +
    "Use after deploy_app to confirm the app came up (poll until healthy).",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key the app was deployed to." },
      appName: { type: "string", description: "The app name that was deployed." },
      namespace: { type: "string", description: "Namespace. Defaults to the env's namespace." },
    },
    required: ["envKey", "appName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const targets = await listDeployTargets(ctx.projectId);
    const target = targets.find((t) => t.envKey === input.envKey);
    const namespace = (input.namespace || "").trim() || target?.namespace || "default";
    const res = await deployStatus({ projectId: ctx.projectId, userId: ctx.userId }, { envKey: input.envKey }, input.appName, namespace);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { found: res.found, ready: res.ready, healthy: res.healthy, pods: res.pods } };
  },
};
