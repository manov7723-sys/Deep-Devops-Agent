/**
 * "Create CI workflow" automation — detects the repo's stack and emits a
 * vetted, stack-aware GitHub Actions workflow (install → build → test) that
 * runs on push/PR. The LLM only detects the stack; the YAML is generated from
 * the vetted template.
 */
import { generateCiWorkflow } from "@/lib/ci/templates";
import { detectRepoStack } from "./repo-analyze";

export type WorkflowAnalysis =
  | {
      ok: true;
      stackTitle: string;
      reasoning: string;
      files: { path: string; content: string }[];
      notes: string[];
    }
  | { ok: false; error: string };

export async function analyzeRepoForWorkflow(projectId: string, repoFullName: string): Promise<WorkflowAnalysis> {
  const det = await detectRepoStack(projectId, repoFullName);
  if (!det.ok) return det;

  let wf: { path: string; content: string };
  try {
    wf = generateCiWorkflow({ stack: det.stack, params: det.params });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed." };
  }

  return {
    ok: true,
    stackTitle: det.stackTitle,
    reasoning: det.reasoning,
    files: [wf],
    notes: [
      "Runs on push to main/master and on pull requests.",
      "The test step is non-blocking when no tests are defined, so the pipeline stays green until you add tests.",
    ],
  };
}
