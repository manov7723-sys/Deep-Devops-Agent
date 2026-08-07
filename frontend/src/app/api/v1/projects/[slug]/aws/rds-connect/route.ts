import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { requireProjectCloud } from "@/lib/projects/cloud-guard";
import { createRdsK8sSecretTool } from "@/lib/agent/tools/rds-tools";
import { applyK8sManifestTool } from "@/lib/agent/tools/apply-k8s-manifest";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { wireSecretToWorkloads, type WireOutcome } from "@/lib/devops/wire-secret-to-workloads";
import { ensureRdsReachableFromCluster } from "@/lib/cloud/rds-network";
import {
  ensureDatabaseExists,
  runMigrations as runDbMigrations,
  type DbBootstrapStep,
} from "@/lib/devops/db-bootstrap";
import { parseEksClusterRef } from "@/lib/cloud/eks-access";
import { decryptSecret } from "@/lib/auth/crypto";

/**
 * POST /projects/[slug]/aws/rds-connect
 *
 * The Connections page's submit action — same shape as the chat playbook's
 * "connect_existing_rds" flow, but driven from a real UI:
 *   1. Build the K8s Secret from the form values (via createRdsK8sSecretTool).
 *   2. Apply the manifest to the env's connected cluster (via applyK8sManifestTool).
 *   3. Return the applied Secret's name + namespace + kubectl output so the UI
 *      can show what happened.
 *
 * The tool code paths are the same the chat agent uses — the UI is just a
 * different entry point. Placeholder / empty inputs are rejected inside the
 * tool (see createRdsK8sSecretTool).
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  secretName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Secret name must be DNS-1123 (lowercase, dashes)."),
  host: z.string().trim().min(1),
  port: z.number().int().positive().max(65535),
  database: z.string().trim().min(1),
  username: z.string().trim().min(1),
  password: z.string().min(1),
  engine: z.enum(["postgres", "mysql"]).optional(),
  alsoStoreInAppSecret: z.boolean().optional(),
  appSecretKey: z.string().trim().optional(),
  /** RDS DBInstanceIdentifier + region — supplied by the Connections picker.
   *  Used to auto-open the RDS security group for the cluster's nodes. When
   *  absent we skip that step (the Secret is still written). */
  dbInstanceIdentifier: z.string().trim().optional(),
  region: z.string().trim().optional(),
  /** OPT-IN bootstrap. Both WRITE to the customer's database, so neither may
   *  default to true — they are checkboxes the user ticks deliberately.
   *    createDatabase — CREATE DATABASE when the target doesn't exist yet
   *    runMigrations  — apply schema migrations (prisma/alembic/django) */
  createDatabase: z.boolean().optional(),
  runMigrations: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  // Refuse a AWS database on a project that targets another cloud. The UI
  // hides the panel, but a stale tab or a wrong agent tool call would still
  // reach here and write an app-db Secret pointing at an unreachable host.
  const cloudOk = await requireProjectCloud(gate.access.project.id, "aws");
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
  const toolCtx = { projectId: gate.access.project.id, userId: gate.access.session.userId };

  // Step 0: OPEN THE NETWORK PATH before writing any Secret.
  //
  // A Secret with perfect credentials is useless if the cluster's nodes can't
  // reach the database. This is the single most common failure after a cluster
  // REBUILD: new cluster → new node security groups → the RDS security group
  // still admits only the old, now-deleted SG. Every query then fails with
  // "Can't reach database server", which reads like the DB is down and sends
  // people hunting through VPCs and credentials.
  //
  // Best-effort: if we can't determine the cluster/RDS pair (or lack the IAM
  // permission), we record it and continue — the Secret is still worth writing,
  // and the UI surfaces the manual rule to add.
  let network:
    | {
        changed: boolean;
        message: string;
        ruleKind: "security-group" | "cidr";
        crossVpc: boolean;
        crossRegion: boolean;
        warnings: string[];
      }
    | undefined;
  let networkError: string | undefined;
  try {
    const envRow = await prisma.env.findFirst({
      where: { projectId: gate.access.project.id, key: body.envKey },
      select: { cloudProviderId: true, kubeconfigRef: true },
    });
    if (!envRow?.cloudProviderId) {
      networkError = "No AWS provider on this env — skipped the security-group check.";
    } else if (!body.dbInstanceIdentifier) {
      networkError = "No RDS instance id supplied — skipped the security-group check.";
    } else {
      // Cluster name/region come from the env's stored kubeconfig, which is the
      // authoritative record of WHICH cluster this env actually points at.
      let clusterName: string | undefined;
      let clusterRegion: string | undefined;
      if (envRow.kubeconfigRef) {
        try {
          const ref = parseEksClusterRef(decryptSecret(envRow.kubeconfigRef));
          if (ref) {
            clusterName = ref.clusterName;
            clusterRegion = ref.region;
          }
        } catch {
          /* unreadable kubeconfig → fall through to the error below */
        }
      }
      if (!clusterName || !clusterRegion) {
        networkError =
          "Could not determine the env's EKS cluster — skipped the security-group check. Connect a cluster on the Clusters page first.";
      } else {
        const fix = await ensureRdsReachableFromCluster({
          cloudProviderId: envRow.cloudProviderId,
          // Cluster region comes from the kubeconfig; the RDS may sit in a
          // different one (body.region is the region the user browsed the RDS
          // picker in), which is exactly the cross-region case.
          region: clusterRegion,
          clusterName,
          dbIdentifier: body.dbInstanceIdentifier,
          dbRegion: body.region || clusterRegion,
        });
        if (fix.ok) {
          network = {
            changed: fix.changed,
            message: fix.message,
            ruleKind: fix.ruleKind,
            crossVpc: fix.crossVpc,
            crossRegion: fix.crossRegion,
            warnings: fix.warnings,
          };
        } else networkError = fix.error;
      }
    }
  } catch (e) {
    networkError = e instanceof Error ? e.message : "Unexpected error checking network access.";
  }

  // Step 1: build the Secret YAML. The tool validates against placeholders +
  // empty values and rejects with a helpful message — surface that as a 400.
  const built = await createRdsK8sSecretTool.execute(
    {
      envKey: body.envKey,
      namespace: body.namespace,
      secretName: body.secretName,
      host: body.host,
      port: body.port,
      database: body.database,
      username: body.username,
      password: body.password,
      engine: body.engine,
      alsoStoreInAppSecret: body.alsoStoreInAppSecret,
      appSecretKey: body.appSecretKey,
    },
    toolCtx,
  );
  if (!built.ok) {
    return NextResponse.json(
      { ok: false, code: "secret_build_failed", message: built.error },
      { status: 400 },
    );
  }

  // Step 2: apply the manifest to the env's connected cluster. If the env has
  // no cluster, the apply tool returns a clear "connect a cluster first"
  // message — bubble it up as 409 so the UI can suggest the fix.
  const applied = await applyK8sManifestTool.execute(
    {
      envKey: body.envKey,
      manifest: built.output.manifest,
      namespace: body.namespace,
    },
    toolCtx,
  );
  if (!applied.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "apply_failed",
        message: applied.error,
        manifest: built.output.manifest, // still return YAML so user can retry manually
      },
      { status: 409 },
    );
  }

  // Step 3: WIRE the Secret into the namespace's Deployments.
  //
  // A Secret nothing consumes does nothing. This step used to be a sentence of
  // instructions ("Patch your Deployment with envFrom.secretRef and roll pods")
  // that users understandably skipped — the banner already said "Connected" —
  // and the app then failed with no DATABASE_URL in the pod. We finish the job.
  //
  // Best-effort by design: the Secret IS written at this point, so a wiring
  // failure must not turn the whole request into an error. We report per-
  // Deployment outcomes and let the UI show exactly what happened.
  let wired: WireOutcome[] = [];
  let wireError: string | undefined;
  const bootstrap: DbBootstrapStep[] = [];
  try {
    const env = await prisma.env.findFirst({
      where: { projectId: gate.access.project.id, key: body.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) {
      wireError = `Env "${body.envKey}" not found.`;
    } else {
      const kcfg = await getKubeconfigForEnv(env.id);
      if (!kcfg.ok) {
        wireError = kcfg.message;
      } else {
        try {
          const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
          const res = await wireSecretToWorkloads({
            kubeconfigPath: kcfg.handle.path,
            execEnv,
            namespace: built.output.namespace,
            secretName: built.output.secretName,
          });
          if (res.ok) wired = res.outcomes;
          else wireError = res.error;

          // Step 4 (OPT-IN): bootstrap the database itself.
          //
          // Runs only when the user ticked the checkboxes — both WRITE to their
          // database (one creates it, one mutates schema), so neither can be a
          // silent side effect of "Connect". Ordering matters: create the
          // database before migrating into it.
          //
          // Migrations target a Deployment we just wired, so it already has
          // DATABASE_URL. Pods roll asynchronously after the patch, so we give
          // the rollout a moment to settle before exec-ing.
          if (body.createDatabase || body.runMigrations) {
            const engine = body.engine === "mysql" ? "mysql" : "postgres";
            const url = `${engine === "mysql" ? "mysql" : "postgresql"}://${encodeURIComponent(
              body.username,
            )}:${encodeURIComponent(body.password)}@${body.host}:${body.port}/${body.database}`;

            if (body.createDatabase) {
              bootstrap.push(
                await ensureDatabaseExists({
                  kubeconfigPath: kcfg.handle.path,
                  execEnv,
                  namespace: built.output.namespace,
                  databaseUrl: url,
                  engine,
                }),
              );
            }

            if (body.runMigrations) {
              // Every wired deployment — runMigrations finds the one with
              // the migration tool rather than assuming the first.
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
                // runMigrations waits on `kubectl rollout status` internally —
                // the fixed sleep that used to be here was far shorter than a
                // typical pod restart, so the migration could execute inside the
                // OLD pod and therefore against the OLD database.
                bootstrap.push(
                  await runDbMigrations({
                    kubeconfigPath: kcfg.handle.path,
                    execEnv,
                    namespace: built.output.namespace,
                    deployments: targets,
                    expectDatabase: body.database,
                  }),
                );
              }
            }
          }
        } finally {
          await kcfg.handle.cleanup().catch(() => {});
        }
      }
    }
  } catch (e) {
    wireError = e instanceof Error ? e.message : "Unexpected error wiring the Secret.";
  }

  const patched = wired.filter((w) => w.status === "patched");
  const already = wired.filter((w) => w.status === "already");
  const failed = wired.filter((w) => w.status === "failed");

  return NextResponse.json({
    ok: true,
    secretName: built.output.secretName,
    namespace: built.output.namespace,
    keysWritten: built.output.keysWritten,
    appSecretKey: built.output.appSecretKey,
    kubectl: {
      command: applied.output.command,
      stdout: applied.output.stdout,
    },
    // Per-Deployment wiring results so the UI can stop telling users to run
    // kubectl themselves.
    wired,
    wireError,
    // Security-group check/fix so a cluster rebuild doesn't silently orphan
    // the database behind a stale inbound rule.
    network,
    networkError,
    // Opt-in database bootstrap (create + migrate) results.
    bootstrap,
    note: built.output.note,
    // Human-readable summary the Connections panel renders under the banner.
    summary:
      failed.length > 0 || wireError
        ? `Secret written, but wiring did not fully succeed${
            wireError ? ` (${wireError})` : ""
          }${failed.length ? `; failed: ${failed.map((f) => f.deployment).join(", ")}` : ""}. ` +
          `Patch manually: kubectl patch deployment <name> -n ${built.output.namespace} --type=json ` +
          `-p '[{"op":"add","path":"/spec/template/spec/containers/0/envFrom","value":[{"secretRef":{"name":"${built.output.secretName}"}}]}]'`
        : patched.length > 0
          ? `Connected. Injected ${built.output.secretName} into ${patched.length} deployment(s) (${patched
              .map((w) => w.deployment)
              .join(", ")}) — pods are rolling now and will come up with DATABASE_URL set.` +
            (already.length ? ` ${already.length} already had it.` : "")
          : already.length > 0
            ? `Already connected — ${already.length} deployment(s) reference ${built.output.secretName}. No changes needed.`
            : `Secret written, but no Deployments were found in "${built.output.namespace}" to wire it into. Deploy the app first, then reconnect.`,
  });
}
