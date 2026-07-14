import { prisma } from "@/lib/db/prisma";
import type { Tool } from "./types";

type FileEntry = { path: string; content: string };

type Input = {
  /** owner/repo — must be attached to the current project. */
  repoFullName: string;
  /** A short name for this pipeline (e.g. "Build & push to ECR"). */
  name: string;
  /** All generated files: Dockerfile, .dockerignore, docker-compose.yml, nginx.conf, the workflow, etc. */
  files: FileEntry[];
  /** Turn on agent auto-review: a failed run is auto-fixed and re-run by the agent. */
  agentReview?: boolean;
};

type Output = {
  id: string;
  name: string;
  fileCount: number;
  workflowPath: string | null;
  status: string;
  message: string;
};

/** Pick the GitHub Actions workflow file out of the generated set, if present. */
function findWorkflowPath(files: FileEntry[]): string | null {
  // GitHub Actions live under .github/workflows/*.yml; GitLab CI is a single
  // .gitlab-ci.yml at the repo root.
  const wf = files.find((f) => {
    const p = f.path.replace(/^\/+/, "");
    return /^\.github\/workflows\/.+\.ya?ml$/.test(p) || /^\.gitlab-ci\.ya?ml$/.test(p);
  });
  return wf ? wf.path.replace(/^\/+/, "") : null;
}

/**
 * Save a generated CI/CD pipeline to the project's CI/CD section WITHOUT
 * pushing anything to GitHub. The user reviews/edits the script in the CI/CD
 * tab, then clicks "Run pipeline" — which is when the workflow is committed to
 * the repo's default branch and the GitHub Actions run is triggered.
 *
 * Call this (instead of write_repo_file) once the user is satisfied with the
 * pipeline in chat and asks to "push to the CI/CD pipeline".
 */
export const savePipelineToProjectTool: Tool<Input, Output> = {
  name: "save_pipeline_to_project",
  description:
    "Save a generated CI/CD pipeline (Dockerfile + workflow + any sidecars) to the project's CI/CD " +
    "section WITHOUT committing to GitHub. Use this once the user is satisfied with the pipeline in chat " +
    "and says to push it to the CI/CD pipeline. The user then edits/reviews the script in the CI/CD tab and " +
    "clicks 'Run pipeline' to commit + trigger it. Pass every generated file. Set agentReview=true to let " +
    "the agent auto-fix and re-run failed pipelines.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: "owner/repo, attached to the project." },
      name: { type: "string", description: 'Short pipeline name, e.g. "Build & push to ECR".' },
      files: {
        type: "array",
        description: "Every generated file for the pipeline.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path within the repo, no leading slash." },
            content: { type: "string", description: "Full file contents." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      agentReview: {
        type: "boolean",
        description: "Auto-fix + re-run failed runs with the agent.",
      },
    },
    required: ["repoFullName", "name", "files"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      return { ok: false, error: "No files to save. Generate the pipeline first." };
    }
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true, defaultBranch: true },
    });
    if (!repo) {
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    }

    const files = input.files.map((f) => ({
      path: f.path.replace(/^\/+/, ""),
      content: f.content,
    }));
    const workflowPath = findWorkflowPath(files);

    const row = await prisma.ciPipeline.create({
      data: {
        projectId: ctx.projectId,
        repoId: repo.id,
        name: input.name,
        files,
        workflowPath,
        branch: repo.defaultBranch || "main",
        status: "draft",
        agentReview: input.agentReview ?? false,
      },
      select: { id: true, name: true, status: true },
    });

    return {
      ok: true,
      output: {
        id: row.id,
        name: row.name,
        fileCount: files.length,
        workflowPath,
        status: row.status,
        message:
          "Saved to the project's CI/CD tab. The user can now edit the script there and click 'Run pipeline' to commit it to the default branch and trigger the GitHub Actions run.",
      },
    };
  },
};
