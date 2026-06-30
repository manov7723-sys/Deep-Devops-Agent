/**
 * "Create docker-compose" automation — detects the repo's stack and emits the
 * vetted docker-compose.yml (port-mapped to the stack's runtime). The compose
 * file builds from the repo's Dockerfile, so it pairs with the Dockerfile
 * automation.
 */
import { generateDockerArtifacts } from "@/lib/ci/templates";
import { detectRepoStack } from "./repo-analyze";

export type ComposeAnalysis =
  | {
      ok: true;
      stackTitle: string;
      reasoning: string;
      files: { path: string; content: string }[];
      notes: string[];
      hasDockerfile: boolean;
    }
  | { ok: false; error: string };

export async function analyzeRepoForCompose(projectId: string, repoFullName: string): Promise<ComposeAnalysis> {
  const det = await detectRepoStack(projectId, repoFullName);
  if (!det.ok) return det;

  let generated: { files: { path: string; content: string }[] };
  try {
    generated = generateDockerArtifacts({ stack: det.stack, params: det.params });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed." };
  }

  const compose = generated.files.filter((f) => f.path === "docker-compose.yml");
  const notes = ["Compose builds from the repo's Dockerfile and maps the app's runtime port."];
  if (!det.existingDockerfile) {
    notes.push("No Dockerfile detected at the repo root — generate one with the Create Dockerfile automation first, or `docker compose up` will fail to build.");
  }

  return {
    ok: true,
    stackTitle: det.stackTitle,
    reasoning: det.reasoning,
    files: compose,
    notes,
    hasDockerfile: det.existingDockerfile,
  };
}
