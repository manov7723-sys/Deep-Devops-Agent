import { prisma } from "@/lib/db/prisma";
import { getTerraformRunAsync, listTerraformRunsAsync, type TfStage } from "@/lib/devops/terraform-run";
import { writeRepoFileTool } from "./write-repo-file";
import type { Tool } from "./types";

/**
 * Recover from a terraform apply that failed with "resource already exists"
 * errors. The classic case: an earlier apply partially succeeded (created N
 * AWS resources), then hit a rate limit / IAM propagation / interrupt. State
 * doesn't track those resources, so the next apply re-creates them → AWS
 * rejects with 400/409.
 *
 * Historically the fix was: `terraform import <addr> <id>` per resource +
 * re-apply. Non-DevOps users can't run those. This tool parses the failed
 * run's stderr, extracts every "already exists" resource + its cloud-side
 * identifier, and generates a Terraform 1.5+ `import.tf` file with declarative
 * import blocks. The agent commits that file to the repo, re-runs apply, and
 * Terraform picks the existing resources up on the next plan.
 *
 * WHAT IT DETECTS (Terraform + AWS provider error patterns):
 *   • IAM Policy       — "creating IAM Policy (<name>): ... EntityAlreadyExists"
 *                        ID = ARN, reconstructed from account id + policy name
 *   • KMS Alias        — "creating KMS Alias (<name>): ... AlreadyExistsException"
 *                        ID = alias name
 *   • CloudWatch Logs  — "creating CloudWatch Logs Log Group (<name>): ...
 *                        ResourceAlreadyExistsException"
 *                        ID = log group name (no ARN)
 *   • IAM Role         — "creating IAM Role (<name>): ... EntityAlreadyExists"
 *                        ID = role name
 *   • Security Group   — "creating Security Group (<name>): ...
 *                        InvalidGroup.Duplicate"
 *                        ID = sg-<hex> (extracted from message if present)
 *   • S3 Bucket        — "creating S3 Bucket (<name>): ...
 *                        BucketAlreadyOwnedByYou / BucketAlreadyExists"
 *                        ID = bucket name
 *
 * Terraform block pattern generated:
 *   import {
 *     to = aws_iam_policy.alb_controller
 *     id = "arn:aws:iam::985465459771:policy/dev-alb-controller"
 *   }
 *
 * Requires Terraform CLI ≥ 1.5 (which the runner ships with — see
 * lib/runner/terraform.ts). On older versions, fall back to the manual
 * `terraform import` commands listed in the tool's response `fallbackImports`.
 */
type OrphanedResource = {
  /** Terraform resource address the error points at, e.g. `aws_iam_policy.alb_controller`. */
  resourceAddress: string;
  /** Cloud-side identifier for `terraform import` / `import.id`. */
  id: string;
  /** Human-readable resource type for the report. */
  kind: string;
  /** Original error snippet — for the report + audit. */
  errorSnippet: string;
};

type Input = {
  envKey: string;
  /**
   * Failed run to heal. Optional — when omitted, the tool auto-picks the most
   * recent `status=failed` run on this env (usually what the user meant when
   * they said "heal the terraform state that just failed").
   */
  runId?: string;
  /**
   * AWS account id, needed to reconstruct IAM policy ARNs from the error text
   * (which only includes the policy name). Optional — if omitted, the tool
   * reads it from the connected AWS provider on this env.
   */
  awsAccountId?: string;
  /**
   * When set, the tool ALSO commits the generated import.tf directly into the
   * repo at the given path, in ONE call. Removes a separate write_repo_file
   * step from the agent's chain. Path is the directory (e.g. "terraform/eks/dev");
   * import.tf is appended to it.
   */
  commitTo?: {
    repoFullName: string;
    /** Directory containing the .tf files. e.g. "terraform/eks/dev". */
    path: string;
    /** Branch to commit to. Defaults to the repo's default branch. */
    branch?: string;
  };
};

type Output = {
  runId: string;
  detected: OrphanedResource[];
  importTfContent: string;
  fallbackImports: string[];
  committed?: { path: string; branch: string; commitSha: string };
  message: string;
  next: string;
};

/**
 * Parse a terraform apply's error text and extract every "already exists"
 * resource. Pure function — no I/O, easy to unit-test.
 */
export function parseOrphanedResources(errorText: string, awsAccountId?: string): OrphanedResource[] {
  const out: OrphanedResource[] = [];
  if (!errorText) return out;

  // Each detected pattern is a [regex, extractor] pair. The regex captures
  // resource NAME + terraform ADDRESS from the "with X, on Y" trailer that
  // AWS-provider errors emit. Order matters: more specific patterns first so
  // a broader match doesn't swallow a narrower one.

  // IAM Policy — "creating IAM Policy (dev-alb-controller): ... EntityAlreadyExists"
  // Followed by: `with aws_iam_policy.alb_controller,`
  const iamPolicyRe =
    /creating IAM Policy \(([^)]+)\):[^]*?EntityAlreadyExists[^]*?with\s+([a-zA-Z0-9_.]+aws_iam_policy\.[a-zA-Z0-9_-]+)/g;
  for (const m of errorText.matchAll(iamPolicyRe)) {
    const name = m[1];
    const address = m[2];
    // IAM Policy ARN needs the account id; reconstruct from name.
    const arn = awsAccountId ? `arn:aws:iam::${awsAccountId}:policy/${name}` : `arn:aws:iam::UNKNOWN:policy/${name}`;
    out.push({
      resourceAddress: address,
      id: arn,
      kind: "IAM Policy",
      errorSnippet: m[0].slice(0, 240),
    });
  }

  // KMS Alias — "creating KMS Alias (alias/eks/dev): ... AlreadyExistsException"
  const kmsAliasRe =
    /creating KMS Alias \(([^)]+)\):[^]*?AlreadyExistsException[^]*?with\s+([a-zA-Z0-9_."[\]-]+aws_kms_alias\.[a-zA-Z0-9_."[\]-]+)/g;
  for (const m of errorText.matchAll(kmsAliasRe)) {
    out.push({
      resourceAddress: m[2],
      id: m[1],
      kind: "KMS Alias",
      errorSnippet: m[0].slice(0, 240),
    });
  }

  // CloudWatch Log Group — "creating CloudWatch Logs Log Group (/aws/eks/dev/cluster): ..."
  const logGroupRe =
    /creating CloudWatch Logs Log Group \(([^)]+)\):[^]*?ResourceAlreadyExistsException[^]*?with\s+([a-zA-Z0-9_."[\]/-]+aws_cloudwatch_log_group\.[a-zA-Z0-9_."[\]-]+)/g;
  for (const m of errorText.matchAll(logGroupRe)) {
    out.push({
      resourceAddress: m[2],
      id: m[1],
      kind: "CloudWatch Log Group",
      errorSnippet: m[0].slice(0, 240),
    });
  }

  // IAM Role — "creating IAM Role (dev-eks-cluster): ... EntityAlreadyExists"
  const iamRoleRe =
    /creating IAM Role \(([^)]+)\):[^]*?EntityAlreadyExists[^]*?with\s+([a-zA-Z0-9_."[\]-]+aws_iam_role\.[a-zA-Z0-9_."[\]-]+)/g;
  for (const m of errorText.matchAll(iamRoleRe)) {
    out.push({
      resourceAddress: m[2],
      id: m[1],
      kind: "IAM Role",
      errorSnippet: m[0].slice(0, 240),
    });
  }

  // S3 Bucket — "creating S3 Bucket (my-bucket): ... BucketAlreadyOwnedByYou"
  const s3Re =
    /creating S3 Bucket \(([^)]+)\):[^]*?(?:BucketAlreadyOwnedByYou|BucketAlreadyExists)[^]*?with\s+([a-zA-Z0-9_."[\]-]+aws_s3_bucket\.[a-zA-Z0-9_."[\]-]+)/g;
  for (const m of errorText.matchAll(s3Re)) {
    out.push({
      resourceAddress: m[2],
      id: m[1],
      kind: "S3 Bucket",
      errorSnippet: m[0].slice(0, 240),
    });
  }

  return out;
}

function importTfBlockFor(r: OrphanedResource): string {
  // Terraform 1.5+ declarative import block. The `to` address must be a
  // Terraform resource address; the `id` is the provider's import id (ARN,
  // name, etc). On next `terraform apply`, Terraform imports each into state
  // before planning changes — so the apply that generated these blocks can
  // just be re-run and it succeeds.
  return `import {
  to = ${r.resourceAddress}
  id = "${r.id.replace(/"/g, '\\"')}"
}
`;
}

function fallbackImportCommand(r: OrphanedResource): string {
  // For users on Terraform < 1.5 or workflows that prefer imperative imports.
  // Bracketed/quoted addresses need shell-escaping — wrap the whole address
  // in single quotes to keep the shell literal.
  const addr = r.resourceAddress.includes(".") && r.resourceAddress.includes("[")
    ? `'${r.resourceAddress}'`
    : r.resourceAddress;
  return `terraform import ${addr} '${r.id.replace(/'/g, `'\\''`)}'`;
}

export const healTerraformStateTool: Tool<Input, Output> = {
  name: "heal_terraform_state",
  description:
    "Recover from a terraform apply that failed because AWS resources already exist (state drift from a partial earlier apply). Parses the failed run's stderr, extracts every 'already exists' resource + its cloud id, and generates a Terraform 1.5+ import.tf file that adopts them on the NEXT apply. Use IMMEDIATELY when run_terraform action='apply' fails with 'EntityAlreadyExists', 'AlreadyExistsException', 'ResourceAlreadyExistsException', 'BucketAlreadyOwnedByYou', or similar. Two calling shapes: (1) pass ONLY envKey — the tool auto-finds the most recent failed run on that env; (2) pass envKey + runId when you already know it. For zero back-and-forth, ALSO pass commitTo={repoFullName, path} — the tool then commits import.tf into the same directory as the other .tf files in ONE call, so all the agent has to do next is re-run run_terraform action='apply'. Do NOT tell the user to run `terraform import` manually.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env whose terraform run failed." },
      runId: {
        type: "string",
        description:
          "Failed run's id (returned by run_terraform). OMIT to auto-pick the most recent failed run on this env — the common case for 'heal the terraform state that just failed'.",
      },
      awsAccountId: {
        type: "string",
        description:
          "AWS account id (numeric, no dashes). Needed to reconstruct IAM policy ARNs from the error text. Optional — auto-resolved from the env's connected AWS provider when omitted.",
      },
      commitTo: {
        type: "object",
        properties: {
          repoFullName: { type: "string", description: "owner/repo of the app repo holding the .tf files." },
          path: {
            type: "string",
            description: "Directory holding the .tf files (e.g. 'terraform/eks/dev'). import.tf is committed inside it.",
          },
          branch: {
            type: "string",
            description: "Branch to commit to. Defaults to the repo's default branch.",
          },
        },
        required: ["repoFullName", "path"],
        additionalProperties: false,
        description:
          "When present, the tool commits import.tf directly into the repo — one call instead of chaining heal + write_repo_file. Omit to just get the content and commit yourself.",
      },
    },
    required: ["envKey"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };

    // Resolve the run: explicit runId → lookup; omitted → latest failed on env.
    let runId: string | undefined = input.runId;
    if (!runId) {
      const recent = await listTerraformRunsAsync(env.id, 20);
      const latestFailed = recent.find((r) => r.status === "failed");
      if (!latestFailed) {
        return {
          ok: false,
          error: `No failed terraform runs found on env "${input.envKey}" — nothing to heal.`,
        };
      }
      runId = latestFailed.id;
    }
    const run = await getTerraformRunAsync(runId);
    if (!run) return { ok: false, error: `Terraform run "${runId}" not found.` };
    if (run.envId !== env.id) {
      return {
        ok: false,
        error: `Run "${runId}" belongs to a different env than "${input.envKey}".`,
      };
    }
    if (run.status !== "failed") {
      return {
        ok: false,
        error: `Run "${runId}" is ${run.status}, not failed — nothing to heal. Only call this after a run failed with 'already exists' errors.`,
      };
    }

    // Concatenate error text from every failed stage + the run-level summary.
    // The AWS-provider errors are often in a specific stage's stderr, not
    // just the run.error summary.
    const errorText =
      (run.error ?? "") +
      "\n" +
      run.stages
        .filter((s: TfStage) => s.status === "failed")
        .map((s: TfStage) => s.logs ?? "")
        .join("\n");

    // Resolve AWS account id: caller override → provider accountRef.
    let awsAccountId = input.awsAccountId?.trim();
    if (!awsAccountId && env.cloudProviderId) {
      const cp = await prisma.cloudProvider.findFirst({
        where: { id: env.cloudProviderId, kind: "aws" },
        select: { accountRef: true },
      });
      if (cp?.accountRef && /^\d{6,15}$/.test(cp.accountRef)) awsAccountId = cp.accountRef;
    }

    const detected = parseOrphanedResources(errorText, awsAccountId);
    if (detected.length === 0) {
      return {
        ok: false,
        error:
          `Run "${runId}" failed but no 'already exists' resource patterns were detected. ` +
          `The failure is a different class (module bug, missing IAM permissions, region typo, quota). ` +
          `Check the run's stages/logs directly — this tool only heals state-drift errors.`,
      };
    }

    const importTfContent =
      `# Auto-generated by DeepAgent's heal_terraform_state on ${new Date().toISOString().slice(0, 19)}Z.\n` +
      `# Cause: run ${runId} failed because the following AWS resources already\n` +
      `# exist (partial-apply state drift). These 'import' blocks tell Terraform 1.5+\n` +
      `# to adopt them on the next apply. Once state is aligned, this file can be\n` +
      `# deleted — Terraform re-planning without it is a no-op for imported resources.\n\n` +
      detected.map(importTfBlockFor).join("\n");

    // Optional auto-commit: land import.tf next to the other .tf files in one
    // call so the agent doesn't have to chain write_repo_file separately.
    let committed: { path: string; branch: string; commitSha: string } | undefined;
    if (input.commitTo) {
      const dir = input.commitTo.path.replace(/^\/+|\/+$/g, "");
      const commitPath = `${dir}/import.tf`;
      // Look up the repo's default branch when the caller didn't pin one — the
      // provision_eks fix (2026-08) makes every fresh infra generation commit
      // to the default branch, so heal defaults to matching.
      let branch = input.commitTo.branch?.trim();
      if (!branch) {
        const repoRow = await prisma.repo.findFirst({
          where: {
            fullName: input.commitTo.repoFullName,
            deletedAt: null,
            projectRepos: { some: { projectId: ctx.projectId } },
          },
          select: { defaultBranch: true },
        });
        if (!repoRow) {
          return {
            ok: false,
            error: `Repo "${input.commitTo.repoFullName}" isn't attached to this project — attach it first, or pass commitTo.branch explicitly.`,
          };
        }
        branch = repoRow.defaultBranch;
      }
      const writeRes = await writeRepoFileTool.execute(
        {
          repoFullName: input.commitTo.repoFullName,
          path: commitPath,
          content: importTfContent,
          branch,
          message: `Add Terraform import blocks to heal state after failed apply (${detected.length} orphaned resource${detected.length === 1 ? "" : "s"})`,
        },
        ctx,
      );
      if (!writeRes.ok) {
        return {
          ok: false,
          error: `Detected ${detected.length} orphaned resource(s) and generated import.tf, but committing to ${input.commitTo.repoFullName}:${commitPath} on branch ${branch} failed: ${writeRes.error}`,
        };
      }
      committed = { path: commitPath, branch, commitSha: writeRes.output.commitSha };
    }

    return {
      ok: true,
      output: {
        runId: runId,
        detected,
        importTfContent,
        fallbackImports: detected.map(fallbackImportCommand),
        committed,
        message:
          `Detected ${detected.length} orphaned resource(s) from run "${runId}": ${detected.map((r) => `${r.kind} "${r.id}" (${r.resourceAddress})`).join(", ")}.` +
          (committed
            ? ` Committed import.tf to ${input.commitTo!.repoFullName}:${committed.path} on branch ${committed.branch} (commit ${committed.commitSha.slice(0, 8)}).`
            : ` Generated import.tf content — commit it via write_repo_file yourself.`) +
          (awsAccountId ? "" : " WARNING: AWS account id could not be resolved — IAM policy ARNs use 'UNKNOWN' as placeholder and must be substituted before apply."),
        next: committed
          ? "Re-run run_terraform action='apply' with the SAME name + stack — Terraform 1.5+ picks up the committed import.tf, imports the orphaned resources, and the apply succeeds in one pass. After success, delete import.tf in a follow-up commit."
          : "Commit the returned `importTfContent` as `import.tf` in the same directory as the other .tf files (write_repo_file), then re-run run_terraform action='apply' with the SAME name+stack.",
      },
    };
  },
};
