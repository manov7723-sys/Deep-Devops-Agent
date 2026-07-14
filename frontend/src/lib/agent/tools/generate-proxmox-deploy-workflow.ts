import type { Tool } from "./types";

type Input = {
  /** App name — used as the container name, systemd unit name, and image name. */
  appName: string;
  /** Container port to expose on the host. */
  port: number;
  /** Branch that triggers the deploy. Default "main". */
  branch?: string;
  /** Docker build context relative to repo root. Default ".". */
  dockerContext?: string;
  /** Dockerfile path relative to repo root. Default "Dockerfile". */
  dockerfile?: string;
  /** Optional extra `docker run` args, e.g. `-e KEY=value -v /data:/data`. */
  extraDockerArgs?: string;
};

type OutputFiles = {
  /** Map of repo-relative path -> file contents. */
  files: Record<string, string>;
  /** Secrets the workflow expects to be set on the repo (name -> purpose). */
  requiredSecrets: Record<string, string>;
};

const NAME_RE = /^[a-z][a-z0-9-]{1,38}$/;

/**
 * Deterministically emit the file set that builds a repo, pushes the image to
 * GHCR, and SSHes into a Proxmox VM to restart a systemd-managed container.
 *
 * Files produced (repo-relative):
 *   .github/workflows/deploy-proxmox.yml — GitHub Actions build + deploy
 *   deploy/systemd/<app>.service         — systemd unit template (docker run)
 *   deploy/scripts/deploy.sh             — runs on the VM: writes env, restarts
 *
 * Secrets the workflow expects on the repo (the orchestrator sets these):
 *   VM_HOST     — the Proxmox VM's IP or DNS name
 *   VM_SSH_KEY  — the project's deploy private key (OpenSSH PEM)
 */
export const generateProxmoxDeployWorkflowTool: Tool<Input, OutputFiles> = {
  name: "generate_proxmox_deploy_workflow",
  description:
    "Generate the GitHub Actions workflow + systemd unit + deploy script that build a Docker " +
    "image, push it to GHCR (using the built-in GITHUB_TOKEN — no cloud-registry setup needed), " +
    "then SSH into a Proxmox VM to restart the container. Returns the file map; the caller writes " +
    "them via write_repo_file. Requires two repo secrets: VM_HOST (IP/DNS) and VM_SSH_KEY " +
    "(deploy-key private PEM). Use deploy_to_proxmox_vm to orchestrate this end-to-end.",
  inputSchema: {
    type: "object",
    properties: {
      appName: {
        type: "string",
        description:
          "App name — used as container name + systemd unit + image name (lowercase-hyphen).",
      },
      port: {
        type: "number",
        description: "Container port to expose on the host (same on both sides for simplicity).",
      },
      branch: { type: "string", description: "Branch that triggers the workflow. Default 'main'." },
      dockerContext: { type: "string", description: "Docker build context. Default '.'." },
      dockerfile: { type: "string", description: "Path to the Dockerfile. Default 'Dockerfile'." },
      extraDockerArgs: {
        type: "string",
        description: "Extra flags for `docker run`, e.g. '-e FOO=bar -v /data:/data'.",
      },
    },
    required: ["appName", "port"],
    additionalProperties: false,
  },
  async execute(input) {
    const app = input.appName.trim().toLowerCase();
    if (!NAME_RE.test(app)) {
      return {
        ok: false,
        error:
          "Invalid appName. Use lowercase letters, digits, hyphens; start with a letter (2-39 chars).",
      };
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return { ok: false, error: "port must be a positive integer between 1 and 65535." };
    }
    const branch = input.branch?.trim() || "main";
    const context = input.dockerContext?.trim() || ".";
    const dockerfile = input.dockerfile?.trim() || "Dockerfile";
    const extraArgs = (input.extraDockerArgs ?? "").trim();

    const workflow = buildWorkflow({ app, port: input.port, branch, context, dockerfile });
    const systemdUnit = buildSystemdUnit({ app, port: input.port, extraArgs });
    const deployScript = buildDeployScript({ app });

    return {
      ok: true,
      output: {
        files: {
          ".github/workflows/deploy-proxmox.yml": workflow,
          [`deploy/systemd/${app}.service`]: systemdUnit,
          "deploy/scripts/deploy.sh": deployScript,
        },
        requiredSecrets: {
          VM_HOST: "The Proxmox VM's IP or DNS name reachable from GitHub-hosted runners.",
          VM_SSH_KEY:
            "The project's deploy-key private PEM. Set by deploy_to_proxmox_vm; do not paste manually.",
        },
      },
    };
  },
};

function buildWorkflow(args: {
  app: string;
  port: number;
  branch: string;
  context: string;
  dockerfile: string;
}): string {
  return `# Build the image on push to \`${args.branch}\`, tag it with the commit SHA,
# push to GHCR (using the built-in GITHUB_TOKEN), then SSH into the VM to
# restart the ${args.app} service. Requires repo secrets VM_HOST and VM_SSH_KEY.
name: Deploy ${args.app} to Proxmox VM

on:
  push:
    branches: [${args.branch}]
  workflow_dispatch:

concurrency:
  group: deploy-${args.app}
  cancel-in-progress: false

permissions:
  contents: read
  packages: write

jobs:
  build_and_deploy:
    runs-on: ubuntu-latest
    env:
      IMAGE: ghcr.io/\${{ github.repository }}/${args.app}
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Set image tag
        id: tag
        run: echo "sha=\${GITHUB_SHA::12}" >> "$GITHUB_OUTPUT"

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: ${args.context}
          file: ${args.dockerfile}
          push: true
          tags: |
            \${{ env.IMAGE }}:\${{ steps.tag.outputs.sha }}
            \${{ env.IMAGE }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Copy deploy artifacts to VM
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VM_HOST }}
          username: deploy
          key: \${{ secrets.VM_SSH_KEY }}
          source: "deploy/systemd/${args.app}.service,deploy/scripts/deploy.sh"
          target: "/tmp/${args.app}-deploy"
          strip_components: 0

      - name: Deploy on VM
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VM_HOST }}
          username: deploy
          key: \${{ secrets.VM_SSH_KEY }}
          envs: IMAGE
          script: |
            set -euo pipefail
            IMAGE_REF="\${IMAGE}:\${{ steps.tag.outputs.sha }}"
            export IMAGE_REF
            chmod +x /tmp/${args.app}-deploy/deploy/scripts/deploy.sh
            /tmp/${args.app}-deploy/deploy/scripts/deploy.sh
`;
}

function buildSystemdUnit(args: { app: string; port: number; extraArgs: string }): string {
  const extra = args.extraArgs ? ` ${args.extraArgs}` : "";
  return `# systemd unit for ${args.app} — runs the container in the foreground so
# systemd owns the process lifecycle (auto-restart, journal capture).
# Image tag is read from /etc/${args.app}/env, which deploy.sh rewrites on
# each rollout. --pull=always would also work but keeps the tag static;
# writing the tag explicitly gives us a clean rollback (edit the file, restart).
[Unit]
Description=${args.app} container
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=-/etc/${args.app}/env
ExecStartPre=-/usr/bin/docker rm -f ${args.app}
ExecStart=/usr/bin/docker run --rm --name ${args.app} --pull=always -p ${args.port}:${args.port}${extra} \${IMAGE_REF}
ExecStop=/usr/bin/docker stop ${args.app}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function buildDeployScript(args: { app: string }): string {
  return `#!/usr/bin/env bash
# Runs on the VM after the workflow copies artifacts to /tmp/${args.app}-deploy.
# Idempotent: installs the unit if missing, writes the new image tag to the
# env file, then restarts the service. IMAGE_REF is exported by the workflow.
set -euo pipefail

APP=${args.app}
ARTIFACT_DIR=/tmp/\${APP}-deploy
UNIT_PATH=/etc/systemd/system/\${APP}.service
ENV_DIR=/etc/\${APP}
ENV_FILE=\${ENV_DIR}/env

: "\${IMAGE_REF:?IMAGE_REF is required (should be exported by the workflow)}"

sudo mkdir -p "\${ENV_DIR}"
echo "IMAGE_REF=\${IMAGE_REF}" | sudo tee "\${ENV_FILE}" > /dev/null

# Install/update the unit file only if changed (avoids needless daemon-reload).
if ! sudo cmp -s "\${ARTIFACT_DIR}/deploy/systemd/\${APP}.service" "\${UNIT_PATH}"; then
  sudo install -m 0644 "\${ARTIFACT_DIR}/deploy/systemd/\${APP}.service" "\${UNIT_PATH}"
  sudo systemctl daemon-reload
  sudo systemctl enable "\${APP}.service" >/dev/null
fi

sudo systemctl restart "\${APP}.service"
sudo systemctl --no-pager --lines=20 status "\${APP}.service" || true
`;
}
