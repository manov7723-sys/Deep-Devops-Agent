/**
 * S3 agent tool — generate Terraform for a new S3 bucket with secure defaults
 * (public access blocked, SSE encryption, versioning on).
 *
 * The full end-to-end flow (via chat playbook, agent chains these):
 *   1. generate_s3_terraform → returns HCL for the bucket + hardening blocks
 *   2. write_repo_file       → commit the HCL under terraform/s3/<name>/ on the default branch
 *   3. run_terraform (plan)  → preview
 *   4. request_infra_approval → one approval-card in chat that authorizes apply
 *   5. (user clicks approve) → terraform apply runs, outputs the bucket ARN
 *
 * Unlike RDS, S3 has NO dependency on an existing cluster/VPC, so there's
 * no cluster preflight — only AWS-provider preflight to prove the caller can
 * even reach S3 with the connected credentials.
 */
import { prisma } from "@/lib/db/prisma";
import { buildS3Terraform, validateBucketName, S3_DEFAULTS } from "@/lib/devops/s3";
import type { S3Encryption } from "@/lib/devops/s3";
import type { Tool } from "./types";

type Input = {
  /** Bucket name (DNS-safe, globally unique across ALL AWS). 3-63 chars, lowercase. */
  name: string;
  region: string;
  envKey?: string;
  versioning?: boolean;
  /** Encryption mode. "AES256" (SSE-S3) or "aws:kms". kmsKeyId only used with aws:kms. */
  encryptionMode?: "AES256" | "aws:kms";
  kmsKeyId?: string;
  /** Lifecycle: expire noncurrent versions after this many days. Omit to skip the rule. */
  noncurrentVersionExpirationDays?: number;
  /** Add a random 6-hex-char suffix to help dodge S3's global-name-collision problem. */
  addRandomSuffix?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateS3TerraformTool: Tool<Input, Output> = {
  name: "generate_s3_terraform",
  description:
    "Generate Terraform for an AWS S3 bucket with SECURE-BY-DEFAULT hardening " +
    "(public access blocked at every layer, SSE encryption on, versioning on). " +
    "NEVER hand-write S3 HCL — always call this. Returns the .tf file set; " +
    "pair with write_repo_file (commit under terraform/s3/<name>/) then " +
    "run_terraform action='plan' and request_infra_approval to gate the apply. " +
    "Bucket name must be globally unique across ALL AWS accounts — pass " +
    "addRandomSuffix:true when the user hasn't already put an org prefix on it.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Bucket name — 3-63 chars, lowercase alphanumerics/dashes/dots, must start+end alphanumeric. GLOBALLY unique across ALL of AWS (not just this account).",
      },
      region: { type: "string", description: "AWS region, e.g. us-east-1." },
      envKey: {
        type: "string",
        description: "Env key (dev / staging / prod) — used for tagging only. Optional.",
      },
      versioning: {
        type: "boolean",
        description: `Enable object versioning. Default ${S3_DEFAULTS.versioning}.`,
      },
      encryptionMode: {
        type: "string",
        enum: ["AES256", "aws:kms"],
        description:
          'Encryption: "AES256" (SSE-S3, no extra cost, sensible default) or "aws:kms" (customer-managed key). Default AES256.',
      },
      kmsKeyId: {
        type: "string",
        description: "KMS key id/ARN — only used when encryptionMode is 'aws:kms'. Omit to use the AWS-managed alias/aws/s3.",
      },
      noncurrentVersionExpirationDays: {
        type: "number",
        description:
          "Days after which noncurrent (superseded) object versions expire. Omit entirely to skip the lifecycle rule; set (e.g. 90) to cap storage cost from versioning.",
      },
      addRandomSuffix: {
        type: "boolean",
        description:
          "Append a random 6-hex-char suffix to the bucket name (e.g. 'my-bucket-a1b2c3'). Helps dodge S3's global-name-collision when the user gave a generic name.",
      },
    },
    required: ["name", "region"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // Fail loudly BEFORE we emit HCL that AWS would reject at apply time.
    const nameCheck = validateBucketName(input.name);
    if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

    // Confirm this project actually has an AWS provider connected — same as
    // every other AWS-generating tool. Without it, apply has no creds.
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) {
      return {
        ok: false,
        error: "No AWS account connected to this project. Connect one on the Cloud providers tab first.",
      };
    }

    const encryption: S3Encryption =
      input.encryptionMode === "aws:kms"
        ? { kind: "aws:kms", kmsKeyId: input.kmsKeyId }
        : { kind: "AES256" };

    try {
      const files = buildS3Terraform({
        name: input.name,
        region: input.region,
        env: input.envKey,
        versioning: input.versioning,
        encryption,
        noncurrentVersionExpirationDays: input.noncurrentVersionExpirationDays,
        addRandomSuffix: input.addRandomSuffix,
        tags: { CreatedBy: "deepagent-s3" },
      });
      const lifecycleLine =
        typeof input.noncurrentVersionExpirationDays === "number"
          ? `, noncurrent versions expire after ${input.noncurrentVersionExpirationDays}d`
          : "";
      return {
        ok: true,
        output: {
          files,
          stack: `s3-${input.name}`,
          summary:
            `S3 bucket "${input.name}"${input.addRandomSuffix ? " (with random suffix)" : ""} in ${input.region}: ` +
            `${encryption.kind === "AES256" ? "SSE-S3" : "SSE-KMS"} encryption, ` +
            `versioning ${(input.versioning ?? S3_DEFAULTS.versioning) ? "on" : "off"}, ` +
            `public access fully blocked${lifecycleLine}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/s3/${input.name}/ on the repo's default branch (commitMode direct — no PR).`,
            `2. run_terraform(envKey, name:'s3-${input.name}-apply', action:'plan', files:<returned>, stack:'s3-${input.name}') to preview.`,
            `3. request_infra_approval with the SAME files/stack + cloud:'aws' — emit the returned approvalId in an approval-card fence and STOP.`,
            `4. After the user approves, the apply runs; read the output 'bucket' + 'arn' from the completed run.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate S3 Terraform." };
    }
  },
};
