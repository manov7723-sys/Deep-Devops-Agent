/**
 * Agent reviewer / auto-heal. When a pipeline run fails and `agentReview` is on,
 * the agent reads the failed job's log, rewrites the workflow YAML to fix it,
 * re-commits to the default branch, and re-triggers the run. Bounded by
 * MAX_HEAL_ATTEMPTS so a persistently-broken pipeline can't loop forever (and
 * burn tokens).
 */
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { completeText } from "@/lib/agent/agent";
import {
  commitFiles,
  dispatchWorkflow,
  findRun,
  getFailedJobLog,
  workflowFileName,
} from "./github-actions";

export const MAX_HEAL_ATTEMPTS = 3;

type FileEntry = { path: string; content: string };

const SYSTEM =
  "You are a DevOps engineer fixing a failed CI/CD run. You are given the failed job log and the project's " +
  "DevOps files (Dockerfile, docker-compose, nginx config, Kubernetes manifests, GitHub Actions workflows). " +
  "Diagnose the failure from the log and fix it by editing ONLY those DevOps files.\n\n" +
  "HARD RULES:\n" +
  "- NEVER touch application source code. You are given ONLY DevOps files; only return fixes for those exact paths.\n" +
  "- Return ONLY the file(s) you actually changed, each complete, keeping its original intent.\n" +
  "- Fix the real cause shown in the log: wrong build-output dir (Create React App builds to build/, Vite to " +
  "dist/, Angular to dist/<name>), wrong COPY path, wrong action version, missing permission, bad image ref, YAML syntax.\n" +
  '- Respond with STRICT JSON and nothing else: {"files":[{"path":"<exact given path>","content":"<full corrected file>"}]}. ' +
  "No prose, no markdown fences.";

/**
 * Files the reviewer is allowed to touch — DevOps only, NEVER app source. This
 * is a belt-and-suspenders allowlist; the primary guarantee is that auto-heal
 * only ever edits paths already in the pipeline's saved file set (all DevOps).
 */
function isDevopsFile(path: string): boolean {
  const p = path.replace(/^\/+/, "");
  const base = p.split("/").pop() ?? p;
  return (
    /^Dockerfile(\..+)?$/i.test(base) ||
    base === ".dockerignore" ||
    /^(docker-)?compose\.ya?ml$/i.test(base) ||
    /\.conf$/i.test(base) ||
    /^\.github\/workflows\/.+\.ya?ml$/i.test(p) ||
    /^\.gitlab-ci\.ya?ml$/i.test(base) ||
    /^(namespace|deployment|service|ingress|configmap|secret|hpa|pvc|manifest|kustomization)\.ya?ml$/i.test(
      base,
    ) ||
    (/\.ya?ml$/i.test(base) &&
      /(^|\/)(k8s|manifests?|kubernetes|deploy|kustomize|helm|charts?)(\/|$)/i.test(p))
  );
}

/** Parse the reviewer's strict-JSON {files:[{path,content}]} response. */
function parseFixes(text: string): Record<string, string> {
  const cleaned = text
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  try {
    const j = JSON.parse(cleaned) as { files?: Array<{ path?: string; content?: string }> };
    const out: Record<string, string> = {};
    for (const f of j.files ?? [])
      if (f.path && typeof f.content === "string") out[f.path.replace(/^\/+/, "")] = f.content;
    return out;
  } catch {
    return {};
  }
}

export type HealResult =
  | { ok: true; healed: true; attempt: number; runId: string | null; runUrl: string | null }
  | { ok: true; healed: false; reason: string }
  | { ok: false; error: string };

/**
 * Attempt one auto-heal cycle for a failed pipeline. Caller should have already
 * confirmed the run failed. No-op (healed:false) when agentReview is off or the
 * attempt budget is spent.
 */
export async function autoHealPipeline(pipelineId: string): Promise<HealResult> {
  const p = await prisma.ciPipeline.findUnique({
    where: { id: pipelineId },
    select: {
      id: true,
      projectId: true,
      repoId: true,
      name: true,
      branch: true,
      files: true,
      workflowPath: true,
      agentReview: true,
      healAttempts: true,
      runId: true,
    },
  });
  if (!p) return { ok: false, error: "pipeline not found" };
  if (!p.agentReview) return { ok: true, healed: false, reason: "agent review off" };
  if (p.healAttempts >= MAX_HEAL_ATTEMPTS) {
    return { ok: true, healed: false, reason: `max ${MAX_HEAL_ATTEMPTS} heal attempts reached` };
  }
  if (!p.workflowPath) return { ok: true, healed: false, reason: "no workflow file to fix" };

  const repo = await prisma.repo.findUnique({
    where: { id: p.repoId },
    select: { fullName: true, defaultBranch: true },
  });
  if (!repo) return { ok: false, error: "repo missing" };
  const tok = await resolveTokenForRepo(p.repoId);
  if (!tok.ok) return { ok: false, error: tok.message };
  const gh = { token: tok.accessToken, repoFullName: repo.fullName };

  const files = (p.files as FileEntry[]) ?? [];
  // DevOps files the reviewer may edit — NEVER application source. Primary
  // guarantee: changes are applied ONLY to paths already in this set (all
  // DevOps), so a fix can't create or touch anything outside it.
  const editable = files.filter((f) => isDevopsFile(f.path));
  if (editable.length === 0) return { ok: true, healed: false, reason: "no DevOps files to fix" };

  // 1 — read the failure log.
  const log = (p.runId ? await getFailedJobLog(gh, p.runId) : null) ?? "(no job log available)";

  // 2 — hand the model the DevOps files + log; it returns only the changed ones.
  const filesBlock = editable.map((f) => `### FILE: ${f.path}\n${f.content}`).join("\n\n");
  const fix = await completeText({
    projectId: p.projectId,
    system: SYSTEM,
    prompt: `--- DevOps files ---\n${filesBlock}\n\n--- Failed job log (tail) ---\n${log.slice(-4000)}`,
    maxTokens: 4000,
  });
  if (!fix.ok) return { ok: false, error: `reviewer failed: ${fix.error}` };

  // 3 — apply returned fixes to EXISTING DevOps files only (ignore anything else).
  const editablePaths = new Set(editable.map((f) => f.path.replace(/^\/+/, "")));
  const byPath = new Map(files.map((f) => [f.path.replace(/^\/+/, ""), f.content] as const));
  const changed = Object.entries(parseFixes(fix.text)).filter(
    ([path, content]) =>
      editablePaths.has(path) &&
      content.trim() &&
      content.trim() !== (byPath.get(path) ?? "").trim(),
  );
  if (changed.length === 0)
    return { ok: true, healed: false, reason: "reviewer produced no change" };
  const changeMap = new Map(changed);
  const newFiles = files.map((f) => {
    const key = f.path.replace(/^\/+/, "");
    return changeMap.has(key) ? { ...f, content: changeMap.get(key)! } : f;
  });
  const attempt = p.healAttempts + 1;
  await prisma.ciPipeline.update({
    where: { id: p.id },
    data: { files: newFiles, healAttempts: attempt, status: "committing" },
  });

  // 4 — re-commit + re-trigger.
  const branch = repo.defaultBranch || p.branch || "main";
  const commitList = changed.map(([path, content]) => ({ path, content }));
  const commit = await commitFiles(
    gh,
    branch,
    commitList,
    `ci: auto-heal ${p.name} — fixed ${commitList.map((f) => f.path).join(", ")} (attempt ${attempt})`,
  );
  if (!commit.ok) {
    await prisma.ciPipeline.update({
      where: { id: p.id },
      data: { status: "error", lastError: commit.error },
    });
    return { ok: false, error: commit.error };
  }
  const wfName = workflowFileName(p.workflowPath);
  if (wfName) await dispatchWorkflow(gh, wfName, branch);

  let run = null;
  if (wfName) {
    for (let i = 0; i < 4 && !run; i++) {
      run = await findRun(gh, wfName, branch, commit.sha);
      if (!run) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await prisma.ciPipeline.update({
    where: { id: p.id },
    data: {
      status: "running",
      commitSha: commit.sha,
      runId: run ? String(run.id) : null,
      runUrl: run?.url ?? null,
      conclusion: null,
      stages: undefined,
    },
  });

  return {
    ok: true,
    healed: true,
    attempt,
    runId: run ? String(run.id) : null,
    runUrl: run?.url ?? null,
  };
}
