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
  | { cloud: "azure"; clientId: string; tenantId: string; subscriptionId: string; registry: string; image: string };

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

/** The registry image:tag the CD deploys (CI pushes :latest + :<sha>). */
function registryImageLatest(r: CicdRegistry): string {
  switch (r.cloud) {
    case "aws":
      return `${r.ecrRepositoryUri}:latest`;
    case "gcp":
      return `${r.location}-docker.pkg.dev/${r.projectId}/${r.repository}/${r.image}:latest`;
    case "azure":
      return `${r.registry}.azurecr.io/${r.image}:latest`;
  }
}

function ciWorkflowFor(
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
        roleArn: r.roleArn, region: r.region, ecrRepositoryUri: r.ecrRepositoryUri, branch, scanGate,
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
        clientId: r.clientId,
        tenantId: r.tenantId,
        subscriptionId: r.subscriptionId,
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
  gke?: { workloadIdentityProvider: string; serviceAccount: string; clusterName: string; location: string };
  /**
   * Keyless AKS auth: azure/login (federated OIDC) + admin AKS credentials
   * (bypasses in-cluster RBAC, mirroring the ADMIN kubeconfig this app itself
   * uses for AKS) — no stored key. Mutually exclusive with eks/gke.
   */
  aks?: { clientId: string; tenantId: string; subscriptionId: string; clusterName: string; resourceGroup: string };
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
      - name: Ensure namespace exists
        run: kubectl get namespace ${ns} || kubectl create namespace ${ns}
`
    : ""
}
      - name: Apply manifests
        run: kubectl apply -n ${ns} -f ${dir}/

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
    imageRef = registryImageLatest(spec.registry);
    if (want("ciWorkflow")) {
      files.push(ciWorkflowFor(spec.branch, spec.scanGate !== false, spec.registry, {
        context: ctx,
        workflowName: spec.ciWorkflowName,
        fileName: spec.ciFileName,
        useVars: spec.registryUseVars,
      }));
      notes.push(`CI builds + scans + pushes to ${spec.registry.cloud.toUpperCase()} on "${spec.branch}"${ctx ? ` from ./${ctx}` : ""}.`);
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
    const fileName: Record<string, string> = { Deployment: "deployment", Service: "service", Ingress: "ingress" };
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
    const ciName = spec.ciWorkflowName || (spec.registry ? CI_WORKFLOW_NAME[spec.registry.cloud] : "Build and push to ECR");
    const eks =
      spec.registry?.cloud === "aws" && spec.eksCluster
        ? {
            roleRef: spec.registryUseVars !== false ? "${{ vars.AWS_ROLE_ARN }}" : spec.registry.roleArn,
            regionRef: spec.registryUseVars !== false ? "${{ vars.AWS_REGION }}" : spec.registry.region,
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
      spec.registry?.cloud === "azure" && spec.aksCluster
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
    notes.push(eks || gke || aks ? "CD deploys keyless (OIDC/WIF) after CI succeeds." : "CD needs the KUBECONFIG_B64 repo secret (the app sets it).");
  }

  if (image) notes.push(`Deployed image: ${image}.`);
  return { files, imageRef, notes };
}
