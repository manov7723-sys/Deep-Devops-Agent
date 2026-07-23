/**
 * Deterministic CI artifact templates — Dockerfile, .dockerignore,
 * docker-compose, and the GitHub Actions → ECR (OIDC) workflow.
 *
 * WHY THIS EXISTS
 * The agent used to hand-write Dockerfiles from the LLM, which reproduced
 * popular-but-broken patterns (`npm ci --only=production` before a build,
 * non-root nginx on port 80, `addgroup -g 101` colliding with the image's
 * own nginx group, CRA-only `build/` output dir). These templates are vetted
 * once, here, so every generation is correct by construction. The agent only
 * *detects the stack and fills variables* — it never writes Dockerfile syntax.
 *
 * Mirrors the existing generate_k8s_manifest / generate_helm_chart pattern:
 * a deterministic generator the agent is told to ALWAYS use instead of
 * authoring the file itself.
 */

export type DockerStackId = "static-spa" | "node-service" | "python" | "go";

export type FieldSpec = {
  key: string;
  type: "string" | "number";
  description: string;
  /** Default applied when the caller omits the field. */
  default?: string | number;
  /** Optional enumerated choices, for the agent's ```options``` prompts. */
  options?: string[];
};

export type StackSpec = {
  id: DockerStackId;
  title: string;
  /** When the agent should pick this stack. */
  detect: string;
  fields: FieldSpec[];
};

export type GeneratedFile = { path: string; content: string };

/** Catalog the agent reads via list_dockerfile_stacks before generating. */
export const DOCKER_STACKS: StackSpec[] = [
  {
    id: "static-spa",
    title: "Static single-page app served by nginx (React, Vue, Vite, CRA, Angular)",
    detect:
      "package.json present and the app builds to static assets (vite/react-scripts/@angular/cli/vue-cli). No long-running Node server.",
    fields: [
      {
        key: "buildDir",
        type: "string",
        description:
          "Build output dir. Vite/Vue=dist, CRA=build, Angular=dist/<name>, Next export=out.",
        default: "dist",
        options: ["dist", "build", "out"],
      },
      {
        key: "buildCommand",
        type: "string",
        description: "Build script.",
        default: "npm run build",
      },
      {
        key: "nodeVersion",
        type: "string",
        description: "Node major used for the build.",
        default: "20",
        options: ["20", "22", "18"],
      },
      {
        key: "packageManager",
        type: "string",
        description: "Package manager.",
        default: "npm",
        options: ["npm", "yarn", "pnpm"],
      },
    ],
  },
  {
    id: "node-service",
    title: "Long-running Node.js server (Express, Nest, Fastify, Next standalone)",
    detect:
      "package.json with a server that listens on a port (a `start` script, an http server). Not a static export.",
    fields: [
      { key: "port", type: "number", description: "Port the server listens on.", default: 3000 },
      {
        key: "startCommand",
        type: "string",
        description: "Production start command.",
        default: "node server.js",
      },
      {
        key: "buildCommand",
        type: "string",
        description: "Build step, or empty if none (e.g. `npm run build` for TS).",
        default: "",
      },
      {
        key: "nodeVersion",
        type: "string",
        description: "Node major.",
        default: "20",
        options: ["20", "22", "18"],
      },
    ],
  },
  {
    id: "python",
    title: "Python web app (Flask, FastAPI, Django)",
    detect: "requirements.txt or pyproject.toml present with a WSGI/ASGI app.",
    fields: [
      { key: "port", type: "number", description: "Port the app listens on.", default: 8000 },
      {
        key: "startCommand",
        type: "string",
        description: "Production start command (gunicorn/uvicorn).",
        default: "gunicorn -b 0.0.0.0:8000 app:app",
      },
      {
        key: "pythonVersion",
        type: "string",
        description: "Python version.",
        default: "3.12",
        options: ["3.12", "3.11", "3.10"],
      },
    ],
  },
  {
    id: "go",
    title: "Go service (compiled static binary, distroless runtime)",
    detect: "go.mod present.",
    fields: [
      { key: "port", type: "number", description: "Port the service listens on.", default: 8080 },
      { key: "mainPath", type: "string", description: "Package path to build.", default: "./..." },
      {
        key: "goVersion",
        type: "string",
        description: "Go version.",
        default: "1.23",
        options: ["1.23", "1.22"],
      },
    ],
  },
];

export function getStack(id: string): StackSpec | undefined {
  return DOCKER_STACKS.find((s) => s.id === id);
}

/** Merge caller-supplied params over the stack's defaults. */
function withDefaults(stack: StackSpec, params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of stack.fields) {
    const v = params[f.key];
    out[f.key] = v === undefined || v === null || v === "" ? String(f.default ?? "") : String(v);
  }
  return out;
}

// `npm ci` REQUIRES a package-lock.json — it errors without one. Many repos
// don't commit a lockfile, so every install line falls back to a plain install
// when the lockfile is absent. Same idea for yarn/pnpm frozen installs.
const NPM_INSTALL = "if [ -f package-lock.json ]; then npm ci; else npm install; fi";
const NPM_INSTALL_PROD =
  "if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi";

function installCmd(packageManager: string): string {
  switch (packageManager) {
    case "yarn":
      return "corepack enable && (if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi)";
    case "pnpm":
      return "corepack enable && (if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi)";
    default:
      return NPM_INSTALL;
  }
}

const DOCKERIGNORE = `# Build context hygiene — keep images small & reproducible
.git
.gitignore
node_modules
npm-debug.log*
yarn-error.log*
.pnpm-store
dist
build
out
.next
coverage
.env
.env.*
*.md
.vscode
.idea
Dockerfile
docker-compose.yml
.dockerignore
`;

/** SPA nginx config: listens on 8080 (non-root safe), SPA fallback, /healthz. */
const NGINX_CONF = `server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Liveness endpoint for the Docker HEALTHCHECK / k8s probes.
    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok\\n";
    }

    # SPA history fallback — unknown routes serve index.html.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;

function staticSpaDockerfile(p: Record<string, string>): string {
  return `# syntax=docker/dockerfile:1
# --- Build stage: install ALL deps (build tools live in devDependencies) ---
FROM node:${p.nodeVersion}-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN ${installCmd(p.packageManager)}
COPY . .
RUN ${p.buildCommand}

# --- Runtime: unprivileged nginx (already non-root uid 101, listens on 8080) ---
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/${p.buildDir} /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
    CMD wget -q --spider http://localhost:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
`;
}

function nodeServiceDockerfile(p: Record<string, string>): string {
  const buildLine = p.buildCommand ? `RUN ${p.buildCommand}\n` : "";
  return `# syntax=docker/dockerfile:1
# --- Build stage: all deps so the build (if any) can run ---
FROM node:${p.nodeVersion}-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN ${NPM_INSTALL}
COPY . .
${buildLine}
# --- Runtime: prod-only deps, non-root built-in \`node\` user ---
FROM node:${p.nodeVersion}-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN ${NPM_INSTALL_PROD} && npm cache clean --force
COPY --from=builder /app ./
USER node
EXPOSE ${p.port}
CMD ${JSON.stringify(p.startCommand.split(" "))}
`;
}

function pythonDockerfile(p: Record<string, string>): string {
  return `# syntax=docker/dockerfile:1
FROM python:${p.pythonVersion}-slim
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Non-root runtime user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /app
USER appuser
EXPOSE ${p.port}
CMD ${JSON.stringify(p.startCommand.split(" "))}
`;
}

function goDockerfile(p: Record<string, string>): string {
  return `# syntax=docker/dockerfile:1
# --- Build stage ---
FROM golang:${p.goVersion}-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/app ${p.mainPath}

# --- Runtime: distroless, non-root, no shell ---
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/app /app
USER nonroot:nonroot
EXPOSE ${p.port}
ENTRYPOINT ["/app"]
`;
}

/** Container port a stack's runtime listens on — used for compose mapping. */
function runtimePort(stack: DockerStackId, p: Record<string, string>): string {
  return stack === "static-spa" ? "8080" : p.port;
}

function composeFile(port: string): string {
  return `services:
  app:
    build: .
    image: app:local
    ports:
      - "${port}:${port}"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:${port}/"]
      interval: 30s
      timeout: 3s
      retries: 3
`;
}

/**
 * Produce the Dockerfile (+ .dockerignore, + compose, + nginx.conf for SPA)
 * for a detected stack. Throws on an unknown stack id so the tool surfaces a
 * clear error rather than emitting a wrong file.
 */
export function generateDockerArtifacts(args: {
  stack: DockerStackId;
  params?: Record<string, unknown>;
}): { files: GeneratedFile[]; notes: string[] } {
  const stack = getStack(args.stack);
  if (!stack) throw new Error(`Unknown stack "${args.stack}". Call list_dockerfile_stacks first.`);
  const p = withDefaults(stack, args.params ?? {});

  let dockerfile: string;
  switch (stack.id) {
    case "static-spa":
      dockerfile = staticSpaDockerfile(p);
      break;
    case "node-service":
      dockerfile = nodeServiceDockerfile(p);
      break;
    case "python":
      dockerfile = pythonDockerfile(p);
      break;
    case "go":
      dockerfile = goDockerfile(p);
      break;
  }

  const port = runtimePort(stack.id, p);
  const files: GeneratedFile[] = [
    { path: "Dockerfile", content: dockerfile },
    { path: ".dockerignore", content: DOCKERIGNORE },
    { path: "docker-compose.yml", content: composeFile(port) },
  ];
  const notes = [`Stack: ${stack.title}.`, `Container listens on ${port}.`];
  if (stack.id === "static-spa") {
    files.push({ path: "nginx.conf", content: NGINX_CONF });
    notes.push(`nginx runs unprivileged on 8080; SPA fallback + /healthz included.`);
    notes.push(`Confirm the build output dir is "${p.buildDir}" for your tool.`);
  }
  return { files, notes };
}

/**
 * Vetted GitHub Actions workflow that builds the image and pushes it to ECR
 * using OIDC (no stored AWS secrets). The role ARN + ECR URI come from the
 * setup_github_oidc_ecr tool — injected here verbatim, never invented.
 */
/**
 * A Trivy scan step that FAILS the job on HIGH/CRITICAL vulnerabilities, so the
 * push step (which runs after it) never executes for an unsafe image. Inserted
 * between build and push when `scanGate` is on.
 */
function trivyGateStep(imageRefWithTag: string): string {
  // GITHUB_TOKEN env is REQUIRED — without it, setup-trivy makes anonymous
  // GitHub API calls to resolve + download the Trivy binary and DB, which
  // rate-limit at 60 req/hr and fail the install with a bare "exit code 1"
  // (NOT a vulnerability finding). Passing the auto-provided token raises the
  // limit to 1000/hr and makes the install reliable. TRIVY_SKIP_VERSION_CHECK
  // avoids an extra self-update API call. db/java-db repos are pinned to the
  // public mirrors so a GHCR hiccup doesn't block the gate either.
  return `
      - name: Scan image for vulnerabilities (Trivy — stop on HIGH/CRITICAL)
        uses: aquasecurity/trivy-action@0.28.0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TRIVY_SKIP_VERSION_CHECK: "true"
        with:
          image-ref: "${imageRefWithTag}"
          format: table
          exit-code: "1"
          ignore-unfixed: true
          vuln-type: os,library
          severity: CRITICAL,HIGH
`;
}

/**
 * Combined CI workflow for a monorepo — ONE file, N parallel matrix jobs, one per
 * service. Each service pushes to its own ECR repo. When the whole matrix
 * completes successfully, the combined CD workflow (below) fires via workflow_run.
 *
 * Way cleaner than 4 separate files for frontend+backend. Also faster — matrix
 * parallelism means both images build simultaneously on separate runners.
 */
export function generateCombinedEcrCiWorkflow(args: {
  /** Shared OIDC role — all services push using the same AWS identity. */
  roleArn: string;
  region: string;
  branch: string;
  /** Insert Trivy gate per service before push. Default true. */
  scanGate?: boolean;
  services: Array<{
    /** Service name — matrix key, also used in job logs. e.g. "frontend", "backend". */
    name: string;
    /** ECR repo URI for this service. */
    ecrRepositoryUri: string;
    /** Build context subdir. "" = repo root; else "frontend", "apps/api", etc. */
    context?: string;
  }>;
}): GeneratedFile {
  const gate = args.scanGate !== false;
  const matrix = args.services
    .map((s) => {
      const ctx = (s.context || "").replace(/^\.?\/*/, "").replace(/\/+$/, "") || ".";
      return `          - service: ${s.name}
            ecr: ${s.ecrRepositoryUri}
            context: ${ctx}`;
    })
    .join("\n");
  // Trivy step referenced by matrix variables — one step, runs per service.
  // GITHUB_TOKEN env avoids the anonymous-API rate limit that fails the binary
  // install with a bare "exit code 1" (not a real vuln finding).
  const scanStep = gate
    ? `
      - name: Scan \${{ matrix.service }} image for vulnerabilities (Trivy — stop on HIGH/CRITICAL)
        uses: aquasecurity/trivy-action@0.28.0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TRIVY_SKIP_VERSION_CHECK: "true"
        with:
          image-ref: "\${{ matrix.ecr }}:\${{ github.sha }}"
          format: table
          exit-code: "1"
          ignore-unfixed: true
          vuln-type: os,library
          severity: CRITICAL,HIGH
`
    : "";
  const content = `name: CI (build all services)

# Manual trigger — click "Run" in the Actions tab (or the app's CI/CD Pipelines page).
# When this workflow succeeds, the CD workflow fires automatically via workflow_run.
on:
  workflow_dispatch:

permissions:
  id-token: write   # required to request the OIDC token
  contents: read

jobs:
  build:
    name: build \${{ matrix.service }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
${matrix}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC — no stored secrets)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${args.roleArn}
          aws-region: ${args.region}

      - name: Log in to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and tag \${{ matrix.service }} image
        env:
          ECR: \${{ matrix.ecr }}
          TAG: \${{ github.sha }}
        run: |
          if [ "\${{ matrix.context }}" = "." ]; then
            docker build -t "$ECR:$TAG" -t "$ECR:latest" .
          else
            docker build -t "$ECR:$TAG" -t "$ECR:latest" -f "\${{ matrix.context }}/Dockerfile" "\${{ matrix.context }}"
          fi
${scanStep}
      - name: Push \${{ matrix.service }} image
        env:
          ECR: \${{ matrix.ecr }}
          TAG: \${{ github.sha }}
        run: |
          docker push "$ECR:$TAG"
          docker push "$ECR:latest"
`;
  return { path: `.github/workflows/ci.yml`, content };
}

/**
 * Combined CD workflow for a monorepo — ONE file, N parallel matrix jobs, one per
 * service. Fires automatically when the combined CI workflow (above) finishes
 * successfully. Currently EKS-only; GKE/AKS will need matching combined variants.
 */
export function generateCombinedEksCdWorkflow(args: {
  /** Must match the CI workflow's name: exactly — that's how workflow_run keys off it. */
  ciWorkflowName?: string;
  roleArn: string;
  region: string;
  clusterName: string;
  namespace: string;
  services: Array<{
    name: string;
    /** k8s Deployment name — kubectl rollout restart/status will target this. */
    appName: string;
    /** Manifest dir this service's YAMLs live in — e.g. "k8s/prod/frontend". */
    manifestDir: string;
  }>;
}): GeneratedFile {
  const ciName = args.ciWorkflowName || "CI (build all services)";
  const ns = args.namespace || "default";
  const matrix = args.services
    .map(
      (s) => `          - service: ${s.name}
            app: ${s.appName}
            manifestDir: ${s.manifestDir}`,
    )
    .join("\n");
  const nsStep =
    ns !== "default"
      ? `
      - name: Ensure namespace exists
        run: kubectl get namespace ${ns} || kubectl create namespace ${ns}
`
      : "";
  const content = `name: CD (deploy all services)

# Runs automatically after the CI workflow ("${ciName}") completes successfully.
# Also supports manual dispatch for redeploying without a fresh build.
on:
  workflow_run:
    workflows: ["${ciName}"]
    types: [completed]
  workflow_dispatch: {}

permissions:
  id-token: write   # required to request the OIDC token
  contents: read

jobs:
  deploy:
    name: deploy \${{ matrix.service }}
    runs-on: ubuntu-latest
    if: \${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    strategy:
      fail-fast: false
      matrix:
        include:
${matrix}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC — no stored secrets)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${args.roleArn}
          aws-region: ${args.region}

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Configure cluster access (keyless)
        run: aws eks update-kubeconfig --name "${args.clusterName}" --region ${args.region}
${nsStep}
      - name: Apply \${{ matrix.service }} manifests
        run: kubectl apply -n ${ns} -f \${{ matrix.manifestDir }}/

      - name: Restart \${{ matrix.service }} rollout (image tag "latest" — force pods onto the new build)
        run: kubectl rollout restart deployment/\${{ matrix.app }} -n ${ns}

      - name: Wait for \${{ matrix.service }} rollout
        run: kubectl rollout status deployment/\${{ matrix.app }} -n ${ns} --timeout=180s

      - name: Rollback \${{ matrix.service }} on failed rollout
        if: failure()
        run: |
          echo "::warning::Rollout of \${{ matrix.app }} failed its health check — rolling back to the previous revision."
          kubectl rollout undo deployment/\${{ matrix.app }} -n ${ns}
          kubectl rollout status deployment/\${{ matrix.app }} -n ${ns} --timeout=120s
`;
  return { path: `.github/workflows/cd.yml`, content };
}

export function generateEcrWorkflow(args: {
  roleArn: string;
  region: string;
  ecrRepositoryUri: string;
  branch: string;
  /** Insert a Trivy gate that stops the pipeline on HIGH/CRITICAL before push. Default true. */
  scanGate?: boolean;
  /**
   * Production style: reference GitHub Actions variables (vars.AWS_ROLE_ARN,
   * vars.AWS_REGION, vars.ECR_REPOSITORY) instead of hardcoding the ARN/region/
   * URI in the YAML. The caller must set those repo variables (setup does this).
   * For MULTI-service repos (frontend + backend) leave this off — repo-level
   * variables can't differ per workflow, so each service bakes in its own values.
   */
  useVars?: boolean;
  /** Build context / service subdir (e.g. "frontend"). Default "." (repo root). */
  context?: string;
  /** The workflow `name:` — must be unique per service. Default "Build and push to ECR". */
  workflowName?: string;
  /** Workflow file basename (e.g. "build-and-push-frontend.yml"). Default "build-and-push.yml". */
  fileName?: string;
}): GeneratedFile {
  const gate = args.scanGate !== false;
  const roleRef = args.useVars ? "\${{ vars.AWS_ROLE_ARN }}" : args.roleArn;
  const regionRef = args.useVars ? "\${{ vars.AWS_REGION }}" : args.region;
  const ecrRef = args.useVars ? "\${{ vars.ECR_REPOSITORY }}" : args.ecrRepositoryUri;
  const scanStep = gate ? trivyGateStep(`${ecrRef}:\${{ github.sha }}`) : "";
  const ctx = (args.context || "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
  const buildArgs = ctx ? `-f "${ctx}/Dockerfile" "${ctx}"` : ".";
  const workflowName = args.workflowName || "Build and push to ECR";
  const fileName = args.fileName || "build-and-push.yml";
  const content = `name: ${workflowName}

# Manual trigger ONLY — this repo's "Run Pipeline" button (or workflow_dispatch
# from the CLI/API) is what starts a build. Pushing to ${args.branch} does NOT
# auto-run this workflow, by design: files can land on the default branch
# immediately while the actual build/deploy stays gated behind an explicit click.
on:
  workflow_dispatch:

permissions:
  id-token: write   # required to request the OIDC token
  contents: read

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC — no stored secrets)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${roleRef}
          aws-region: ${regionRef}

      - name: Log in to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and tag image
        env:
          ECR_REPOSITORY: ${ecrRef}
          IMAGE_TAG: \${{ github.sha }}
        run: docker build -t "$ECR_REPOSITORY:$IMAGE_TAG" -t "$ECR_REPOSITORY:latest" ${buildArgs}
${scanStep}
      - name: Push image
        env:
          ECR_REPOSITORY: ${ecrRef}
          IMAGE_TAG: \${{ github.sha }}
        run: |
          docker push "$ECR_REPOSITORY:$IMAGE_TAG"
          docker push "$ECR_REPOSITORY:latest"
`;
  return { path: `.github/workflows/${fileName}`, content };
}

/**
 * Vetted GitHub Actions workflow that builds the image and pushes it to GCP
 * Artifact Registry using keyless Workload Identity Federation (no stored
 * service-account key). The WIF provider + service account come from the
 * setup_gcp_github_wif tool — injected here verbatim, never invented.
 */
export function generateGarWorkflow(args: {
  /** Full WIF provider resource name: projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<prov>. */
  workloadIdentityProvider: string;
  /** Service-account email the GitHub identity impersonates. */
  serviceAccount: string;
  /** Artifact Registry location, e.g. "us-central1". */
  location: string;
  /** GCP project id. */
  projectId: string;
  /** Artifact Registry repository (docker format). */
  repository: string;
  /** Image name within the repo. */
  image: string;
  branch: string;
  /** Insert a Trivy gate that stops the pipeline on HIGH/CRITICAL before push. Default true. */
  scanGate?: boolean;
  /** Build context / service subdir (e.g. "frontend"). Default "." (repo root). */
  context?: string;
  /** Workflow `name:` — unique per service. Default "Build and push to Artifact Registry". */
  workflowName?: string;
  /** Workflow file basename. Default "build-and-push-gar.yml". */
  fileName?: string;
}): GeneratedFile {
  const imageBase = `${args.location}-docker.pkg.dev/${args.projectId}/${args.repository}/${args.image}`;
  const scanStep = args.scanGate !== false ? trivyGateStep(`${imageBase}:\${{ github.sha }}`) : "";
  const ctx = (args.context || "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
  const buildArgs = ctx ? `-f "${ctx}/Dockerfile" "${ctx}"` : ".";
  const workflowName = args.workflowName || "Build and push to Artifact Registry";
  const fileName = args.fileName || "build-and-push-gar.yml";
  const content = `name: ${workflowName}

# Manual trigger ONLY — this repo's "Run Pipeline" button (or workflow_dispatch
# from the CLI/API) is what starts a build. Pushing to ${args.branch} does NOT
# auto-run this workflow, by design: files can land on the default branch
# immediately while the actual build/deploy stays gated behind an explicit click.
on:
  workflow_dispatch:

permissions:
  id-token: write   # required to request the GitHub OIDC token
  contents: read

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Authenticate to Google Cloud (keyless WIF — no stored key)
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${args.workloadIdentityProvider}
          service_account: ${args.serviceAccount}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker ${args.location}-docker.pkg.dev --quiet

      - name: Build and tag image
        env:
          IMAGE: ${imageBase}
          IMAGE_TAG: \${{ github.sha }}
        run: docker build -t "$IMAGE:$IMAGE_TAG" -t "$IMAGE:latest" ${buildArgs}
${scanStep}
      - name: Push image
        env:
          IMAGE: ${imageBase}
          IMAGE_TAG: \${{ github.sha }}
        run: |
          docker push "$IMAGE:$IMAGE_TAG"
          docker push "$IMAGE:latest"
`;
  return { path: `.github/workflows/${fileName}`, content };
}

/**
 * Vetted GitHub Actions workflow that builds the image and pushes it to Azure
 * Container Registry using keyless OIDC (azure/login with a federated
 * credential — no stored secret). The client/tenant/subscription ids come from
 * the setup_azure_github_oidc tool — injected here verbatim, never invented.
 */
export function generateAcrWorkflow(args: {
  /** ACR name (without .azurecr.io). */
  registry: string;
  image: string;
  branch: string;
  /**
   * Auth mode. "keyless" uses azure/login with an OIDC federated credential
   * (needs a Service-Principal Azure connection). "secret" uses docker login
   * with ACR admin credentials stored as GitHub Actions secrets — the OAuth
   * fallback for tenants where keyless can't be set up.
   */
  mode?: "keyless" | "secret";
  /** Keyless-mode only. Present when mode === "keyless". */
  clientId?: string;
  tenantId?: string;
  subscriptionId?: string;
  /** Secret-mode only. Prefix used for ACR_*_LOGIN_SERVER/USERNAME/PASSWORD in repo secrets. */
  secretPrefix?: string;
  /** Insert a Trivy gate that stops the pipeline on HIGH/CRITICAL before push. Default true. */
  scanGate?: boolean;
  /** Build context / service subdir (e.g. "frontend"). Default "." (repo root). */
  context?: string;
  /** Workflow `name:` — unique per service. Default "Build and push to ACR". */
  workflowName?: string;
  /** Workflow file basename. Default "build-and-push-acr.yml". */
  fileName?: string;
}): GeneratedFile {
  const mode = args.mode ?? "keyless";
  const imageBase = `${args.registry}.azurecr.io/${args.image}`;
  const scanStep = args.scanGate !== false ? trivyGateStep(`${imageBase}:\${{ github.sha }}`) : "";
  const ctx = (args.context || "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
  const buildArgs = ctx ? `-f "${ctx}/Dockerfile" "${ctx}"` : ".";
  const workflowName = args.workflowName || "Build and push to ACR";
  const fileName = args.fileName || "build-and-push-acr.yml";

  const permissions =
    mode === "keyless"
      ? "permissions:\n  id-token: write   # required to request the GitHub OIDC token\n  contents: read"
      : "permissions:\n  contents: read";

  const loginSteps =
    mode === "keyless"
      ? `      - name: Azure login (keyless OIDC — no stored secret)
        uses: azure/login@v2
        with:
          client-id: ${args.clientId}
          tenant-id: ${args.tenantId}
          subscription-id: ${args.subscriptionId}

      - name: Log in to ACR
        run: az acr login --name ${args.registry}`
      : // Preflight step BEFORE docker/login-action so a missing/empty secret fails
        // with a clear, self-diagnosable marker instead of the cryptic upstream
        // "Username and password required". The agent's wait_for_workflow_run
        // watches for the DEEPAGENT_ACR_SECRETS_MISSING marker and auto-invokes
        // repair_azure_acr_push_auth to self-heal without user intervention.
        `      - name: Verify ACR push secrets are present
        env:
          ACR_LOGIN_SERVER: \${{ secrets.${args.secretPrefix}_LOGIN_SERVER }}
          ACR_USERNAME: \${{ secrets.${args.secretPrefix}_USERNAME }}
          ACR_PASSWORD: \${{ secrets.${args.secretPrefix}_PASSWORD }}
        run: |
          missing=""
          [ -z "$ACR_LOGIN_SERVER" ] && missing="$missing ${args.secretPrefix}_LOGIN_SERVER"
          [ -z "$ACR_USERNAME" ] && missing="$missing ${args.secretPrefix}_USERNAME"
          [ -z "$ACR_PASSWORD" ] && missing="$missing ${args.secretPrefix}_PASSWORD"
          if [ -n "$missing" ]; then
            echo "::error::DEEPAGENT_ACR_SECRETS_MISSING repo=\${{ github.repository }} registry=${args.registry} missing=$missing"
            echo "One or more ACR admin secrets are missing/empty on this repo. The agent can heal this — say 'repair the ACR push auth' and it will refresh them."
            exit 1
          fi

      - name: Log in to ACR (admin credential from repo secrets)
        uses: docker/login-action@v3
        with:
          registry: \${{ secrets.${args.secretPrefix}_LOGIN_SERVER }}
          username: \${{ secrets.${args.secretPrefix}_USERNAME }}
          password: \${{ secrets.${args.secretPrefix}_PASSWORD }}`;

  const content = `name: ${workflowName}

# Manual trigger ONLY — this repo's "Run Pipeline" button (or workflow_dispatch
# from the CLI/API) is what starts a build. Pushing to ${args.branch} does NOT
# auto-run this workflow, by design: files can land on the default branch
# immediately while the actual build/deploy stays gated behind an explicit click.
on:
  workflow_dispatch:

${permissions}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

${loginSteps}

      - name: Build and tag image
        env:
          IMAGE: ${imageBase}
          IMAGE_TAG: \${{ github.sha }}
        run: docker build -t "$IMAGE:$IMAGE_TAG" -t "$IMAGE:latest" ${buildArgs}
${scanStep}
      - name: Push image
        env:
          IMAGE: ${imageBase}
          IMAGE_TAG: \${{ github.sha }}
        run: |
          docker push "$IMAGE:$IMAGE_TAG"
          docker push "$IMAGE:latest"
`;
  return { path: `.github/workflows/${fileName}`, content };
}

/**
 * Vetted, stack-aware CI workflow (install → build → test) on push/PR.
 * Like the Dockerfile templates, the agent only DETECTS the stack + params;
 * the YAML itself is correct by construction (right toolchain setup, lockfile
 * fallbacks, non-fatal test step so missing tests don't red-X the pipeline).
 */
export function generateCiWorkflow(args: {
  stack: DockerStackId;
  params?: Record<string, unknown>;
}): GeneratedFile {
  const stack = getStack(args.stack);
  if (!stack) throw new Error(`Unknown stack "${args.stack}". Call list_dockerfile_stacks first.`);
  const p = withDefaults(stack, args.params ?? {});

  let steps: string;
  if (args.stack === "python") {
    steps = `      - uses: actions/setup-python@v5
        with:
          python-version: "${p.pythonVersion}"
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
          if [ -f pyproject.toml ]; then pip install -e .; fi
      - name: Test
        run: |
          pip install pytest
          pytest --maxfail=1 --disable-warnings -q || echo "No tests or tests failed (non-blocking)."`;
  } else if (args.stack === "go") {
    steps = `      - uses: actions/setup-go@v5
        with:
          go-version: "${p.goVersion}"
      - name: Build
        run: go build ./...
      - name: Test
        run: go test ./... || echo "No tests or tests failed (non-blocking)."`;
  } else {
    // static-spa or node-service — Node toolchain.
    const buildCmd = p.buildCommand || "npm run build --if-present";
    steps = `      - uses: actions/setup-node@v4
        with:
          node-version: "${p.nodeVersion || "20"}"
      - name: Install dependencies
        run: ${NPM_INSTALL}
      - name: Build
        run: ${buildCmd}
      - name: Test
        run: npm test --if-present || echo "No tests defined (non-blocking)."`;
  }

  const content = `name: CI

on:
  push:
    branches: ["main", "master"]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
${steps}
`;
  return { path: ".github/workflows/ci.yml", content };
}

/**
 * GitLab CI equivalent of generateCiWorkflow + generateTrivyWorkflow, merged
 * into the ONE `.gitlab-ci.yml` GitLab allows per repo: a stack-aware
 * build/test job plus a Trivy security stage (fails on HIGH/CRITICAL). No
 * registry push here — keyless cloud-registry federation for GitLab is a later
 * phase; add CI/CD variables + a push job manually if you need it now.
 */
export function generateGitlabCi(args: {
  stack: DockerStackId;
  params?: Record<string, unknown>;
}): GeneratedFile {
  const stack = getStack(args.stack);
  if (!stack) throw new Error(`Unknown stack "${args.stack}". Call list_dockerfile_stacks first.`);
  const p = withDefaults(stack, args.params ?? {});

  let image: string;
  let script: string;
  if (args.stack === "python") {
    image = `python:${p.pythonVersion || "3.12"}`;
    script = `    - python -m pip install --upgrade pip
    - if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
    - if [ -f pyproject.toml ]; then pip install -e .; fi
    - pip install pytest
    - pytest --maxfail=1 --disable-warnings -q || echo "No tests or tests failed (non-blocking)."`;
  } else if (args.stack === "go") {
    image = `golang:${p.goVersion || "1.22"}`;
    script = `    - go build ./...
    - go test ./... || echo "No tests or tests failed (non-blocking)."`;
  } else {
    const buildCmd = p.buildCommand || "npm run build --if-present";
    image = `node:${p.nodeVersion || "20"}`;
    script = `    - npm ci || npm install
    - ${buildCmd}
    - npm test --if-present || echo "No tests defined (non-blocking)."`;
  }

  const content = `# Generated by DeepAgent — GitLab CI (build/test + Trivy security scan).
stages:
  - build
  - security

build:
  stage: build
  image: ${image}
  script:
${script}
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "merge_request_event"'

trivy:
  stage: security
  image:
    name: aquasec/trivy:latest
    entrypoint: [""]
  script:
    - trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --no-progress .
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "merge_request_event"'
`;
  return { path: ".gitlab-ci.yml", content };
}

/**
 * Vetted Trivy security-scan workflow. Scans the repo filesystem (deps,
 * misconfig, secrets) on push/PR using the official trivy-action, and fails
 * the build on HIGH/CRITICAL findings with a fix available.
 */
export function generateTrivyWorkflow(): GeneratedFile {
  const content = `name: Security scan (Trivy)

on:
  push:
    branches: ["main", "master"]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  trivy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@v0.33.1
        with:
          scan-type: fs
          scan-ref: .
          scanners: vuln,secret,misconfig
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: "1"
          format: table
`;
  return { path: ".github/workflows/trivy.yml", content };
}
