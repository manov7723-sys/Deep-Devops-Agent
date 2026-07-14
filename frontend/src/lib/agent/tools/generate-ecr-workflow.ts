import { generateEcrWorkflow } from "@/lib/ci/templates";
import type { Tool } from "./types";

type Input = {
  /** IAM role ARN from setup_github_oidc_ecr — used verbatim. */
  roleArn: string;
  /** ECR repository URI from setup_github_oidc_ecr — used verbatim. */
  ecrRepositoryUri: string;
  /** AWS region. */
  region: string;
  /** Branch that triggers the build (the repo's default branch). */
  branch?: string;
};

type Output = { file: { path: string; content: string } };

/**
 * Generate the vetted GitHub Actions workflow that builds the image and pushes
 * it to ECR over OIDC (no stored AWS secrets). Pass the roleArn + ecrRepositoryUri
 * returned by setup_github_oidc_ecr — this tool injects them verbatim, so the
 * workflow never contains a hallucinated ARN, action version, or URI. ALWAYS use
 * this instead of hand-writing the workflow YAML.
 */
export const generateEcrWorkflowTool: Tool<Input, Output> = {
  name: "generate_ecr_workflow",
  description:
    "Generate the GitHub Actions workflow that builds the Docker image and pushes it to Amazon ECR " +
    "using OIDC (keyless — no AWS secrets in the repo). Call this AFTER setup_github_oidc_ecr and pass " +
    "its returned roleArn, ecrRepositoryUri and region. ALWAYS use this instead of writing the workflow " +
    "yourself. Returns the file to commit at .github/workflows/build-and-push.yml.",
  inputSchema: {
    type: "object",
    properties: {
      roleArn: { type: "string", description: "IAM role ARN from setup_github_oidc_ecr." },
      ecrRepositoryUri: {
        type: "string",
        description: "ECR repository URI from setup_github_oidc_ecr.",
      },
      region: { type: "string", description: "AWS region (e.g. us-east-1)." },
      branch: {
        type: "string",
        description: "Branch that triggers the build. Defaults to 'main'.",
      },
    },
    required: ["roleArn", "ecrRepositoryUri", "region"],
    additionalProperties: false,
  },
  async execute(input) {
    if (!/^arn:aws:iam::\d{12}:role\//.test(input.roleArn)) {
      return {
        ok: false,
        error: `"${input.roleArn}" is not a valid IAM role ARN. Use the value from setup_github_oidc_ecr.`,
      };
    }
    const file = generateEcrWorkflow({
      roleArn: input.roleArn,
      ecrRepositoryUri: input.ecrRepositoryUri,
      region: input.region,
      branch: input.branch?.trim() || "main",
    });
    return { ok: true, output: { file } };
  },
};
