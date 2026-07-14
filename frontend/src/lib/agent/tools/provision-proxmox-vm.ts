import { prisma } from "@/lib/db/prisma";
import { buildProxmoxVmTerraform, type ProxmoxVmSpec } from "@/lib/devops/proxmox-vm";
import { getProjectDeployPublicKey } from "@/lib/devops/deploy-keypair";
import { startTerraformRun } from "@/lib/devops/terraform-run";
import { writeRepoFileTool } from "./write-repo-file";
import type { Tool } from "./types";

type Input = {
  envKey: string;
  name: string;
  node?: string;
  cores?: number;
  memoryMB?: number;
  diskGB?: number;
  datastore?: string;
  bridge?: string;
  templateVmId?: number;
  isoFile?: string;
  ipv4?: string;
  gateway?: string;
  /** Skip the deploy-user + docker cloud-init bake-in. Default false — the VM boots deploy-ready. */
  skipDeployPrep?: boolean;
  /** Don't install Docker via cloud-init (still adds the deploy user + SSH key). Default false. */
  skipInstallDocker?: boolean;
  /** Datastore with snippets content enabled for cloud-init. Default "local". */
  snippetsDatastore?: string;
  mode: "push" | "apply" | "push_and_apply";
  repoFullName?: string;
  path?: string;
};

type Output = {
  vm: string;
  fileCount: number;
  mode: string;
  runId?: string;
  pullRequest?: { number: number; url: string };
  committed?: string[];
  note: string;
};

/**
 * Deterministically create a VM on a connected Proxmox VE server. The agent
 * supplies the spec; this tool builds the full Terraform (bpg/proxmox) via the
 * shared generator, then PUSHES it to a repo and/or APPLIES it — matching the
 * same three execution modes as provision_eks. The Proxmox API credentials are
 * injected into the terraform run from the connected provider, so no secrets
 * appear in the HCL.
 */
export const provisionProxmoxVmTool: Tool<Input, Output> = {
  name: "provision_proxmox_vm",
  description:
    "Create a VM on a connected Proxmox VE server from a spec, using Terraform (bpg/proxmox). " +
    "Generates provider.tf + vm.tf and then, per `mode`: pushes to a repo as a PR/MR ('push'), runs " +
    "terraform apply ('apply'), or both ('push_and_apply'). Ask the requirement questions (name, node, " +
    "cores, memory, disk, datastore, network bridge, and a clone template VM id OR an ISO) and the mode first. " +
    "The env's connected cloud provider must be Proxmox.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose connected Proxmox provider to use." },
      name: { type: "string", description: "VM name (lowercase letters, digits, hyphens; start with a letter)." },
      node: { type: "string", description: "Proxmox node to create the VM on. Defaults to the provider's default node." },
      cores: { type: "number", description: "vCPU cores. Default 2." },
      memoryMB: { type: "number", description: "RAM in MB. Default 2048." },
      diskGB: { type: "number", description: "Disk size in GB. Default 20." },
      datastore: { type: "string", description: "Storage pool for the disk, e.g. 'local-lvm'. Default 'local-lvm'." },
      bridge: { type: "string", description: "Network bridge, e.g. 'vmbr0'. Default 'vmbr0'." },
      templateVmId: { type: "number", description: "Template VM id to clone from (preferred). Provide this OR isoFile." },
      isoFile: { type: "string", description: "Boot ISO (e.g. 'local:iso/ubuntu-24.04.iso') when not cloning." },
      ipv4: { type: "string", description: "cloud-init IPv4: 'dhcp' or a CIDR like '10.0.0.50/24'." },
      gateway: { type: "string", description: "cloud-init gateway (with a static ipv4)." },
      skipDeployPrep: { type: "boolean", description: "Skip auto-baking the deploy user + SSH key. Default false." },
      skipInstallDocker: { type: "boolean", description: "Skip installing Docker via cloud-init (still adds the deploy user). Default false." },
      snippetsDatastore: { type: "string", description: "Proxmox datastore with snippets content enabled. Default 'local'." },
      mode: { type: "string", enum: ["push", "apply", "push_and_apply"], description: "Execution mode the user chose." },
      repoFullName: { type: "string", description: "owner/repo to push to (required for push modes)." },
      path: { type: "string", description: "Repo folder for the files. Default terraform/proxmox/<name>." },
    },
    required: ["envKey", "name", "mode"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!/^[a-z][a-z0-9-]{1,38}$/.test(input.name)) {
      return { ok: false, error: "Invalid VM name. Use lowercase letters, digits, hyphens; start with a letter." };
    }
    const wantsPush = input.mode === "push" || input.mode === "push_and_apply";
    const wantsApply = input.mode === "apply" || input.mode === "push_and_apply";
    if (wantsPush && !input.repoFullName) {
      return { ok: false, error: "repoFullName is required for push modes." };
    }
    if (!input.templateVmId && !input.isoFile) {
      return { ok: false, error: "Provide either templateVmId (to clone from a template) or isoFile (to boot from an ISO)." };
    }

    const env = await prisma.env.findUnique({
      where: { projectId_key: { projectId: ctx.projectId, key: input.envKey } },
      select: {
        id: true,
        key: true,
        cloudProviderId: true,
        cloudProvider: { select: { kind: true, region: true } },
      },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    if (wantsApply) {
      if (!env.cloudProviderId) {
        return { ok: false, error: `Env "${input.envKey}" has no cloud provider — connect Proxmox and attach it to this env before applying.` };
      }
      if (env.cloudProvider?.kind !== "proxmox") {
        return { ok: false, error: `Env "${input.envKey}" is connected to ${env.cloudProvider?.kind ?? "another"} cloud, not Proxmox.` };
      }
    }

    // Bake the project's SSH deploy key into cloud-init unless the caller
    // opted out. The keypair is generated lazily on first read, so the very
    // first Proxmox VM in a project mints the pair; every subsequent VM
    // reuses it. This is what makes run_vm_command + the Proxmox deploy
    // workflow able to SSH in without any manual key setup.
    const sshPublicKey = input.skipDeployPrep
      ? undefined
      : await getProjectDeployPublicKey(ctx.projectId);

    const spec: ProxmoxVmSpec = {
      name: input.name,
      node: (input.node ?? env.cloudProvider?.region ?? "pve").trim(),
      cores: input.cores ?? 2,
      memoryMB: input.memoryMB ?? 2048,
      diskGB: input.diskGB ?? 20,
      datastore: (input.datastore ?? "local-lvm").trim(),
      bridge: (input.bridge ?? "vmbr0").trim(),
      templateVmId: input.templateVmId,
      isoFile: input.isoFile,
      ipv4: input.ipv4,
      gateway: input.gateway,
      sshPublicKey,
      installDocker: !input.skipInstallDocker,
      snippetsDatastore: input.snippetsDatastore,
    };
    if (spec.cores < 1 || spec.memoryMB < 128 || spec.diskGB < 1) {
      return { ok: false, error: "cores ≥ 1, memoryMB ≥ 128 and diskGB ≥ 1 are required." };
    }

    const files = buildProxmoxVmTerraform(spec);
    const fileCount = Object.keys(files).length;

    let pullRequest: { number: number; url: string } | undefined;
    const committed: string[] = [];
    if (wantsPush) {
      const base = (input.path ?? `terraform/proxmox/${input.name}`).replace(/^\/+|\/+$/g, "");
      const branch = `infra/proxmox-vm-${input.name}`;
      let first = true;
      for (const [rel, content] of Object.entries(files)) {
        const filename = rel.split("/").pop() || rel;
        const res = await writeRepoFileTool.execute(
          {
            repoFullName: input.repoFullName!,
            path: `${base}/${filename}`,
            content,
            branch,
            message: `Add Proxmox VM ${input.name} (Terraform)`,
            openPullRequest: first,
            pullRequestBody: `Terraform for Proxmox VM \`${input.name}\` on node ${spec.node}.`,
          },
          ctx,
        );
        if (!res.ok) return { ok: false, error: `Push failed on ${base}/${filename}: ${res.error}` };
        committed.push(`${base}/${filename}`);
        if (first && res.output.pullRequest) pullRequest = res.output.pullRequest;
        first = false;
      }
    }

    let runId: string | undefined;
    if (wantsApply) {
      const run = startTerraformRun({
        projectId: ctx.projectId,
        envId: env.id,
        envKey: env.key,
        cloudProviderId: env.cloudProviderId,
        name: `proxmox-vm-${input.name}-apply`,
        action: "apply",
        files,
        backend: null, // Proxmox has no S3 state backend — use local state.
        stack: `proxmox-vm-${input.name}`,
      });
      runId = run.id;
    }

    const bits: string[] = [`Generated ${fileCount} Proxmox VM Terraform files for "${input.name}".`];
    if (pullRequest) bits.push(`Opened PR #${pullRequest.number}: ${pullRequest.url}`);
    else if (committed.length) bits.push(`Committed ${committed.length} files.`);
    if (runId) bits.push(`Started terraform apply (run ${runId}) — track it on the Infrastructure tab.`);

    return {
      ok: true,
      output: { vm: input.name, fileCount, mode: input.mode, runId, pullRequest, committed, note: bits.join(" ") },
    };
  },
};
