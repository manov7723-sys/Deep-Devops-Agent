/**
 * fix_ci_build_failure — the "review agent" for BUILD failures.
 *
 * The agent already self-heals infrastructure failures (bad kubeconfig, ACR
 * secrets, OIDC bindings) via dedicated repair tools, but build errors —
 * Dockerfile bugs, missing codegen steps, broken build scripts — previously
 * dead-ended with "needs a Dockerfile/app fix — report and stop". This tool
 * closes that gap:
 *
 *   1. Pull the latest FAILED run for the workflow + its failing job's log
 *   2. Try DETERMINISTIC fixers first (known signatures, no LLM):
 *        • "@prisma/client did not initialize" → insert `npx prisma generate`
 *          into the Dockerfile before the build step
 *   3. Fall back to an LLM review: log tail + the suspect files → a strict
 *      JSON fix proposal, committed ONLY at high confidence
 *   4. Commit the corrected file(s) straight to the deploy branch (the app's
 *      direct-commit convention — CI is workflow_dispatch-gated, so nothing
 *      builds from the commit alone)
 *   5. Return the diagnosis + an explicit `next` telling the agent to ASK THE
 *      USER to re-run the pipeline. The tool NEVER triggers a run itself.
 */
import { resolveRepoClient } from "@/lib/git";
import { resolveAttachedRepo } from "@/lib/automation/repo-analyze";
import { completeText } from "@/lib/agent/agent";
import type { Tool } from "./types";

const GH = "https://api.github.com";
const LOG_TAIL_BYTES = 12_000;
const MAX_FIX_FILES = 3;
const MAX_FIX_BYTES = 128 * 1024;

type Input = {
  /** Full repo name like "alice/api". Must be attached to the project. */
  repoFullName: string;
  /** Workflow file basename to inspect, e.g. "ci.yml" or "build-and-push-frontend.yml". */
  workflowFile?: string;
  /** Branch whose latest run to inspect. Defaults to the repo's default branch. */
  branch?: string;
};

type Output = {
  diagnosis: string;
  fixedBy: "deterministic" | "llm" | "none";
  committed: { path: string }[];
  commitSha: string | null;
  runUrl: string | null;
  /** What the agent should do next — surfaced verbatim in its reply. */
  next: string;
};

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Strip GitHub's per-line timestamps so the log reads clean for the LLM. */
function cleanLog(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""))
    .join("\n");
}

/**
 * Deterministic fixer: missing `prisma generate` in a Dockerfile. The single
 * most common Node build failure — deps install in a stage without the
 * schema, so the client never generates, and `next build` dies collecting
 * page data. Returns the patched content or null when not applicable.
 */
function fixMissingPrismaGenerate(dockerfile: string): string | null {
  if (/prisma\s+generate/.test(dockerfile)) return null; // already there
  const lines = dockerfile.split("\n");
  // Insert before the first build RUN (npm/yarn/pnpm run build) — after
  // COPY . . the schema is present, so generate succeeds.
  const buildIdx = lines.findIndex((l) =>
    /^RUN\s+(npm|yarn|pnpm)(\s+run)?\s+build\b/.test(l.trim()),
  );
  if (buildIdx === -1) return null;
  lines.splice(
    buildIdx,
    0,
    "# Prisma: generate the client before build (added by DeepAgent CI-fix).",
    "RUN if [ -f prisma/schema.prisma ] || [ -f schema.prisma ]; then \\",
    "      npx --yes prisma generate; \\",
    "    fi",
  );
  return lines.join("\n");
}

export const fixCiBuildFailureTool: Tool<Input, Output> = {
  name: "fix_ci_build_failure",
  description:
    "Review agent for CI BUILD failures (docker build errors, missing codegen like `prisma generate`, broken " +
    "build scripts). Finds the MOST RECENT FAILED run on the branch (looks past newer skipped/cancelled runs " +
    "— a skipped CD run after a failed CI is normal and does NOT mean there is nothing to fix), reads its " +
    "log, diagnoses the root cause, COMMITS the corrected file(s) to the repo, and returns instructions to " +
    "ask the user to re-run the pipeline. Use when a pipeline failed for a reason that is NOT one of the " +
    "infrastructure failureKinds (those have dedicated repair tools). Never triggers a workflow run itself — " +
    "always relay the `next` message so the USER decides when to re-run.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'The repo as "owner/name", attached to the project.' },
      workflowFile: {
        type: "string",
        description: 'Workflow file basename that failed, e.g. "ci.yml". Omit to use the latest run of any workflow.',
      },
      branch: { type: "string", description: "Branch of the failed run. Defaults to the repo default branch." },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const resolved = await resolveAttachedRepo(ctx.projectId, input.repoFullName);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const token = resolved.repo.accessToken;
    const branch = input.branch || resolved.repo.ref;
    const fullName = resolved.repo.fullName;

    // ── 1 · most recent FAILED run ─────────────────────────────────────────
    // NOT just the latest run: the CD workflow fires via `workflow_run` after
    // CI completes, and when CI fails, that CD run still appears — concluding
    // "skipped" — as the NEWEST run. Requiring failure on run[0] made the tool
    // answer "latest run was skipped, nothing to fix" while the real failed CI
    // run sat one position behind it. Hunt back through recent runs instead.
    const runsPath = input.workflowFile
      ? `/repos/${fullName}/actions/workflows/${encodeURIComponent(input.workflowFile)}/runs`
      : `/repos/${fullName}/actions/runs`;
    const runsRes = await fetch(`${GH}${runsPath}?per_page=15&branch=${encodeURIComponent(branch)}`, {
      headers: ghHeaders(token),
      cache: "no-store",
    });
    if (!runsRes.ok) {
      return { ok: false, error: `Couldn't list workflow runs (HTTP ${runsRes.status}).` };
    }
    const runsJson = (await runsRes.json().catch(() => ({}))) as {
      workflow_runs?: Array<{
        id: number;
        name?: string;
        conclusion: string | null;
        html_url?: string;
        path?: string;
      }>;
    };
    const runs = runsJson.workflow_runs ?? [];
    if (runs.length === 0) return { ok: false, error: "No workflow runs found for that workflow/branch." };
    // Any still-running run means a retry may already be in flight — say so
    // rather than reviewing a stale failure underneath it.
    const inFlight = runs.find((r) => r.conclusion === null);
    const run = runs.find((r) => r.conclusion === "failure");
    if (!run) {
      const summary = runs
        .slice(0, 5)
        .map((r) => `${r.name ?? r.path ?? "run"}: ${r.conclusion ?? "in progress"}`)
        .join("; ");
      return {
        ok: false,
        error: `No failed run in the last ${runs.length} runs on "${branch}" (${summary}). Nothing to fix.`,
      };
    }
    if (inFlight) {
      return {
        ok: false,
        error: `A run is currently in progress (${inFlight.name ?? "workflow"}) — wait for it to finish before reviewing the older failure (it may already contain a fix).`,
      };
    }
    const runUrl = run.html_url ?? null;
    // The workflow's own path in-repo (".github/workflows/ci.yml") — a fix
    // candidate itself (bad workflow YAML is a build failure too).
    const workflowPath = run.path ?? (input.workflowFile ? `.github/workflows/${input.workflowFile}` : null);

    // ── 2 · failing job's log tail ─────────────────────────────────────────
    const jobsRes = await fetch(`${GH}/repos/${fullName}/actions/runs/${run.id}/jobs?per_page=20`, {
      headers: ghHeaders(token),
      cache: "no-store",
    });
    if (!jobsRes.ok) return { ok: false, error: `Couldn't list the run's jobs (HTTP ${jobsRes.status}).` };
    const jobsJson = (await jobsRes.json().catch(() => ({}))) as {
      jobs?: Array<{ id: number; name?: string; conclusion?: string | null }>;
    };
    const failedJob = (jobsJson.jobs ?? []).find((j) => j.conclusion === "failure");
    if (!failedJob) return { ok: false, error: "The run failed but no failed job was found (cancelled?)." };
    const logRes = await fetch(`${GH}/repos/${fullName}/actions/jobs/${failedJob.id}/logs`, {
      headers: ghHeaders(token),
      cache: "no-store",
      redirect: "follow",
    });
    const rawLog = logRes.ok ? await logRes.text().catch(() => "") : "";
    // Window around the LAST ##[error] marker, not the raw tail — job logs
    // end with a multi-KB teardown section that can push the real failure
    // out of a tail slice.
    const cleaned = cleanLog(rawLog);
    const errIdx = cleaned.lastIndexOf("##[error]");
    const logTail =
      errIdx === -1
        ? cleaned.slice(-LOG_TAIL_BYTES)
        : cleaned.slice(Math.max(0, errIdx - LOG_TAIL_BYTES + 2_000), errIdx + 2_000);
    if (!logTail.trim()) return { ok: false, error: "Couldn't fetch the failed job's log." };

    // Repo client for reads + the eventual commit.
    const clientRes = await resolveRepoClient(resolved.repo.id);
    if (!clientRes.ok) return { ok: false, error: clientRes.message };
    const client = clientRes.client;

    // Candidate files the fix may touch. Dockerfile path: prefer one named in
    // the log ("./frontend/Dockerfile"), else probe common spots.
    const dockerfileFromLog = /(?:^|\s|\.\/)((?:[\w.-]+\/)*Dockerfile)\b/m.exec(logTail)?.[1] ?? null;
    const dockerfileCandidates = Array.from(
      new Set([dockerfileFromLog, "Dockerfile", "frontend/Dockerfile", "backend/Dockerfile"].filter(Boolean)),
    ) as string[];
    let dockerfilePath: string | null = null;
    let dockerfileContent: string | null = null;
    for (const p of dockerfileCandidates) {
      const c = await client.readFile(p, branch);
      if (c !== null) {
        dockerfilePath = p;
        dockerfileContent = c;
        break;
      }
    }

    const nextMsg =
      "Fix committed. Ask the user to re-run the pipeline (Run button on the CI/CD → Pipelines tab), or offer " +
      "to trigger it for them via run_ci_pipeline. Do NOT trigger it without their say-so.";

    // ── 3 · deterministic fixers ───────────────────────────────────────────
    if (/@prisma\/client did not initialize/i.test(logTail) && dockerfilePath && dockerfileContent) {
      const patched = fixMissingPrismaGenerate(dockerfileContent);
      if (patched) {
        const commit = await client.commitFiles({
          branch,
          message: `fix(ci): run prisma generate in ${dockerfilePath} before build`,
          files: [{ path: dockerfilePath, content: patched }],
        });
        return {
          ok: true,
          output: {
            diagnosis:
              "Docker build failed with `@prisma/client did not initialize` — the deps stage installs " +
              "node_modules without the Prisma schema, so the client is never generated. Added a guarded " +
              `\`npx prisma generate\` step to ${dockerfilePath} before the build.`,
            fixedBy: "deterministic",
            committed: [{ path: dockerfilePath }],
            commitSha: commit.commitSha,
            runUrl,
            next: nextMsg,
          },
        };
      }
    }

    // ── 4 · LLM review fallback ────────────────────────────────────────────
    const files: { path: string; content: string }[] = [];
    if (dockerfilePath && dockerfileContent) files.push({ path: dockerfilePath, content: dockerfileContent });
    if (workflowPath) {
      const wf = await client.readFile(workflowPath, branch);
      if (wf !== null) files.push({ path: workflowPath, content: wf });
    }
    const pkg = await client.readFile(
      dockerfilePath && dockerfilePath.includes("/")
        ? `${dockerfilePath.slice(0, dockerfilePath.lastIndexOf("/"))}/package.json`
        : "package.json",
      branch,
    );
    if (pkg !== null)
      files.push({
        path: "package.json",
        content: pkg.length > 6_000 ? pkg.slice(0, 6_000) : pkg,
      });
    if (files.length === 0) {
      return { ok: false, error: "Couldn't read any candidate files (Dockerfile / workflow) from the repo." };
    }

    const review = await completeText({
      projectId: ctx.projectId,
      system:
        "You are a CI build-failure repair bot. You receive a failed GitHub Actions job log tail and the " +
        "likely-culprit files. Diagnose the ROOT CAUSE and, if you can fix it by rewriting one of the " +
        "PROVIDED files, output the complete corrected file. Reply with STRICT JSON only, no fences:\n" +
        '{"diagnosis": "<one paragraph>", "confidence": "high"|"low", "fixes": [{"path": "<one of the provided paths>", "content": "<full corrected file>"}]}\n' +
        "Rules: fixes may ONLY name provided paths; content is the WHOLE file, not a diff; empty fixes [] when " +
        "the cause is outside these files (app source bug, quota, credentials) or you are not confident. " +
        'Only use confidence "high" when the log unambiguously points at the fix.',
      prompt:
        `## Failed job log (tail)\n\`\`\`\n${logTail}\n\`\`\`\n\n` +
        files.map((f) => `## File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n"),
      maxTokens: 4_000,
    });
    if (!review.ok) return { ok: false, error: `LLM review unavailable: ${review.error}` };

    let parsed: { diagnosis?: string; confidence?: string; fixes?: { path?: string; content?: string }[] };
    try {
      parsed = JSON.parse(review.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
    } catch {
      return { ok: false, error: "The review model returned unparseable output — report the raw failure instead." };
    }
    const diagnosis = (parsed.diagnosis ?? "").trim() || "No diagnosis produced.";
    const allowedPaths = new Set(files.map((f) => f.path));
    const fixes = (parsed.fixes ?? [])
      .filter(
        (f): f is { path: string; content: string } =>
          typeof f.path === "string" &&
          allowedPaths.has(f.path) &&
          typeof f.content === "string" &&
          f.content.trim().length > 0 &&
          Buffer.byteLength(f.content, "utf8") <= MAX_FIX_BYTES,
      )
      .slice(0, MAX_FIX_FILES);

    if (parsed.confidence !== "high" || fixes.length === 0) {
      return {
        ok: true,
        output: {
          diagnosis,
          fixedBy: "none",
          committed: [],
          commitSha: null,
          runUrl,
          next:
            "No auto-fix was committed (cause is outside the build files or confidence was low). Report the " +
            "diagnosis to the user with the run link and suggest the concrete manual fix.",
        },
      };
    }

    const commit = await client.commitFiles({
      branch,
      message: `fix(ci): ${diagnosis.slice(0, 60).replace(/\n/g, " ")}`,
      files: fixes.map((f) => ({ path: f.path, content: f.content })),
    });
    return {
      ok: true,
      output: {
        diagnosis,
        fixedBy: "llm",
        committed: fixes.map((f) => ({ path: f.path })),
        commitSha: commit.commitSha,
        runUrl,
        next: nextMsg,
      },
    };
  },
};
