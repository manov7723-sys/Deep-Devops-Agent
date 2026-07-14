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
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

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

/**
 * Remote-state backend for the run. Tagged by cloud so the override file we
 * inject picks the right Terraform backend block. When absent the engine
 * falls back to durable local state under stateRoot().
 *   • s3       → AWS backend (S3 bucket + optional DynamoDB lock table)
 *   • gcs      → GCP backend (GCS bucket, locks via object generation)
 *   • azurerm  → Azure backend (blob container, locks via blob leases)
 */
export type TfBackendCfg =
  | { kind: "s3"; bucket: string; region: string; table?: string }
  | { kind: "gcs"; bucket: string }
  | { kind: "azurerm"; resourceGroup: string; storageAccount: string; container: string };

export type StartTfRunArgs = {
  projectId: string;
  envId: string;
  envKey: string;
  cloudProviderId: string | null;
  name: string;
  action: TfRunAction;
  /** Generated Terraform files: relative path → file contents. */
  files: Record<string, string>;
  /** Remote-state backend (from the env). When absent, durable local state. */
  backend?: TfBackendCfg | null;
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

/**
 * Side-table of the source spec for each in-memory TfRun: the files, stack,
 * backend and cloudProviderId that produced it. Kept off the TfRun the client
 * sees so run listings stay small. Consumed by rerunTerraformRun() to replay
 * a run without the caller having to re-supply anything. Evicted in sync
 * with RUNS via evictOld().
 */
type RunSource = {
  files: Record<string, string>;
  stack?: string;
  backend: TfBackendCfg | null;
  cloudProviderId: string | null;
};
const RUN_SOURCES = new Map<string, RunSource>();

// Extend PATH so Homebrew-installed terraform is found (matches old backend).
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
// Regional K8s cluster creates legitimately take 20-30 min (control plane
// across zones, ILB, metadata service). GKE + node pools can push 30-35 min;
// AKS with private cluster + monitoring similar. 60 min gives comfortable
// headroom without hiding a genuinely stuck run for too long.
const APPLY_TIMEOUT_MS = 60 * 60_000;
const PLAN_TIMEOUT_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 5 * 60_000;

export function getTerraformRun(id: string): TfRun | null {
  return RUNS.get(id) ?? null;
}

/**
 * Fetch a run from the DB when it isn't (or is no longer) in the in-memory
 * ring. Used by Rerun after a process restart, and by getTerraformRunAsync
 * below. Returns null when the row doesn't exist.
 */
async function getTerraformRunFromDb(id: string): Promise<TfRun | null> {
  const row = await prisma.tfRun.findUnique({ where: { id } }).catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    envId: row.envId,
    envKey: row.envKey,
    name: row.name,
    action: row.action as TfRunAction,
    status: row.status as TfRunStatus,
    stages: (row.stages as unknown as TfStage[]) ?? [],
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    error: row.errorMessage ?? undefined,
  };
}

/** Prefer memory (live logs), fall back to DB for older or post-restart runs. */
export async function getTerraformRunAsync(id: string): Promise<TfRun | null> {
  return RUNS.get(id) ?? (await getTerraformRunFromDb(id));
}

export function listTerraformRuns(envId: string, limit = 20): TfRun[] {
  return [...RUNS.values()]
    .filter((r) => r.envId === envId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * DB-backed list for the pipeline UI. Merges the in-memory ring (fresh live
 * logs for currently-running rows) with older/post-restart rows from the DB,
 * dedupes by id preferring the in-memory copy, and returns newest-first.
 */
export async function listTerraformRunsAsync(envId: string, limit = 20): Promise<TfRun[]> {
  const dbRows = await prisma.tfRun
    .findMany({
      where: { envId },
      orderBy: { createdAt: "desc" },
      take: limit,
    })
    .catch(() => []);
  const dbRuns: TfRun[] = dbRows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    envId: row.envId,
    envKey: row.envKey,
    name: row.name,
    action: row.action as TfRunAction,
    status: row.status as TfRunStatus,
    stages: (row.stages as unknown as TfStage[]) ?? [],
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    error: row.errorMessage ?? undefined,
  }));
  const memRuns = [...RUNS.values()].filter((r) => r.envId === envId);
  const byId = new Map<string, TfRun>();
  for (const r of dbRuns) byId.set(r.id, r);
  for (const r of memRuns) byId.set(r.id, r); // in-memory wins (fresher logs)
  return [...byId.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * Idempotent upsert of a live TfRun into the DB. Called at every state
 * transition (create, stage boundary, finish, error) — NOT on every log-line
 * append (that would burn tens of writes per second on a busy plan). The
 * in-memory copy carries fresh log tails; the DB copy is the durable trail.
 * Fire-and-forget: a DB hiccup mid-run must never take down the runner.
 */
function persistTfRun(run: TfRun, source: RunSource): void {
  void prisma.tfRun
    .upsert({
      where: { id: run.id },
      create: {
        id: run.id,
        projectId: run.projectId,
        envId: run.envId,
        envKey: run.envKey,
        cloudProviderId: source.cloudProviderId,
        name: run.name,
        action: run.action,
        status: run.status,
        stages: run.stages as unknown as Prisma.InputJsonValue,
        sourceFiles: source.files as unknown as Prisma.InputJsonValue,
        sourceStack: source.stack ?? null,
        sourceBackend: (source.backend ?? null) as unknown as Prisma.InputJsonValue,
        errorMessage: run.error ?? null,
        createdAt: new Date(run.createdAt),
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
      },
      update: {
        status: run.status,
        stages: run.stages as unknown as Prisma.InputJsonValue,
        errorMessage: run.error ?? null,
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
      },
    })
    .catch(() => {
      // Silence transient DB errors — the run keeps executing regardless.
    });
}

/**
 * Replay a run — same files, same stack, same action. Useful after a transient
 * failure (auth misconfig, provider outage) or when Terraform state has drifted
 * and you just want to hit init → plan → apply again with the same inputs.
 *
 * Returns null when the run isn't found OR its source spec was evicted (a run
 * older than MAX_RUNS in the ring can't be replayed — the file map is gone).
 * Callers should relay that plainly rather than silently starting a new run.
 */
export type RerunOptions = {
  /** Override the run's original action. Default: reuse the same one. */
  action?: TfRunAction;
  /** Override the display name. Default: derive from the source run. */
  name?: string;
};
export async function rerunTerraformRun(runId: string, opts: RerunOptions = {}): Promise<TfRun | null> {
  // First try in-memory (fresh, has the exact source spec). If the run was
  // evicted or the server restarted, fall back to the DB row — sourceFiles +
  // sourceBackend + sourceStack + cloudProviderId are all persisted there.
  let source = RUN_SOURCES.get(runId) ?? null;
  let original = RUNS.get(runId) ?? null;
  if (!source || !original) {
    const row = await prisma.tfRun.findUnique({ where: { id: runId } }).catch(() => null);
    if (!row) return null;
    source = source ?? {
      files: (row.sourceFiles as unknown as Record<string, string>) ?? {},
      stack: row.sourceStack ?? undefined,
      backend: (row.sourceBackend as unknown as TfBackendCfg | null) ?? null,
      cloudProviderId: row.cloudProviderId,
    };
    original = original ?? {
      id: row.id,
      projectId: row.projectId,
      envId: row.envId,
      envKey: row.envKey,
      name: row.name,
      action: row.action as TfRunAction,
      status: row.status as TfRunStatus,
      stages: (row.stages as unknown as TfStage[]) ?? [],
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString(),
      error: row.errorMessage ?? undefined,
    };
  }
  const action = opts.action ?? original.action;
  const baseName = opts.name ?? original.name.replace(/-rerun-\d+$/, "");
  const rerunCount = 1 + [...RUNS.values()].filter((r) => r.name.startsWith(`${baseName}-rerun-`)).length;
  return startTerraformRun({
    projectId: original.projectId,
    envId: original.envId,
    envKey: original.envKey,
    cloudProviderId: source.cloudProviderId,
    name: `${baseName}-rerun-${rerunCount}`,
    action,
    files: source.files,
    backend: source.backend,
    stack: source.stack,
  });
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

/** Backend override written as a separate file so it can't collide with any
 *  `terraform {}` block the generator already emitted. Emits the right HCL
 *  block for the backend's kind (s3 / gcs / azurerm). */
function backendOverride(b: TfBackendCfg, key: string): string {
  if (b.kind === "gcs") {
    return [
      "terraform {",
      '  backend "gcs" {',
      `    bucket = "${b.bucket}"`,
      `    prefix = "${key}"`,
      "  }",
      "}",
      "",
    ].join("\n");
  }
  if (b.kind === "azurerm") {
    return [
      "terraform {",
      '  backend "azurerm" {',
      `    resource_group_name  = "${b.resourceGroup}"`,
      `    storage_account_name = "${b.storageAccount}"`,
      `    container_name       = "${b.container}"`,
      `    key                  = "${key}/terraform.tfstate"`,
      "  }",
      "}",
      "",
    ].join("\n");
  }
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
  // Retain the source spec on a side-table so rerunTerraformRun() can replay
  // this exact run. Not exposed on the TfRun the client sees — files may hold
  // (non-secret) HCL, but they're not something the run-list view needs. Evicted
  // together with the TfRun via evictOld() below.
  const source: RunSource = {
    files: args.files,
    stack: args.stack,
    backend: args.backend ?? null,
    cloudProviderId: args.cloudProviderId,
  };
  RUN_SOURCES.set(id, source);
  evictOld();
  // Durable copy in Postgres so this run survives dev-server restarts and HMR.
  persistTfRun(run, source);

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

/** Snapshot the current run to Postgres. Silent on error — the run keeps going. */
function syncRun(run: TfRun): void {
  const source = RUN_SOURCES.get(run.id);
  if (source) persistTfRun(run, source);
}

async function execRun(run: TfRun, args: StartTfRunArgs): Promise<void> {
  run.status = "running";
  syncRun(run);

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
  const usingRemote = !!args.backend;
  const localStateDir = usingRemote ? null : join(stateRoot(), san(args.projectId), san(args.envKey), stack);
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

    // 2) Configure state: remote backend (s3/gcs/azurerm) with a STABLE key,
    //    or durable local state. Override file MUST go in the same dir
    //    Terraform runs in.
    if (usingRemote) {
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
        const applied = await runTfStage(
          run,
          "apply",
          runCwd,
          childEnv,
          ["apply", "-auto-approve", "-input=false", "-no-color"],
          APPLY_TIMEOUT_MS,
        );
        // Auto-heal: if apply failed only on "already exists" for resources we
        // know how to import (partial-apply leftovers in AWS but not in state),
        // import them and retry apply ONCE. If any orphan is of an unknown type,
        // don't half-import — leave the failure so the user can see it.
        if (!applied) await maybeAutoImportAndRetry(run, runCwd, childEnv);
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
    // Final durable snapshot — this is the row future page loads will render.
    syncRun(run);
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
  syncRun(run); // stage entered running

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
    syncRun(run); // stage completed successfully
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
  syncRun(run); // stage failed
  return false;
}

type OrphanSpec = { address: string; type: string; id: string };

/**
 * Scan an `apply` stage's captured logs for "AlreadyExists"-style errors on
 * resource types we know how to `terraform import`. Returns:
 *   - `null` if apply failed for reasons that aren't recoverable by import
 *     (unknown resource type, non-AlreadyExists errors) — do NOT auto-import.
 *   - `[]` if the log has no error blocks at all — nothing to do.
 *   - a non-empty list of orphans, each with a real cloud id, ready to import.
 * The rule is all-or-nothing: any unrecognised error block forces `null`, so we
 * never half-import a partial failure.
 */
function detectOrphans(logs: string): OrphanSpec[] | null {
  // Isolate each "Error: ..." block. Blocks are separated by blank lines and
  // followed by another Error / a warning / end of stream.
  const blocks: string[] = [];
  const re = /Error:[\s\S]*?(?=\n\nError:|\n\nWarning:|\n\nTerraform |$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(logs))) blocks.push(m[0]);
  if (blocks.length === 0) return [];

  const seen = new Set<string>();
  const specs: OrphanSpec[] = [];
  for (const block of blocks) {
    if (!/(AlreadyExists|EntityAlreadyExists|ResourceAlreadyExistsException|BucketAlreadyExists|BucketAlreadyOwnedByYou)/i.test(block)) {
      return null;
    }
    const addr = block.match(/with\s+([^,\n]+),/)?.[1]?.trim();
    const type = block.match(/in resource\s+"([^"]+)"/)?.[1];
    if (!addr || !type) return null;

    let id: string | null = null;
    if (type === "aws_kms_alias") {
      id = block.match(/\balias\/[A-Za-z0-9/_.-]+/)?.[0] ?? null;
    } else if (type === "aws_cloudwatch_log_group") {
      id = block.match(/Log Group \(([^)]+)\)/)?.[1] ?? null;
    } else if (type === "aws_iam_role") {
      id = block.match(/Role with name ([A-Za-z0-9+=,.@_-]+)/)?.[1]
        ?? block.match(/iam[/ ]role[/ ]([A-Za-z0-9+=,.@_-]+)/i)?.[1]
        ?? null;
    } else if (type === "aws_iam_openid_connect_provider") {
      id = block.match(/arn:aws:iam::[^"\s]+:oidc-provider\/[^"\s]+/)?.[0] ?? null;
    } else if (type === "aws_iam_instance_profile") {
      id = block.match(/Instance Profile ([A-Za-z0-9+=,.@_-]+)/)?.[1] ?? null;
    } else if (type === "aws_s3_bucket") {
      id = block.match(/BucketName:\s*([A-Za-z0-9.-]+)/)?.[1]
        ?? block.match(/bucket \(([^)]+)\) already exists/)?.[1]
        ?? null;
    } else {
      return null;
    }
    if (!id) return null;

    const key = `${addr}=>${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push({ address: addr, type, id });
  }
  return specs;
}

/**
 * Run `terraform import` for each orphan and re-run `apply` once. Appends each
 * step's output to the existing `apply` stage log so the user can see exactly
 * what was imported. Bounded to a single retry — no import loops.
 */
async function maybeAutoImportAndRetry(
  run: TfRun,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const applyStage = run.stages.find((s) => s.name === "apply");
  if (!applyStage) return;
  const orphans = detectOrphans(applyStage.logs);
  if (orphans === null) return;
  if (orphans.length === 0) return;

  applyStage.logs = capLogs(
    applyStage.logs +
      `\n\n[auto-heal] Detected ${orphans.length} resource(s) that already exist in AWS but aren't in the Terraform state. Importing and retrying apply:\n` +
      orphans.map((o) => `  - ${o.type}  ${o.address}  <=  ${o.id}`).join("\n") +
      "\n",
  );

  for (const o of orphans) {
    const res = await runStage({
      command: "terraform",
      args: ["import", "-input=false", "-no-color", o.address, o.id],
      cwd,
      env,
      timeoutMs: INIT_TIMEOUT_MS,
      onLog: (chunk) => {
        applyStage.logs = capLogs(applyStage.logs + chunk);
      },
    });
    if (res.exitCode !== 0) {
      applyStage.logs = capLogs(
        applyStage.logs +
          `\n[auto-heal] terraform import failed for ${o.address} (exit ${res.exitCode}). Not retrying apply.\n`,
      );
      return;
    }
  }

  applyStage.logs = capLogs(applyStage.logs + "\n[auto-heal] All orphans imported. Retrying apply...\n");

  // Reset the apply stage's fail markers so the retry can succeed cleanly.
  applyStage.status = "running";
  applyStage.exitCode = undefined;
  applyStage.finishedAt = undefined;
  run.status = "running";
  run.error = undefined;

  const res = await runStage({
    command: "terraform",
    args: ["apply", "-auto-approve", "-input=false", "-no-color"],
    cwd,
    env,
    timeoutMs: APPLY_TIMEOUT_MS,
    onLog: (chunk) => {
      applyStage.logs = capLogs(applyStage.logs + chunk);
    },
  });
  applyStage.exitCode = res.exitCode;
  applyStage.finishedAt = nowIso();
  if (res.exitCode === 0) {
    applyStage.status = "succeeded";
  } else {
    applyStage.status = "failed";
    run.status = "failed";
    run.error = `terraform apply failed after auto-import (exit ${res.exitCode}).`;
    applyStage.logs = capLogs(applyStage.logs + `\n${res.stderr.slice(-2_000)}`);
  }
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
  for (const r of sorted.slice(0, RUNS.size - MAX_RUNS)) {
    RUNS.delete(r.id);
    RUN_SOURCES.delete(r.id);
  }
}

// Date.now()/Math.random() are fine in app runtime (the workflow-script ban
// does not apply here). Kept in helpers so the rest reads cleanly.
function nowIso(): string {
  return new Date().toISOString();
}
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
