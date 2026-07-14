/**
 * "Create Dockerfile" automation — the agent analyzes a connected repo and
 * produces a production Dockerfile (+ .dockerignore, compose, nginx for SPAs).
 *
 * Stack detection lives in repo-analyze.ts (shared with the CI-workflow and
 * compose automations). Here we just turn the detected stack into the vetted
 * Dockerfile artifact set — the LLM never hand-writes the Dockerfile.
 */
import { generateDockerArtifacts, type DockerStackId } from "@/lib/ci/templates";
import { detectRepoStack } from "./repo-analyze";

export type DockerfileAnalysis =
  | {
      ok: true;
      stack: DockerStackId;
      stackTitle: string;
      params: Record<string, unknown>;
      reasoning: string;
      files: { path: string; content: string }[];
      notes: string[];
      existingDockerfile: boolean;
    }
  | { ok: false; error: string };

/** Analyze a project-attached repo and generate a Dockerfile set. */
export async function analyzeRepoForDockerfile(
  projectId: string,
  repoFullName: string,
): Promise<DockerfileAnalysis> {
  const det = await detectRepoStack(projectId, repoFullName);
  if (!det.ok) return det;

  let generated: { files: { path: string; content: string }[]; notes: string[] };
  try {
    generated = generateDockerArtifacts({ stack: det.stack, params: det.params });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed." };
  }

  return {
    ok: true,
    stack: det.stack,
    stackTitle: det.stackTitle,
    params: det.params,
    reasoning: det.reasoning,
    files: generated.files,
    notes: generated.notes,
    existingDockerfile: det.existingDockerfile,
  };
}
