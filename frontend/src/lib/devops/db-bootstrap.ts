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
export async function runMigrations(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  deployment: string;
}): Promise<DbBootstrapStep> {
  const { kubeconfigPath, execEnv, namespace, deployment } = args;
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };

  const exec = (sh: string, timeoutMs = 300_000) =>
    runStage({
      command: "kubectl",
      args: ["exec", "-n", namespace, `deploy/${deployment}`, "--", "sh", "-c", sh],
      cwd: process.cwd(),
      env,
      timeoutMs,
      maxBufferBytes: 4 * 1024 * 1024,
    });

  const probe = await exec(
    "if [ -f prisma/schema.prisma ]; then echo prisma; " +
      "elif [ -f alembic.ini ]; then echo alembic; " +
      "elif [ -f manage.py ]; then echo django; " +
      "else echo none; fi",
    60_000,
  );
  const tool = probe.stdout.trim();

  if (probe.exitCode !== 0) {
    return {
      step: "migrate",
      status: "failed",
      message: `Could not inspect ${deployment}: ${probe.stderr.slice(-200)}`,
    };
  }
  if (tool === "none" || !tool) {
    return {
      step: "migrate",
      status: "skipped",
      message: `No migration tool detected in ${deployment} (no prisma/alembic/manage.py) — nothing to run.`,
    };
  }

  // `migrate deploy` is correct for committed migration histories; `db push` is
  // the fallback for schema-first projects that have none. Trying deploy first
  // preserves migration history when it exists.
  const cmd =
    tool === "prisma"
      ? "npx prisma migrate deploy --skip-generate 2>&1 || npx prisma db push --skip-generate --accept-data-loss"
      : tool === "alembic"
        ? "alembic upgrade head"
        : "python manage.py migrate --noinput";

  const res = await exec(cmd);
  const out = (res.stdout + res.stderr).trim().slice(-600);
  if (res.exitCode !== 0) {
    return { step: "migrate", status: "failed", message: `${tool}: ${out || "no output"}` };
  }
  return { step: "migrate", status: "done", message: `${tool} migrations applied.` };
}
