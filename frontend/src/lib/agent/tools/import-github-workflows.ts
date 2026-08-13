/**
 * import_github_workflows — clone a repo's EXISTING GitHub Actions workflows
 * into the app's CI/CD tab.
 *
 * The CI/CD → Pipelines tab previously only listed pipelines the app itself
 * generated (deploy_my_app / save_pipeline_to_project). A repo that already
 * carries hand-written or previously-generated workflows had them invisible
 * to the app: no Run button, no background watcher, no auto-heal. This tool
 * registers each workflow file under .github/workflows as a CiPipeline row:
 *
 *   • files = the workflow itself + any Dockerfiles it references (so the
 *     auto-heal review agent is allowed to fix the Dockerfile too — its
 *     allowlist only permits paths in the pipeline's saved file set)
 *   • status "committed" — the files are already live on the branch; Run
 *     just re-commits (a no-op when unchanged) and fires workflow_dispatch
 *   • agentReview on — the always-on watcher + auto-heal cover it
 *
 * Upserts by (project, repo, name) — re-importing refreshes rather than
 * duplicates. Workflows without a workflow_dispatch trigger import too, but
 * are flagged: the app's Run button can't fire them (GitHub rejects the
 * dispatch); they run on their own push/PR triggers and the row still tracks
 * status via the watcher once a run exists.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import type { Tool } from "./types";

type Input = {
  /** Full repo name like "alice/api". Must be attached to the project. */
  repoFullName: string;
};

type ImportedRow = {
  name: string;
  workflowPath: string;
  fileCount: number;
  dispatchable: boolean;
  updated: boolean;
};

type Output = {
  imported: ImportedRow[];
  message: string;
};

/** Pull the workflow's display name out of its YAML (`name: …`), else the filename. */
function workflowName(yaml: string, fileName: string): string {
  const m = /^name:\s*["']?(.+?)["']?\s*$/m.exec(yaml);
  return m?.[1]?.trim() || fileName;
}

/** Dockerfile paths referenced by the workflow (docker build -f "x/Dockerfile" …). */
function referencedDockerfiles(yaml: string): string[] {
  const out = new Set<string>();
  const re = /["']?((?:[\w.-]+\/)*Dockerfile(?:\.[\w.-]+)?)["']?/g;
  for (const m of yaml.matchAll(re)) out.add(m[1]!.replace(/^\.\//, ""));
  return Array.from(out);
}

export const importGithubWorkflowsTool: Tool<Input, Output> = {
  name: "import_github_workflows",
  description:
    "Clone/import the repo's EXISTING GitHub Actions workflows (.github/workflows/*.yml) into the project's " +
    "CI/CD → Pipelines tab, so the app can run them (workflow_dispatch), monitor them with the background " +
    "watcher, and auto-heal failures. Includes any Dockerfiles the workflow references so the review agent " +
    "may fix those too. Idempotent — re-importing refreshes the saved copies from the repo. Use when the " +
    "user asks to 'clone the GitHub Action into the app', 'import my existing pipeline', or when a repo " +
    "already has workflows the app didn't generate.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'The repo as "owner/name", attached to the project.' },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true, defaultBranch: true },
    });
    if (!repo) return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };

    const clientRes = await resolveRepoClient(repo.id);
    if (!clientRes.ok) return { ok: false, error: clientRes.message };
    const client = clientRes.client;
    const branch = repo.defaultBranch || client.defaultBranch || "main";

    const entries = await client.listFiles(".github/workflows", branch);
    const workflowFiles = entries.filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name));
    if (workflowFiles.length === 0) {
      return { ok: false, error: `No workflow files found under .github/workflows in ${input.repoFullName}.` };
    }

    const imported: ImportedRow[] = [];
    for (const wf of workflowFiles) {
      const wfPath = `.github/workflows/${wf.name}`;
      const yaml = await client.readFile(wfPath, branch);
      if (yaml === null) continue;

      const files: { path: string; content: string }[] = [{ path: wfPath, content: yaml }];
      for (const dfPath of referencedDockerfiles(yaml)) {
        const df = await client.readFile(dfPath, branch);
        if (df !== null) files.push({ path: dfPath, content: df });
      }

      const name = workflowName(yaml, wf.name);
      const dispatchable = /workflow_dispatch/.test(yaml);

      // Upsert by (project, repo, name) — same identity rule as the generated
      // pipelines, so an import over a generated pipeline of the same name
      // refreshes it instead of duplicating.
      const existing = await prisma.ciPipeline.findFirst({
        where: { projectId: ctx.projectId, repoId: repo.id, name },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const data = {
        files,
        workflowPath: wfPath,
        branch,
        status: "committed",
        agentReview: true,
      };
      if (existing) {
        await prisma.ciPipeline.update({ where: { id: existing.id }, data });
      } else {
        await prisma.ciPipeline.create({
          data: { projectId: ctx.projectId, repoId: repo.id, name, ...data },
        });
      }
      imported.push({
        name,
        workflowPath: wfPath,
        fileCount: files.length,
        dispatchable,
        updated: Boolean(existing),
      });
    }

    const nonDispatchable = imported.filter((i) => !i.dispatchable);
    return {
      ok: true,
      output: {
        imported,
        message:
          `Imported ${imported.length} workflow(s) from ${input.repoFullName} into the CI/CD tab — ` +
          `each with the background watcher + auto-heal enabled.` +
          (nonDispatchable.length
            ? ` Note: ${nonDispatchable.map((i) => i.name).join(", ")} lack a workflow_dispatch trigger, so the Run button can't fire them — they run on their own push/PR triggers.`
            : ""),
      },
    };
  },
};
