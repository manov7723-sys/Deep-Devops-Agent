import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { requireProjectCloud } from "@/lib/projects/cloud-guard";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { applyAppSecret } from "@/lib/devops/app-secrets";
import {
  ensureDatabaseExists as _unusedEnsureDb,
  runMigrations as runDbMigrations,
  type DbBootstrapStep,
} from "@/lib/devops/db-bootstrap";
import {
  listCloudSqlInstances,
  ensureCloudSqlDatabase,
  ensureCloudSqlWorkloadIdentity,
  buildCloudSqlProxyUrl,
} from "@/lib/cloud/gcp-cloudsql";
import {
  ensureProxyServiceAccount,
  injectCloudSqlProxy,
  type SidecarOutcome,
} from "@/lib/devops/cloudsql-sidecar";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

// Referenced only to keep the import list honest about what this route does
// NOT use: the database is created through the Cloud SQL Admin API, not by
// exec-ing psql in a pod like the AWS/Azure paths.
void _unusedEnsureDb;

/**
 * POST /projects/[slug]/gcp/db-connect
 *
 * Wire a Cloud SQL instance into a GKE namespace. Same contract as the AWS and
 * Azure connect routes — one click, four outcomes — but the ACCESS mechanism
 * is Google's recommended one for GKE, which changes the steps:
 *
 *   1. IDENTITY  — create a Google service account, grant it
 *                  roles/cloudsql.client, and bind the namespace's Kubernetes
 *                  service account to it via Workload Identity.
 *   2. DATABASE  — create the database inside the instance if asked (via the
 *                  Cloud SQL Admin API, not by exec-ing a client in a pod).
 *   3. SECRET +  — write DATABASE_URL pointing at 127.0.0.1, then inject the
 *      SIDECAR     cloud-sql-proxy container and the service account into
 *                  every Deployment.
 *   4. MIGRATE   — optional, reusing the shared bootstrap.
 *
 * There is deliberately NO firewall step. That is the entire point of the
 * proxy: access is granted to an IAM identity rather than an IP range, so a
 * node-pool rotation or cluster rebuild can't silently break connectivity the
 * way a stale allow-list does on the other two clouds.
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  secretName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Secret name must be DNS-1123.")
    .default("app-db"),
  /** Cloud SQL instance name (not the connection name). */
  instanceName: z.string().trim().min(1),
  database: z.string().trim().min(1),
  /** Database user — Cloud SQL's built-in user, e.g. `postgres`. */
  username: z.string().trim().min(1),
  password: z.string().min(1, "The database user's password is required."),
  createDatabase: z.boolean().optional(),
  runMigrations: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  // Refuse a GCP database on a project that targets another cloud. The UI
  // hides the panel, but a stale tab or a wrong agent tool call would still
  // reach here and write an app-db Secret pointing at an unreachable host.
  const cloudOk = await requireProjectCloud(gate.access.project.id, "gcp");
  if (!cloudOk.ok)
    return NextResponse.json(
      { ok: false, code: "wrong_cloud", message: cloudOk.message },
      { status: cloudOk.status },
    );

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "gcp" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) {
    return NextResponse.json(
      { ok: false, code: "gcp_not_connected", message: "Connect a GCP project first." },
      { status: 409 },
    );
  }
  const projectId = cp.accountRef;

  const env = await prisma.env.findFirst({
    where: { projectId: gate.access.project.id, key: body.envKey },
    select: { id: true, cloudProviderId: true },
  });
  if (!env) {
    return NextResponse.json(
      { ok: false, code: "env_not_found", message: `Env "${body.envKey}" not found.` },
      { status: 404 },
    );
  }

  // Re-read the instance rather than trusting client state — we need its
  // connectionName (project:region:instance) and engine, and a stale pick
  // would wire the proxy to the wrong database.
  const listed = await listCloudSqlInstances(cp.id, projectId);
  if (!listed.ok) {
    return NextResponse.json({ ok: false, code: "list_failed", message: listed.error }, { status: 502 });
  }
  const instance = listed.instances.find((i) => i.name === body.instanceName);
  if (!instance) {
    return NextResponse.json(
      {
        ok: false,
        code: "instance_not_found",
        message: `No Cloud SQL instance named "${body.instanceName}" in project ${projectId}.`,
      },
      { status: 404 },
    );
  }

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json(
      { ok: false, code: "no_cluster", message: `${kcfg.message} Connect a cluster to this env first.` },
      { status: 409 },
    );
  }

  const identity: string[] = [];
  const bootstrap: DbBootstrapStep[] = [];
  let sidecars: SidecarOutcome[] = [];
  let sidecarError: string | undefined;

  try {
    const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

    // ── 1. IDENTITY ─────────────────────────────────────────────────────
    // Service-account ids are limited to 6-30 chars, lowercase alphanumeric
    // and hyphens, and must start with a letter — derive deterministically so
    // re-running Connect reuses the same identity instead of creating a new
    // one each time.
    const ksaName = "cloudsql-proxy";
    const gsaId = `cloudsql-${body.namespace}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/-$/, "")
      .slice(0, 30);

    const wi = await ensureCloudSqlWorkloadIdentity({
      cloudProviderId: cp.id,
      projectId,
      namespace: body.namespace,
      ksaName,
      gsaId,
    });
    if (!wi.ok) {
      return NextResponse.json(
        { ok: false, code: "identity_failed", message: wi.error },
        { status: 409 },
      );
    }
    identity.push(...wi.data.steps);

    const ksa = await ensureProxyServiceAccount({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      ksaName,
      gsaEmail: wi.data.gsaEmail,
    });
    if (!ksa.ok) {
      return NextResponse.json(
        { ok: false, code: "ksa_failed", message: ksa.error, identity },
        { status: 409 },
      );
    }
    identity.push(`Kubernetes service account "${ksaName}" annotated with ${wi.data.gsaEmail}.`);

    // ── 2. DATABASE ─────────────────────────────────────────────────────
    if (body.createDatabase) {
      const created = await ensureCloudSqlDatabase(
        cp.id,
        projectId,
        instance.name,
        body.database,
      );
      bootstrap.push(
        created.ok
          ? {
              step: "create-database",
              status: "done",
              message: created.created
                ? `Created database "${body.database}" on ${instance.name}.`
                : `Database "${body.database}" already exists.`,
            }
          : { step: "create-database", status: "failed", message: created.error },
      );
    }

    // ── 3. SECRET + SIDECAR ─────────────────────────────────────────────
    // The URL points at 127.0.0.1 because the proxy listens there inside the
    // pod. Using the instance's public IP here would bypass the proxy and
    // reintroduce the firewall problem it exists to eliminate.
    const url = buildCloudSqlProxyUrl({
      engine: instance.engine,
      user: body.username,
      password: body.password,
      database: body.database,
    });
    const port = instance.engine === "mysql" ? 3306 : 5432;
    const applied = await applyAppSecret({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      secretName: body.secretName,
      entries: [
        { key: "DATABASE_URL", value: url },
        { key: "DB_HOST", value: "127.0.0.1" },
        { key: "DB_PORT", value: String(port) },
        { key: "DB_NAME", value: body.database },
        { key: "DB_USER", value: body.username },
        { key: "DB_PASSWORD", value: body.password },
        // Handy for apps that build their own connection or use the Cloud SQL
        // connector libraries directly.
        { key: "CLOUD_SQL_CONNECTION_NAME", value: instance.connectionName },
      ],
    });
    if (!applied.ok) {
      return NextResponse.json(
        { ok: false, code: "apply_failed", message: applied.error, identity, bootstrap },
        { status: 409 },
      );
    }

    const inject = await injectCloudSqlProxy({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      ksaName,
      connectionName: instance.connectionName,
      engine: instance.engine,
    });
    if (inject.ok) sidecars = inject.outcomes;
    else sidecarError = inject.error;

    // ── 4. MIGRATE ──────────────────────────────────────────────────────
    if (body.runMigrations) {
      const targets = sidecars
        .filter((s) => s.status === "patched" || s.status === "already")
        .map((s) => s.deployment);
      if (targets.length === 0) {
        bootstrap.push({
          step: "migrate",
          status: "skipped",
          message: "No Deployment carries the proxy yet — deploy the app first, then reconnect.",
        });
      } else {
        bootstrap.push(
          await runDbMigrations({
            kubeconfigPath: kcfg.handle.path,
            execEnv,
            namespace: body.namespace,
            deployments: targets,
            expectDatabase: body.database,
          }),
        );
      }
    }

    const meta = extractRequestMeta(req);
    await audit({
      userId: gate.access.session.userId,
      projectId: gate.access.project.id,
      action: "gcp.db_connected",
      targetType: "env",
      targetId: env.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        instance: instance.name,
        connectionName: instance.connectionName,
        engine: instance.engine,
        database: body.database,
        namespace: body.namespace,
      },
    });

    const patched = sidecars.filter((s) => s.status === "patched").length;
    const already = sidecars.filter((s) => s.status === "already").length;
    return NextResponse.json({
      ok: true,
      instance: {
        name: instance.name,
        engine: instance.engine,
        connectionName: instance.connectionName,
      },
      namespace: body.namespace,
      secretName: body.secretName,
      keysWritten: applied.keys,
      identity,
      sidecars,
      sidecarError,
      bootstrap,
      summary:
        `Connected "${instance.name}" (${instance.engine}) to namespace "${body.namespace}" via the Cloud SQL Auth Proxy — ` +
        `wrote ${applied.keys.length} keys and wired ${patched + already} deployment(s).` +
        (sidecarError ? ` NOTE: sidecar injection did not fully succeed — ${sidecarError}` : ""),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "unexpected",
        message: e instanceof Error ? e.message : "Unexpected error connecting Cloud SQL.",
      },
      { status: 500 },
    );
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
