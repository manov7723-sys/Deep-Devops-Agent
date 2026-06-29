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
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
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
    const tok = await resolveTokenForRepo(repo.id);
    if (!tok.ok) return { ok: false, error: `Cannot access ${repo.fullName}: ${tok.message}` };

    const chartPath = (input.chartPath ?? "chart").replace(/^\/+|\/+$/g, "") || "chart";
    const branch = input.branch ?? "deepagent/scaffold-helm";
    const headers = {
      Authorization: `Bearer ${tok.accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    // 1. Idempotency check — Chart.yaml already there?
    const chartCheckUrl = `https://api.github.com/repos/${repo.fullName}/contents/${chartPath}/Chart.yaml?ref=${encodeURIComponent(repo.defaultBranch)}`;
    const chartCheck = await fetch(chartCheckUrl, { headers, cache: "no-store" });
    if (chartCheck.ok) {
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

    // 2. Ensure the branch exists.
    const branchUrl = `https://api.github.com/repos/${repo.fullName}/git/refs/heads/${encodeURIComponent(branch)}`;
    const branchHead = await fetch(branchUrl, { headers, cache: "no-store" });
    if (!branchHead.ok) {
      const defHead = await fetch(
        `https://api.github.com/repos/${repo.fullName}/git/refs/heads/${encodeURIComponent(repo.defaultBranch)}`,
        { headers, cache: "no-store" },
      );
      if (!defHead.ok) {
        return { ok: false, error: `Could not read default branch HEAD: ${defHead.status}` };
      }
      const defRef = (await defHead.json()) as { object: { sha: string } };
      const create = await fetch(`https://api.github.com/repos/${repo.fullName}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: defRef.object.sha,
        }),
      });
      if (!create.ok) {
        const body = await create.text().catch(() => "");
        return { ok: false, error: `Could not create branch ${branch}: ${create.status} ${body.slice(0, 200)}` };
      }
    }

    // 3. Read each scaffold file off disk, optionally rewrite a couple of
    // fields in values.yaml, commit one PUT per file.
    const filesCommitted: string[] = [];
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

      const targetPath = `${chartPath}/${f.relPath}`;
      const put = await fetch(
        `https://api.github.com/repos/${repo.fullName}/contents/${encodeURIComponent(targetPath).replace(/%2F/g, "/")}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            message: `chore(helm): scaffold ${f.relPath}`,
            content: Buffer.from(content, "utf8").toString("base64"),
            branch,
          }),
        },
      );
      if (!put.ok) {
        const body = await put.text().catch(() => "");
        // 422 with "sha required" means the file exists on this branch
        // already — skip silently so reruns are safe.
        if (put.status === 422 && body.includes("sha")) continue;
        return {
          ok: false,
          error: `Failed committing ${targetPath}: ${put.status} ${body.slice(0, 200)}`,
        };
      }
      filesCommitted.push(targetPath);
    }

    // 4. Open the PR.
    let pr: { number: number; url: string } | undefined;
    const prRes = await fetch(`https://api.github.com/repos/${repo.fullName}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "chore(helm): scaffold default chart",
        head: branch,
        base: repo.defaultBranch,
        body:
          `DeepAgent scaffolded a default Helm chart under \`${chartPath}/\`.\n\n` +
          `Merge this PR, then ask DeepAgent to "deploy <repo> to <env>" to roll it out.\n\n` +
          `Files added:\n${filesCommitted.map((f) => `- ${f}`).join("\n")}`,
        maintainer_can_modify: true,
      }),
    });
    if (prRes.ok) {
      const j = (await prRes.json()) as { number: number; html_url: string };
      pr = { number: j.number, url: j.html_url };
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
