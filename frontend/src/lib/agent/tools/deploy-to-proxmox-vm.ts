import { getOrCreateProjectDeployKeypair } from "@/lib/devops/deploy-keypair";
import { setGithubSecretTool } from "./set-github-secret";
import { generateProxmoxDeployWorkflowTool } from "./generate-proxmox-deploy-workflow";
import { writeRepoFileTool } from "./write-repo-file";
import type { Tool } from "./types";

type Input = {
  /** GitHub repo (owner/name) attached to the project. */
  repoFullName: string;
  /** App name — used as container name, systemd unit, and image name. */
  appName: string;
  /** Container port to expose on the host. */
  port: number;
  /** VM host — IP or DNS name reachable from GitHub-hosted runners. */
  vmHost: string;
  /** Branch that triggers the deploy. Default "main". */
  branch?: string;
  /** Docker build context. Default ".". */
  dockerContext?: string;
  /** Dockerfile path. Default "Dockerfile". */
  dockerfile?: string;
  /** Extra `docker run` flags baked into the systemd unit. */
  extraDockerArgs?: string;
};

type Output = {
  repoFullName: string;
  appName: string;
  vmHost: string;
  pullRequest?: { number: number; url: string };
  committed: string[];
  secretsSet: string[];
  note: string;
};

/**
 * End-to-end wiring for "deploy this app to a Proxmox VM". Idempotent — safe
 * to re-run. Ties together:
 *   1. Project deploy keypair (lazily created on first Proxmox action).
 *   2. Repo secrets: VM_HOST + VM_SSH_KEY.
 *   3. Files pushed as a PR: GitHub Actions workflow, systemd unit, deploy.sh.
 *
 * After merge (or workflow_dispatch), the workflow builds the image, pushes
 * to GHCR, and SSHes into the VM to restart the systemd-managed container.
 * The VM must have been created with provision_proxmox_vm so the deploy user
 * + key are pre-installed via cloud-init.
 */
export const deployToProxmoxVmTool: Tool<Input, Output> = {
  name: "deploy_to_proxmox_vm",
  description:
    "Wire up end-to-end deployment of an app to a Proxmox VM. Sets the VM_HOST + VM_SSH_KEY " +
    "repo secrets, generates the GitHub Actions workflow + systemd unit + deploy script, and " +
    "opens a PR with all three files. The VM must be Docker-ready (provision_proxmox_vm bakes " +
    "in the deploy user + Docker via cloud-init). Uses GHCR for images (no cloud-registry setup). " +
    "Idempotent — safe to re-run when the app or VM changes.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'The repo as "owner/name", attached to the project.',
      },
      appName: { type: "string", description: "App name (lowercase-hyphen)." },
      port: { type: "number", description: "Container port to expose on the host." },
      vmHost: {
        type: "string",
        description: "VM IP or DNS name reachable from GitHub-hosted runners.",
      },
      branch: { type: "string", description: "Branch that triggers the workflow. Default 'main'." },
      dockerContext: { type: "string", description: "Docker build context. Default '.'." },
      dockerfile: { type: "string", description: "Path to the Dockerfile. Default 'Dockerfile'." },
      extraDockerArgs: { type: "string", description: "Extra `docker run` flags (env, volumes)." },
    },
    required: ["repoFullName", "appName", "port", "vmHost"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const vmHost = input.vmHost.trim();
    if (!vmHost) return { ok: false, error: "vmHost is required." };

    // 1. Ensure the project has a deploy keypair (lazy — creates on first call).
    const keys = await getOrCreateProjectDeployKeypair(ctx.projectId);

    // 2. Push the two repo secrets the workflow reads.
    const secretsSet: string[] = [];
    for (const [name, value] of [
      ["VM_HOST", vmHost],
      ["VM_SSH_KEY", keys.privateKey],
    ] as const) {
      const res = await setGithubSecretTool.execute(
        { repoFullName: input.repoFullName, name, value },
        ctx,
      );
      if (!res.ok) return { ok: false, error: `Setting secret ${name} failed: ${res.error}` };
      secretsSet.push(name);
    }

    // 3. Generate the workflow / systemd / deploy.sh trio.
    const gen = await generateProxmoxDeployWorkflowTool.execute(
      {
        appName: input.appName,
        port: input.port,
        branch: input.branch,
        dockerContext: input.dockerContext,
        dockerfile: input.dockerfile,
        extraDockerArgs: input.extraDockerArgs,
      },
      ctx,
    );
    if (!gen.ok) return { ok: false, error: `Generation failed: ${gen.error}` };

    // 4. Push files in a single PR — openPullRequest=true only on the first
    //    write so we end up with one PR that carries all three files.
    const branch = `deploy/proxmox-${input.appName}`;
    const committed: string[] = [];
    let pullRequest: { number: number; url: string } | undefined;
    let first = true;
    for (const [path, content] of Object.entries(gen.output.files)) {
      const res = await writeRepoFileTool.execute(
        {
          repoFullName: input.repoFullName,
          path,
          content,
          branch,
          message: `Wire up Proxmox deploy for ${input.appName}`,
          openPullRequest: first,
          pullRequestBody: [
            `Deploys \`${input.appName}\` to Proxmox VM \`${vmHost}\` on every push to \`${input.branch ?? "main"}\`.`,
            "",
            "Files:",
            ...Object.keys(gen.output.files).map((p) => `- \`${p}\``),
            "",
            "Repo secrets already set: `VM_HOST`, `VM_SSH_KEY`.",
          ].join("\n"),
        },
        ctx,
      );
      if (!res.ok) return { ok: false, error: `Push failed on ${path}: ${res.error}` };
      committed.push(path);
      if (first && res.output.pullRequest) pullRequest = res.output.pullRequest;
      first = false;
    }

    const bits: string[] = [
      `Wired Proxmox deploy for "${input.appName}" → ${vmHost}:${input.port}.`,
      `Committed ${committed.length} files.`,
    ];
    if (pullRequest) bits.push(`PR #${pullRequest.number}: ${pullRequest.url}`);
    bits.push(`Repo secrets set: ${secretsSet.join(", ")}.`);

    return {
      ok: true,
      output: {
        repoFullName: input.repoFullName,
        appName: input.appName,
        vmHost,
        pullRequest,
        committed,
        secretsSet,
        note: bits.join(" "),
      },
    };
  },
};
