/**
 * scaffold_helm_chart — bootstrap Phase 2 chart files into a repo.
 *
 * Reads the DeepAgent-shipped scaffold under src/lib/scaffolds/helm-service/
 * and commits each file under the repo's `chart/` directory in one PR.
 * Idempotent: if Chart.yaml already exists at the target path the tool
 * reports "already_scaffolded" and exits without changes.
 *
 * Use this before run_helm_upgrade for repos that don't have a chart yet.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import type { Tool } from "./types";

type Input = {
  repoFullName: string;
  /** Target directory inside the repo. Defaults to "chart". */
  chartPath?: string;
  /** Container image repo (e.g. ghcr.io/org/api). Defaults to "ghcr.io/example/app". */
  imageRepository?: string;
  /** Container port the app listens on. Defaults to 3000. */
  targetPort?: number;
  /** Branch to commit on. Defaults to "deepagent/scaffold-helm". */
  branch?: string;
};

type Output = {
  fullName: string;
  chartPath: string;
  branch: string;
  filesCommitted: string[];
  pullRequest?: { number: number; url: string };
  alreadyScaffolded?: boolean;
};

const SCAFFOLD_DIR = "src/lib/scaffolds/helm-service";
const SCAFFOLD_FILES: Array<{ relPath: string }> = [
  { relPath: "Chart.yaml" },
  { relPath: "values.yaml" },
  { relPath: "templates/_helpers.tpl" },
  { relPath: "templates/deployment.yaml" },
  { relPath: "templates/service.yaml" },
  { relPath: "templates/serviceaccount.yaml" },
  { relPath: "templates/ingress.yaml" },
];

export const scaffoldHelmChartTool: Tool<Input, Output> = {
  name: "scaffold_helm_chart",
  description:
    "Bootstrap a Helm chart into a repo by committing DeepAgent's default service " +
    "templates (Chart.yaml, values.yaml, Deployment, Service, ServiceAccount, Ingress) " +
    "under <chartPath>/ and opening a PR. Idempotent: skips if the chart already " +
    "exists. Use this BEFORE run_helm_upgrade for first-time deploys.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: "owner/repo attached to this project." },
      chartPath: { type: "string", description: 'Directory inside the repo for the chart. Defaults to "chart".' },
      imageRepository: { type: "string", description: 'Sets the default image repository in values.yaml.' },
      targetPort: { type: "number", description: "Container port. Defaults to 3000." },
      branch: { type: "string", description: 'Branch to commit on. Defaults to "deepagent/scaffold-helm".' },
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
      select: { id: true, defaultBranch: true, fullName: true },
    });
    if (!repo) {
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };
    }
    const resolved = await resolveRepoClient(repo.id);
    if (!resolved.ok) return { ok: false, error: `Cannot access ${repo.fullName}: ${resolved.message}` };
    const client = resolved.client;

    const chartPath = (input.chartPath ?? "chart").replace(/^\/+|\/+$/g, "") || "chart";
    const branch = input.branch ?? "deepagent/scaffold-helm";

    // 1. Idempotency check — Chart.yaml already there?
    const existingChart = await client.readFile(`${chartPath}/Chart.yaml`, repo.defaultBranch).catch(() => null);
    if (existingChart != null) {
      return {
        ok: true,
        output: {
          fullName: repo.fullName,
          chartPath,
          branch: repo.defaultBranch,
          filesCommitted: [],
          alreadyScaffolded: true,
        },
      };
    }

    // 2. Ensure the branch exists (off the default branch).
    try {
      await client.ensureBranch(branch, repo.defaultBranch);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `Could not create branch ${branch}.` };
    }

    // 3. Read each scaffold file off disk, optionally rewriting a couple of
    // fields in values.yaml.
    const files: { path: string; content: string }[] = [];
    const cwd = process.cwd();
    for (const f of SCAFFOLD_FILES) {
      const localPath = join(cwd, SCAFFOLD_DIR, f.relPath);
      let content: string;
      try {
        content = await readFile(localPath, "utf8");
      } catch (err) {
        return {
          ok: false,
          error: `Server is missing scaffold file ${f.relPath}: ${err instanceof Error ? err.message : "unknown"}`,
        };
      }

      if (f.relPath === "values.yaml") {
        if (input.imageRepository) {
          content = content.replace(/repository:\s+ghcr\.io\/example\/app/, `repository: ${input.imageRepository}`);
        }
        if (input.targetPort != null) {
          content = content.replace(/targetPort:\s+3000/, `targetPort: ${input.targetPort}`);
        }
      }
      files.push({ path: `${chartPath}/${f.relPath}`, content });
    }

    // 4. Commit all chart files in a single commit (GitLab: one actions[] call;
    // GitHub: one git-data commit).
    try {
      await client.commitFiles({ branch, message: "chore(helm): scaffold default chart", files });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `Failed committing chart: ${err.message}` : "Commit failed." };
    }
    const filesCommitted = files.map((f) => f.path);

    // 5. Open the PR / MR.
    let pr: { number: number; url: string } | undefined;
    try {
      pr = await client.openChangeRequest({
        sourceBranch: branch,
        targetBranch: repo.defaultBranch,
        title: "chore(helm): scaffold default chart",
        body:
          `DeepAgent scaffolded a default Helm chart under \`${chartPath}/\`.\n\n` +
          `Merge this, then ask DeepAgent to "deploy <repo> to <env>" to roll it out.\n\n` +
          `Files added:\n${filesCommitted.map((f) => `- ${f}`).join("\n")}`,
      });
    } catch {
      // The commit landed — don't fail if the PR/MR can't open (e.g. one exists).
    }

    return {
      ok: true,
      output: {
        fullName: repo.fullName,
        chartPath,
        branch,
        filesCommitted,
        ...(pr && { pullRequest: pr }),
      },
    };
  },
};
