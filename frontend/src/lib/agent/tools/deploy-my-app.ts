import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { analyzeAppServices, type AppService } from "@/lib/automation/repo-analyze";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { parseAksClusterRef, setupAzureDeployRegistry } from "@/lib/cloud/azure-acr";
import { findAksClusterByName } from "@/lib/cloud/azure-arm";
import { parseEksClusterRef } from "@/lib/cloud/eks-access";
import { parseGkeClusterRef, setupGcpDeployRegistry } from "@/lib/cloud/gcp-artifact-registry";
import { buildCicdArtifacts } from "@/lib/devops/cicd-pipeline";
import {
  generateCombinedEcrCiWorkflow,
  generateCombinedEksCdWorkflow,
} from "@/lib/ci/templates";
import { listDeployTargets } from "@/lib/devops/deploy";
import { sanitizeAppName } from "@/lib/devops/deploy-manifest";
import { setRepoActionsVariable } from "@/lib/github/secrets";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { grantEksAccessTool } from "./grant-eks-access";
import { setupGithubOidcEcrTool } from "./setup-github-oidc-ecr";
import { setKubeconfigSecretTool } from "./deploy-tools";
import { writeRepoFileTool } from "./write-repo-file";
import { registerCommittedPipeline } from "./save-pipeline-to-project";
import type { Tool } from "./types";

/**
 * URL-encode a git ref path (e.g. `deploy/dynamic-react-app-abc`) with the
 * slashes KEPT literal. GitHub's `/git/refs/heads/{ref}` endpoint 404s when
 * slashes are percent-encoded (`%2F`), so encodeURIComponent breaks any
 * multi-segment ref name. Preserve the slash structure, encode each segment.
 */
function encodeRefPath(ref: string): string {
  return ref.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * deploy_my_app — the single from-scratch flow for non-DevOps users.
 *
 *   1. ANALYZE the repo → every deployable service (one app, OR a monorepo with
 *      a separate frontend + backend, each with its own build path/stack/port).
 *   2. Per service: ensure an ECR repo + keyless GitHub-OIDC role. The caller can
 *      pass which ECR repo to use per service (existing or auto-create).
 *   3. GENERATE everything from vetted templates: Dockerfile (per service dir),
 *      the CI build→scan→push workflow (one per service), and production-style
 *      manifests. Single service uses repo-level GitHub vars; a monorepo bakes
 *      each service's registry values in (repo vars can't differ per workflow).
 *   4. Commit everything directly to the target branch (default = repo's
 *      default branch). commitMode='pr' is available but almost never used —
 *      branch protection on the target branch is enforced by GitHub itself.
 *
 * After merge the agent chains per service: wait_for_workflow_run(its workflow
 * file) → deploy_app(its imageRef/containerPort), server-side + approval-gated.
 */
type ServiceInput = {
  /** Role from analyze_app_services: "frontend" | "backend" | "app". */
  name?: string;
  /** Build-context subdir; "" = repo root. */
  path?: string;
  /** ECR/image repo name to use for this service (an existing one, or a new name to auto-create). */
  imageName?: string;
  /** Expose this service publicly via Ingress (needs host). Usually true for a frontend. */
  expose?: boolean;
  host?: string;
};

type Input = {
  repoFullName: string;
  envKey: string;
  /**
   * Kubernetes namespace to deploy into — the USER's choice (never defaulted
   * silently). Ask via list_kubernetes_resources(envKey, kind:"namespaces") +
   * one ```options``` question offering the existing namespaces plus
   * "Create new: <default>".
   */
  namespace: string;
  /**
   * Git branch the CI/CD workflow triggers from — the USER's choice, asked via
   * list_repo_branches + one ```options``` block ("existing branches + Create
   * new: <default>"). If the chosen branch doesn't exist on GitHub yet, the
   * tool auto-creates it off the repo's default branch before pushing.
   */
  branch: string;
  /**
   * Explicit per-service targets (from analyze_app_services + the user's ECR
   * choice). Omit to auto-deploy every detected service with suggested ECR names.
   */
  services?: ServiceInput[];
  /** Base app name (lowercase DNS label). Defaults to the repo name. */
  appName?: string;
  replicas?: number;
  /**
   * "direct" (default — commit straight to the target branch, no PR) or
   * "pr" (opens one PR for teams that require review). The deploy chat
   * playbook always uses direct; pr is only for callers that opt in.
   */
  commitMode?: "pr" | "direct";
  overwriteDockerfile?: boolean;
  /**
   * How to package the app for Kubernetes:
   *   - "manifests" (default) — plain Deployment + Service + Ingress YAMLs;
   *     CD workflow uses `kubectl apply`.
   *   - "helm" — full chart under charts/<appName>/ (Chart.yaml, values.yaml,
   *     values-<env>.yaml, templates/*); CD workflow uses `helm upgrade --install`.
   * Ask the user via the batch options-form; see agent.ts step 3.
   */
  manifestType?: "manifests" | "helm";
};

type DeployedService = {
  name: string;
  path: string;
  appName: string;
  imageRef: string;
  containerPort: number;
  registryUri: string;
  workflowFile: string;
  cdWorkflowFile: string;
  expose: boolean;
  keptExistingDockerfile: boolean;
};

type Output = {
  monorepo: boolean;
  services: DeployedService[];
  files: string[];
  branch: string;
  namespace: string;
  pullRequest?: { number: number; url: string };
  registrySteps: string[];
  next: string;
};

/** Match an explicit service target to a detected service (by path, then name). */
function matchService(detected: AppService[], t: ServiceInput): AppService | undefined {
  const path = (t.path ?? "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
  if (t.path !== undefined) {
    const byPath = detected.find((d) => d.path === path);
    if (byPath) return byPath;
  }
  if (t.name) {
    const byName = detected.find((d) => d.name.toLowerCase() === t.name!.toLowerCase());
    if (byName) return byName;
  }
  return detected.length === 1 ? detected[0] : undefined;
}

export const deployMyAppTool: Tool<Input, Output> = {
  name: "deploy_my_app",
  description:
    "ONE-SHOT from-scratch pipeline for an app repo, on AWS (EKS+ECR), GCP (GKE+Artifact Registry) OR Azure (AKS+ACR) — " +
    "picked automatically from the target env's connected cloud. ANALYZES the repo's real files to find every " +
    "deployable service (a single app, OR a monorepo with a separate FRONTEND and BACKEND), ensures a registry repo + " +
    "keyless auth per service (and grants that identity cluster access), generates the Dockerfile(s), the CI " +
    "build→scan→push workflow(s), production-style Kubernetes manifests AND the CD deploy workflow (runs after CI, " +
    "keyless), and commits everything DIRECTLY to the target branch (default = repo's default branch; " +
    "commitMode='pr' is available but almost never used — the deploy playbook always uses direct). REQUIRED order: " +
    "(1) analyze_app_services, (2) list_kubernetes_resources(envKey, kind:'namespaces') and ask the user which " +
    "namespace to deploy into (```options``` — existing namespaces + 'Create new'), (3) list existing registry repos " +
    "(list_ecr_repos on AWS, list_artifact_registries on GCP, list_acr on Azure), (4) ask the user which repo to use " +
    "for EACH service (```options``` — existing repos + 'Create new'), (5) call this with `namespace` (the user's " +
    "choice) and `services` ([{name,path,imageName,expose}]) where imageName is the user's choice. The call FAILS " +
    "without `namespace` or `services`. AFTER merge everything is automatic: CI builds+pushes, then the CD workflow " +
    "deploys — watch each service with wait_for_workflow_run(workflowFile, then cdWorkflowFile) and confirm with " +
    "deployment_status. deploy_app is only the fallback if a CD run fails.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'The app repo as "owner/name" (attached to the project).',
      },
      envKey: {
        type: "string",
        description: "Target env (from list_deploy_targets) — its cluster is the deploy target.",
      },
      namespace: {
        type: "string",
        description:
          "REQUIRED. Kubernetes namespace to deploy into — the USER's choice, never the env's default silently. " +
          "Ask via list_kubernetes_resources(envKey, kind:'namespaces') then an ```options``` question (existing " +
          "namespaces + 'Create new: <default>').",
      },
      branch: {
        type: "string",
        description:
          "REQUIRED. Git branch the CI/CD workflow will trigger from — the USER's choice, never defaulted to " +
          "the repo's default silently. Ask via list_repo_branches then an ```options``` question (existing " +
          "branches + 'Create new: <default>'). If the branch name doesn't exist on GitHub yet, this tool " +
          "creates it off the repo's default branch before pushing.",
      },
      services: {
        type: "array",
        description:
          "REQUIRED. One entry per service from analyze_app_services, with imageName = the ECR repository the USER " +
          "chose (you must have asked them via an ```options``` question built from list_ecr_repos — even for a single service).",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: '"frontend" | "backend" | "app" (matches analyze_app_services).',
            },
            path: { type: "string", description: 'Build-context subdir; "" for repo root.' },
            imageName: {
              type: "string",
              description: "ECR repo name the user chose (existing) or the new name to create.",
            },
            expose: {
              type: "boolean",
              description: "Expose publicly via Ingress (needs host). Usually true for a frontend.",
            },
            host: { type: "string", description: "Public hostname when exposing." },
          },
          required: ["name", "imageName"],
          additionalProperties: false,
        },
      },
      appName: {
        type: "string",
        description: "Base app name (lowercase DNS label). Defaults to the repo name.",
      },
      replicas: { type: "number", description: "Replicas. Default 1." },
      commitMode: {
        type: "string",
        enum: ["pr", "direct"],
        description:
          "'direct' (default) commits straight to the target branch — the standard path, no PR. " +
          "'pr' opens a review PR for teams that require it; almost never used since branch protection " +
          "gates get enforced by GitHub anyway.",
      },
      overwriteDockerfile: {
        type: "boolean",
        description: "Replace an existing Dockerfile with the vetted template. Default false.",
      },
      manifestType: {
        type: "string",
        enum: ["manifests", "helm"],
        description:
          "How to package the app for Kubernetes. 'manifests' (default) → raw Deployment/Service/Ingress " +
          "YAMLs applied with `kubectl apply`. 'helm' → full chart (Chart.yaml + values.yaml + " +
          "values-<env>.yaml + templates/) under charts/<appName>/; CD workflow runs `helm upgrade --install`. " +
          "Ask via the deploy batch options-form (agent step 3).",
      },
    },
    required: ["repoFullName", "envKey", "namespace", "branch", "services"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // 0 — the repo must be attached; the env must exist.
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true, defaultBranch: true },
    });
    if (!repo)
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    const targets = await listDeployTargets(ctx.projectId);
    const target = targets.find((t) => t.envKey === input.envKey);
    if (!target)
      return { ok: false, error: `No deployable env "${input.envKey}" — use list_deploy_targets.` };

    // GATE: the namespace is the USER's choice — never default to the env's
    // namespace silently. The model must have asked (options built from
    // list_kubernetes_resources kind:"namespaces") and pass the answer.
    const namespace = (input.namespace || "").trim();
    if (!namespace) {
      return {
        ok: false,
        error:
          `Missing the user's namespace choice. Do NOT default to "${target.namespace || "default"}" or any other namespace yourself: ` +
          '(1) call list_kubernetes_resources(envKey, kind:"namespaces"), (2) ask ONE ```options``` question — the ' +
          `existing namespace names plus "Create new: ${sanitizeAppName(input.repoFullName.split("/").pop() || "app")}", ` +
          "(3) call deploy_my_app again with the user's answer as `namespace`.",
      };
    }

    // 1 — ANALYZE → every deployable service.
    const det = await analyzeAppServices(ctx.projectId, input.repoFullName);
    if (!det.ok) return { ok: false, error: `Repo analysis failed: ${det.error}` };

    // GATE: the ECR choice is the USER's — this tool refuses to guess it. The
    // model must have asked (options built from list_ecr_repos) and pass the
    // answer via services[].imageName, even for a single-service repo.
    if (
      !input.services ||
      input.services.length === 0 ||
      input.services.some((s) => !(s.imageName || "").trim())
    ) {
      return {
        ok: false,
        error:
          'Missing the user\'s container-registry choice. Do NOT pick a registry yourself: (1) list the existing registry repos (list_ecr_repos on AWS, list_artifact_registries on GCP), (2) ask the user ONE ```options``` question per detected service — the existing repo names plus "Create new: <suggestedImageName>" — services detected here: ' +
          det.services.map((s) => `${s.name} (suggested: ${s.suggestedImageName})`).join(", ") +
          ", (3) call deploy_my_app again with services:[{name, path, imageName: the user's answer, expose}].",
      };
    }

    // Resolve the list of services to deploy + their ECR name / expose choice.
    type Plan = { svc: AppService; imageName: string; expose: boolean; host?: string };
    const plans: Plan[] = [];
    for (const t of input.services) {
      const svc = matchService(det.services, t);
      if (!svc)
        return {
          ok: false,
          error: `Service "${t.name ?? t.path ?? "?"}" not found in the repo analysis (detected: ${det.services.map((s) => s.name).join(", ")}).`,
        };
      plans.push({
        svc,
        imageName: (t.imageName || svc.suggestedImageName).toLowerCase(),
        expose: !!t.expose,
        host: t.host,
      });
    }
    for (const p of plans) {
      if (p.expose && !(p.host || "").trim())
        return { ok: false, error: `A host is required to expose "${p.svc.name}" publicly.` };
    }

    const multi = plans.length > 1;
    const short = sanitizeAppName(input.repoFullName.split("/").pop() || "app");
    const baseApp = sanitizeAppName(input.appName || short);
    const tok = await resolveTokenForRepo(repo.id);

    // GATE: the branch is the USER's choice — never default to the repo's
    // default silently. The model must have asked (options built from
    // list_repo_branches) and pass the answer. If the branch doesn't exist on
    // GitHub yet, create it off the repo's default so the workflow can trigger.
    const requestedBranch = (input.branch || "").trim();
    if (!requestedBranch) {
      return {
        ok: false,
        error:
          `Missing the user's branch choice. Do NOT default to "${repo.defaultBranch || "main"}" silently: ` +
          "(1) call list_repo_branches(repoFullName), (2) ask ONE ```options``` question — the returned branch " +
          `names plus "Create new: ${repo.defaultBranch || "main"}", (3) call deploy_my_app again with the user's answer as \`branch\`.`,
      };
    }
    const branch = requestedBranch;
    const branchCreated = await ensureBranchExists(
      tok,
      input.repoFullName,
      branch,
      repo.defaultBranch || "main",
    );
    if (!branchCreated.ok) return branchCreated;

    // Which cloud is this env on? Drives the registry (ECR / Artifact Registry /
    // ACR) and the keyless CD auth (EKS OIDC / GKE WIF / AKS federated OIDC).
    const envRow = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: {
        kubeconfigRef: true,
        cloudProvider: { select: { id: true, kind: true, region: true, accountRef: true } },
      },
    });
    // Prefer the env's own linked provider; fall back to the project's own
    // cloud provider directly (CloudProvider.projectId) when the env was never
    // back-linked — e.g. a cluster connected via connect-cluster's fallback
    // resolver, which authenticates fine but doesn't persist cloudProviderId
    // onto the env row. Same fallback pattern connect-cluster itself uses.
    const provider =
      envRow?.cloudProvider ??
      (await prisma.cloudProvider.findFirst({
        where: { projectId: ctx.projectId, kind: { in: ["aws", "gcp", "azure"] } },
        select: { id: true, kind: true, region: true, accountRef: true },
        orderBy: { createdAt: "desc" },
      }));
    const cloud = provider?.kind;
    if (cloud !== "aws" && cloud !== "gcp" && cloud !== "azure") {
      return {
        ok: false,
        error: `deploy_my_app supports AWS (EKS + ECR), GCP (GKE + Artifact Registry), and Azure (AKS + ACR). The env "${input.envKey}" is on "${cloud ?? "no connected cloud"}".`,
      };
    }
    const cloudProviderId = provider!.id;

    // Cluster ref for the keyless CD, parsed from the env's stored kubeconfig.
    let eksRef: { region: string; accountId: string; clusterName: string } | null = null;
    let gkeRef: { projectId: string; location: string; clusterName: string } | null = null;
    let aksRef: { clusterName: string; resourceGroup: string } | null = null;
    if (envRow?.kubeconfigRef) {
      try {
        const kc = await decryptSecret(envRow.kubeconfigRef);
        // Cross-cloud pre-check: parse the kubeconfig for cluster kind REGARDLESS
        // of the env's cloudProviderId. If the cluster is on a different cloud
        // than the connected provider, the CD workflow can't authenticate — the
        // runner would have no creds for that cloud. Refuse loudly with a
        // remediation the user can act on, instead of generating a workflow
        // that fails with "NoCredentials" mid-CD.
        const wrongCloudEks = cloud !== "aws" && parseEksClusterRef(kc);
        const wrongCloudGke = cloud !== "gcp" && parseGkeClusterRef(kc);
        if (wrongCloudEks) {
          return {
            ok: false,
            error:
              `The env "${input.envKey}"'s cluster is EKS (cluster="${wrongCloudEks.clusterName}", region="${wrongCloudEks.region}") ` +
              `but the connected cloud provider on this env is "${cloud}". A GitHub Actions CD workflow needs AWS credentials in the runner to reach EKS, ` +
              `and the app has none because no AWS cloud provider is connected. Connect AWS on the Cloud providers page, then set the env's cloud provider to that AWS one, and rerun deploy_my_app. ` +
              `Alternatively, deploy server-side with deploy_app — the app has cluster access via the stored kubeconfig and does not need AWS creds in a runner.`,
          };
        }
        if (wrongCloudGke) {
          return {
            ok: false,
            error:
              `The env "${input.envKey}"'s cluster is GKE (cluster="${wrongCloudGke.clusterName}") ` +
              `but the connected cloud provider on this env is "${cloud}". A GitHub Actions CD workflow needs a GCP identity to reach GKE, and the app has none. ` +
              `Connect GCP on the Cloud providers page and set the env's cloud provider to it, then rerun deploy_my_app — or deploy server-side with deploy_app.`,
          };
        }
        if (cloud === "aws") eksRef = parseEksClusterRef(kc);
        else if (cloud === "gcp") gkeRef = parseGkeClusterRef(kc);
        else {
          const parsed = parseAksClusterRef(kc);
          if (parsed) {
            let rg = parsed.resourceGroup;
            if (!rg) {
              // Kubeconfig didn't carry the resource group — resolve it via ARM.
              const tok = await getAzureAccessToken(cloudProviderId);
              const subscription = provider!.accountRef?.trim();
              if (tok.ok && subscription) {
                const found = await findAksClusterByName(
                  tok.accessToken,
                  subscription,
                  parsed.clusterName,
                );
                if (found.ok) rg = found.resourceGroup;
              }
            }
            if (rg) aksRef = { clusterName: parsed.clusterName, resourceGroup: rg };
          }
        }
      } catch {
        /* no cluster ref → AWS CD falls back to the KUBECONFIG_B64 secret */
      }
    }
    const cdNotes: string[] = [];
    // Only when the cluster ref couldn't be resolved does the CD fall back to
    // the KUBECONFIG_B64 secret — EKS/GKE/AKS are otherwise all keyless.
    const needsSecretFallback =
      (cloud === "aws" && !eksRef) ||
      (cloud === "gcp" && !gkeRef) ||
      (cloud === "azure" && !aksRef);
    if (needsSecretFallback) {
      const kc = await setKubeconfigSecretTool.execute(
        { repoFullName: input.repoFullName, envKey: input.envKey },
        ctx,
      );
      cdNotes.push(
        kc.ok
          ? "Set the KUBECONFIG_B64 repo secret for the CD workflow."
          : `Could not set KUBECONFIG_B64 (${kc.error}) — set it with set_kubeconfig_secret.`,
      );
    }

    // 2+3 — per service: ensure the registry + keyless auth, then generate files.
    const allFiles: { path: string; content: string }[] = [];
    const deployed: DeployedService[] = [];
    const pipelineFilesByService: { path: string; content: string }[][] = [];
    const registrySteps: string[] = [];

    // Combined-mode collector — when a monorepo targets ECR + EKS, we emit ONE
    // ci.yml (matrix over services) + ONE cd.yml (workflow_run, matrix deploy)
    // instead of 2N per-service workflows. Collected during the per-service
    // loop below; the combined files get generated + prepended AFTER the loop.
    // GCP/Azure keep the per-service pattern for now — same combined shape can
    // be added later with matching generators.
    const useCombinedEksMode = multi && cloud === "aws" && !!eksRef;
    const combinedCiServices: Array<{ name: string; ecrRepositoryUri: string; context?: string }> = [];
    const combinedCdServices: Array<{ name: string; appName: string; manifestDir: string }> = [];
    let combinedCiRoleArn = "";
    let combinedCiRegion = "";
    for (const { svc, imageName, expose, host } of plans) {
      const appName = multi ? sanitizeAppName(`${baseApp}-${svc.name}`) : baseApp;
      // Combined mode uses one shared cd.yml across all services; per-service
      // mode uses deploy-<name>.yml per service.
      const useCombinedForThisSvc = multi && cloud === "aws" && !!eksRef;
      const cdWorkflowFile = useCombinedForThisSvc
        ? "cd.yml"
        : multi
        ? `deploy-${svc.name}.yml`
        : "deploy.yml";
      const cdWorkflowName = multi
        ? `Deploy ${svc.name} to Kubernetes (CD)`
        : "Deploy to Kubernetes (CD)";
      const manifestDir = multi ? `k8s/${input.envKey}/${svc.name}` : `k8s/${input.envKey}`;
      const keepDockerfile = svc.existingDockerfile && !input.overwriteDockerfile;
      const label = multi ? `[${svc.name}] ` : "";
      // Static-SPA's vetted Dockerfile ALWAYS COPYs nginx.conf. When we keep an
      // existing Dockerfile (from a prior deploy attempt), we still need to
      // commit nginx.conf next to it or `docker build` fails with
      // "COPY nginx.conf: not found". Only skip nginx.conf when we're also
      // keeping a NON-static-spa Dockerfile (which won't reference it).
      const needsNginxConf = svc.stack === "static-spa";
      const commonSpec = {
        stack: svc.stack,
        dockerParams: svc.params,
        branch,
        context: svc.path,
        cdWorkflowName,
        cdFileName: cdWorkflowFile,
        include: {
          dockerfile: !keepDockerfile,
          nginx: needsNginxConf || !keepDockerfile,
          compose: !keepDockerfile,
          cdWorkflow: true,
        },
        deploy: {
          appName,
          namespace,
          replicas: Math.max(1, input.replicas ?? 1),
          containerPort: svc.port,
          env: [],
          expose,
          host,
        },
        manifestDir,
      };

      let built: ReturnType<typeof buildCicdArtifacts>;
      let registryUri: string;
      let workflowFile: string;

      if (cloud === "gcp") {
        const location = provider!.region || "us-central1";
        const gcp = await setupGcpDeployRegistry(
          cloudProviderId,
          input.repoFullName,
          location,
          imageName,
        );
        if (!gcp.ok)
          return { ok: false, error: `Registry/WIF setup for "${svc.name}" failed: ${gcp.error}` };
        registrySteps.push(`${label}Artifact Registry "${imageName}" + keyless WIF ready.`);
        if (gkeRef)
          cdNotes.push(
            `${label}Granted the CI service account GKE deploy access (keyless CD ready).`,
          );
        workflowFile = multi ? `build-and-push-${svc.name}-gar.yml` : "build-and-push-gar.yml";
        const ciWorkflowName = multi
          ? `Build and push ${svc.name} to Artifact Registry`
          : "Build and push to Artifact Registry";
        registryUri = `${location}-docker.pkg.dev/${gcp.data.projectId}/${imageName}/${appName}`;
        built = buildCicdArtifacts({
          ...commonSpec,
          ciWorkflowName,
          ciFileName: workflowFile,
          registryUseVars: false,
          registry: {
            cloud: "gcp",
            workloadIdentityProvider: gcp.data.workloadIdentityProvider,
            serviceAccount: gcp.data.serviceAccount,
            location,
            projectId: gcp.data.projectId,
            repository: imageName,
            image: appName,
          },
          gkeCluster: gkeRef
            ? { clusterName: gkeRef.clusterName, location: gkeRef.location }
            : undefined,
        });
      } else if (cloud === "azure") {
        const providerRow = await prisma.cloudProvider.findUnique({
          where: { id: cloudProviderId },
          select: { resourceGroup: true, region: true },
        });
        const resourceGroup = aksRef?.resourceGroup || providerRow?.resourceGroup;
        if (!resourceGroup)
          return {
            ok: false,
            error: `No Azure resource group known for "${svc.name}" — connect an AKS cluster on this env or set a default resource group on the Cloud providers tab.`,
          };
        const location = providerRow?.region || "eastus";
        const azureAcrName =
          imageName
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .slice(0, 50) || "app";
        const az = await setupAzureDeployRegistry(
          cloudProviderId,
          input.repoFullName,
          resourceGroup,
          azureAcrName,
          location,
          branch,
          aksRef ?? undefined,
        );
        if (!az.ok)
          return { ok: false, error: `Registry/OIDC setup for "${svc.name}" failed: ${az.error}` };
        const keyless = az.data.mode === "keyless";
        registrySteps.push(
          keyless
            ? `${label}ACR "${azureAcrName}" + keyless federated OIDC ready.`
            : `${label}ACR "${azureAcrName}" ready (Azure connection is OAuth — using ACR admin credentials stored as GitHub secrets instead of keyless OIDC).`,
        );
        if (aksRef && keyless)
          cdNotes.push(
            `${label}Granted the CI app AKS admin credential access (keyless CD ready).`,
          );
        if (aksRef && !keyless)
          cdNotes.push(
            `${label}AKS CD via GitHub Actions isn't wired (needs a service-principal Azure connection). Once the image is pushed, use deploy_app to deploy server-side with the stored kubeconfig.`,
          );
        workflowFile = multi ? `build-and-push-${svc.name}-acr.yml` : "build-and-push-acr.yml";
        const ciWorkflowName = multi
          ? `Build and push ${svc.name} to ACR`
          : "Build and push to ACR";
        registryUri = `${az.data.loginServer}/${appName}`;
        const azureRegistry =
          az.data.mode === "keyless"
            ? {
                cloud: "azure" as const,
                mode: "keyless" as const,
                clientId: az.data.clientId,
                tenantId: az.data.tenantId,
                subscriptionId: az.data.subscriptionId,
                registry: az.data.registry,
                image: appName,
              }
            : {
                cloud: "azure" as const,
                mode: "secret" as const,
                secretPrefix: az.data.secretPrefix,
                registry: az.data.registry,
                image: appName,
              };
        built = buildCicdArtifacts({
          ...commonSpec,
          ciWorkflowName,
          ciFileName: workflowFile,
          registryUseVars: false,
          registry: azureRegistry,
          // Only wire the keyless AKS CD when we actually have SP creds.
          aksCluster:
            aksRef && keyless
              ? { clusterName: aksRef.clusterName, resourceGroup: aksRef.resourceGroup }
              : undefined,
        });
      } else {
        const oidc = await setupGithubOidcEcrTool.execute(
          { repoFullName: input.repoFullName, ecrRepoName: imageName },
          ctx,
        );
        if (!oidc.ok)
          return { ok: false, error: `Registry setup for "${svc.name}" failed: ${oidc.error}` };
        registrySteps.push(...oidc.output.steps.map((s) => `${label}${s}`));
        // Single service uses repo-level GitHub vars; a monorepo bakes values in.
        if (!multi && tok.ok) {
          await setRepoActionsVariable(
            tok.accessToken,
            input.repoFullName,
            "AWS_ROLE_ARN",
            oidc.output.roleArn,
          );
          await setRepoActionsVariable(
            tok.accessToken,
            input.repoFullName,
            "AWS_REGION",
            oidc.output.region,
          );
          await setRepoActionsVariable(
            tok.accessToken,
            input.repoFullName,
            "ECR_REPOSITORY",
            oidc.output.ecrRepositoryUri,
          );
        }
        // Keyless CD needs the CI role to have cluster RBAC (idempotent Access Entries).
        if (eksRef) {
          const grant = await grantEksAccessTool.execute(
            { envKey: input.envKey, roleArn: oidc.output.roleArn, accessLevel: "admin" },
            ctx,
          );
          cdNotes.push(
            grant.ok
              ? `${label}Granted ${oidc.output.roleArn} access to cluster ${eksRef.clusterName} (keyless CD ready).`
              : `${label}Could not grant cluster access (${grant.error}) — if the CD run fails "Unauthorized", call grant_eks_access(envKey, roleArn).`,
          );
        }
        // Combined-mode: one ci.yml + one cd.yml for the whole monorepo.
        // Skip per-service CI/CD workflow generation here; the combined files
        // get generated ONCE after the loop below.
        if (useCombinedEksMode) {
          workflowFile = "ci.yml";
          combinedCiRoleArn = oidc.output.roleArn;
          combinedCiRegion = oidc.output.region;
          combinedCiServices.push({
            name: svc.name,
            ecrRepositoryUri: oidc.output.ecrRepositoryUri,
            context: svc.path,
          });
          combinedCdServices.push({
            name: svc.name,
            appName,
            manifestDir,
          });
          registryUri = oidc.output.ecrRepositoryUri;
          built = buildCicdArtifacts({
            ...commonSpec,
            include: { ...commonSpec.include, ciWorkflow: false, cdWorkflow: false },
            registryUseVars: false,
            registry: {
              cloud: "aws",
              roleArn: oidc.output.roleArn,
              region: oidc.output.region,
              ecrRepositoryUri: oidc.output.ecrRepositoryUri,
            },
          });
        } else {
          workflowFile = multi ? `build-and-push-${svc.name}.yml` : "build-and-push.yml";
          const ciWorkflowName = multi
            ? `Build and push ${svc.name} to ECR`
            : "Build and push to ECR";
          registryUri = oidc.output.ecrRepositoryUri;
          built = buildCicdArtifacts({
            ...commonSpec,
            ciWorkflowName,
            ciFileName: workflowFile,
            eksCluster: eksRef
              ? { clusterName: eksRef.clusterName, region: eksRef.region }
              : undefined,
            registryUseVars: !multi,
            registry: {
              cloud: "aws",
              roleArn: oidc.output.roleArn,
              region: oidc.output.region,
              ecrRepositoryUri: oidc.output.ecrRepositoryUri,
            },
          });
        }
      }

      for (const f of built.files) allFiles.push(f);
      deployed.push({
        name: svc.name,
        path: svc.path,
        appName,
        imageRef: built.imageRef,
        containerPort: svc.port,
        registryUri,
        workflowFile,
        cdWorkflowFile,
        expose,
        keptExistingDockerfile: keepDockerfile,
      });
      // Kept alongside `deployed` (same index) so we can register a CI/CD-tab
      // pipeline (Run button) per service once every file is committed below —
      // not part of DeployedService/Output so we don't dump file contents back
      // into the model's context.
      pipelineFilesByService.push(built.files);
    }

    // Combined-mode: emit ONE ci.yml + ONE cd.yml for the whole monorepo,
    // now that we've collected every service. Matrix over services so both
    // frontend + backend build in parallel, and CD only fires once CI succeeds
    // for all of them.
    if (useCombinedEksMode && combinedCiServices.length > 0 && eksRef) {
      const combinedCi = generateCombinedEcrCiWorkflow({
        roleArn: combinedCiRoleArn,
        region: combinedCiRegion,
        branch,
        scanGate: true,
        services: combinedCiServices,
      });
      const combinedCd = generateCombinedEksCdWorkflow({
        roleArn: combinedCiRoleArn,
        region: combinedCiRegion,
        clusterName: eksRef.clusterName,
        namespace,
        services: combinedCdServices,
      });
      allFiles.push(combinedCi);
      allFiles.push(combinedCd);
      registrySteps.push(
        `Emitted ONE combined CI workflow (ci.yml — matrix over ${combinedCiServices.length} services, parallel builds) + ONE combined CD workflow (cd.yml — workflow_run gated on CI success, parallel deploys) instead of ${combinedCiServices.length * 2} per-service files.`,
      );
    }

    registrySteps.push(...cdNotes);

    // 4 — Push everything as ONE PR (or straight to the chosen branch).
    // For PR mode, use a UNIQUE branch name per run (`deploy/${baseApp}-<n>`)
    // so a prior failed deploy_my_app attempt CANNOT collide with this one —
    // eliminates the whole class of "not a fast forward" errors that plagued
    // reused `deploy/${baseApp}` branches. Trade-off: leaves harmless orphan
    // branches on the repo; the user can delete stale ones anytime, and the
    // PR link is stable per run (PR gets closed → source branch may be deleted).
    // Suffix derived from process.hrtime.bigint so ordering is deterministic
    // within a run and unique across runs without needing Date.now().
    // Default = 'direct'. Deploy playbook always commits straight to the
    // default branch (main / master); user has to explicitly opt in to 'pr'
    // for teams that require review — rare, and gated by GitHub's branch
    // protection anyway.
    const direct = input.commitMode !== "pr";
    const runId = process.hrtime.bigint().toString(36).slice(-8);
    const pushBranch = direct ? branch : `deploy/${baseApp}-${runId}`;
    const svcList = deployed
      .map((d) => `**${d.name}**${d.path ? ` (\`./${d.path}\`)` : ""} → \`${d.imageRef}\``)
      .join("\n- ");
    const prBody =
      `End-to-end pipeline generated by DeepAgent for **${baseApp}**` +
      (multi ? ` (monorepo — ${deployed.length} services).` : ` (${det.services[0].stackTitle}).`) +
      `\n\nServices:\n- ${svcList}\n\n` +
      allFiles.map((f) => `- \`${f.path}\``).join("\n") +
      `\n\nOn \`${branch}\`: CI builds → scans → pushes each image, then the CD workflow deploys it to the cluster automatically (${eksRef || gkeRef || aksRef ? "keyless — no stored cluster credentials" : "via the KUBECONFIG_B64 secret"}).`;

    // Commit every file to the push branch FIRST (no PR yet), then open the
    // PR on the LAST file. Previously we opened the PR on file 1, which had
    // two failure modes: (a) if the PR-open API call failed silently (old
    // catch-swallow bug), files 2..N still landed but no PR ever opened;
    // (b) GitHub occasionally 422'd "no commits between branches" when only
    // one commit existed at PR-open time. Opening on the last commit avoids
    // both — the branch has all commits by then, and a real failure surfaces
    // as an explicit error the agent can retry.
    const committed: string[] = [];
    let pullRequest: { number: number; url: string } | undefined;
    let lastCommitSha: string | undefined;
    for (let i = 0; i < allFiles.length; i++) {
      const f = allFiles[i];
      const isLast = i === allFiles.length - 1;
      const res = await writeRepoFileTool.execute(
        {
          repoFullName: input.repoFullName,
          path: f.path,
          content: f.content,
          branch: pushBranch,
          message: `Add app pipeline for ${baseApp} (DeepAgent)`,
          openPullRequest: !direct && isLast,
          // PR base = the branch the user picked in the deploy-config form,
          // NOT the repo's default branch. Otherwise CI (which triggers on
          // push to `branch`) never fires after merging into the default.
          targetBranch: branch,
          pullRequestBody: prBody,
        },
        ctx,
      );
      if (!res.ok) return { ok: false, error: `Failed writing ${f.path}: ${res.error}` };
      committed.push(f.path);
      lastCommitSha = res.output.commitSha;
      if (res.output.pullRequest) pullRequest = res.output.pullRequest;
    }
    if (!direct && !pullRequest) {
      return {
        ok: false,
        error:
          `Committed ${committed.length} file(s) to branch "${pushBranch}" but the PR into "${branch}" wasn't opened. ` +
          `Open it manually from ${input.repoFullName} → New pull request (${pushBranch} → ${branch}), or delete the branch and re-run deploy_my_app.`,
      };
    }

    // Files land on the default branch immediately (direct commit), but the
    // generated workflows trigger on workflow_dispatch ONLY (never push) — so
    // register a CI/CD-tab pipeline per service now, giving the user a "Run"
    // button that starts the build/deploy exactly when they click it.
    if (direct && lastCommitSha) {
      for (let i = 0; i < deployed.length; i++) {
        const d = deployed[i];
        await registerCommittedPipeline({
          projectId: ctx.projectId,
          repoId: repo.id,
          name: multi ? `${baseApp} — ${d.name}` : baseApp,
          files: pipelineFilesByService[i] ?? [],
          branch: pushBranch,
          commitSha: lastCommitSha,
          workflowPath: `.github/workflows/${d.workflowFile}`,
        });
      }
    }

    const watchHint = deployed
      .map(
        (d) =>
          `wait_for_workflow_run("${d.workflowFile}") then wait_for_workflow_run("${d.cdWorkflowFile}") then deployment_status(envKey:"${input.envKey}", appName:"${d.appName}")`,
      )
      .join("; and for the next service ");
    const next = direct
      ? `Files committed to ${branch}. Nothing builds automatically — the generated workflows only run on workflow_dispatch (by design), not on push. Tell the user to open the CI/CD → Pipelines tab and click "Run" for each service (${deployed.map((d) => d.name).join(", ")}) whenever they're ready to build & deploy. Once a run starts, the CD workflow deploys automatically after CI succeeds — watch it: ${watchHint}. deploy_app is only the fallback if the CD run fails.`
      : `PR #${pullRequest?.number ?? "?"} opened — after the user merges it, the files land on ${branch} but nothing builds automatically (workflow_dispatch only). They can click "Run" on each pipeline in the CI/CD → Pipelines tab to start it. Then watch: ${watchHint}. deploy_app is only the fallback if the CD run fails.`;

    // Echo which packaging style was picked so the deploy report + downstream
    // steps can see it. `helm` uses the existing scaffold_helm_chart + run_helm_upgrade
    // tools instead of raw manifests — the agent should route accordingly after
    // this call returns (see agent.ts step 4 for the branching prompt).
    const manifestType = input.manifestType ?? "manifests";
    const manifestNote =
      manifestType === "helm"
        ? "Manifest style: Helm chart — after this succeeds, run scaffold_helm_chart(repoFullName, chartPath:'charts/" +
          (input.appName || input.repoFullName.split("/")[1]) +
          "', imageRepository:'<registry>', targetPort:<port>) then run_helm_upgrade to install it. The CD workflow will use `helm upgrade --install` on subsequent pushes."
        : "Manifest style: raw manifests — CD workflow uses `kubectl apply` on the generated Deployment + Service + Ingress files.";

    return {
      ok: true,
      output: {
        monorepo: multi,
        services: deployed,
        files: committed,
        branch: pushBranch,
        namespace,
        pullRequest,
        registrySteps,
        manifestType,
        manifestNote,
        next,
      },
    };
  },
};

/**
 * Reset `branch` to the tip of `targetBranch`. Called before writing to the
 * PR's source branch (`deploy/${baseApp}`) so every deploy_my_app run starts
 * from a clean state — stale commits from prior failed runs otherwise trip
 * "Update is not a fast forward" on the ref PATCH inside commitFiles.
 *
 * Strategy: if the branch exists, DELETE it first, then create it fresh at
 * targetBranch's tip. DELETE + CREATE is bulletproof — no history alignment
 * check applies, unlike PATCH-with-force which GitHub sometimes refuses even
 * when force:true is set (branch protection edge cases, ref state drift).
 *
 * Safe here because deploy/${baseApp} is authored ONLY by this tool; no
 * user commits get lost. If a PR is open against this branch, GitHub keeps
 * the PR intact and re-points it at the new commits after we recreate.
 */
async function resetBranchToTarget(
  tok: Awaited<ReturnType<typeof resolveTokenForRepo>>,
  repoFullName: string,
  branch: string,
  targetBranch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!tok.ok)
    return {
      ok: false,
      error: `Couldn't resolve a GitHub token for "${repoFullName}": ${tok.message}`,
    };
  const headers = {
    Authorization: `Bearer ${tok.accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  // Look up target's head sha — the point we want branch to sit at.
  const target = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${encodeRefPath(targetBranch)}`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  if (!target || !target.ok)
    return { ok: false, error: `Couldn't read target branch "${targetBranch}".` };
  const targetSha = ((await target.json().catch(() => ({}))) as { object?: { sha?: string } })
    .object?.sha;
  if (!targetSha) return { ok: false, error: `Target branch "${targetBranch}" has no sha.` };

  // Does branch exist? If yes, delete it first — no PATCH-force ambiguity.
  const existing = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${encodeRefPath(branch)}`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  if (existing && existing.ok) {
    const del = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${encodeRefPath(branch)}`,
      { method: "DELETE", headers },
    ).catch(() => null);
    if (!del || (del.status !== 204 && del.status !== 422)) {
      const t = del ? await del.text().catch(() => "") : "network error";
      return {
        ok: false,
        error: `Deleting stale "${branch}" failed (HTTP ${del?.status ?? "?"}). ${t.slice(0, 160)}`,
      };
    }
  } else if (existing && existing.status !== 404) {
    return {
      ok: false,
      error: `Unexpected GitHub response reading "${branch}" (HTTP ${existing.status}).`,
    };
  }

  // Create fresh at target's tip. Retry once on 422 (rare race with a still-
  // propagating delete) with a brief pause.
  for (let attempt = 0; attempt < 3; attempt++) {
    const create = await fetch(`https://api.github.com/repos/${repoFullName}/git/refs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: targetSha }),
    }).catch(() => null);
    if (!create) return { ok: false, error: `Network error creating "${branch}".` };
    if (create.status === 201) return { ok: true };
    if (create.status === 422 && attempt < 2) {
      // GitHub may still see the just-deleted ref as existing for a moment.
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    const t = await create.text().catch(() => "");
    return {
      ok: false,
      error: `GitHub refused to create "${branch}" (HTTP ${create.status}). ${t.slice(0, 160)}`,
    };
  }
  return { ok: false, error: `Timed out recreating "${branch}" after DELETE.` };
}

/**
 * Confirm the requested target branch exists on GitHub; if not, create it off
 * the repo's default branch's tip sha. This is what makes "Create new: staging"
 * actually work — user picks a new name in the options block and we materialize
 * it before the first write_repo_file, so CI/CD triggers on push resolve.
 * Idempotent: creating an existing ref returns 422, which is treated as ok.
 */
async function ensureBranchExists(
  tok: Awaited<ReturnType<typeof resolveTokenForRepo>>,
  repoFullName: string,
  branch: string,
  defaultBranch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!tok.ok)
    return {
      ok: false,
      error: `Couldn't resolve a GitHub token for "${repoFullName}": ${tok.message}`,
    };
  const headers = {
    Authorization: `Bearer ${tok.accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Already exists? Nothing to do.
  const check = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${encodeRefPath(branch)}`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  if (check && check.ok) return { ok: true };
  if (check && check.status !== 404) {
    return { ok: false, error: `GitHub returned ${check.status} checking branch "${branch}".` };
  }
  // Look up the default branch's tip so we know where to branch from.
  const base = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${encodeRefPath(defaultBranch)}`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  if (!base || !base.ok) {
    return {
      ok: false,
      error: `Couldn't read the default branch "${defaultBranch}" of "${repoFullName}" to branch from — is the repo empty?`,
    };
  }
  const sha = ((await base.json().catch(() => ({}))) as { object?: { sha?: string } }).object?.sha;
  if (!sha) return { ok: false, error: `Default branch "${defaultBranch}" has no sha.` };
  // Create it.
  const create = await fetch(`https://api.github.com/repos/${repoFullName}/git/refs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  }).catch(() => null);
  if (!create) return { ok: false, error: `Network error creating branch "${branch}".` };
  if (create.status === 201) return { ok: true };
  if (create.status === 422) return { ok: true }; // race — someone created it first
  const t = await create.text().catch(() => "");
  return {
    ok: false,
    error: `GitHub refused to create branch "${branch}" (HTTP ${create.status}). ${t.slice(0, 160)}`,
  };
}
