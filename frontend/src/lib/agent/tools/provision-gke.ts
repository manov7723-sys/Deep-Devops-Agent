import { prisma } from "@/lib/db/prisma";
import { buildGkeTerraform, type GkeSpec } from "@/lib/devops/gke";
import { setEnvGcsBackend } from "@/lib/devops/envs";
import { startTerraformRun } from "@/lib/devops/terraform-run";
import { writeRepoFileTool } from "./write-repo-file";
import type { Tool } from "./types";

type Input = {
  envKey: string;
  name: string;
  /** GCP project id the cluster is created in. */
  project: string;
  /** Region (e.g. "us-central1") or zone (e.g. "us-central1-a"). */
  location?: string;
  kubernetesVersion?: string;
  machineType?: string;
  desiredNodes?: number;
  minNodes?: number;
  maxNodes?: number;
  /** Network step: create a dedicated VPC or reuse an existing one. */
  createNetwork?: boolean;
  existingNetwork?: string;
  existingSubnetwork?: string;
  /** Private nodes (no external IPs); control plane stays reachable unless privateEndpoint is set. */
  privateNodes?: boolean;
  privateEndpoint?: boolean;
  /** Security step. */
  workloadIdentity?: boolean;
  shieldedNodes?: boolean;
  binaryAuthorization?: boolean;
  /** Release channel (Console default is REGULAR). */
  releaseChannel?: "REGULAR" | "STABLE" | "RAPID";
  /** Optional application node pool. */
  appNodePool?: boolean;
  appMachineType?: string;
  appSpot?: boolean;
  appMinNodes?: number;
  appMaxNodes?: number;
  /** Optional GCS remote-state backend. */
  stateBucket?: string;
  /** The three execution modes from the infra playbook. */
  mode: "push" | "apply" | "push_and_apply";
  /** Required when mode includes push. */
  repoFullName?: string;
  /** GitHub folder for the generated files (push modes). Defaults to terraform/gke/<name>. */
  path?: string;
};

type Output = {
  cluster: string;
  fileCount: number;
  mode: string;
  runId?: string;
  pullRequest?: { number: number; url: string };
  committed?: string[];
  note: string;
};

/**
 * Deterministically provision a GKE cluster from a spec. The agent supplies
 * only the answers to the GCP-Console-style questions (env, project id,
 * region/zone, node pool, network, security, optional app pool, optional GCS
 * remote state) — this tool builds the complete Terraform via the same
 * generator the GKE static form uses, then PUSHES it to a repo and/or APPLIES
 * it for real. Matches the three infra execution modes.
 */
export const provisionGkeTool: Tool<Input, Output> = {
  name: "provision_gke",
  description:
    "Create a GKE cluster from a spec. Use this for ANY GKE request instead of hand-writing " +
    "Terraform — it deterministically generates the full VPC-native cluster + node pool + " +
    "security config, then per `mode`: pushes it to a repo as a PR ('push'), runs terraform " +
    "apply ('apply'), or both ('push_and_apply'). Ask the GCP-Console-style questions first: " +
    "env, project id, location (region or zone), cluster name, K8s version / release channel, " +
    "machine type, node counts, network (create new VPC or existing network+subnetwork, private " +
    "nodes), security (workload identity, shielded nodes, binary auth), optional app node pool, " +
    "and mode.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose GCP creds to use, e.g. 'release'." },
      name: {
        type: "string",
        description: "Cluster name (lowercase letters, digits, hyphens; start with a letter).",
      },
      project: { type: "string", description: "GCP project id the cluster lives in." },
      location: {
        type: "string",
        description:
          "Region (e.g. 'us-central1') or zone (e.g. 'us-central1-a'). Default us-central1.",
      },
      kubernetesVersion: { type: "string", description: "K8s version, e.g. '1.30'." },
      machineType: { type: "string", description: "Node machine type, e.g. 'n2-standard-4'." },
      desiredNodes: { type: "number", description: "Desired node count. Default 1." },
      minNodes: { type: "number", description: "Min node count. Default 1." },
      maxNodes: { type: "number", description: "Max node count. Default 3." },
      createNetwork: { type: "boolean", description: "Create a new dedicated VPC. Default true." },
      existingNetwork: {
        type: "string",
        description: "Existing network name (required when createNetwork=false).",
      },
      existingSubnetwork: {
        type: "string",
        description: "Existing subnetwork name (optional, only when createNetwork=false).",
      },
      privateNodes: { type: "boolean", description: "Nodes have no public IPs. Default true." },
      privateEndpoint: {
        type: "boolean",
        description: "Also make the control-plane endpoint private. Default false.",
      },
      workloadIdentity: {
        type: "boolean",
        description: "Federated GCP IAM for pods. Default true.",
      },
      shieldedNodes: {
        type: "boolean",
        description: "Secure boot + integrity monitoring. Default true.",
      },
      binaryAuthorization: {
        type: "boolean",
        description: "Signed-image enforcement. Default true.",
      },
      releaseChannel: {
        type: "string",
        enum: ["REGULAR", "STABLE", "RAPID"],
        description: "GKE release channel. Default REGULAR.",
      },
      appNodePool: {
        type: "boolean",
        description: "Add an application node pool alongside the default. Default true.",
      },
      appMachineType: { type: "string", description: "App pool machine type." },
      appSpot: { type: "boolean", description: "Use spot VMs for the app pool. Default true." },
      appMinNodes: { type: "number", description: "App pool min nodes." },
      appMaxNodes: { type: "number", description: "App pool max nodes." },
      stateBucket: { type: "string", description: "GCS bucket for remote state (optional)." },
      mode: {
        type: "string",
        enum: ["push", "apply", "push_and_apply"],
        description: "Execution mode the user chose.",
      },
      repoFullName: {
        type: "string",
        description: "owner/repo to push to (required for push modes).",
      },
      path: {
        type: "string",
        description: "GitHub folder for the files. Default terraform/gke/<name>.",
      },
    },
    required: ["envKey", "name", "project", "mode"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!/^[a-z][a-z0-9-]{1,38}$/.test(input.name)) {
      return {
        ok: false,
        error: "Invalid cluster name. Use lowercase letters, digits, hyphens; start with a letter.",
      };
    }
    const wantsPush = input.mode === "push" || input.mode === "push_and_apply";
    const wantsApply = input.mode === "apply" || input.mode === "push_and_apply";
    if (wantsPush && !input.repoFullName) {
      return { ok: false, error: "repoFullName is required for push modes." };
    }
    const createNetwork = input.createNetwork ?? true;
    if (!createNetwork && !input.existingNetwork?.trim()) {
      return { ok: false, error: "existingNetwork is required when createNetwork=false." };
    }

    const env = await prisma.env.findUnique({
      where: { projectId_key: { projectId: ctx.projectId, key: input.envKey } },
      select: { id: true, key: true, cloudProviderId: true, tfBackendGcsBucket: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    if (wantsApply && !env.cloudProviderId) {
      return {
        ok: false,
        error: `Env "${input.envKey}" has no cloud provider connected — connect GCP before applying.`,
      };
    }

    // Backend resolution priority: explicit stateBucket from this call →
    // env.tfBackendGcsBucket (persisted from a previous create). Passing
    // a bucket here also PERSISTS it onto the env so future GKE creates
    // in the same env reuse it automatically (matches the EKS pattern).
    const explicitBucket = input.stateBucket?.trim();
    const resolvedBucket = explicitBucket || env.tfBackendGcsBucket || undefined;
    if (explicitBucket && explicitBucket !== env.tfBackendGcsBucket) {
      await setEnvGcsBackend(ctx.projectId, input.envKey, { bucket: explicitBucket }).catch(
        () => {},
      );
    }

    const spec: GkeSpec = {
      name: input.name,
      project: input.project,
      location: (input.location ?? "us-central1").trim(),
      kubernetesVersion: input.kubernetesVersion ?? "1.33",
      machineType: input.machineType ?? "n2-standard-4",
      desiredNodes: input.desiredNodes ?? 1,
      minNodes: input.minNodes ?? 1,
      maxNodes: input.maxNodes ?? 3,
      privateNodes: input.privateNodes ?? true,
      createNetwork,
      existingNetwork: input.existingNetwork,
      existingSubnetwork: input.existingSubnetwork,
      releaseChannel: input.releaseChannel ?? "REGULAR",
      privateEndpoint: input.privateEndpoint ?? false,
      workloadIdentity: input.workloadIdentity ?? true,
      shieldedNodes: input.shieldedNodes ?? true,
      binaryAuthorization: input.binaryAuthorization ?? true,
      appNodePool: input.appNodePool ?? true,
      appMachineType: input.appMachineType,
      appSpot: input.appSpot ?? true,
      appMinNodes: input.appMinNodes,
      appMaxNodes: input.appMaxNodes,
      ...(resolvedBucket ? { stateBucket: resolvedBucket } : {}),
    };
    if (
      spec.maxNodes < spec.minNodes ||
      spec.desiredNodes < spec.minNodes ||
      spec.desiredNodes > spec.maxNodes
    ) {
      return { ok: false, error: "Node counts must satisfy min ≤ desired ≤ max." };
    }

    const files = buildGkeTerraform(spec);
    const fileCount = Object.keys(files).length;

    let pullRequest: { number: number; url: string } | undefined;
    const committed: string[] = [];
    if (wantsPush) {
      const base = (input.path ?? `terraform/gke/${input.name}`).replace(/^\/+|\/+$/g, "");
      const branch = `infra/gke-${input.name}`;
      let first = true;
      for (const [rel, content] of Object.entries(files)) {
        const filename = rel.split("/").pop() || rel;
        const res = await writeRepoFileTool.execute(
          {
            repoFullName: input.repoFullName!,
            path: `${base}/${filename}`,
            content,
            branch,
            message: `Add GKE cluster ${input.name} (Terraform)`,
            openPullRequest: first,
            pullRequestBody: `Deterministic GKE blueprint for \`${input.name}\` in ${spec.location} (project \`${spec.project}\`).`,
          },
          ctx,
        );
        if (!res.ok)
          return { ok: false, error: `Push failed on ${base}/${filename}: ${res.error}` };
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
        name: `gke-${input.name}-apply`,
        action: "apply",
        files,
        backend: resolvedBucket ? { kind: "gcs", bucket: resolvedBucket } : null,
        stack: `gke-${input.name}`,
      });
      runId = run.id;
    }

    const bits: string[] = [`Generated ${fileCount} GKE Terraform files for "${input.name}".`];
    if (pullRequest) bits.push(`Opened PR #${pullRequest.number}: ${pullRequest.url}`);
    else if (committed.length) bits.push(`Committed ${committed.length} files.`);
    if (runId)
      bits.push(
        `Started terraform apply (run ${runId}) — track it on the Infrastructure tab (GKE takes ~10–15 min).`,
      );

    return {
      ok: true,
      output: {
        cluster: input.name,
        fileCount,
        mode: input.mode,
        runId,
        pullRequest,
        committed,
        note: bits.join(" "),
      },
    };
  },
};
