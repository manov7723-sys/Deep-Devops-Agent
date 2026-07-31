import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { analyzeAppServices, type AppService } from "@/lib/automation/repo-analyze";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { parseAksClusterRef, setupAzureDeployRegistry } from "@/lib/cloud/azure-acr";
import { grantAksAccessTool } from "./grant-aks-access";
import { attachAcrToAksTool } from "./attach-acr-to-aks";
import { findAksClusterByName } from "@/lib/cloud/azure-arm";
import {
  detectAlbController,
  detectClusterSubnetType,
  detectServiceMonitorCrd,
} from "@/lib/cloud/aws-onboard";
import {
  applyArgoApplications,
  argoAccessInstructions,
  buildArgoApplication,
  ensureArgoCd,
} from "@/lib/devops/argocd";
import { kubeExecEnv } from "@/lib/runner/creds";
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
  /** Expose this service publicly. Set to true for user-facing services. */
  expose?: boolean;
  host?: string;
  /**
   * How to expose this service publicly — the USER's choice from the deploy
   * wizard's "Load balancer type" question (only relevant when expose=true):
   *
   *   - "nlb"      → Network Load Balancer (Layer 4). Service
   *                  type=LoadBalancer + internet-facing NLB annotations.
   *                  No domain needed. Needs the AWS Load Balancer
   *                  Controller when nodes are in private subnets.
   *   - "alb"      → Application Load Balancer (Layer 7). Service
   *                  type=ClusterIP + an Ingress with alb.ingress.*
   *                  annotations. Supports path routing / WAF / ACM TLS.
   *                  REQUIRES the AWS Load Balancer Controller. Host is
   *                  optional — without one the user gets the ALB DNS name.
   *   - "nodeport" → Service type=NodePort only. $0/mo, no LB. Reached at
   *                  <node-public-ip>:<nodePort>. Needs PUBLIC-subnet nodes
   *                  and an open node security group. Good for dev/demo.
   *   - "classic"  → Service type=LoadBalancer with NO annotations →
   *                  legacy Classic ELB from the in-tree controller. Needs
   *                  no extra controller; works on brand-new AWS accounts.
   *   - "ingress"  → Service type=ClusterIP + nginx Ingress on `host`.
   *                  Needs an nginx controller AND a domain.
   *   - unset      → Auto-detected: host given → "ingress"; else the tool
   *                  inspects the cluster's NODE GROUP subnets and picks
   *                  "nlb" (any private) or "classic" (all public).
   */
  exposeMode?: "nlb" | "alb" | "nodeport" | "classic" | "ingress";
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
  /**
   * GitOps mode — install ArgoCD (if absent) and let it reconcile the cluster
   * from git, instead of a push-based CD workflow.
   *
   * This is not an additive toggle: it REPLACES the deploy half of the
   * pipeline.
   *   • The image tag becomes an immutable `:<git-sha>`. `:latest` cannot work
   *     under Argo — Argo watches git, so if the manifest text never changes
   *     the cluster never changes and the new image is never deployed.
   *   • CI gains a step that rewrites that tag and commits. That commit IS the
   *     deploy trigger.
   *   • NO CD workflow is generated. One running `kubectl apply` would fight
   *     Argo's selfHeal and the two flap against each other.
   */
  useArgoCd?: boolean;
  /**
   * Build + deploy automatically on every push to the deploy branch.
   *
   * Generated CI workflows are `workflow_dispatch`-only by default, so files
   * land on the branch without building and nothing happens until someone
   * clicks Run. That is safe but confounds the usual expectation that pushing
   * code ships it. true adds a `push:` trigger (keeping the Run button) and,
   * in a monorepo, a `paths:` filter so one service's change doesn't redeploy
   * the other.
   */
  autoDeployOnPush?: boolean;
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
              description: "Expose publicly. Usually true for a frontend. See exposeMode.",
            },
            host: {
              type: "string",
              description: "Public hostname (e.g. app.acme.com) — REQUIRED only when exposeMode='ingress'.",
            },
            exposeMode: {
              type: "string",
              enum: ["nlb", "alb", "nodeport", "classic", "ingress"],
              description:
                "Load balancer type for this service — the USER's answer to the wizard's `lbType_<serviceName>` question. 'nlb' = Network LB (L4, no domain needed, fast). 'alb' = Application LB (L7, path routing + WAF + ACM TLS, needs the AWS Load Balancer Controller, host optional). 'nodeport' = NodePort only, no LB, $0/mo, reachable at <node-ip>:<nodePort> (public-subnet nodes only). 'classic' = plain Classic ELB, needs no controller. 'ingress' = nginx Ingress (needs a domain + nginx controller). Omit to let the tool auto-detect from the cluster's node-group subnets.",
            },
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
      autoDeployOnPush: {
        type: "boolean",
        description:
          "true = CI runs on every push to the deploy branch (plus the manual Run button), so pushing code builds and deploys automatically; in a monorepo a paths: filter keeps one service's change from rebuilding the other. false (default) = manual trigger only. Comes from the wizard's `autoDeploy` question — never guess it.",
      },
      useArgoCd: {
        type: "boolean",
        description:
          "GitOps mode. true = install ArgoCD on the cluster (if absent), commit an Argo Application, and let Argo sync the cluster from git; the image is tagged with the git SHA and CI commits that tag (the commit IS the deploy), and NO CD workflow is generated. false (default) = the normal push-based CD workflow with a :latest tag. Comes from the deploy wizard's `deployMode` question — never guess it.",
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

    // GitOps mode flips the pipeline shape — see Input.useArgoCd.
    const useArgo = input.useArgoCd === true;

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

    // GATE: in a MONOREPO (2+ services), the tool refuses to run unless every
    // service has an EXPLICIT `expose` boolean. Enforcing this at the tool
    // layer — not just via playbook prose — is deliberate: LLM playbook
    // instructions get skipped, but a tool-level 'missing' error forces the
    // agent to ask the user before the deploy can proceed. Without this gate
    // an agent that forgot the backendExpose question would silently deploy
    // the backend as ClusterIP (or worse, LoadBalancer) without ever asking
    // the user what they wanted. See `agent-playbook-tool-calls-need-step2`
    // memory: "a tool call only mentioned in prose gets skipped".
    if (input.services.length > 1) {
      const missing = input.services.find((s) => s.expose === undefined);
      if (missing) {
        const isBackend = /back[- ]?end|api|server|service/i.test(missing.name ?? "");
        return {
          ok: false,
          error:
            `Missing the user's exposure choice for "${missing.name}" — every service in a monorepo MUST have services[i].expose set to true or false explicitly (never omitted). ` +
            (isBackend
              ? "This is a BACKEND service — the batch options-form in step 3 MUST include a `backendExpose` question. Re-emit the batch form INCLUDING that question, mapping the user's answer to services[backend].expose (true for 'Yes — expose externally', false for 'No — internal only'). Set services[frontend].expose=true by default (frontends are user-facing)."
              : "Set expose based on the service type — frontends default to true (user-facing), other services should have been asked about via the batch form. Re-emit the batch form with a Yes/No exposure question for this service.") +
            " Then call deploy_my_app again with the answer set on services[i].expose. THIS IS A HARD GATE — the deploy cannot proceed with omitted expose fields.",
        };
      }
    }

    // Resolve the list of services to deploy + their ECR name / expose choice.
    type ExposeMode = "nlb" | "alb" | "nodeport" | "classic" | "ingress";
    type Plan = {
      svc: AppService;
      imageName: string;
      expose: boolean;
      host?: string;
      exposeMode?: ExposeMode;
    };
    const plans: Plan[] = [];
    for (const t of input.services) {
      const svc = matchService(det.services, t);
      if (!svc)
        return {
          ok: false,
          error: `Service "${t.name ?? t.path ?? "?"}" not found in the repo analysis (detected: ${det.services.map((s) => s.name).join(", ")}).`,
        };
      // Provisional exposeMode: the USER's explicit choice always wins. Else
      // fall back to 'ingress' when they supplied a host (that only makes
      // sense with an Ingress). Else leave UNDEFINED so the subnet-aware
      // block below can auto-detect once the cluster ref is resolved.
      const exposeMode: ExposeMode | undefined =
        t.exposeMode ?? (t.expose && (t.host || "").trim() ? "ingress" : undefined);
      plans.push({
        svc,
        imageName: (t.imageName || svc.suggestedImageName).toLowerCase(),
        expose: !!t.expose,
        host: t.host,
        exposeMode,
      });
    }
    for (const p of plans) {
      // Ingress mode is the only path that fundamentally needs a hostname.
      // ALB mode gives the user the LB's DNS name; loadbalancer likewise.
      if (p.expose && p.exposeMode === "ingress" && !(p.host || "").trim()) {
        return {
          ok: false,
          error:
            `Missing the user's domain for "${p.svc.name}" (exposeMode='ingress' requires a host). ` +
            "Ask ONE `options` question — 'Enter your domain (e.g. app.acme.com)' — and pass it as `host` on this service, then call deploy_my_app again.",
        };
      }
      // No gate for missing exposeMode: when expose=true is set without
      // exposeMode, the tool auto-defaults to 'alb' (internet-facing NLB
      // annotations — safe for both public and private subnet clusters).
      // Callers who want Ingress explicitly pass host + exposeMode='ingress'.
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
          // Resolve the AKS cluster identity through THREE escalating paths.
          // aksRef being null is not a soft failure — it disables combined
          // ci.yml/cd.yml generation AND the proactive RBAC/AcrPull grants,
          // so every path here matters (2026-07 incident).
          const tok = await getAzureAccessToken(cloudProviderId);
          const subscription = provider!.accountRef?.trim();
          const parsed = parseAksClusterRef(kc);

          // 1 — kubeconfig carried both cluster + RG (the `clusterUser_<rg>_<name>`
          //     shape `az aks get-credentials` and our own writer produce).
          if (parsed?.clusterName && parsed.resourceGroup) {
            aksRef = { clusterName: parsed.clusterName, resourceGroup: parsed.resourceGroup };
          }

          // 2 — cluster name known, RG missing → look the RG up by name.
          if (!aksRef && parsed?.clusterName && tok.ok && subscription) {
            const found = await findAksClusterByName(
              tok.accessToken,
              subscription,
              parsed.clusterName,
            );
            if (found.ok) {
              aksRef = { clusterName: parsed.clusterName, resourceGroup: found.resourceGroup };
            }
          }

          // 3 — nothing parseable, or the name didn't match any real cluster
          //     (stale kubeconfig, legacy generic "aks" placeholder, renamed
          //     cluster). Fall back to listing the subscription: exactly one
          //     cluster is unambiguous. Same policy grant_aks_access and
          //     repair_cd_kubeconfig already use.
          //
          //     MUST run even when step 1/2 produced a name — a parsed name
          //     that no longer resolves is exactly the stale-kubeconfig case,
          //     and giving up there is what left aksRef null for every Azure
          //     deploy.
          if (!aksRef && tok.ok && subscription) {
            const { listAksClusters } = await import("@/lib/cloud/azure-arm");
            const listed = await listAksClusters(tok.accessToken, subscription);
            if (listed.ok && listed.clusters.length === 1) {
              const only = listed.clusters[0];
              aksRef = { clusterName: only.name, resourceGroup: only.resourceGroup };
            }
            // Multiple clusters + an unresolvable kubeconfig → genuinely
            // ambiguous. Leave null; the deploy still works via the
            // KUBECONFIG_B64 CD path, just without combined mode.
          }
        }
      } catch {
        /* no cluster ref → AWS CD falls back to the KUBECONFIG_B64 secret */
      }
    }
    const cdNotes: string[] = [];

    // ── exposeMode auto-resolution (only for plans the user left unset) ────
    // ALB is the standing default for HTTP services — see the ADR at the top
    // of lib/devops/deploy-manifest.ts. NLB is NEVER auto-selected: this AWS
    // account cannot create NLBs, and the failure surfaces only as
    // EXTERNAL-IP <pending> with no error, which is near-undiagnosable.
    //
    // The only question worth asking is whether ALB is USABLE, i.e. is the
    // AWS Load Balancer Controller actually running:
    //   controller present            → "alb"      (Ingress → ALB, L7)
    //   absent + all-public nodes     → "classic"  (in-tree Classic ELB —
    //                                   no controller needed; the one path
    //                                   that still works on a bare cluster)
    //   absent + any private node     → "alb" anyway, plus a loud note. There
    //                                   is no working alternative: a Classic
    //                                   ELB cannot attach to private subnets,
    //                                   so silently emitting one would produce
    //                                   the exact <pending> hang we're fixing.
    //                                   Better to emit the correct manifest
    //                                   and tell the operator to install the
    //                                   controller (our EKS Terraform does).
    // ── Can this cluster hold a ServiceMonitor? ───────────────────────────
    // Emitted by default so the Observability page's app-metrics cards work
    // without the user hand-filling a scrape-target form. Skipped when the
    // Prometheus Operator CRDs are absent, because a ServiceMonitor doc in the
    // multi-doc manifest would fail the ENTIRE `kubectl apply` with
    // "no matches for kind ServiceMonitor" and take the deploy down with it.
    let canScrapeMetrics = false;
    if (envRow?.kubeconfigRef) {
      let kc: string | null = null;
      try {
        kc = decryptSecret(envRow.kubeconfigRef);
      } catch {
        /* unreadable kubeconfig → leave monitoring off */
      }
      if (kc) {
        const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const dir = await mkdtemp(join(tmpdir(), "dda-smchk-"));
        try {
          const p = join(dir, "config");
          await writeFile(p, kc, { mode: 0o600 });
          canScrapeMetrics = await detectServiceMonitorCrd(p);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
    cdNotes.push(
      canScrapeMetrics
        ? "[metrics] Prometheus Operator detected — emitting a ServiceMonitor per service so the app-metrics cards populate automatically (once the app exposes /metrics)."
        : "[metrics] No Prometheus Operator CRDs on this cluster — skipping ServiceMonitor. Install in-cluster monitoring from the Observability page to enable app metrics.",
    );

    // ── HARD GUARD: reject AWS-only expose modes on non-AWS clouds ─────────
    //
    // 'alb' and 'nlb' are AWS-specific. 'alb' emits an Ingress with
    // `ingressClassName: alb`, claimed ONLY by the AWS Load Balancer
    // Controller; 'nlb' emits `service.beta.kubernetes.io/aws-load-balancer-*`
    // annotations that Azure/GCP controllers ignore. On AKS/GKE the result is
    // an Ingress that never gets an ADDRESS — no event, no error, no timeout.
    // The app is simply unreachable and nothing says why (2026-07 incident).
    //
    // This runs as a SERVER-SIDE correction rather than a playbook rule
    // because the caller is an LLM: a prompt instruction is advisory, and a
    // product cannot ship a silent-unreachable failure mode that depends on
    // the model remembering which cloud it's on. Substitute rather than
    // error — the user asked for "a public load balancer" and 'classic'
    // (Service type=LoadBalancer, no annotations) delivers exactly that via
    // each cloud's in-tree controller.
    if (cloud !== "aws") {
      for (const p of plans) {
        if (p.exposeMode === "alb" || p.exposeMode === "nlb") {
          const from = p.exposeMode;
          p.exposeMode = "classic";
          cdNotes.push(
            `[expose] "${p.svc.name}": exposeMode '${from}' is AWS-only and does nothing on ${cloud} — ` +
              `substituted 'classic' (Service type=LoadBalancer). ${cloud === "azure" ? "Azure" : "GCP"} ` +
              `provisions a public load balancer for it directly. An '${from}' Ingress here would never ` +
              `receive an address.`,
          );
        }
      }
    }

    const anyNeedsAutoExpose = plans.some((p) => p.expose && !p.exposeMode);
    if (anyNeedsAutoExpose) {
      // Cloud-aware default. "alb" emits an Ingress with
      // `ingressClassName: alb`, which ONLY the AWS Load Balancer Controller
      // watches — it is meaningless on AKS/GKE. Defaulting every cloud to
      // "alb" (the pre-2026-07 behaviour) produced an Ingress that sat with
      // an empty ADDRESS forever on Azure: no controller claimed it, no error
      // surfaced, and the app was simply unreachable.
      //
      // "classic" = Service type=LoadBalancer with no annotations, which each
      // cloud's in-tree controller honours natively:
      //   Azure → Standard Load Balancer + public IP
      //   GCP   → Network Load Balancer + public IP
      // No add-on controller required, works on a bare cluster. AWS keeps its
      // richer detection below (real ALB when the controller is installed).
      let auto: ExposeMode = cloud === "aws" ? "alb" : "classic";
      if (cloud !== "aws") {
        cdNotes.push(
          `[expose] Cloud is "${cloud}" — auto exposeMode='classic' (Service type=LoadBalancer). ` +
            `The in-tree cloud controller provisions a public load balancer directly; ` +
            `'alb' is AWS-only and would leave the Ingress unassigned forever here. ` +
            `For host-based routing on this cloud, install an ingress controller (nginx / AGIC) ` +
            `and pass exposeMode='ingress' with a host.`,
        );
      }
      if (cloud === "aws" && eksRef) {
        let hasController = false;
        if (envRow?.kubeconfigRef) {
          let kc: string | null = null;
          try {
            kc = decryptSecret(envRow.kubeconfigRef);
          } catch {
            /* unreadable kubeconfig → treat as "controller unknown" */
          }
          if (kc) {
            const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
            const { join } = await import("node:path");
            const { tmpdir } = await import("node:os");
            const dir = await mkdtemp(join(tmpdir(), "dda-albchk-"));
            try {
              const p = join(dir, "config");
              await writeFile(p, kc, { mode: 0o600 });
              hasController = await detectAlbController(p);
            } finally {
              await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
        const subnets = await detectClusterSubnetType(
          cloudProviderId,
          eksRef.region,
          eksRef.clusterName,
        );
        const allPublic = subnets.ok && subnets.kind === "all_public";
        auto = hasController ? "alb" : allPublic ? "classic" : "alb";
        cdNotes.push(
          `[expose] Cluster "${eksRef.clusterName}": AWS Load Balancer Controller ` +
            `${hasController ? "present" : "NOT FOUND"}; node subnets ` +
            `${subnets.ok ? `${subnets.totalSubnets} total / ${subnets.privateCount} private` : `undetermined (${subnets.message})`}` +
            ` → auto exposeMode='${auto}'.`,
        );
        if (!hasController && auto === "alb") {
          cdNotes.push(
            "[expose] ACTION NEEDED: the Ingress will not produce an ALB until the " +
              "AWS Load Balancer Controller is installed. Clusters created by DeepAgent's " +
              "EKS blueprint install it via Terraform (IRSA + helm_release); this cluster " +
              "predates that or was built by hand.",
          );
        }
      }
      for (const p of plans) {
        if (p.expose && !p.exposeMode) p.exposeMode = auto;
      }
    }

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
    // Combined mode covers ANY multi-service deploy onto a known cluster.
    // Historically AWS-only; extended in 2026-07 so Azure/AKS monorepo deploys
    // also collapse to `ci.yml` + `cd.yml` instead of 4+ per-service files.
    // GCP/GKE will follow the same shape when the matching generators land.
    const useCombinedEksMode = multi && cloud === "aws" && !!eksRef;
    const useCombinedAksMode = multi && cloud === "azure" && !!aksRef;
    const useCombinedGkeMode = multi && cloud === "gcp" && !!gkeRef;
    const useCombinedMode = useCombinedEksMode || useCombinedAksMode || useCombinedGkeMode;
    const combinedCiServices: Array<{ name: string; ecrRepositoryUri: string; context?: string }> = [];
    const combinedCdServices: Array<{ name: string; appName: string; manifestDir: string }> = [];
    // Azure-specific combined collector. Kept separate from combinedCiServices
    // because the two clouds' shapes diverge (secret-mode ACR vs OIDC ECR).
    const combinedAcrServices: Array<{
      name: string;
      loginServer: string;
      imageBase: string;
      secretPrefix: string;
      context?: string;
    }> = [];
    // GCP collector. WIF provider + service account are the same across
    // services (one identity for the repo), so only the image and build
    // context differ per matrix row.
    const combinedGarServices: Array<{ name: string; imageBase: string; context?: string }> = [];
    let combinedGarWif = "";
    let combinedGarSa = "";
    let combinedGarLocation = "";
    let combinedGarProject = "";
    let combinedCiRoleArn = "";
    let combinedCiRegion = "";
    // Combined-mode: call setup_github_oidc_ecr ONCE upfront with the primary
    // service's ECR + additionalEcrRepos=[rest] so ONE role is created with a
    // policy that lists every service's ECR ARN. Without this, each per-service
    // OIDC call would silently overwrite the previous role's trust policy AND
    // create a role whose inline policy only allows push to that one service's
    // ECR — the matrix job for the other service fails with AccessDenied on
    // ecr:PutImage. This is the exact demo-blocker bug the audit surfaced.
    let combinedOidc: { roleArn: string; region: string; accountId: string } | null = null;
    if (useCombinedEksMode) {
      const primaryImage = plans[0]?.imageName?.trim().toLowerCase();
      const extraImages = plans
        .slice(1)
        .map((p) => p.imageName?.trim().toLowerCase())
        .filter((n): n is string => !!n && n !== primaryImage);
      if (primaryImage) {
        const oidcOnce = await setupGithubOidcEcrTool.execute(
          {
            repoFullName: input.repoFullName,
            ecrRepoName: primaryImage,
            additionalEcrRepos: extraImages,
          },
          ctx,
        );
        if (!oidcOnce.ok) {
          return { ok: false, error: `Combined-mode OIDC setup failed: ${oidcOnce.error}` };
        }
        combinedOidc = {
          roleArn: oidcOnce.output.roleArn,
          region: oidcOnce.output.region,
          accountId: oidcOnce.output.accountId,
        };
        registrySteps.push(...oidcOnce.output.steps.map((s) => `[combined] ${s}`));
        // Grant this SINGLE role EKS cluster access for the keyless CD.
        if (eksRef) {
          const grant = await grantEksAccessTool.execute(
            { envKey: input.envKey, roleArn: combinedOidc.roleArn, accessLevel: "admin" },
            ctx,
          );
          cdNotes.push(
            grant.ok
              ? `[combined] Granted ${combinedOidc.roleArn} access to cluster ${eksRef.clusterName} (keyless CD ready).`
              : `[combined] Could not grant cluster access (${grant.error}) — if the CD run fails "Unauthorized", call grant_eks_access(envKey, roleArn).`,
          );
        }
      }
    }
    for (const { svc, imageName, expose, host, exposeMode } of plans) {
      const appName = multi ? sanitizeAppName(`${baseApp}-${svc.name}`) : baseApp;
      // Combined mode uses one shared cd.yml across all services; per-service
      // mode uses deploy-<name>.yml per service.
      // Any multi-service deploy targeting a known cluster gets one cd.yml.
      const useCombinedForThisSvc = useCombinedMode;
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
        // Flips the image tag to :<git-sha> and adds the bump-and-commit job
        // that Argo watches for. See CicdPipelineSpec.gitops.
        gitops: useArgo,
        autoDeployOnPush: input.autoDeployOnPush === true,
        include: {
          dockerfile: !keepDockerfile,
          nginx: needsNginxConf || !keepDockerfile,
          compose: !keepDockerfile,
          // GitOps: NO CD workflow. Argo owns cluster state; a workflow doing
          // `kubectl apply` would be reverted by Argo's selfHeal, and the two
          // would flap against each other on every push.
          cdWorkflow: !useArgo,
        },
        deploy: {
          appName,
          namespace,
          replicas: Math.max(1, input.replicas ?? 1),
          containerPort: svc.port,
          env: [],
          // Declare the conventional config secrets in the MANIFEST rather than
          // patching them onto the live Deployment afterwards.
          //
          // WHY (2026-07 incident): the Connections page wrote `app-db`, someone
          // ran `kubectl patch ... envFrom`, and the next CD run re-applied this
          // generated manifest — which had no envFrom — silently stripping the
          // wiring. The app came back up with no DATABASE_URL and the failure
          // looked like a database outage.
          //
          // Both are `optional: true`, so a service deployed before any database
          // is connected still schedules normally; the moment the Secret exists,
          // the next roll picks it up.
          //   app-db  — DATABASE_URL + DB_* (written by the Connections page)
          //   app-env — application config/secrets (APP_SECRET_KEY, JWT keys, …)
          envFromSecrets: [
            { name: "app-db", optional: true },
            { name: "app-env", optional: true },
          ],
          expose,
          host,
          exposeMode,
          // Ship the scrape config WITH the app. The Observability page shows
          // request-rate / latency / 5xx cards unconditionally; without a
          // ServiceMonitor they stay "—" forever and the UI lies about what it
          // can show. Gated on the CRD actually existing (see canScrapeMetrics).
          scrapeMetrics: canScrapeMetrics,
          metricsPort: "http",
          metricsPath: "/metrics",
          // Service type derived from the user's load-balancer choice:
          //   expose=false        → ClusterIP  (internal only; the frontend
          //                         reaches it at svc.<ns>.svc.cluster.local,
          //                         saving ~$18/mo on a needless LB)
          //   'alb' | 'ingress'   → ClusterIP  (an Ingress fronts the Service;
          //                         the ALB/nginx controller targets pod IPs)
          //   'nodeport'          → NodePort   (no LB at all; reachable at
          //                         <node-public-ip>:<nodePort>)
          //   'nlb' | 'classic'   → LoadBalancer (annotations, or lack of
          //                         them, decide NLB vs Classic ELB)
          serviceType: !expose
            ? ("ClusterIP" as const)
            : exposeMode === "ingress" || exposeMode === "alb"
              ? ("ClusterIP" as const)
              : exposeMode === "nodeport"
                ? ("NodePort" as const)
                : ("LoadBalancer" as const),
          cloud,
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
        registryUri = `${location}-docker.pkg.dev/${gcp.data.projectId}/${imageName}/${appName}`;
        // Combined mode: collect for the single ci.yml/cd.yml emitted after
        // the loop, and suppress this service's own workflow files.
        if (useCombinedGkeMode) {
          combinedGarServices.push({ name: svc.name, imageBase: registryUri, context: svc.path });
          combinedCdServices.push({ name: svc.name, appName, manifestDir });
          combinedGarWif = gcp.data.workloadIdentityProvider;
          combinedGarSa = gcp.data.serviceAccount;
          combinedGarLocation = location;
          combinedGarProject = gcp.data.projectId;
        }
        workflowFile = useCombinedGkeMode
          ? "ci.yml"
          : multi ? `build-and-push-${svc.name}-gar.yml` : "build-and-push-gar.yml";
        const ciWorkflowName = multi
          ? `Build and push ${svc.name} to Artifact Registry`
          : "Build and push to Artifact Registry";
        built = buildCicdArtifacts({
          ...commonSpec,
          ciWorkflowName,
          ciFileName: workflowFile,
          include: useCombinedGkeMode
            ? { ...commonSpec.include, ciWorkflow: false, cdWorkflow: false }
            : commonSpec.include,
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
        // Proactive AKS RBAC grant — symmetric with the EKS Access Entry
        // grant above. The AKS blueprint ships with `azure_rbac_enabled =
        // true`, so any principal that will run kubectl against this cluster
        // needs the AAD RBAC role first. Without this, every deploy's first
        // kubectl call fails with "does not have access to the resource in
        // Azure" and only recovers via the classifier's auto-heal — which
        // works but wastes one round-trip and confuses the demo. Called
        // whether keyless or secret mode; grant_aks_access auto-detects the
        // caller identity (SP in keyless mode, user in OAuth secret mode)
        // and grants the appropriate principal type. Idempotent.
        if (aksRef) {
          const aksGrant = await grantAksAccessTool.execute(
            { envKey: input.envKey },
            ctx,
          );
          cdNotes.push(
            aksGrant.ok
              ? `${label}Granted ${aksGrant.output.principalType} ${aksGrant.output.principalObjectId} 'RBAC Cluster Admin' on AKS ${aksGrant.output.clusterName} — kubectl will work on first apply.`
              : `${label}Couldn't preemptively grant AKS RBAC (${aksGrant.error}) — if the CD fails with 'does not have access to the resource in Azure', the auto-heal will fire on the retry.`,
          );
          // Proactive AcrPull grant to the AKS kubelet — prevents the pods
          // coming up ImagePullBackOff because kubelet has no permission on
          // the ACR the deploy just pushed to. Idempotent (RoleAssignmentExists
          // = success) and cheap (one ARM PUT). Same-cluster call after the
          // RBAC grant so we hit both auth failures in one wave.
          const acrAttach = await attachAcrToAksTool.execute(
            { envKey: input.envKey, acrNames: [azureAcrName] },
            ctx,
          );
          cdNotes.push(
            acrAttach.ok
              ? `${label}Granted AKS kubelet AcrPull on ACR '${azureAcrName}' — pods can pull images on first apply.`
              : `${label}Couldn't preemptively grant AcrPull (${acrAttach.error}) — if pods come up ImagePullBackOff, call attach_acr_to_aks(envKey, acrNames=['${azureAcrName}']).`,
          );
        }
        // Combined mode: collapse to ONE ci.yml + ONE cd.yml (matrix over
        // services). Collected here; the actual files get generated once
        // after the loop. Only viable in secret-mode ACR right now — the
        // combined CI template uses docker/login-action per matrix row with
        // the same secret-prefix scheme as the per-service secret template.
        // Keyless mode continues on the per-service path until we ship a
        // matrix-friendly azure/login step.
        // TypeScript narrows `az.data.mode === "secret"` only inside the same
        // conditional — nest the check so `secretPrefix` (only present on the
        // secret branch of AzureDeployRegistry) is reachable.
        let combineThisSvc = false;
        if (useCombinedAksMode && az.data.mode === "secret") {
          combineThisSvc = true;
          combinedAcrServices.push({
            name: svc.name,
            loginServer: az.data.loginServer,
            imageBase: `${az.data.loginServer}/${appName}`,
            secretPrefix: az.data.secretPrefix,
            context: svc.path,
          });
          combinedCdServices.push({
            name: svc.name,
            appName,
            manifestDir,
          });
        }

        workflowFile = combineThisSvc
          ? "ci.yml"
          : multi ? `build-and-push-${svc.name}-acr.yml` : "build-and-push-acr.yml";
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
          // Combined mode owns ci.yml + cd.yml at the end of the loop, so
          // suppress the per-service workflows this call would otherwise
          // emit. Manifests + Dockerfiles still flow through normally.
          include: combineThisSvc
            ? { ...commonSpec.include, ciWorkflow: false, cdWorkflow: false }
            : commonSpec.include,
        });
      } else {
        // Combined mode: reuse the SINGLE role + policy provisioned upfront
        // (see combinedOidc above). Per-service OIDC calls would silently
        // overwrite the shared role's trust policy — the whole point of
        // combined mode is one role covering every service.
        const oidc =
          useCombinedEksMode && combinedOidc
            ? {
                ok: true as const,
                output: {
                  roleArn: combinedOidc.roleArn,
                  region: combinedOidc.region,
                  accountId: combinedOidc.accountId,
                  ecrRepositoryUri: `${combinedOidc.accountId}.dkr.ecr.${combinedOidc.region}.amazonaws.com/${imageName}`,
                  ecrRepositoryName: imageName,
                  oidcProviderArn: `arn:aws:iam::${combinedOidc.accountId}:oidc-provider/token.actions.githubusercontent.com`,
                  steps: [],
                },
              }
            : await setupGithubOidcEcrTool.execute(
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
        // Keyless CD needs the CI role to have cluster RBAC (idempotent Access
        // Entries). Skip in combined mode — we already granted the SHARED role
        // access upfront when combinedOidc was set up; per-service grants
        // would just repeat the same idempotent call.
        if (eksRef && !useCombinedEksMode) {
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

    // GCP/GKE mirror of the AWS + Azure combined-mode emissions. Simpler than
    // Azure's because GCP auth is keyless: one WIF identity serves every
    // matrix row, so there are no per-service secrets to select between.
    if (useCombinedGkeMode && combinedGarServices.length > 0 && gkeRef) {
      const { generateCombinedGarCiWorkflow, generateCombinedGkeCdWorkflow } = await import(
        "@/lib/ci/templates"
      );
      const combinedCi = generateCombinedGarCiWorkflow({
        workloadIdentityProvider: combinedGarWif,
        serviceAccount: combinedGarSa,
        location: combinedGarLocation,
        branch,
        scanGate: true,
        services: combinedGarServices,
      });
      const combinedCd = generateCombinedGkeCdWorkflow({
        workloadIdentityProvider: combinedGarWif,
        serviceAccount: combinedGarSa,
        projectId: combinedGarProject,
        location: gkeRef.location,
        clusterName: gkeRef.clusterName,
        namespace,
        services: combinedCdServices,
      });
      allFiles.push(combinedCi);
      allFiles.push(combinedCd);
      registrySteps.push(
        `Emitted ONE combined CI workflow (ci.yml — matrix over ${combinedGarServices.length} services, parallel builds) + ONE combined CD workflow (cd.yml — workflow_run gated on CI success, keyless GKE access) instead of ${combinedGarServices.length * 2} per-service files.`,
      );
    }

    // Azure/AKS mirror of the AWS combined-mode emission above. Runs when
    // multi-service Azure deploys used secret-mode ACR auth for every
    // service (the current common case for OAuth-connected Azure).
    if (useCombinedAksMode && combinedAcrServices.length > 0 && aksRef) {
      const { generateCombinedAcrCiWorkflow, generateCombinedAksCdWorkflow } = await import(
        "@/lib/ci/templates"
      );
      const combinedCi = generateCombinedAcrCiWorkflow({
        branch,
        scanGate: true,
        services: combinedAcrServices,
      });
      const combinedCd = generateCombinedAksCdWorkflow({
        namespace,
        services: combinedCdServices,
      });
      allFiles.push(combinedCi);
      allFiles.push(combinedCd);
      registrySteps.push(
        `Emitted ONE combined CI workflow (ci.yml — matrix over ${combinedAcrServices.length} services, parallel builds) + ONE combined CD workflow (cd.yml — workflow_run gated on CI success, parallel deploys) instead of ${combinedAcrServices.length * 2} per-service files.`,
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
    // register CI/CD-tab pipeline(s) now, giving the user a "Run" button that
    // starts the build/deploy exactly when they click it.
    //
    // Combined mode (monorepo → ECR + EKS): register ONE pipeline pointing at
    // the single ci.yml, carrying ALL committed files (every service's
    // Dockerfile + manifests + the shared ci.yml + cd.yml). The user sees ONE
    // pipeline whose Run button matrix-builds every service and then triggers
    // the single cd.yml — NOT one row per service. Non-combined mode keeps the
    // per-service registration (each has its own build-and-push-<svc>.yml).
    if (direct && lastCommitSha) {
      if (useCombinedEksMode) {
        // TWO rows total, regardless of service count: one CI (builds every
        // service in a matrix), one CD (deploys every service after CI
        // succeeds). The CI row's Run button matrix-builds all services; the
        // CD row's Run button re-deploys the latest images without a rebuild
        // (cd.yml also accepts workflow_dispatch).
        await registerCommittedPipeline({
          projectId: ctx.projectId,
          repoId: repo.id,
          name: `${baseApp} — CI (build all services)`,
          files: allFiles,
          branch: pushBranch,
          commitSha: lastCommitSha,
          workflowPath: `.github/workflows/ci.yml`,
        });
        await registerCommittedPipeline({
          projectId: ctx.projectId,
          repoId: repo.id,
          name: `${baseApp} — CD (deploy all services)`,
          files: allFiles,
          branch: pushBranch,
          commitSha: lastCommitSha,
          workflowPath: `.github/workflows/cd.yml`,
        });
      } else {
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
    }

    // ── GitOps bootstrap ──────────────────────────────────────────────────
    // Runs AFTER the manifests are committed, because the Argo Application
    // points at a repo path that must already exist — pointing Argo at an
    // empty path makes the first sync fail and the app show as Missing.
    //
    // Install is per-CLUSTER (reused when already present); the Application is
    // per-SERVICE. The Application CR is applied server-side rather than only
    // committed: it is the bootstrap that tells Argo to start watching at all,
    // so a committed-but-unapplied file would do nothing.
    if (useArgo) {
      if (!envRow?.kubeconfigRef) {
        cdNotes.push(
          "[argocd] SKIPPED — this env has no connected cluster, so ArgoCD could not be installed. Connect a cluster, then redeploy.",
        );
      } else {
        const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const dir = await mkdtemp(join(tmpdir(), "dda-argo-boot-"));
        try {
          const kcPath = join(dir, "config");
          await writeFile(kcPath, decryptSecret(envRow.kubeconfigRef), { mode: 0o600 });
          const execEnv = await kubeExecEnv(kcPath, envRow.cloudProvider?.id ?? null);

          const install = await ensureArgoCd({ kubeconfigPath: kcPath, execEnv });
          if (!install.ok) {
            cdNotes.push(`[argocd] Install failed: ${install.error}`);
          } else {
            cdNotes.push(`[argocd] ${install.note}`);
            const repoUrl = `https://github.com/${input.repoFullName}.git`;
            const apps = deployed.map((d) =>
              buildArgoApplication({
                name: d.appName,
                repoUrl,
                branch,
                path: multi ? `k8s/${input.envKey}/${d.name}` : `k8s/${input.envKey}`,
                destinationNamespace: namespace,
              }),
            );
            const applied = await applyArgoApplications({
              kubeconfigPath: kcPath,
              execEnv,
              manifests: apps,
            });
            if (applied.ok) {
              cdNotes.push(
                `[argocd] ${applied.applied} Application(s) created and watching ${repoUrl} @ ${branch}. ` +
                  "Every push now deploys: CI builds + commits the new image tag, Argo syncs that commit.",
              );
              cdNotes.push(`[argocd] UI → ${argoAccessInstructions(install.adminPassword)}`);
            } else {
              cdNotes.push(`[argocd] Could not create the Application: ${applied.error}`);
            }
          }
        } catch (e) {
          cdNotes.push(
            `[argocd] Bootstrap error: ${e instanceof Error ? e.message : "unknown"}`,
          );
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // Combined mode: ONE ci.yml matrix-builds every service, then the single
    // cd.yml matrix-deploys every service. Watch the two combined workflows,
    // then check each service's rollout. Non-combined: per-service pairs.
    const watchHint = useCombinedEksMode
      ? `wait_for_workflow_run("ci.yml") then wait_for_workflow_run("cd.yml") then ${deployed
          .map((d) => `deployment_status(envKey:"${input.envKey}", appName:"${d.appName}")`)
          .join(" then ")}`
      : deployed
          .map(
            (d) =>
              `wait_for_workflow_run("${d.workflowFile}") then wait_for_workflow_run("${d.cdWorkflowFile}") then deployment_status(envKey:"${input.envKey}", appName:"${d.appName}")`,
          )
          .join("; and for the next service ");
    const runInstruction = useCombinedEksMode
      ? `click "Run" ONCE on the "${baseApp} — CI (build all services)" pipeline — its matrix builds every service (${deployed
          .map((d) => d.name)
          .join(", ")}) in parallel, and the single CD pipeline auto-deploys all of them once CI succeeds`
      : `click "Run" for each service (${deployed.map((d) => d.name).join(", ")})`;
    const next = direct
      ? `Files committed to ${branch}. Nothing builds automatically — the generated workflows only run on workflow_dispatch (by design), not on push. Tell the user to open the CI/CD → Pipelines tab and ${runInstruction} whenever they're ready to build & deploy. Once CI starts, the CD workflow deploys automatically after it succeeds — watch it: ${watchHint}. deploy_app is only the fallback if the CD run fails.`
      : `PR #${pullRequest?.number ?? "?"} opened — after the user merges it, the files land on ${branch} but nothing builds automatically (workflow_dispatch only). They can ${runInstruction} in the CI/CD → Pipelines tab to start it. Then watch: ${watchHint}. deploy_app is only the fallback if the CD run fails.`;

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
