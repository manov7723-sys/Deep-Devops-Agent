import { prisma } from "@/lib/db/prisma";
import { buildEksTerraform, type EksSpec } from "@/lib/devops/eks";
import { startTerraformRun } from "@/lib/devops/terraform-run";
import { writeRepoFileTool } from "./write-repo-file";
import type { Tool } from "./types";

type Input = {
  envKey: string;
  name: string;
  region?: string;
  kubernetesVersion?: string;
  instanceType?: string;
  desiredNodes?: number;
  minNodes?: number;
  maxNodes?: number;
  endpointPublic?: boolean;
  /** The three execution modes from the infra playbook. */
  mode: "push" | "apply" | "push_and_apply";
  /** Required when mode includes push. */
  repoFullName?: string;
  /** GitHub folder for the generated files (push modes). Defaults to terraform/eks/<name>. */
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
 * Deterministically provision an EKS cluster. The agent supplies only the spec
 * (no raw HCL — a full EKS config is too large to emit reliably within the
 * model's output budget). This tool builds the complete, production Terraform
 * via the same generator the EKS chat box uses, then PUSHES it to a repo and/or
 * APPLIES it for real — matching the three infra execution modes.
 */
export const provisionEksTool: Tool<Input, Output> = {
  name: "provision_eks",
  description:
    "Create an EKS cluster from a spec. Use this for ANY EKS request instead of hand-writing " +
    "Terraform — it deterministically generates the full VPC + EKS + node-group config and then, " +
    "per `mode`: pushes it to a repo as a PR ('push'), runs terraform apply ('apply'), or both " +
    "('push_and_apply'). Ask the user the requirement questions and which mode first.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env key whose AWS creds + S3 state to use, e.g. 'release'.",
      },
      name: {
        type: "string",
        description: "Cluster name (lowercase letters, digits, hyphens; start with a letter).",
      },
      region: { type: "string", description: "AWS region. Default us-east-1." },
      kubernetesVersion: { type: "string", description: "K8s version, e.g. '1.30'." },
      instanceType: { type: "string", description: "Node instance type, e.g. 't3.medium'." },
      desiredNodes: { type: "number", description: "Desired node count. Default 2." },
      minNodes: { type: "number", description: "Min node count. Default 1." },
      maxNodes: { type: "number", description: "Max node count. Default 3." },
      endpointPublic: { type: "boolean", description: "Public API endpoint. Default true." },
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
        description: "GitHub folder for the files. Default terraform/eks/<name>.",
      },
    },
    required: ["envKey", "name", "mode"],
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

    const env = await prisma.env.findUnique({
      where: { projectId_key: { projectId: ctx.projectId, key: input.envKey } },
      select: {
        id: true,
        key: true,
        cloudProviderId: true,
        tfBackendBucket: true,
        tfBackendRegion: true,
        tfBackendTable: true,
      },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    if (wantsApply && !env.cloudProviderId) {
      return {
        ok: false,
        error: `Env "${input.envKey}" has no cloud provider connected — connect AWS before applying.`,
      };
    }

    const region = (input.region ?? "us-east-1").trim();
    const spec: EksSpec = {
      name: input.name,
      region,
      kubernetesVersion: input.kubernetesVersion ?? "1.33",
      instanceType: input.instanceType ?? "t3.medium",
      desiredNodes: input.desiredNodes ?? 2,
      minNodes: input.minNodes ?? 1,
      maxNodes: input.maxNodes ?? 3,
      endpointPublic: input.endpointPublic ?? true,
      ...(env.tfBackendBucket
        ? {
            stateBucket: env.tfBackendBucket,
            stateRegion: env.tfBackendRegion ?? region,
            stateTable: env.tfBackendTable ?? undefined,
          }
        : {}),
    };
    if (
      spec.maxNodes < spec.minNodes ||
      spec.desiredNodes < spec.minNodes ||
      spec.desiredNodes > spec.maxNodes
    ) {
      return { ok: false, error: "Node counts must satisfy min ≤ desired ≤ max." };
    }

    const files = buildEksTerraform(spec);
    const fileCount = Object.keys(files).length;

    let pullRequest: { number: number; url: string } | undefined;
    const committed: string[] = [];
    if (wantsPush) {
      const base = (input.path ?? `terraform/eks/${input.name}`).replace(/^\/+|\/+$/g, "");
      const branch = `infra/eks-${input.name}`;
      let first = true;
      for (const [rel, content] of Object.entries(files)) {
        const filename = rel.split("/").pop() || rel;
        const res = await writeRepoFileTool.execute(
          {
            repoFullName: input.repoFullName!,
            path: `${base}/${filename}`,
            content,
            branch,
            message: `Add EKS cluster ${input.name} (Terraform)`,
            openPullRequest: first,
            pullRequestBody: `Deterministic EKS blueprint for \`${input.name}\` in ${region}.`,
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
      const backend = env.tfBackendBucket
        ? {
            kind: "s3" as const,
            bucket: env.tfBackendBucket,
            region: env.tfBackendRegion ?? region,
            table: env.tfBackendTable ?? undefined,
          }
        : null;
      const run = startTerraformRun({
        projectId: ctx.projectId,
        envId: env.id,
        envKey: env.key,
        cloudProviderId: env.cloudProviderId,
        name: `eks-${input.name}-apply`,
        action: "apply",
        files,
        backend,
        stack: `eks-${input.name}`,
      });
      runId = run.id;
    }

    const bits: string[] = [`Generated ${fileCount} EKS Terraform files for "${input.name}".`];
    if (pullRequest) bits.push(`Opened PR #${pullRequest.number}: ${pullRequest.url}`);
    else if (committed.length) bits.push(`Committed ${committed.length} files.`);
    if (runId)
      bits.push(
        `Started terraform apply (run ${runId}) — track it on the Infrastructure tab (EKS takes ~15–20 min).`,
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
