# syntax=docker/dockerfile:1
#
# DeepAgent frontend — the Next.js app AND the agent runtime.
#
# WHY THIS ISN'T A STOCK NODE IMAGE (2026-08 incident):
# The agent's tools don't call cloud SDKs — they shell out to real binaries:
#   • kubectl   — 54 call sites (every Kubernetes operation, ALL clouds)
#   • aws       — 35 call sites (all AWS operations)
#   • terraform — 17 call sites (all infra provisioning, ALL clouds)
#   • helm      —  4 call sites (chart installs)
# On a laptop those resolve from Homebrew. In a stock `node:20-alpine` container
# none of them exist, so a deployed agent replies "the AWS CLI is not installed
# on the server" and every deploy/provision path dies. Azure and GCP resource
# calls go over REST and are fine — but Kubernetes and Terraform are not, which
# makes this image a hard requirement on every cloud, not just AWS.
#
# The rule this image enforces: a deployed pod behaves exactly like localhost.
#
# LONGER TERM: replacing the shell-outs with SDKs (@aws-sdk/client-*, an HTTP
# Kubernetes client) or routing them through remote MCP servers would let this
# shrink back to a plain node image. Until then the binaries ship with the app.

# ── Tool stage: fetch the static CLIs once, copy only the binaries forward ──
# Downloading here rather than in the runtime stage keeps curl, unzip and the
# archives out of the final image.
FROM alpine:3.20 AS tools
# TARGETARCH is supplied by BuildKit (amd64 | arm64). Pinning per-arch URLs
# means one Dockerfile builds correctly on Graviton nodes and on x86.
ARG TARGETARCH=amd64
ARG KUBECTL_VERSION=v1.31.0
ARG HELM_VERSION=v3.15.4
ARG TERRAFORM_VERSION=1.9.5

RUN apk add --no-cache curl unzip tar

# kubectl, helm and terraform are static Go binaries — they run against musl
# with no glibc shim, which is what makes an alpine base viable here.
RUN curl -fsSL -o /out-kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /out-kubectl

RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /tmp \
 && mv "/tmp/linux-${TARGETARCH}/helm" /out-helm \
 && chmod +x /out-helm

RUN curl -fsSL -o /tmp/tf.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip" \
 && unzip -q /tmp/tf.zip -d /tmp \
 && mv /tmp/terraform /out-terraform \
 && chmod +x /out-terraform

# ── Build stage: all deps so the build can run ─────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
# Prisma: generate the client BEFORE the build so TS type checks see the enums.
# Skipped when the app doesn't use Prisma.
RUN if [ -f prisma/schema.prisma ] || [ -f schema.prisma ]; then \
      npx --yes prisma generate; \
    fi
# Auto-build when the app defines a build script (Next.js needs it).
# Fails the image build if the script exists and errors — surfaces bugs early.
RUN if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then \
      npm run build; \
    else \
      echo "no build script — skipping"; \
    fi

# ── Runtime: non-root built-in `node` user ─────────────────────────────────
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# aws-cli v2 from the alpine community repo — a musl-native build, so no glibc
# compatibility shim is needed. This is the largest added layer (~120MB with
# its python runtime); that is the cost of the 35 `aws` shell-outs.
#
# NOTE (2026-08): AWS operations are migrating from this CLI to the AWS Labs
# MCP server (`aws-via-mcp.ts`). The CLI stays as the fallback path while
# migration is in progress — code prefers MCP when a connector is registered.
# Once every AWS call site is MCP-only in prod, drop `aws-cli` here and the
# image shrinks by ~120MB.
RUN apk add --no-cache aws-cli ca-certificates

# uv / uvx — spawns MCP servers written in Python (e.g. awslabs.aws-api-mcp-
# server) as stdio subprocesses. `python3` alone is not enough: uvx is the one
# that fetches, caches, and runs the package inside an isolated environment.
# python3 is already installed as a dep of aws-cli; only py3-pip and uv add.
#
# `--break-system-packages` is required on Alpine's PEP 668-managed python.
# This is a container, not a shared host, so overriding is the right call —
# there is no other Python workload here to be broken.
RUN apk add --no-cache py3-pip \
 && pip install --no-cache-dir --break-system-packages uv

# Static CLIs from the tools stage.
COPY --from=tools /out-kubectl    /usr/local/bin/kubectl
COPY --from=tools /out-helm       /usr/local/bin/helm
COPY --from=tools /out-terraform  /usr/local/bin/terraform

# Fail the BUILD if any tool is missing or won't execute. Without this, a bad
# download or an arch mismatch surfaces only at runtime, as "command not found"
# deep inside an agent tool — the exact failure this image exists to prevent.
RUN kubectl version --client=true --output=yaml > /dev/null \
 && helm version --short \
 && terraform version \
 && aws --version \
 && uvx --version

# Copy the built app WITH its node_modules from the builder (avoids a second
# install and guarantees framework binaries + build output are present).
COPY --from=builder /app ./

# HOME must be writable: `aws` reads ~/.aws, kubectl reads ~/.kube, terraform
# writes ~/.terraform.d. The stock `node` user's home is /home/node, so point
# HOME there and make sure it belongs to that user.
ENV HOME=/home/node
RUN mkdir -p /home/node/.aws /home/node/.kube /home/node/.terraform.d \
 && chown -R node:node /home/node

USER node
EXPOSE 3000
# /usr/local/bin carries the CLIs, node_modules/.bin carries `next`. This PATH
# is what lib/runner/creds.ts passes on to every spawned process.
CMD ["sh", "-c", "export PATH=/usr/local/bin:/app/node_modules/.bin:$PATH; exec next start"]
