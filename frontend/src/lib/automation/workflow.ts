/**
 * "Create CI workflow" automation — detects the repo's stack and emits a
 * vetted, stack-aware GitHub Actions workflow (install → build → test) that
 * runs on push/PR. The LLM only detects the stack; the YAML is generated from
 * the vetted template.
 */
import { prisma } from "@/lib/db/prisma";
import { generateCiWorkflow, generateGitlabCi } from "@/lib/ci/templates";
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

  // Emit GitLab CI (.gitlab-ci.yml) for GitLab repos, GitHub Actions otherwise.
  const repoRow = await prisma.repo.findFirst({
    where: { fullName: repoFullName, deletedAt: null, projectRepos: { some: { projectId } } },
    select: { provider: true },
  });
  const isGitlab = repoRow?.provider === "gitlab";

  let wf: { path: string; content: string };
  try {
    wf = isGitlab
      ? generateGitlabCi({ stack: det.stack, params: det.params })
      : generateCiWorkflow({ stack: det.stack, params: det.params });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed." };
  }

  return {
    ok: true,
    stackTitle: det.stackTitle,
    reasoning: det.reasoning,
    files: [wf],
    notes: isGitlab
      ? [
          "One `.gitlab-ci.yml` with a build/test job and a Trivy security stage (GitLab uses a single CI file).",
          "Runs on pushes and merge-request events; the test step is non-blocking until you add tests.",
          "Needs a GitLab runner available to the project (gitlab.com shared runners or a self-hosted runner).",
        ]
      : [
          "Runs on push to main/master and on pull requests.",
          "The test step is non-blocking when no tests are defined, so the pipeline stays green until you add tests.",
        ],
  };
}
