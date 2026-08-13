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
  readRepoFile,
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
  "- NEVER mask a failure: no `|| true`, no `continue-on-error`, no `set +e`, no removing a failing step. A green " +
  "run with a broken artifact is WORSE than a red run. If you cannot fix the real cause, return no fixes.\n" +
  "- Missing codegen is a classic real cause: '@prisma/client did not initialize' or 'Failed to collect page data' " +
  "in a Next.js build means the Dockerfile must run `npx prisma generate` AFTER `COPY . .` and BEFORE the build.\n" +
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

/**
 * Cut a diagnostic window around the FAILURE in a GitHub Actions job log.
 * Strategy: strip per-line timestamps, find the LAST `##[error]` marker, and
 * take generous context before it (the failing command's output leads up to
 * the marker) plus a little after. Falls back to the tail when no marker
 * exists. A raw tail is the wrong default — job logs end with a long
 * teardown section that buries the real error.
 */
function errorWindow(raw: string, before = 9_000, after = 1_200): string {
  const clean = raw
    .split("\n")
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""))
    .join("\n");
  const idx = clean.lastIndexOf("##[error]");
  if (idx === -1) return clean.slice(-(before + after));
  return clean.slice(Math.max(0, idx - before), idx + after);
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
  const branchForReads = repo.defaultBranch || p.branch || "main";

  // Augment the saved file set from the REPO: the workflow file itself + any
  // Dockerfiles it references. Pipeline rows don't always carry every file
  // the run actually uses — a real incident: a row saved only k8s manifests,
  // the run failed in `docker build`, and the reviewer was handed two
  // irrelevant YAMLs, shrugging "no change" while the broken Dockerfile sat
  // in the repo. Fetching from the repo makes the reviewer self-sufficient;
  // the DevOps-only allowlist still bounds what it may touch.
  const byPathAll = new Map(files.map((f) => [f.path.replace(/^\/+/, ""), f] as const));
  if (p.workflowPath && !byPathAll.has(p.workflowPath.replace(/^\/+/, ""))) {
    const wf = await readRepoFile(gh, p.workflowPath, branchForReads);
    if (wf !== null) {
      const entry = { path: p.workflowPath.replace(/^\/+/, ""), content: wf };
      files.push(entry);
      byPathAll.set(entry.path, entry);
    }
  }
  const wfContent = p.workflowPath
    ? (byPathAll.get(p.workflowPath.replace(/^\/+/, ""))?.content ?? "")
    : "";
  const dockerfileRefs = new Set<string>();
  for (const m of wfContent.matchAll(/["']?((?:[\w.-]+\/)*Dockerfile(?:\.[\w.-]+)?)["']?/g)) {
    dockerfileRefs.add(m[1]!.replace(/^\.\//, ""));
  }
  for (const ref of Array.from(dockerfileRefs).slice(0, 6)) {
    if (byPathAll.has(ref)) continue;
    const df = await readRepoFile(gh, ref, branchForReads);
    if (df !== null) {
      const entry = { path: ref, content: df };
      files.push(entry);
      byPathAll.set(ref, entry);
    }
  }

  // DevOps files the reviewer may edit — NEVER application source. Primary
  // guarantee: changes are applied ONLY to paths already in this set (all
  // DevOps), so a fix can't create or touch anything outside it.
  const editable = files.filter((f) => isDevopsFile(f.path));
  if (editable.length === 0) return { ok: true, healed: false, reason: "no DevOps files to fix" };

  // 1 — read the failure log and cut a window AROUND the error, not the raw
  // tail. GitHub job logs end with a multi-KB "Post job cleanup" teardown
  // (git config resets, orphan-process cleanup, node deprecation warnings) —
  // a plain tail-slice handed the reviewer nothing but that noise, so it
  // "produced no change" while the docker build error sat 6KB earlier.
  const rawLog = (p.runId ? await getFailedJobLog(gh, p.runId) : null) ?? "(no job log available)";
  const log = errorWindow(rawLog);

  // 1a — INFRASTRUCTURE fixers: failures no file edit can cure. The
  // unreachable-cluster class (KUBECONFIG_B64 pointing at a dead/foreign
  // cluster — kubectl times out on every call) is repaired by the same logic
  // the chat agent uses: reconnect the env's real cluster, rewrite the
  // secret, re-run the workflow. Wired here so a re-run needs NO chat.
  // Broad anchor on purpose: "Unable to connect to the server" covers the
  // i/o-timeout (dead IP), no-such-host (deleted cluster, DNS gone) and
  // connection-refused variants — all the same root cause and same repair.
  const clusterUnreachable =
    /Unable to connect to the server|no such host|couldn't get current server API group list/i.test(
      log,
    );
  if (clusterUnreachable) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: p.projectId },
        select: { ownerId: true },
      });
      // Env pick: the one wired to a cloud provider; else the only env.
      const envs = await prisma.env.findMany({
        where: { projectId: p.projectId },
        select: { key: true, cloudProviderId: true },
      });
      const env =
        envs.find((e) => e.cloudProviderId) ?? (envs.length === 1 ? envs[0] : undefined);
      if (!project || !env) {
        return {
          ok: true,
          healed: false,
          reason: "cluster unreachable — could not resolve which env to repair (link a cloud provider to an env)",
        };
      }
      const { repairCdKubeconfigTool } = await import("@/lib/agent/tools/repair-cd-kubeconfig");
      const wfName = workflowFileName(p.workflowPath) ?? undefined;
      const repair = await repairCdKubeconfigTool.execute(
        { repoFullName: repo.fullName, envKey: env.key, cdWorkflowFile: wfName },
        { projectId: p.projectId, userId: project.ownerId },
      );
      if (!repair.ok) {
        return { ok: true, healed: false, reason: `kubeconfig repair failed: ${repair.error}` };
      }
      if (repair.output.candidates?.length) {
        return {
          ok: true,
          healed: false,
          reason: `multiple clusters found (${repair.output.candidates.map((c) => c.name).join(", ")}) — pick one in chat`,
        };
      }
      const attempt = p.healAttempts + 1;
      const rerunId = repair.output.reran?.runId ? String(repair.output.reran.runId) : null;
      await prisma.ciPipeline.update({
        where: { id: p.id },
        data: {
          healAttempts: attempt,
          status: "running",
          conclusion: null,
          ...(rerunId ? { runId: rerunId } : {}),
        },
      });
      try {
        const { watchPipelineRun } = await import("./pipeline-watcher");
        watchPipelineRun(p.id, p.projectId);
      } catch {}
      return { ok: true, healed: true, attempt, runId: rerunId, runUrl: null };
    } catch (e) {
      return {
        ok: true,
        healed: false,
        reason: `kubeconfig repair errored: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
  }

  // 1b — DETERMINISTIC fixers before any LLM call. Known signatures with a
  // known-correct fix should never depend on model judgment (a real incident:
  // the reviewer "fixed" a Prisma failure with `npm run build || true`).
  //   • Missing `prisma generate`: the deps stage installs node_modules
  //     without the schema, so the client never generates and `next build`
  //     dies collecting page data. Insert the guarded generate before build.
  const prismaFailure =
    /@prisma\/client did not initialize|prisma generate|Failed to collect page data/i.test(log);
  if (prismaFailure) {
    for (const f of editable) {
      if (!/^(.*\/)?Dockerfile(\..+)?$/i.test(f.path)) continue;
      if (/prisma\s+generate/.test(f.content)) continue; // already fixed
      const lines = f.content.split("\n");
      const buildIdx = lines.findIndex((l) =>
        /^RUN\s+(npm|yarn|pnpm)(\s+run)?\s+build\b/.test(l.trim()),
      );
      if (buildIdx === -1) continue;
      lines.splice(
        buildIdx,
        0,
        "# Prisma: generate the client before build (added by DeepAgent auto-heal).",
        "RUN if [ -f prisma/schema.prisma ] || [ -f schema.prisma ]; then \\",
        "      npx --yes prisma generate; \\",
        "    fi",
      );
      const patched = lines.join("\n");
      const attempt = p.healAttempts + 1;
      const newFiles = files.map((x) => (x.path === f.path ? { ...x, content: patched } : x));
      await prisma.ciPipeline.update({
        where: { id: p.id },
        data: { files: newFiles, healAttempts: attempt, status: "committing" },
      });
      const branch = repo.defaultBranch || p.branch || "main";
      const commit = await commitFiles(
        gh,
        branch,
        [{ path: f.path, content: patched }],
        `ci: auto-heal ${p.name} — add prisma generate to ${f.path} (attempt ${attempt})`,
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
      try {
        const { watchPipelineRun } = await import("./pipeline-watcher");
        watchPipelineRun(p.id, p.projectId);
      } catch {}
      return {
        ok: true,
        healed: true,
        attempt,
        runId: run ? String(run.id) : null,
        runUrl: run?.url ?? null,
      };
    }
  }

  // 2 — hand the model the DevOps files + log; it returns only the changed ones.
  const filesBlock = editable.map((f) => `### FILE: ${f.path}\n${f.content}`).join("\n\n");
  const fix = await completeText({
    projectId: p.projectId,
    system: SYSTEM,
    prompt: `--- DevOps files ---\n${filesBlock}\n\n--- Failed job log (window around the error) ---\n${log}`,
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

  // Arm the background watcher on the freshly-dispatched run so the heal
  // loop CHAINS: if this attempt fails too, the next heal fires without
  // anyone polling a tab. Dynamic import breaks the module cycle
  // (pipeline-watcher imports auto-heal).
  try {
    const { watchPipelineRun } = await import("./pipeline-watcher");
    watchPipelineRun(p.id, p.projectId);
  } catch {
    // watcher is best-effort; the status-route polling path still exists
  }

  return {
    ok: true,
    healed: true,
    attempt,
    runId: run ? String(run.id) : null,
    runUrl: run?.url ?? null,
  };
}
