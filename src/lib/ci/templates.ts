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
      { key: "buildDir", type: "string", description: "Build output dir. Vite/Vue=dist, CRA=build, Angular=dist/<name>, Next export=out.", default: "dist", options: ["dist", "build", "out"] },
      { key: "buildCommand", type: "string", description: "Build script.", default: "npm run build" },
      { key: "nodeVersion", type: "string", description: "Node major used for the build.", default: "20", options: ["20", "22", "18"] },
      { key: "packageManager", type: "string", description: "Package manager.", default: "npm", options: ["npm", "yarn", "pnpm"] },
    ],
  },
  {
    id: "node-service",
    title: "Long-running Node.js server (Express, Nest, Fastify, Next standalone)",
    detect: "package.json with a server that listens on a port (a `start` script, an http server). Not a static export.",
    fields: [
      { key: "port", type: "number", description: "Port the server listens on.", default: 3000 },
      { key: "startCommand", type: "string", description: "Production start command.", default: "node server.js" },
      { key: "buildCommand", type: "string", description: "Build step, or empty if none (e.g. `npm run build` for TS).", default: "" },
      { key: "nodeVersion", type: "string", description: "Node major.", default: "20", options: ["20", "22", "18"] },
    ],
  },
  {
    id: "python",
    title: "Python web app (Flask, FastAPI, Django)",
    detect: "requirements.txt or pyproject.toml present with a WSGI/ASGI app.",
    fields: [
      { key: "port", type: "number", description: "Port the app listens on.", default: 8000 },
      { key: "startCommand", type: "string", description: "Production start command (gunicorn/uvicorn).", default: "gunicorn -b 0.0.0.0:8000 app:app" },
      { key: "pythonVersion", type: "string", description: "Python version.", default: "3.12", options: ["3.12", "3.11", "3.10"] },
    ],
  },
  {
    id: "go",
    title: "Go service (compiled static binary, distroless runtime)",
    detect: "go.mod present.",
    fields: [
      { key: "port", type: "number", description: "Port the service listens on.", default: 8080 },
      { key: "mainPath", type: "string", description: "Package path to build.", default: "./..." },
      { key: "goVersion", type: "string", description: "Go version.", default: "1.23", options: ["1.23", "1.22"] },
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
    case "static-spa": dockerfile = staticSpaDockerfile(p); break;
    case "node-service": dockerfile = nodeServiceDockerfile(p); break;
    case "python": dockerfile = pythonDockerfile(p); break;
    case "go": dockerfile = goDockerfile(p); break;
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
export function generateEcrWorkflow(args: {
  roleArn: string;
  region: string;
  ecrRepositoryUri: string;
  branch: string;
}): GeneratedFile {
  const content = `name: Build and push to ECR

on:
  push:
    branches: ["${args.branch}"]
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
          role-to-assume: ${args.roleArn}
          aws-region: ${args.region}

      - name: Log in to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag and push image
        env:
          ECR_REPOSITORY: ${args.ecrRepositoryUri}
          IMAGE_TAG: \${{ github.sha }}
        run: |
          docker build -t "$ECR_REPOSITORY:$IMAGE_TAG" -t "$ECR_REPOSITORY:latest" .
          docker push "$ECR_REPOSITORY:$IMAGE_TAG"
          docker push "$ECR_REPOSITORY:latest"
`;
  return { path: ".github/workflows/build-and-push.yml", content };
}
