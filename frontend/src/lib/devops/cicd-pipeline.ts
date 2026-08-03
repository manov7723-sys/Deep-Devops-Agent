/**
 * CI/CD pipeline orchestrator — composes the existing, vetted, deterministic
 * generators into ONE file set for a repo, so the "Set up CI/CD" box generates
 * and opens a SINGLE PR instead of the agent hand-writing files conversationally
 * (which hallucinated "pushed" and invented bad action versions).
 *
 *   CI  → Dockerfile (+ .dockerignore, compose, nginx.conf) + a build/scan/push
 *         workflow for the connected cloud's registry (ECR / GAR / ACR).
 *   CD  → k8s/manifest.yaml + a deploy workflow that runs ONLY AFTER the CI
 *         workflow completes successfully (workflow_run) — enforcing CI→CD
 *         ordering — then kubectl-applies to the cluster.
 *
 * Each file is individually toggleable (`include`), so the box can write only
 * the parts the user wants. Every artifact comes from the vetted templates;
 * nothing here writes Dockerfile/YAML syntax by hand.
 */
import {
  generateDockerArtifacts,
  generateEcrWorkflow,
  generateGarWorkflow,
  generateAcrWorkflow,
  type DockerStackId,
  type GeneratedFile,
} from "@/lib/ci/templates";
import { normalizeManifestDir } from "./cd-files";
import { buildDeployManifest, sanitizeAppName, type DeploySpec } from "./deploy-manifest";

export type CicdRegistry =
  | { cloud: "aws"; roleArn: string; region: string; ecrRepositoryUri: string }
  | {
      cloud: "gcp";
      workloadIdentityProvider: string;
      serviceAccount: string;
      location: string;
      projectId: string;
      repository: string;
      image: string;
    }
  | {
      cloud: "azure";
      registry: string;
      image: string;
      /**
       * "keyless" → azure/login OIDC with clientId/tenantId/subscriptionId.
       * "secret"  → docker login with ACR admin creds stored as repo secrets
       *             under `<secretPrefix>_LOGIN_SERVER/USERNAME/PASSWORD` (the
       *             OAuth-friendly fallback).
       */
      mode?: "keyless" | "secret";
      clientId?: string;
      tenantId?: string;
      subscriptionId?: string;
      secretPrefix?: string;
    };

/** Which files to write. Every flag defaults to true (undefined = include). */
export type FileToggles = {
  /** Dockerfile + .dockerignore. */
  dockerfile?: boolean;
  compose?: boolean;
  /** nginx.conf — only produced for the static-spa stack. */
  nginx?: boolean;
  /** .github/workflows/build-and-push.yml (needs a registry). */
  ciWorkflow?: boolean;
  /** .github/workflows/deploy.yml. */
  cdWorkflow?: boolean;
  /** k8s/<dir>/manifest.yaml (needs an image ref). */
  manifest?: boolean;
};

export type CicdPipelineSpec = {
  stack: DockerStackId;
  dockerParams?: Record<string, unknown>;
  /** Default branch the CI workflow triggers on (auto-detected — e.g. "master"). */
  branch: string;
  /** Trivy gate that fails the build on HIGH/CRITICAL before push. Default on. */
  scanGate?: boolean;
  /** Registry the CI workflow pushes to. Optional — omit when the CI workflow + manifest are disabled. */
  registry?: CicdRegistry;
  /** Manifest inputs; `image` is filled from the registry when omitted. */
  deploy: Omit<DeploySpec, "image"> & { image?: string };
  /** Repo folder for the manifests (default "k8s"). */
  manifestDir?: string;
  /** Per-file include flags (all default true). */
  include?: FileToggles;
  /**
   * Service build context subdir for a monorepo (e.g. "frontend"). Default "" =
   * repo root. When set, the Dockerfile/.dockerignore/nginx/compose are written
   * inside this dir and the CI workflow builds from it.
   */
  context?: string;
  /** Unique CI workflow `name:` for this service (multi-service). */
  ciWorkflowName?: string;
  /** Unique CI workflow file basename, e.g. "build-and-push-frontend.yml". */
  ciFileName?: string;
  /** Unique CD workflow `name:` for this service (multi-service). */
  cdWorkflowName?: string;
  /** Unique CD workflow file basename, e.g. "deploy-frontend.yml". */
  cdFileName?: string;
  /**
   * GitOps mode — ArgoCD reconciles the cluster from git.
   *
   * Changes two things about the generated pipeline:
   *   • the manifest's image tag becomes an immutable `:<git-sha>`, because a
   *     `:latest` tag never changes the git content and so never triggers a
   *     sync — the new image would sit unused in the registry;
   *   • CI gains a step that rewrites that tag and COMMITS the manifest. That
   *     commit is the deploy trigger; Argo watches git, not the registry.
   *
   * The caller must ALSO skip generating a CD workflow (include.cdWorkflow =
   * false): a workflow running `kubectl apply` fights Argo's self-heal, and
   * the two flap against each other.
   */
  gitops?: boolean;
  /**
   * Trigger CI on push to the deploy branch, not just the Run button.
   *
   * Generated workflows are `workflow_dispatch` only by default so files can
   * land on the branch without immediately building. That surprises anyone
   * expecting a normal pipeline — 'I pushed and nothing happened'. Turning
   * this on adds a `push:` trigger (keeping workflow_dispatch for manual
   * re-runs) and, in a monorepo, a `paths:` filter so a frontend change does
   * not rebuild the backend.
   */
  autoDeployOnPush?: boolean;
  /**
   * EKS cluster the CD workflow deploys to — enables the KEYLESS CD variant
   * (OIDC role + `aws eks update-kubeconfig`, no KUBECONFIG_B64 secret).
   * AWS registry only. Omit for the kubeconfig-secret CD.
   */
  eksCluster?: { clusterName: string; region: string };
  /**
   * GKE cluster the CD workflow deploys to — enables the KEYLESS GKE CD variant
   * (WIF auth + get-gke-credentials). GCP registry only.
   */
  gkeCluster?: { clusterName: string; location: string };
  /**
   * AKS cluster the CD workflow deploys to — enables the KEYLESS AKS CD variant
   * (federated OIDC + admin credentials). Azure registry only.
   */
  aksCluster?: { clusterName: string; resourceGroup: string };
  /**
   * AWS only: reference repo-level GitHub vars (AWS_ROLE_ARN/REGION/ECR_REPOSITORY)
   * instead of baking values in. Default true for a single service. Multi-service
   * repos must pass false (repo vars can't differ per workflow).
   */
  registryUseVars?: boolean;
};

/** The `name:` each registry's CI generator emits — the CD workflow_run keys off it. */
const CI_WORKFLOW_NAME: Record<CicdRegistry["cloud"], string> = {
  aws: "Build and push to ECR",
  gcp: "Build and push to Artifact Registry",
  azure: "Build and push to ACR",
};

/** Registry path WITHOUT a tag — callers append :latest or :<sha>. */
function registryImageBase(r: CicdRegistry): string {
  switch (r.cloud) {
    case "aws":
      return r.ecrRepositoryUri;
    case "gcp":
      return `${r.location}-docker.pkg.dev/${r.projectId}/${r.repository}/${r.image}`;
    case "azure":
      return `${r.registry}.azurecr.io/${r.image}`;
  }
}

/**
 * The image reference baked into the generated manifest.
 *
 * GitOps mode uses an IMMUTABLE `:<sha>` tag. `:latest` cannot work under
 * ArgoCD: Argo reconciles against git, so if the manifest text never changes
 * neither does the cluster — a new `:latest` push would sit in the registry
 * forever. The CI workflow rewrites this tag on every build and commits it,
 * and that commit is what Argo actually deploys.
 *
 * Push-based CD keeps `:latest` + `rollout restart`, which is simpler and has
 * no commit-back step.
 */
function registryImageLatest(r: CicdRegistry, gitops = false): string {
  const base = registryImageBase(r);
  // A literal placeholder the CI step replaces with the real SHA. Kept
  // recognisable so a human reading the committed manifest can tell it is
  // machine-managed.
  return gitops ? `${base}:REPLACED_BY_CI` : `${base}:latest`;
}

/**
 * Append the GitOps "bump image tag and commit" job to a generated CI workflow.
 *
 * Appended rather than woven into each cloud's generator so the three
 * registries (ECR/GAR/ACR) stay untouched and the GitOps behaviour lives in
 * exactly one place.
 *
 * This job IS the deploy trigger. ArgoCD reconciles against git, so the only
 * way a freshly built image reaches the cluster is for its tag to appear in a
 * committed manifest. Without this step the pipeline would build, push, and
 * change nothing.
 *
 * `[skip ci]` in the commit message prevents the commit from re-triggering the
 * same workflow — otherwise every build queues another build, forever.
 */
function appendGitopsBumpJob(
  file: GeneratedFile,
  args: { manifestDir: string; imageBase: string; branch: string },
): GeneratedFile {
  const { manifestDir, imageBase, branch } = args;
  const dir = manifestDir.replace(/^\/+|\/+$/g, "");
  const bump = `
  bump-manifest:
    name: Bump image tag + commit (GitOps)
    needs: build-and-push
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${branch}
          # Default GITHUB_TOKEN is enough to push back to the same repo when
          # contents:write is granted above.
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Point the manifest at this commit's image
        run: |
          set -euo pipefail
          TAG="\${GITHUB_SHA::7}"
          FILE="${dir}/manifest.yaml"
          test -f "$FILE" || { echo "::error::$FILE not found"; exit 1; }
          # Replace whatever tag is currently on our image with the new SHA.
          # Anchored to the image path so other images in the file are untouched.
          sed -i -E "s#(${imageBase.replace(/[.*+?^\${}()|[\]\\]/g, "\\\\$&")}):[A-Za-z0-9._-]+#\\1:\${TAG}#g" "$FILE"
          echo "Image now:"; grep -n "image:" "$FILE" || true

      - name: Commit the bump
        run: |
          set -euo pipefail
          git config user.name  "deepagent-ci"
          git config user.email "ci@deepagent.local"
          if git diff --quiet -- "${dir}/manifest.yaml"; then
            echo "Manifest already at this SHA — nothing to commit."
            exit 0
          fi
          git add "${dir}/manifest.yaml"
          # [skip ci] stops this commit from re-triggering the build workflow.
          git commit -m "chore(deploy): \${GITHUB_SHA::7} [skip ci]"
          git push origin HEAD:${branch}
          echo "Pushed — ArgoCD will sync this commit to the cluster."
`;
  return { ...file, content: `${file.content.replace(/\s*$/, "")}\n${bump}` };
}

/**
 * Turn a manual-only CI workflow into one that also fires on push.
 *
 * The generators emit `on: workflow_dispatch:` — a deliberate default so
 * generated files can land on the default branch without immediately building
 * anything. But it means "I pushed code and nothing happened", which is not
 * what most people expect from a deploy pipeline. This rewrites the trigger
 * when the user asks for auto-deploy.
 *
 * `workflow_dispatch` is KEPT alongside `push` so the Run button and manual
 * re-runs still work — losing that would make a failed build unrepeatable
 * without an empty commit.
 *
 * In a monorepo a `paths:` filter is added from the service's build context,
 * so pushing a frontend change doesn't rebuild and redeploy the backend. The
 * workflow file itself is included in the filter so edits to the pipeline
 * still trigger a run.
 */
function enablePushTrigger(
  file: GeneratedFile,
  args: { branch: string; context?: string; fileName?: string },
): GeneratedFile {
  const { branch, context, fileName } = args;
  const ctx = (context ?? "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
  const pathsBlock = ctx
    ? `\n    paths:\n      - "${ctx}/**"\n${fileName ? `      - ".github/workflows/${fileName}"\n` : ""}`
    : "\n";
  const replacement = `on:
  push:
    branches: ["${branch}"]${pathsBlock}  workflow_dispatch:`;

  // Match the generators' exact shape: `on:` then an indented workflow_dispatch
  // (with or without an empty-map suffix).
  const re = /on:\n\s+workflow_dispatch:(\s*\{\})?/;
  if (!re.test(file.content)) return file; // unknown shape — leave it alone
  return { ...file, content: file.content.replace(re, replacement) };
}

function ciWorkflowFor(
  branch: string,
  scanGate: boolean,
  r: CicdRegistry,
  opts?: {
    context?: string;
    workflowName?: string;
    fileName?: string;
    useVars?: boolean;
    gitops?: boolean;
    manifestDir?: string;
    imageBase?: string;
    autoDeployOnPush?: boolean;
  },
): GeneratedFile {
  const withGitops = (f: GeneratedFile): GeneratedFile =>
    opts?.gitops && opts.manifestDir && opts.imageBase
      ? appendGitopsBumpJob(f, {
          manifestDir: opts.manifestDir,
          imageBase: opts.imageBase,
          branch,
        })
      : f;
  const withPush = (f: GeneratedFile): GeneratedFile =>
    opts?.autoDeployOnPush
      ? enablePushTrigger(f, { branch, context: opts.context, fileName: opts.fileName })
      : f;
  // Order matters only for readability: the trigger sits at the top of the
  // file, the bump job at the bottom, so either order produces the same YAML.
  return withPush(withGitops(ciWorkflowForInner(branch, scanGate, r, opts)));
}

function ciWorkflowForInner(
  branch: string,
  scanGate: boolean,
  r: CicdRegistry,
  opts?: { context?: string; workflowName?: string; fileName?: string; useVars?: boolean },
): GeneratedFile {
  switch (r.cloud) {
    case "aws":
      // useVars → the workflow references vars.AWS_ROLE_ARN / vars.AWS_REGION /
      // vars.ECR_REPOSITORY (set by the /cicd/setup endpoint) — nothing hardcoded.
      // Multi-service repos pass useVars:false + a per-service context/name/file.
      return generateEcrWorkflow({
        roleArn: r.roleArn,
        region: r.region,
        ecrRepositoryUri: r.ecrRepositoryUri,
        branch,
        scanGate,
        useVars: opts?.useVars !== false,
        context: opts?.context,
        workflowName: opts?.workflowName,
        fileName: opts?.fileName,
      });
    case "gcp":
      return generateGarWorkflow({
        workloadIdentityProvider: r.workloadIdentityProvider,
        serviceAccount: r.serviceAccount,
        location: r.location,
        projectId: r.projectId,
        repository: r.repository,
        image: r.image,
        branch,
        scanGate,
        context: opts?.context,
        workflowName: opts?.workflowName,
        fileName: opts?.fileName,
      });
    case "azure":
      return generateAcrWorkflow({
        mode: r.mode ?? "keyless",
        clientId: r.clientId,
        tenantId: r.tenantId,
        subscriptionId: r.subscriptionId,
        secretPrefix: r.secretPrefix,
        registry: r.registry,
        image: r.image,
        branch,
        scanGate,
        context: opts?.context,
        workflowName: opts?.workflowName,
        fileName: opts?.fileName,
      });
  }
}

/**
 * CD workflow that runs ONLY AFTER the CI workflow finishes successfully
 * (workflow_run), then applies the manifests. This enforces CI→CD ordering
 * (a plain push trigger would race CI and deploy before the image exists).
 * Cluster auth via a KUBECONFIG_B64 repo secret (the app sets it for you).
 */
function cdWorkflowAfterCi(opts: {
  appName: string;
  namespace: string;
  manifestDir: string;
  ciWorkflowName: string;
  /** Unique per service in a monorepo. Defaults: "Deploy to Kubernetes (CD)" / "deploy.yml". */
  workflowName?: string;
  fileName?: string;
  /**
   * Keyless EKS auth: assume the CI role over OIDC and `aws eks update-kubeconfig`
   * — no KUBECONFIG_B64 secret to set or expire. Omit for the generic
   * KUBECONFIG_B64-secret variant (non-EKS clusters).
   */
  eks?: { roleRef: string; regionRef: string; clusterName: string };
  /**
   * Keyless GKE auth: authenticate over WIF and `get-gke-credentials` — no
   * stored key. Mutually exclusive with eks.
   */
  gke?: {
    workloadIdentityProvider: string;
    serviceAccount: string;
    clusterName: string;
    location: string;
  };
  /**
   * Keyless AKS auth: azure/login (federated OIDC) + admin AKS credentials
   * (bypasses in-cluster RBAC, mirroring the ADMIN kubeconfig this app itself
   * uses for AKS) — no stored key. Mutually exclusive with eks/gke.
   */
  aks?: {
    clientId: string;
    tenantId: string;
    subscriptionId: string;
    clusterName: string;
    resourceGroup: string;
  };
}): GeneratedFile {
  const app = sanitizeAppName(opts.appName);
  const ns = opts.namespace || "default";
  const dir = opts.manifestDir;
  const workflowName = opts.workflowName || "Deploy to Kubernetes (CD)";
  const fileName = opts.fileName || "deploy.yml";
  const auth = opts.eks
    ? `      - name: Configure AWS credentials (OIDC — no stored secrets)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${opts.eks.roleRef}
          aws-region: ${opts.eks.regionRef}

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Configure cluster access (keyless)
        run: aws eks update-kubeconfig --name "${opts.eks.clusterName}" --region ${opts.eks.regionRef}`
    : opts.gke
      ? `      - name: Authenticate to Google Cloud (keyless — no stored key)
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${opts.gke.workloadIdentityProvider}
          service_account: ${opts.gke.serviceAccount}

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Get GKE credentials
        uses: google-github-actions/get-gke-credentials@v2
        with:
          cluster_name: ${opts.gke.clusterName}
          location: ${opts.gke.location}`
      : opts.aks
        ? `      - name: Azure login (OIDC — no stored secret)
        uses: azure/login@v2
        with:
          client-id: ${opts.aks.clientId}
          tenant-id: ${opts.aks.tenantId}
          subscription-id: ${opts.aks.subscriptionId}

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Get AKS credentials (admin — keyless, bypasses in-cluster RBAC)
        uses: azure/aks-set-context@v4
        with:
          resource-group: ${opts.aks.resourceGroup}
          cluster-name: ${opts.aks.clusterName}
          admin: "true"`
        : `      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Configure cluster access
        run: |
          mkdir -p "$HOME/.kube"
          printf '%s' "\${{ secrets.KUBECONFIG_B64 }}" | base64 -d > "$HOME/.kube/config"
          kubectl config current-context`;
  const content = `name: ${workflowName}

# Runs ONLY after the CI workflow ("${opts.ciWorkflowName}") completes
# successfully, so the image is already in the registry before we deploy.
on:
  workflow_run:
    workflows: ["${opts.ciWorkflowName}"]
    types: [completed]
  workflow_dispatch: {}

permissions:
  id-token: write   # required to request the OIDC token
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: \${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

${auth}
${
  ns !== "default"
    ? `
      - name: Ensure namespace ${ns} is Active (auto-heal if stuck Terminating)
        # Three-stage self-heal — a namespace stuck Terminating rejects every
        # kubectl apply with "unable to create new content in namespace X because
        # it is being terminated". Stuck namespaces are usually a hanging
        # LoadBalancer/PVC finalizer whose cloud resource couldn't be released
        # (LB deleted out-of-band, IAM revoked mid-clean, controller crash).
        #
        # Stage 1: wait 60s for a natural deletion to finish.
        # Stage 2: if still Terminating, force-clear finalizers on all Services +
        #          PVCs in the namespace (safe — the underlying LB is typically
        #          already gone by this point), wait another 30s.
        # Stage 3: if STILL Terminating, remove the namespace's own finalizer via
        #          the /finalize subresource (kubernetes' standard force-delete
        #          for stuck namespaces).
        # Finally: create the namespace if it's now gone (or was never there).
        #
        # Closes the 2026-08 incident where every deploy failed against a
        # Terminating namespace and required an operator to hand-clear finalizers.
        run: |
          set -eu
          NS="${ns}"
          ns_phase() { kubectl get namespace "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo ""; }
          # Stage 1 — natural wait
          for i in $(seq 1 30); do
            p=$(ns_phase)
            { [ -z "$p" ] || [ "$p" = "Active" ]; } && break
            echo "namespace $NS is $p — waiting for natural termination ($i/30)"
            sleep 2
          done
          # Stage 2 — force-clear finalizers on Services + PVCs
          p=$(ns_phase)
          if [ "$p" = "Terminating" ]; then
            echo "::warning::Namespace $NS still Terminating after 60s — auto-clearing finalizers on Services and PVCs."
            for kind in svc pvc; do
              for res in $(kubectl get "$kind" -n "$NS" -o name 2>/dev/null); do
                echo "  clearing finalizers on $res"
                kubectl patch "$res" -n "$NS" -p '{"metadata":{"finalizers":null}}' --type=merge >/dev/null 2>&1 || true
              done
            done
            for i in $(seq 1 15); do
              p=$(ns_phase)
              { [ -z "$p" ] || [ "$p" = "Active" ]; } && break
              sleep 2
            done
          fi
          # Stage 3 — nuke the namespace's own finalizer via /finalize
          p=$(ns_phase)
          if [ "$p" = "Terminating" ]; then
            echo "::warning::Namespace $NS still Terminating — force-clearing its own finalizer via /finalize subresource."
            if command -v jq >/dev/null 2>&1; then
              kubectl get namespace "$NS" -o json | jq '.spec.finalizers = []' | kubectl replace --raw "/api/v1/namespaces/$NS/finalize" -f - >/dev/null 2>&1 || true
            else
              printf '%s' '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"'"$NS"'"},"spec":{"finalizers":[]}}' | kubectl replace --raw "/api/v1/namespaces/$NS/finalize" -f - >/dev/null 2>&1 || true
            fi
            sleep 3
          fi
          # Recreate if now gone
          p=$(ns_phase)
          [ -z "$p" ] && kubectl create namespace "$NS"
          p=$(ns_phase)
          if [ "$p" != "Active" ]; then
            echo "::error::Namespace $NS auto-heal exhausted; still $p. Ask the agent to run unstick_terminating_namespace for deep diagnosis."
            exit 1
          fi
          echo "namespace $NS is Active — proceeding with apply."
`
    : ""
}
      - name: Apply manifests
        # Prefer manifest.yaml — deploy_my_app writes exactly that file, and
        # applying the whole dir picks up any stale *.yaml (e.g. a
        # hand-committed service.yaml from an older scaffold) that
        # alphabetically-sorts AFTER it and silently overrides the freshly
        # generated resource. Fall back to the dir for repos whose manifests
        # are still split across multiple files.
        run: |
          if [ -f "${dir}/manifest.yaml" ]; then
            kubectl apply -n ${ns} -f "${dir}/manifest.yaml"
          else
            kubectl apply -n ${ns} -f "${dir}/"
          fi

      - name: Restart rollout (image tag "latest" — force pods onto the new build)
        run: kubectl rollout restart deployment/${app} -n ${ns}

      - name: Wait for rollout
        run: kubectl rollout status deployment/${app} -n ${ns} --timeout=180s

      - name: Rollback on failed rollout
        if: failure()
        run: |
          echo "::warning::Rollout of ${app} failed its health check — rolling back to the previous revision."
          kubectl rollout undo deployment/${app} -n ${ns}
          kubectl rollout status deployment/${app} -n ${ns} --timeout=120s
`;
  return { path: `.github/workflows/${fileName}`, content };
}

export type CicdArtifacts = { files: GeneratedFile[]; imageRef: string; notes: string[] };

/** The CI + CD file set for one app (filtered by `include`), ready to push as one PR. */
export function buildCicdArtifacts(spec: CicdPipelineSpec): CicdArtifacts {
  const want = (k: keyof FileToggles) => spec.include?.[k] !== false; // undefined = include
  const dir = normalizeManifestDir(spec.manifestDir);
  // Service build context (monorepo). "" = repo root; else Docker files live in it.
  const ctx = (spec.context || "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
  const pfx = ctx ? `${ctx}/` : "";
  const files: GeneratedFile[] = [];
  const notes: string[] = [];

  // Docker artifacts, filtered per toggle. Paths are prefixed with the service
  // context so a monorepo's frontend/backend get their own Dockerfile.
  const docker = generateDockerArtifacts({ stack: spec.stack, params: spec.dockerParams });
  for (const f of docker.files) {
    const pf = { ...f, path: `${pfx}${f.path}` };
    if (f.path === "Dockerfile" || f.path === ".dockerignore") {
      if (want("dockerfile")) files.push(pf);
    } else if (f.path === "docker-compose.yml") {
      if (want("compose")) files.push(pf);
    } else if (f.path === "nginx.conf") {
      if (want("nginx")) files.push(pf);
    } else {
      files.push(pf);
    }
  }
  if (want("dockerfile")) notes.push(...docker.notes);

  // CI workflow (needs a registry) + the registry-derived image.
  let imageRef = "";
  if (spec.registry) {
    imageRef = registryImageLatest(spec.registry, spec.gitops === true);
    if (want("ciWorkflow")) {
      files.push(
        ciWorkflowFor(spec.branch, spec.scanGate !== false, spec.registry, {
          context: ctx,
          workflowName: spec.ciWorkflowName,
          fileName: spec.ciFileName,
          useVars: spec.registryUseVars,
          gitops: spec.gitops === true,
          autoDeployOnPush: spec.autoDeployOnPush === true,
          manifestDir: spec.manifestDir,
          imageBase: registryImageBase(spec.registry),
        }),
      );
      notes.push(
        `CI builds + scans + pushes to ${spec.registry.cloud.toUpperCase()} on "${spec.branch}"${ctx ? ` from ./${ctx}` : ""}.`,
      );
    }
  }

  // Manifest (needs an image — from the registry or an explicit override).
  const image = spec.deploy.image || imageRef;
  if (want("manifest") && image) {
    const deploySpec: DeploySpec = { ...spec.deploy, image };
    // Production style: ONE resource per file under the manifest dir. The
    // namespace itself is NOT a committed manifest — the CD workflow ensures
    // it exists (get-then-create, same as the server-side deploy path) rather
    // than the app repo owning a Namespace resource.
    const written: string[] = [];
    const dm = buildDeployManifest(deploySpec);
    const fileName: Record<string, string> = {
      Deployment: "deployment",
      Service: "service",
      Ingress: "ingress",
    };
    dm.yaml.split("---\n").forEach((doc, i) => {
      const kind = dm.resources[i] ?? `resource-${i}`;
      // Namespace is deliberately not a committed file here — see the comment above.
      if (kind === "Namespace") return;
      const name = `${fileName[kind] ?? kind.toLowerCase()}.yaml`;
      files.push({ path: `${dir}/${name}`, content: doc.replace(/^\n+/, "") });
      written.push(name);
    });
    notes.push(`Manifests (one per file) in ${dir}/: ${written.join(", ")}.`);
  }

  // CD workflow. With an AWS registry + eksCluster it's fully keyless (assumes
  // the same OIDC role as CI); otherwise it uses the KUBECONFIG_B64 secret.
  if (want("cdWorkflow")) {
    const ciName =
      spec.ciWorkflowName ||
      (spec.registry ? CI_WORKFLOW_NAME[spec.registry.cloud] : "Build and push to ECR");
    const eks =
      spec.registry?.cloud === "aws" && spec.eksCluster
        ? {
            roleRef:
              spec.registryUseVars !== false ? "${{ vars.AWS_ROLE_ARN }}" : spec.registry.roleArn,
            regionRef:
              spec.registryUseVars !== false ? "${{ vars.AWS_REGION }}" : spec.registry.region,
            clusterName: spec.eksCluster.clusterName,
          }
        : undefined;
    const gke =
      spec.registry?.cloud === "gcp" && spec.gkeCluster
        ? {
            workloadIdentityProvider: spec.registry.workloadIdentityProvider,
            serviceAccount: spec.registry.serviceAccount,
            clusterName: spec.gkeCluster.clusterName,
            location: spec.gkeCluster.location,
          }
        : undefined;
    const aks =
      spec.registry?.cloud === "azure" &&
      spec.registry.mode !== "secret" &&
      spec.registry.clientId &&
      spec.registry.tenantId &&
      spec.registry.subscriptionId &&
      spec.aksCluster
        ? {
            clientId: spec.registry.clientId,
            tenantId: spec.registry.tenantId,
            subscriptionId: spec.registry.subscriptionId,
            clusterName: spec.aksCluster.clusterName,
            resourceGroup: spec.aksCluster.resourceGroup,
          }
        : undefined;
    files.push(
      cdWorkflowAfterCi({
        appName: spec.deploy.appName,
        namespace: spec.deploy.namespace,
        manifestDir: dir,
        ciWorkflowName: ciName,
        workflowName: spec.cdWorkflowName,
        fileName: spec.cdFileName,
        eks,
        gke,
        aks,
      }),
    );
    notes.push(
      eks || gke || aks
        ? "CD deploys keyless (OIDC/WIF) after CI succeeds."
        : "CD needs the KUBECONFIG_B64 repo secret (the app sets it).",
    );
  }

  if (image) notes.push(`Deployed image: ${image}.`);
  return { files, imageRef, notes };
}
