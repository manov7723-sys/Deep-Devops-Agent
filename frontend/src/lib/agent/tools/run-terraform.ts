import { prisma } from "@/lib/db/prisma";
import { startTerraformRun } from "@/lib/devops/terraform-run";
import { pickBackendForEnv } from "@/lib/devops/envs";
import type { Tool } from "./types";

type Input = {
  /** Env key whose cluster/cloud-provider + state backend to use (e.g. "release"). */
  envKey: string;
  /** A short run label, e.g. "s3-assets-apply". */
  name: string;
  /** "plan" previews changes; "apply" provisions for real. */
  action: "plan" | "apply";
  /** Terraform files to run: relative path → HCL contents (e.g. { "main.tf": "..." }). */
  files: Record<string, string>;
  /**
   * Stable logical stack name for this infra (e.g. "s3-agent9944222-bucket").
   * REUSE the same value across plan/apply and across re-runs of the SAME infra
   * so Terraform tracks one consistent state. Omit only for one-offs.
   */
  stack?: string;
};

type Output = {
  runId: string;
  action: string;
  status: string;
  envKey: string;
  note: string;
};

/**
 * Run Terraform (plan or apply) for a project env, using that env's cloud
 * provider credentials and S3 remote-state backend. The agent uses this for the
 * "apply" infra modes after generating the HCL. Runs in the background; the tool
 * returns the run id so the user can track it on the Infrastructure tab.
 *
 * Safety: `apply` provisions real cloud resources and costs money. Only call it
 * when the user has EXPLICITLY chosen an apply mode.
 */
export const runTerraformTool: Tool<Input, Output> = {
  name: "run_terraform",
  description:
    "Run Terraform (plan or apply) for an environment in this project. Provide the " +
    "full set of .tf files as a path→content map. Uses the env's connected cloud " +
    "credentials and S3 state backend automatically. Use action='plan' to preview, " +
    "action='apply' to provision for real. ONLY use action='apply' when the user " +
    "explicitly asked to apply. Returns a run id to track on the Infrastructure tab.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: 'Env key, e.g. "release" or "alpha". Must exist in this project.',
      },
      name: { type: "string", description: 'Short run label, e.g. "s3-bucket-apply".' },
      action: {
        type: "string",
        enum: ["plan", "apply"],
        description: "plan = preview, apply = provision for real.",
      },
      files: {
        type: "object",
        description:
          'Terraform files: relative path → HCL contents, e.g. {"main.tf":"resource ..."}.',
        additionalProperties: { type: "string" },
      },
      stack: {
        type: "string",
        description:
          'Stable logical stack name (e.g. "s3-agent9944222-bucket"). Reuse the same value for plan/apply and re-runs of the same infra so state stays consistent.',
      },
    },
    required: ["envKey", "name", "action", "files"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const fileKeys = Object.keys(input.files ?? {});
    if (fileKeys.length === 0) {
      return {
        ok: false,
        error: "No Terraform files provided. Pass a path→content map of .tf files.",
      };
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
        tfBackendGcsBucket: true,
        tfBackendAzureResourceGroup: true,
        tfBackendAzureStorageAccount: true,
        tfBackendAzureContainer: true,
        cloudProvider: { select: { kind: true } },
      },
    });
    if (!env) {
      return { ok: false, error: `Env "${input.envKey}" not found in this project.` };
    }
    if (input.action === "apply" && !env.cloudProviderId) {
      return {
        ok: false,
        error: `Env "${input.envKey}" has no cloud provider connected, so apply can't authenticate. Connect a cloud on the Cloud providers tab, or use action='plan'.`,
      };
    }

    // Pick the backend that matches the env's cloud (S3 for AWS, GCS for GCP,
    // azurerm for Azure) — never blindly S3, which used to force AWS creds
    // onto every apply regardless of cloud.
    const backend = pickBackendForEnv(env);

    const run = startTerraformRun({
      projectId: ctx.projectId,
      envId: env.id,
      envKey: env.key,
      cloudProviderId: env.cloudProviderId,
      name: input.name,
      action: input.action,
      files: input.files,
      backend,
      stack: input.stack,
    });

    return {
      ok: true,
      output: {
        runId: run.id,
        action: input.action,
        status: run.status,
        envKey: env.key,
        note: `Terraform ${input.action} started (run ${run.id}). Track live stages + logs on the project's Infrastructure tab.`,
      },
    };
  },
};
