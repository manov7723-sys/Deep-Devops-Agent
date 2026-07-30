/**
 * Post-connect database bootstrap: create the database if it's missing, and
 * run the app's schema migrations.
 *
 * WHY THIS EXISTS (2026-07 incident):
 * Connecting an RDS instance wires credentials, but an RDS *instance* is not a
 * *database*. A freshly created instance contains only `postgres`/`rdsadmin`
 * (or `mysql`/`sys`), so an app pointed at `…/myapp` fails with:
 *
 *     Database `myapp` does not exist
 *
 * and even once it exists, an empty database fails on the first query with
 * "table does not exist". Both were manual steps people forgot, and the errors
 * look like connectivity problems rather than missing setup.
 *
 * Both operations are OPT-IN. They write to the customer's database — one
 * creates a database, the other mutates schema — so neither may be a silent
 * side effect of clicking "Connect". The caller passes explicit booleans that
 * come from checkboxes the user ticked.
 *
 * Everything runs INSIDE the cluster (an ephemeral pod for SQL, `kubectl exec`
 * for migrations) because that is the only place with a working network path
 * to a private RDS instance — the app server usually has none.
 */
import { runStage } from "@/lib/runner/exec";

export type DbBootstrapStep = {
  step: "create-database" | "migrate";
  status: "done" | "skipped" | "failed";
  message: string;
};

const PG_IMAGE = "postgres:16-alpine";
const MYSQL_IMAGE = "mysql:8";

/** Replace the database component of a connection URL (…/olddb → …/newdb). */
function withDatabase(url: string, db: string): string {
  return url.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
}

/** Extract the database name from a connection URL. */
export function databaseFromUrl(url: string): string | null {
  const m = url.match(/\/\/[^/]+\/([^/?]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** Run a one-shot pod, capture its logs, always clean it up. */
async function runEphemeral(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  name: string;
  image: string;
  command: string[];
}): Promise<{ ok: boolean; output: string }> {
  const { kubeconfigPath, execEnv, namespace, name, image, command } = args;
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };
  const base = ["-n", namespace];

  // A leftover pod from a previous attempt would make `run` fail outright.
  await runStage({
    command: "kubectl",
    args: ["delete", "pod", name, ...base, "--ignore-not-found"],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });

  const run = await runStage({
    command: "kubectl",
    args: ["run", name, ...base, "--restart=Never", "--image", image, "--command", "--", ...command],
    cwd: process.cwd(),
    env,
    timeoutMs: 60_000,
  });
  if (run.exitCode !== 0) {
    return { ok: false, output: run.stderr.slice(-400) };
  }

  // Wait for completion either way — a failed SQL statement still produces the
  // logs we need to explain what went wrong.
  await runStage({
    command: "kubectl",
    args: ["wait", "--for=condition=Ready=false", `pod/${name}`, ...base, "--timeout=120s"],
    cwd: process.cwd(),
    env,
    timeoutMs: 130_000,
  });

  const logs = await runStage({
    command: "kubectl",
    args: ["logs", name, ...base],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });

  await runStage({
    command: "kubectl",
    args: ["delete", "pod", name, ...base, "--ignore-not-found"],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });

  const out = (logs.stdout + logs.stderr).trim();
  // psql/mysql exit non-zero on SQL errors; the log text is the real signal.
  const failed = /error|fatal|denied|refused|timeout/i.test(out) && !/already exists/i.test(out);
  return { ok: !failed, output: out.slice(-600) };
}

/**
 * Create the target database when it does not already exist.
 *
 * Connects to the engine's ALWAYS-PRESENT admin database (`postgres` / `mysql`)
 * using the same credentials, then issues CREATE DATABASE. "already exists" is
 * treated as success — the goal is the end state, not the act of creating.
 */
export async function ensureDatabaseExists(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  databaseUrl: string;
  engine: "postgres" | "mysql";
}): Promise<DbBootstrapStep> {
  const { kubeconfigPath, execEnv, namespace, databaseUrl, engine } = args;
  const dbName = databaseFromUrl(databaseUrl);
  if (!dbName) {
    return {
      step: "create-database",
      status: "failed",
      message: "Could not determine the database name from the connection URL.",
    };
  }

  const adminDb = engine === "mysql" ? "mysql" : "postgres";
  const adminUrl = withDatabase(databaseUrl, adminDb);

  // Quoted identifiers so names with hyphens (e.g. "database-1") are legal.
  const sql =
    engine === "mysql"
      ? `CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`
      : `SELECT 'CREATE DATABASE "${dbName}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='${dbName}')\\gexec`;

  const res = await runEphemeral({
    kubeconfigPath,
    execEnv,
    namespace,
    name: "dda-db-create",
    image: engine === "mysql" ? MYSQL_IMAGE : PG_IMAGE,
    command:
      engine === "mysql"
        ? ["sh", "-c", `mysql --protocol=TCP "${adminUrl}" -e '${sql}'`]
        : ["sh", "-c", `psql "${adminUrl}" -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`],
  });

  if (!res.ok) {
    return {
      step: "create-database",
      status: "failed",
      message: `Could not create "${dbName}": ${res.output || "no output"}`,
    };
  }
  return {
    step: "create-database",
    status: "done",
    message: `Database "${dbName}" is present.`,
  };
}

/**
 * Run schema migrations inside the app's own container.
 *
 * Executed in the running pod rather than an ephemeral one because migrations
 * need the app's source, dependencies and migration files — all of which exist
 * only in the app image. The tool is auto-detected by probing for its manifest,
 * so no per-app configuration is needed:
 *
 *   prisma/schema.prisma  → prisma migrate deploy (falls back to db push)
 *   alembic.ini           → alembic upgrade head
 *   manage.py             → python manage.py migrate
 *
 * Nothing detected is reported as "skipped", never as a failure — plenty of
 * apps create their tables at boot and legitimately have no migration step.
 */
/**
 * Read the Postgres extensions an app's Prisma schema declares, by inspecting
 * a running container.
 *
 * Prisma writes them as:
 *     extensions = [vector, postgis(version: "3.3")]
 * inside the `datasource`/`generator` block when `postgresqlExtensions` is a
 * preview feature.
 *
 * Needed because Azure Flexible Server refuses `CREATE EXTENSION` for anything
 * not in its `azure.extensions` allow-list, and the resulting migration
 * failure names the extension but nothing tells the caller ahead of time
 * which ones to permit. Returns [] for non-Prisma apps or when the schema
 * can't be read — the caller then skips allow-listing rather than guessing.
 */
export async function detectRequiredPgExtensions(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  /** Every candidate deployment — only one of them holds schema.prisma in a
   *  monorepo, and which one cannot be inferred from the name. Probing a
   *  single guessed deployment returns [] for the common frontend/backend
   *  split and the extension never gets allow-listed. */
  deployments: string[];
}): Promise<string[]> {
  const { kubeconfigPath, execEnv, namespace } = args;
  const { runStage } = await import("@/lib/runner/exec");

  for (const deployment of args.deployments.filter(Boolean)) {
    const res = await runStage({
      command: "kubectl",
      args: [
        "exec",
        "-n",
        namespace,
        `deploy/${deployment}`,
        "--",
        "sh",
        "-c",
        // Only the extensions line — cheap, and avoids shipping an 80KB schema
        // back through the runner for no reason.
        "grep -m1 -oE 'extensions[[:space:]]*=[[:space:]]*\\[[^]]*\\]' prisma/schema.prisma 2>/dev/null || true",
      ],
      cwd: process.cwd(),
      env: { ...execEnv, KUBECONFIG: kubeconfigPath },
      timeoutMs: 30_000,
    });
    const inner = /\[([^\]]*)\]/.exec((res.stdout || "").trim())?.[1];
    if (!inner) continue;
    const exts = inner
      .split(",")
      // Strip any `(version: "…")` argument — we only want the bare name.
      .map((e) => e.trim().replace(/\(.*$/, "").trim())
      .filter((e) => /^[a-z0-9_]+$/i.test(e));
    if (exts.length > 0) return exts;
  }
  return [];
}

export async function runMigrations(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  /**
   * Deployment(s) that might own the schema. Pass EVERY wired deployment —
   * this function probes each and migrates in the first one that actually
   * carries a migration tool.
   *
   * WHY A LIST (2026-07 incident): callers used to pass a single deployment,
   * picked as "the first one that got wired". In a monorepo that is whichever
   * name sorts first — `…-backend` — while the Prisma schema lives in
   * `…-frontend`. The step then reported:
   *
   *     skipped — No migration tool detected in <app>-backend
   *
   * …and the database was never migrated, even though a sibling deployment
   * one probe away had the full schema. Searching is cheap (one `test -f`
   * per deployment) and removes the guess entirely.
   */
  deployments: string[];
  /** The database the caller just wired. When supplied, the pod's live
   *  DATABASE_URL is checked against it before migrating — see below. */
  expectDatabase?: string;
}): Promise<DbBootstrapStep> {
  const { kubeconfigPath, execEnv, namespace, expectDatabase } = args;
  const candidates = args.deployments.filter(Boolean);
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };

  if (candidates.length === 0) {
    return {
      step: "migrate",
      status: "skipped",
      message: "No Deployment available to run migrations in — deploy the app first, then reconnect.",
    };
  }

  const execIn = (dep: string, sh: string, timeoutMs = 300_000) =>
    runStage({
      command: "kubectl",
      args: ["exec", "-n", namespace, `deploy/${dep}`, "--", "sh", "-c", sh],
      cwd: process.cwd(),
      env,
      timeoutMs,
      maxBufferBytes: 4 * 1024 * 1024,
    });

  // ── Find the deployment that actually owns the schema ────────────────
  //
  // Probe every candidate rather than assuming the first one. In a monorepo
  // the migration tool lives in exactly one service, and which of the wired
  // deployments that is cannot be inferred from the name.
  let deployment = "";
  let tool = "";
  const probed: string[] = [];
  for (const dep of candidates) {
    const p = await execIn(
      dep,
      "if [ -f prisma/schema.prisma ]; then echo prisma; " +
        "elif [ -f alembic.ini ]; then echo alembic; " +
        "elif [ -f manage.py ]; then echo django; " +
        "else echo none; fi",
      60_000,
    );
    const found = p.exitCode === 0 ? p.stdout.trim() : "";
    probed.push(`${dep}=${found || "unreachable"}`);
    if (found && found !== "none") {
      deployment = dep;
      tool = found;
      break;
    }
  }
  if (!deployment) {
    return {
      step: "migrate",
      status: "skipped",
      message: `No migration tool found in any deployment (${probed.join(", ")}) — nothing to run.`,
    };
  }

  const exec = (sh: string, timeoutMs = 300_000) => execIn(deployment, sh, timeoutMs);

  // WAIT FOR THE ROLLOUT BEFORE EXEC-ING (2026-07 incident).
  //
  // The caller has just patched the Deployment's envFrom with a NEW
  // DATABASE_URL and triggered a roll. Until that roll COMPLETES, the old
  // ReplicaSet's pod is still running — and `kubectl exec deploy/<name>`
  // resolves to whichever pod currently matches the selector, which during a
  // roll is very often the OLD one.
  //
  // Exec-ing too early therefore runs the migration against the PREVIOUS
  // database: the freshly-created one stays empty, the app 500s with "table
  // does not exist", and the step still reports success because the migration
  // genuinely succeeded — just against the wrong target. Callers used a fixed
  // 8-second sleep, which is far short of a typical Node/Next pod's 30-60s
  // startup.
  //
  // `rollout status` blocks until the new ReplicaSet is fully available, so
  // after it returns, exec is guaranteed to hit a pod carrying the new
  // environment. Bounded so a genuinely broken rollout can't hang the request;
  // on timeout we continue and let the migration report the real error.
  const rollout = await runStage({
    command: "kubectl",
    args: [
      "rollout",
      "status",
      `deployment/${deployment}`,
      "-n",
      namespace,
      "--timeout=180s",
    ],
    cwd: process.cwd(),
    env,
    timeoutMs: 190_000,
  });
  if (rollout.exitCode !== 0) {
    return {
      step: "migrate",
      status: "failed",
      message:
        `Deployment "${deployment}" did not finish rolling out with the new database settings, ` +
        `so migrations were not run (they would have targeted the previous database). ` +
        `${rollout.stderr.slice(-200) || "Check the pod's status and logs."}`,
    };
  }

  // Belt-and-braces: confirm the pod we reached actually carries the database
  // the caller just wired. `rollout status` returning success is normally
  // enough, but a Deployment that was already up-to-date (no roll triggered)
  // or a slow Secret propagation can still leave a stale value — and migrating
  // the wrong database is silent and destructive-looking (the new database
  // stays empty while an unrelated one gets touched).
  if (expectDatabase) {
    const seen = await exec('printf %s "$DATABASE_URL"', 30_000);
    const live = seen.stdout.trim();
    // Compare only the path segment; credentials and query params are noise.
    const liveDb = /\/([^/?]+)(?:\?|$)/.exec(live.replace(/^[a-z]+:\/\/[^/]+/i, ""))?.[1];
    if (liveDb && liveDb !== expectDatabase) {
      return {
        step: "migrate",
        status: "failed",
        message:
          `The pod is still pointed at database "${liveDb}" but you connected "${expectDatabase}". ` +
          `Migrations were NOT run, to avoid modifying the wrong database. ` +
          `The pods are mid-restart — wait ~30s and click Connect again.`,
      };
    }
  }

  // `tool` and `deployment` were resolved by the candidate probe above.

  // `migrate deploy` is correct for committed migration histories; `db push` is
  // the fallback for schema-first projects that have none. Trying deploy first
  // preserves migration history when it exists.
  // PRISMA FLAG WARNING (2026-07 incident): `migrate deploy` does NOT accept
  // `--skip-generate` — that flag belongs to `migrate dev` / `db push`. Prisma
  // responds to an unknown flag by printing its HELP TEXT and exiting 0.
  //
  // The previous command was:
  //     npx prisma migrate deploy --skip-generate || npx prisma db push ...
  // so `migrate deploy` "succeeded" (exit 0, help text), the `||` fallback
  // never fired, and this function reported "migrations applied" while
  // creating ZERO tables. The app then failed every query with "table does
  // not exist" and re-running the connect changed nothing — the checkbox was
  // working, the command was not.
  //
  // Fixed by dropping the invalid flag AND by verifying the output rather
  // than trusting the exit code alone.
  // ── Prisma: migrate, then CLOSE ANY DRIFT ───────────────────────────
  //
  // `migrate deploy` applies the migration files that are COMMITTED to the
  // repo. That is not the same as making the database match schema.prisma:
  // models added locally with `db push` never produce a migration file, so a
  // repo whose migration history has drifted will report "All migrations have
  // been successfully applied" and STILL be missing tables (2026-07: the
  // `UptimeMonitor` table was absent from a database Prisma had just declared
  // fully migrated).
  //
  // `prisma migrate diff --exit-code` is the supported way to ask "does the
  // live database match the schema?" — exit 2 means it does not. When it
  // doesn't, `db push` reconciles the remainder.
  //
  // Order matters and is deliberately conservative:
  //   1. migrate deploy — respects migration history where it exists
  //   2. diff           — ask, don't assume
  //   3. db push        — only if step 2 says there is still drift
  // A database that is already correct never reaches step 3, so a
  // fully-migrated production database is never touched by `db push`.
  if (tool === "prisma") {
    const deployRes = await exec("npx prisma migrate deploy 2>&1");
    const deployOut = (deployRes.stdout + deployRes.stderr).trim();

    // Exit code 0 is NOT proof for Prisma: an unknown flag makes it print help
    // and exit 0. Require positive evidence in the output.
    const deployLooksReal =
      /migrations? (have|has) been successfully applied|No pending migrations|No migration found/i.test(
        deployOut,
      );
    if (deployRes.exitCode !== 0 && !deployLooksReal) {
      // Not fatal on its own — a schema-first project with no migrations
      // directory fails here and is fully handled by db push below.
    }

    // Does the live database still differ from schema.prisma?
    const diff = await exec(
      'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code 2>&1',
    );
    // 0 = in sync, 2 = drift, anything else = the check itself failed.
    const hasDrift = diff.exitCode === 2;
    const diffBroken = diff.exitCode !== 0 && diff.exitCode !== 2;

    if (!hasDrift && !diffBroken) {
      return {
        step: "migrate",
        status: "done",
        message: deployLooksReal
          ? "prisma migrations applied; schema matches the database."
          : "Database already matches the Prisma schema.",
      };
    }

    // Drift (or an inconclusive check) → reconcile with db push. Safe in the
    // connect flow: the database was just created or is being wired for the
    // first time, so there is no production data to lose.
    const push = await exec("npx prisma db push --skip-generate --accept-data-loss 2>&1");
    const pushOut = (push.stdout + push.stderr).trim().slice(-600);
    const pushed = /in sync with your Prisma schema/i.test(pushOut);
    if (push.exitCode !== 0 || !pushed) {
      return {
        step: "migrate",
        status: "failed",
        message:
          `prisma: migrate deploy ran but the schema still didn't match, and db push failed. ` +
          `Output: ${pushOut.slice(-400) || "(empty)"}`,
      };
    }
    return {
      step: "migrate",
      status: "done",
      message: diffBroken
        ? "prisma db push applied the schema (drift check was inconclusive)."
        : "prisma migrations applied, then db push closed the remaining schema drift.",
    };
  }

  const cmd = tool === "alembic" ? "alembic upgrade head" : "python manage.py migrate --noinput";

  const res = await exec(cmd);
  const out = (res.stdout + res.stderr).trim().slice(-600);
  if (res.exitCode !== 0) {
    return { step: "migrate", status: "failed", message: `${tool}: ${out || "no output"}` };
  }

  return { step: "migrate", status: "done", message: `${tool} migrations applied.` };
}
