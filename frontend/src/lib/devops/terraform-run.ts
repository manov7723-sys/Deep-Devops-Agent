/**
 * Terraform run engine — the project's Terraform pipeline backbone.
 *
 * Mirrors the original DevOps-Agent backend's `tf_async`:
 *   1. Write a generated Terraform tree to a temp workdir.
 *   2. Inject an S3 remote-state backend (from the env's tfBackend* config).
 *   3. Resolve the env's AWS creds from Vault.
 *   4. Run `terraform init → plan → apply` via the runner, capturing per-stage
 *      logs + exit codes.
 *
 * State lives in an in-process Map keyed by run id, polled by the UI — exactly
 * like the old backend's in-memory `_jobs` dict. This is single-instance only
 * (fine for the local/dev runner host); move to a DB/queue when the runner is
 * extracted to its own service.
 */
import { mkdtemp, mkdir, writeFile, rm, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { runStage } from "@/lib/runner/exec";
import { getDecryptedCloudCreds } from "@/lib/runner/creds";

export type TfRunAction = "plan" | "apply";
export type TfStageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type TfRunStatus = "queued" | "running" | "succeeded" | "failed";

export type TfStage = {
  name: string;
  status: TfStageStatus;
  logs: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type TfRun = {
  id: string;
  projectId: string;
  envId: string;
  envKey: string;
  name: string;
  action: TfRunAction;
  status: TfRunStatus;
  stages: TfStage[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
};

export type StartTfRunArgs = {
  projectId: string;
  envId: string;
  envKey: string;
  cloudProviderId: string | null;
  name: string;
  action: TfRunAction;
  /** Generated Terraform files: relative path → file contents. */
  files: Record<string, string>;
  /** S3 remote-state backend (from the env). When absent, durable local state. */
  backend?: { bucket: string; region: string; table?: string } | null;
  /**
   * Stable logical stack id. The Terraform state is keyed by
   * (project, env, stack) — NOT by the run name — so re-running the same infra
   * reuses the same state and plans/applies stay consistent. Defaults to a hash
   * of the resource addresses in `files`.
   */
  stack?: string;
};

// In-process run store (single instance; mirrors old tf_async `_jobs`).
const RUNS = new Map<string, TfRun>();
// Keep memory bounded — only retain the most recent N runs.
const MAX_RUNS = 100;

// Extend PATH so Homebrew-installed terraform is found (matches old backend).
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const APPLY_TIMEOUT_MS = 25 * 60_000; // EKS applies can take ~15-20 min.
const PLAN_TIMEOUT_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 5 * 60_000;

export function getTerraformRun(id: string): TfRun | null {
  return RUNS.get(id) ?? null;
}

export function listTerraformRuns(envId: string, limit = 20): TfRun[] {
  return [...RUNS.values()]
    .filter((r) => r.envId === envId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/** Filesystem-safe token. */
function san(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "x";
}

/** Where durable local Terraform state lives when no S3 backend is configured. */
function stateRoot(): string {
  return process.env.DDA_TF_STATE_DIR?.trim() || join(homedir(), ".deepagent", "tfstate");
}

/**
 * A stable logical stack id for state keying. Prefers an explicit `stack`;
 * otherwise derives one from the sorted Terraform resource addresses in the
 * files, so the SAME infra always maps to the SAME state regardless of run name.
 */
function resolveStack(explicit: string | undefined, files: Record<string, string>): string {
  if (explicit && explicit.trim()) return san(explicit.trim()).slice(0, 80);
  const addrs: string[] = [];
  // Detect both top-level resources AND module blocks (EKS/VPC use modules).
  const reRes = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  const reMod = /module\s+"([^"]+)"/g;
  for (const c of Object.values(files)) {
    let m: RegExpExecArray | null;
    while ((m = reRes.exec(c))) addrs.push(`${m[1]}.${m[2]}`);
    while ((m = reMod.exec(c))) addrs.push(`module.${m[1]}`);
  }
  if (addrs.length === 0) return "default";
  const hash = createHash("sha256").update([...addrs].sort().join(",")).digest("hex").slice(0, 12);
  const hint = san(addrs.sort()[0].split(".")[0]); // e.g. "module" or "aws_s3_bucket"
  return `${hint}-${hash}`.slice(0, 80);
}

/**
 * Remove any `backend "..." { ... }` block the generator/agent emitted so the
 * ENGINE fully owns where state lives (deterministic). S3/local backend blocks
 * are flat (no nested braces), so a single-level match is sufficient.
 */
function stripBackendBlocks(content: string): string {
  return content.replace(/\bbackend\s+"[^"]+"\s*\{[^{}]*\}/g, "");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Copy persisted local state INTO the workdir before init (if any exists). */
async function restoreLocalState(dir: string, workdir: string): Promise<void> {
  for (const f of ["terraform.tfstate", "terraform.tfstate.backup"]) {
    if (await fileExists(join(dir, f))) await copyFile(join(dir, f), join(workdir, f)).catch(() => {});
  }
}

/** Persist the workdir's local state back to the durable dir (even on failure). */
async function persistLocalState(dir: string, workdir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const f of ["terraform.tfstate", "terraform.tfstate.backup"]) {
    if (await fileExists(join(workdir, f))) await copyFile(join(workdir, f), join(dir, f)).catch(() => {});
  }
}

/** S3 backend override written as a separate file so it can't collide with
 *  any `terraform {}` block the generator already emitted. */
function backendOverride(b: { bucket: string; region: string; table?: string }, key: string): string {
  return [
    "terraform {",
    '  backend "s3" {',
    `    bucket = "${b.bucket}"`,
    `    key    = "${key}/terraform.tfstate"`,
    `    region = "${b.region}"`,
    ...(b.table ? [`    dynamodb_table = "${b.table}"`] : []),
    "    encrypt = true",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Kick off a Terraform run. Returns the run id immediately; the init/plan/apply
 * stages execute in the background and update the run record as they progress.
 */
export function startTerraformRun(args: StartTfRunArgs): TfRun {
  const id = `tf_${randomId()}`;
  const stages: TfStage[] = [
    { name: "init", status: "pending", logs: "" },
    { name: "plan", status: "pending", logs: "" },
    { name: "apply", status: args.action === "apply" ? "pending" : "skipped", logs: "" },
  ];
  const run: TfRun = {
    id,
    projectId: args.projectId,
    envId: args.envId,
    envKey: args.envKey,
    name: args.name,
    action: args.action,
    status: "queued",
    stages,
    createdAt: nowIso(),
  };
  RUNS.set(id, run);
  evictOld();

  // Fire-and-forget; the worker mutates `run` in place.
  void execRun(run, args).catch((e) => {
    run.status = "failed";
    run.error = e instanceof Error ? e.message : String(e);
    run.finishedAt = nowIso();
  });

  return run;
}

/**
 * Pick the directory (relative to the workdir) that holds the root Terraform
 * config — the one with the most top-level `.tf` files. CRITICAL: Terraform only
 * reads `.tf` files in its CWD, not subdirectories. Generators may nest files
 * (e.g. the EKS generator emits `terraform/eks/<name>/*.tf`), so we must run
 * Terraform inside that directory or it sees an empty config.
 */
function pickTfDir(files: Record<string, string>): string {
  const counts: Record<string, number> = {};
  for (const f of Object.keys(files)) {
    if (!f.endsWith(".tf")) continue;
    const d = dirname(f);
    counts[d] = (counts[d] ?? 0) + 1;
  }
  let dir = ".";
  let best = -1;
  for (const [d, c] of Object.entries(counts)) {
    if (c > best || (c === best && d.length < dir.length)) {
      best = c;
      dir = d;
    }
  }
  return dir;
}

async function execRun(run: TfRun, args: StartTfRunArgs): Promise<void> {
  run.status = "running";

  // Resolve AWS creds from Vault (when a provider is linked).
  let credEnv: Record<string, string> = {};
  if (args.cloudProviderId) {
    const creds = await getDecryptedCloudCreds(args.cloudProviderId);
    if (!creds.ok) {
      failStage(run, "init", `Could not resolve cloud credentials: ${creds.message}`);
      run.status = "failed";
      run.error = creds.message;
      run.finishedAt = nowIso();
      return;
    }
    credEnv = creds.env;
  }

  const workdir = await mkdtemp(join(tmpdir(), "dda-tf-"));
  const childEnv: Record<string, string> = {
    ...credEnv,
    PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":"),
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    // Terraform downloads registry modules via `git clone`. Bypass the host's
    // global/system git config so a broken ~/.gitconfig or /etc/gitconfig on the
    // runner can't fail module downloads (e.g. a missing include path).
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  // Stable state identity: keyed by (project, env, stack), NOT the run name, so
  // re-running the same infra reuses the same state and stays consistent.
  const stack = resolveStack(args.stack, args.files);
  const usingS3 = !!args.backend?.bucket;
  const localStateDir = usingS3 ? null : join(stateRoot(), san(args.projectId), san(args.envKey), stack);
  let runCwd = workdir; // set to the real .tf dir once files are materialized

  try {
    // 1) Materialize the tree — stripping any backend block so the engine fully
    //    owns where state lives (deterministic, no agent-chosen backends).
    for (const [rel, content] of Object.entries(args.files)) {
      const abs = join(workdir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, stripBackendBlocks(content), "utf8");
    }

    // Terraform only reads its CWD — run it where the .tf files actually live
    // (generators may nest them, e.g. terraform/eks/<name>/).
    const tfRel = pickTfDir(args.files);
    runCwd = tfRel === "." ? workdir : join(workdir, tfRel);

    // 2) Configure state: S3 backend with a STABLE key, or durable local state.
    //    These MUST go in the same dir Terraform runs in.
    if (usingS3) {
      const stateKey = `${san(args.projectId)}/${san(args.envKey)}/${stack}`;
      await writeFile(join(runCwd, "backend_override.tf"), backendOverride(args.backend!, stateKey), "utf8");
    } else if (localStateDir) {
      await mkdir(localStateDir, { recursive: true });
      await restoreLocalState(localStateDir, runCwd);
    }

    // 3) init → plan → (apply)
    const ranInit = await runTfStage(run, "init", runCwd, childEnv, ["init", "-input=false", "-no-color"], INIT_TIMEOUT_MS);
    if (ranInit) {
      const ranPlan = await runTfStage(run, "plan", runCwd, childEnv, ["plan", "-input=false", "-no-color"], PLAN_TIMEOUT_MS);
      if (ranPlan && args.action === "apply") {
        await runTfStage(
          run,
          "apply",
          runCwd,
          childEnv,
          ["apply", "-auto-approve", "-input=false", "-no-color"],
          APPLY_TIMEOUT_MS,
        );
      }
    }
    if (run.status === "running") {
      run.status = run.stages.some((s) => s.status === "failed") ? "failed" : "succeeded";
    }
  } catch (e) {
    run.status = "failed";
    run.error = run.error ?? (e instanceof Error ? e.message : String(e));
  } finally {
    // Persist local state EVEN ON FAILURE — a partial apply may have created
    // real resources that Terraform must remember.
    if (localStateDir) await persistLocalState(localStateDir, runCwd).catch(() => {});
    run.finishedAt = nowIso();
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run one terraform subcommand as a stage. Returns true on exit 0. */
async function runTfStage(
  run: TfRun,
  name: string,
  cwd: string,
  env: Record<string, string>,
  tfArgs: string[],
  timeoutMs: number,
): Promise<boolean> {
  const stage = run.stages.find((s) => s.name === name);
  if (!stage) return false;
  stage.status = "running";
  stage.startedAt = nowIso();

  const res = await runStage({
    command: "terraform",
    args: tfArgs,
    cwd,
    env,
    timeoutMs,
    onLog: (chunk) => {
      stage.logs = capLogs(stage.logs + chunk);
    },
  });

  stage.exitCode = res.exitCode;
  stage.finishedAt = nowIso();
  if (res.exitCode === 0) {
    stage.status = "succeeded";
    return true;
  }

  // Friendlier message when the binary is missing (ENOENT → exit -1).
  const missingBinary =
    res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"));
  stage.logs = capLogs(
    stage.logs +
      (missingBinary
        ? "\n[exec] The `terraform` binary isn't on the server's PATH. Install Terraform on the runner host."
        : res.timedOut
          ? "\n[exec] terraform timed out."
          : `\n${res.stderr.slice(-2_000)}`),
  );
  stage.status = "failed";
  run.status = "failed";
  run.error = run.error ?? `terraform ${name} failed (exit ${res.exitCode}).`;
  return false;
}

function failStage(run: TfRun, name: string, msg: string): void {
  const stage = run.stages.find((s) => s.name === name);
  if (stage) {
    stage.status = "failed";
    stage.logs = capLogs(stage.logs + "\n" + msg);
    stage.finishedAt = nowIso();
  }
}

const MAX_STAGE_LOG = 32 * 1024;
function capLogs(s: string): string {
  return s.length <= MAX_STAGE_LOG ? s : s.slice(s.length - MAX_STAGE_LOG);
}

function evictOld(): void {
  if (RUNS.size <= MAX_RUNS) return;
  const sorted = [...RUNS.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const r of sorted.slice(0, RUNS.size - MAX_RUNS)) RUNS.delete(r.id);
}

// Date.now()/Math.random() are fine in app runtime (the workflow-script ban
// does not apply here). Kept in helpers so the rest reads cleanly.
function nowIso(): string {
  return new Date().toISOString();
}
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
