import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { applyAppSecret } from "@/lib/devops/app-secrets";
import { wireSecretToWorkloads, type WireOutcome } from "@/lib/devops/wire-secret-to-workloads";
import {
  ensureDatabaseExists,
  detectRequiredPgExtensions,
  runMigrations as runDbMigrations,
  type DbBootstrapStep,
} from "@/lib/devops/db-bootstrap";
import {
  listAzureDatabaseServers,
  ensurePostgresReachableFromAks,
  allowPostgresExtensions,
  buildAzureDbUrl,
} from "@/lib/cloud/azure-postgres";
import { parseAksClusterRef } from "@/lib/cloud/azure-acr";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/azure/db-connect
 *
 * Wire an Azure Database for PostgreSQL/MySQL Flexible Server into an AKS
 * cluster's namespace — the Azure counterpart of /aws/rds-connect, with the
 * same four steps and the same guarantees:
 *
 *   1. NETWORK  — allow the cluster's OUTBOUND IPs through the server's
 *                 firewall. Azure has no cross-resource "allow this cluster"
 *                 primitive, so we resolve the AKS egress LB's effective
 *                 outbound IPs and add a /32 rule per address. Private-access
 *                 (VNet-integrated) servers are reported rather than
 *                 "fixed" — a firewall rule does nothing for those.
 *   2. SECRET   — write DATABASE_URL + DB_* keys as a Kubernetes Secret.
 *   3. WIRING   — inject it into every Deployment via envFrom.secretRef and
 *                 roll the pods, because a Secret nothing consumes is
 *                 invisible to the app.
 *   4. BOOTSTRAP (opt-in) — CREATE DATABASE and/or run migrations.
 *
 * The Secret is built here rather than via create_rds_k8s_secret because
 * Azure Flexible Server ENFORCES TLS: the URL needs `sslmode=require`
 * (postgres) / `ssl=true` (mysql), and without it the driver negotiates
 * plaintext and the server drops the connection with an error that never
 * mentions TLS.
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  secretName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Secret name must be DNS-1123.")
    .default("app-db"),
  /** Flexible Server name as returned by GET /azure/databases. */
  serverName: z.string().trim().min(1),
  /** Database to connect to (NOT the server name). */
  database: z.string().trim().min(1),
  /** Admin login. Defaults to the server's stored administratorLogin. */
  username: z.string().trim().min(1),
  password: z.string().min(1, "The server's admin password is required."),
  /** Opt-in writes — both MUTATE the user's database, so neither is implicit. */
  createDatabase: z.boolean().optional(),
  runMigrations: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) {
    return NextResponse.json(
      { ok: false, code: "azure_not_connected", message: "Connect an Azure subscription first." },
      { status: 409 },
    );
  }

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

  // Resolve the chosen server from the live list — we need its FQDN, engine and
  // resource group, and re-reading is cheaper than trusting client-side state
  // that may be stale.
  const listed = await listAzureDatabaseServers(cp.id, cp.accountRef);
  if (!listed.ok) {
    return NextResponse.json(
      { ok: false, code: "list_failed", message: listed.error },
      { status: 502 },
    );
  }
  const server = listed.servers.find((s) => s.name === body.serverName);
  if (!server) {
    return NextResponse.json(
      {
        ok: false,
        code: "server_not_found",
        message: `No Flexible Server named "${body.serverName}" in this subscription.`,
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

  const network: string[] = [];
  const warnings: string[] = [];
  let networkError: string | undefined;
  let wired: WireOutcome[] = [];
  let wireError: string | undefined;
  const bootstrap: DbBootstrapStep[] = [];

  try {
    const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

    // ── 1. NETWORK ──────────────────────────────────────────────────────
    // Best-effort: a firewall failure must not block the Secret write. A user
    // whose cluster is VNet-peered to a private server needs no rule at all,
    // and reporting the miss is more useful than refusing to continue.
    try {
      const { readFile } = await import("node:fs/promises");
      const kcText = await readFile(kcfg.handle.path, "utf8");
      const clusterRef = parseAksClusterRef(kcText);
      if (!clusterRef?.clusterName || !clusterRef.resourceGroup) {
        networkError =
          "Couldn't identify the AKS cluster from the env's kubeconfig, so the database firewall wasn't touched. If the app can't reach the database, allow the cluster's outbound IP on the server manually.";
      } else {
        const fix = await ensurePostgresReachableFromAks({
          cloudProviderId: cp.id,
          subscriptionId: cp.accountRef,
          server,
          clusterResourceGroup: clusterRef.resourceGroup,
          clusterName: clusterRef.clusterName,
        });
        if (fix.ok) {
          network.push(fix.message);
          warnings.push(...fix.warnings);
        } else {
          networkError = fix.error;
        }
      }
    } catch (e) {
      networkError = e instanceof Error ? e.message : "Unexpected error configuring the firewall.";
    }

    // ── 2. SECRET ───────────────────────────────────────────────────────
    const url = buildAzureDbUrl({
      engine: server.engine,
      fqdn: server.fqdn,
      user: body.username,
      password: body.password,
      database: body.database,
    });
    const port = server.engine === "mysql" ? 3306 : 5432;
    const applied = await applyAppSecret({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      secretName: body.secretName,
      entries: [
        { key: "DATABASE_URL", value: url },
        { key: "DB_HOST", value: server.fqdn },
        { key: "DB_PORT", value: String(port) },
        { key: "DB_NAME", value: body.database },
        { key: "DB_USER", value: body.username },
        { key: "DB_PASSWORD", value: body.password },
      ],
    });
    if (!applied.ok) {
      return NextResponse.json(
        { ok: false, code: "apply_failed", message: applied.error, network, networkError },
        { status: 409 },
      );
    }

    // ── 3. WIRING ───────────────────────────────────────────────────────
    const wire = await wireSecretToWorkloads({
      kubeconfigPath: kcfg.handle.path,
      execEnv,
      namespace: body.namespace,
      secretName: body.secretName,
    });
    if (wire.ok) wired = wire.outcomes;
    else wireError = wire.error;

    // ── 4. BOOTSTRAP (opt-in) ───────────────────────────────────────────
    if (body.createDatabase || body.runMigrations) {
      if (body.createDatabase) {
        bootstrap.push(
          await ensureDatabaseExists({
            kubeconfigPath: kcfg.handle.path,
            execEnv,
            namespace: body.namespace,
            databaseUrl: url,
            engine: server.engine,
          }),
        );
      }
      if (body.runMigrations) {
        // Pass EVERY successfully-wired deployment. runMigrations probes each
        // and migrates in whichever one actually carries the schema — picking
        // just the first wired deployment lands on the backend in a monorepo
        // while Prisma lives in the frontend.
        const targets = wired
          .filter((w) => w.status === "patched" || w.status === "already")
          .map((w) => w.deployment);
        const target = targets[0];
        if (!target) {
          bootstrap.push({
            step: "migrate",
            status: "skipped",
            message:
              "No Deployment available to run migrations in — deploy the app first, then reconnect.",
          });
        } else {
          // Allow-list any Postgres extensions the schema needs BEFORE
          // migrating. Azure refuses CREATE EXTENSION for anything not in
          // `azure.extensions`, and the migration then dies on its first
          // statement — no tables created, and re-running never helps because
          // the block is server configuration, not the migration itself.
          // AWS RDS permits pgvector by default, so this only bites on Azure.
          try {
            const exts = await detectRequiredPgExtensions({
              kubeconfigPath: kcfg.handle.path,
              execEnv,
              namespace: body.namespace,
              deployments: targets,
            });
            if (exts.length > 0) {
              const allow = await allowPostgresExtensions({
                cloudProviderId: cp.id,
                subscriptionId: cp.accountRef,
                server,
                extensions: exts,
              });
              network.push(
                allow.ok
                  ? allow.message
                  : `Extension allow-list failed — migrations will likely fail: ${allow.error}`,
              );
              if (!allow.ok) warnings.push(allow.error);
            }
          } catch (e) {
            warnings.push(
              `Couldn't check the schema's required extensions: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
          // No sleep here: runMigrations now blocks on `kubectl rollout
          // status` itself, which is the only reliable signal that the pod
          // carrying the NEW DATABASE_URL is the one exec will reach. A fixed
          // 8s sleep used to let the migration land on the OLD pod — and
          // therefore the OLD database — leaving the newly-created one empty.
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
    }

    const meta = extractRequestMeta(req);
    await audit({
      userId: gate.access.session.userId,
      projectId: gate.access.project.id,
      action: "azure.db_connected",
      targetType: "env",
      targetId: env.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        server: server.name,
        engine: server.engine,
        database: body.database,
        namespace: body.namespace,
        secretName: body.secretName,
      },
    });

    const patched = wired.filter((w) => w.status === "patched").length;
    const already = wired.filter((w) => w.status === "already").length;
    return NextResponse.json({
      ok: true,
      server: { name: server.name, engine: server.engine, fqdn: server.fqdn },
      namespace: body.namespace,
      secretName: body.secretName,
      keysWritten: applied.keys,
      network,
      networkError,
      warnings,
      wired,
      wireError,
      bootstrap,
      summary:
        `Connected "${server.name}" (${server.engine}) to namespace "${body.namespace}" — ` +
        `wrote ${applied.keys.length} keys to Secret "${body.secretName}" and rolled ${patched + already} deployment(s).` +
        (networkError ? ` NOTE: the firewall step did not complete — ${networkError}` : "") +
        (wireError ? ` NOTE: wiring did not fully succeed — ${wireError}` : ""),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "unexpected",
        message: e instanceof Error ? e.message : "Unexpected error connecting the database.",
      },
      { status: 500 },
    );
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
