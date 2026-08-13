import { prisma } from "@/lib/db/prisma";
import { runCiPipeline } from "@/lib/ci/run-pipeline";
import type { Tool } from "./types";

type Input = {
  repoFullName: string;
  /** Pipeline name (or a substring of it) as shown in the CI/CD → Pipelines tab. Omit when the repo has exactly one pipeline. */
  name?: string;
};

type Output =
  | {
      matched: string;
      commitSha: string;
      runId: string | null;
      runUrl: string | null;
      /** Workflow file basename (e.g. "ci-frontend.yml") — pass to wait_for_workflow_run. */
      workflowFile: string | null;
      message: string;
    }
  | { needsDisambiguation: true; candidates: string[] };

/**
 * Chat-side equivalent of clicking "Run" on a pipeline in the CI/CD →
 * Pipelines tab. The generated CI workflows only trigger on workflow_dispatch
 * (never push) — by design, files can commit immediately while the actual
 * build/deploy stays gated behind an explicit trigger, from the UI OR chat.
 * Call this ONLY when the user explicitly asks to run/trigger/start a
 * pipeline that's already listed there (e.g. after deploy_my_app finished
 * committing files) — never as a substitute for the approval-gated deploy
 * flows, and never to "auto-run" a pipeline the user hasn't asked to start.
 */
export const runCiPipelineTool: Tool<Input, Output> = {
  name: "run_ci_pipeline",
  description:
    "Trigger a CI/CD pipeline that's already listed in the project's CI/CD → Pipelines tab (created by " +
    "deploy_my_app or save_pipeline_to_project). Commits any pending edits (no-op if unchanged) then fires " +
    "workflow_dispatch — the exact same action as the user clicking 'Run' in the UI. Use this ONLY when the " +
    "user explicitly asks to run/trigger/start the pipeline — generated workflows never auto-run on push.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: "owner/repo, attached to the project." },
      name: {
        type: "string",
        description: "Pipeline name or substring (e.g. the service name) to disambiguate when a repo has more than one pipeline.",
      },
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
      select: { id: true },
    });
    if (!repo) return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };

    const rows = await prisma.ciPipeline.findMany({
      where: { projectId: ctx.projectId, repoId: repo.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, workflowPath: true },
    });
    if (rows.length === 0) {
      return {
        ok: false,
        error: `No pipeline found for "${input.repoFullName}". Generate one first (deploy_my_app or save_pipeline_to_project).`,
      };
    }

    // Disambiguation is only meaningful across DISTINCT names. Historical
    // duplicate rows (same project+repo+name from repeated redeploys before
    // the upsert fix) would otherwise produce a candidates list of N
    // identical strings — an unanswerable question. Rows are newest-first,
    // so first-seen per name is the freshest copy.
    const distinct: typeof rows = [];
    const seenNames = new Set<string>();
    for (const r of rows) {
      const k = r.name.toLowerCase();
      if (seenNames.has(k)) continue;
      seenNames.add(k);
      distinct.push(r);
    }

    let match = distinct[0];
    if (input.name) {
      const needle = input.name.toLowerCase();
      const filtered = distinct.filter((r) => r.name.toLowerCase().includes(needle));
      if (filtered.length === 0) {
        return {
          ok: false,
          error: `No pipeline matching "${input.name}" — available: ${distinct.map((r) => r.name).join(", ")}.`,
        };
      }
      if (filtered.length > 1) {
        return { ok: true, output: { needsDisambiguation: true, candidates: filtered.map((r) => r.name) } };
      }
      match = filtered[0];
    } else if (distinct.length > 1) {
      return { ok: true, output: { needsDisambiguation: true, candidates: distinct.map((r) => r.name) } };
    }

    const result = await runCiPipeline(match.id, ctx.projectId);
    if (!result.ok) return { ok: false, error: `${result.code}: ${result.message}` };

    return {
      ok: true,
      output: {
        matched: match.name,
        commitSha: result.commitSha,
        runId: result.runId,
        runUrl: result.runUrl,
        // The REAL committed workflow file — watchers must use this (or the
        // runId) instead of guessing names like "build-and-push-<svc>.yml".
        workflowFile: match.workflowPath ? (match.workflowPath.split("/").pop() ?? null) : null,
        message: result.message,
      },
    };
  },
};
