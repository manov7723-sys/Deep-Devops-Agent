import { analyzeRepoForWorkflow } from "@/lib/automation/workflow";
import { generateTrivyWorkflow } from "@/lib/ci/templates";
import type { Tool } from "./types";

type CiInput = { repoFullName: string };
type CiOutput = { stackTitle: string; reasoning: string; files: Array<{ path: string; content: string }>; notes: string[] };

/**
 * Generate a stack-aware GitHub Actions CI workflow (install → build → test) for
 * a connected repo. The agent detects the stack; the YAML is vetted. Show it,
 * then commit with write_repo_file.
 */
export const generateCiWorkflowTool: Tool<CiInput, CiOutput> = {
  name: "generate_ci_workflow",
  description:
    "Generate a vetted, stack-aware GitHub Actions CI workflow (.github/workflows/ci.yml: install → build → test, " +
    "runs on push/PR) for a connected repo. Use when the user wants CI / a build pipeline. Show the file, then commit with write_repo_file.",
  inputSchema: {
    type: "object",
    properties: { repoFullName: { type: "string", description: 'The repo as "owner/name", attached to this project.' } },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await analyzeRepoForWorkflow(ctx.projectId, input.repoFullName);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { stackTitle: res.stackTitle, reasoning: res.reasoning, files: res.files, notes: res.notes } };
  },
};

/**
 * Generate the Trivy security-scan CI workflow (no repo analysis needed — same
 * for any stack). Commit it so the repo is scanned on every push/PR.
 */
export const generateTrivyWorkflowTool: Tool<Record<string, never>, { files: Array<{ path: string; content: string }>; notes: string[] }> = {
  name: "generate_trivy_workflow",
  description:
    "Generate the Trivy security-scan GitHub Actions workflow (.github/workflows/trivy.yml) so the repo is scanned " +
    "for vulnerabilities, secrets and misconfigurations on every push/PR. No input needed. Show it, then commit with write_repo_file.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const file = generateTrivyWorkflow();
    return {
      ok: true,
      output: {
        files: [file],
        notes: ["Scans deps, secrets and misconfigurations on push/PR.", "Fails the build on HIGH/CRITICAL findings that have a fix available."],
      },
    };
  },
};
