/**
 * RDS agent tools — create a new AWS RDS database wired into the project's
 * EKS cluster, or connect an existing DB and inject the connection string
 * into the deployed app as a Kubernetes Secret.
 *
 * The full end-to-end flow (via chat playbook, agent chains these):
 *   1. generate_rds_terraform   → returns the HCL for aws_db_instance + SG
 *   2. run_terraform (existing) → applies the HCL, waits for creation
 *   3. read the Terraform outputs to get host / port / user / pass / dbname
 *   4. create_rds_k8s_secret    → writes a K8s Secret in the app's namespace
 *   5. (optionally) patch the app Deployment to envFrom the Secret and roll it
 *
 * Or, for teams with an existing RDS:
 *   1. connect_existing_rds     → paste connection string → verify → K8s Secret
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";
import { buildRdsTerraform, RDS_DEFAULTS, RDS_POSTGRES_VERSIONS, RDS_MYSQL_VERSIONS } from "@/lib/devops/rds";
import type { RdsEngine } from "@/lib/devops/rds";
import { parseEksClusterRef } from "@/lib/cloud/eks-access";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

/**
 * Auto-derive the EKS cluster name from the env's own stored kubeconfig —
 * same trick deploy_my_app uses (parseEksClusterRef) — so the caller NEVER
 * has to know or ask for a cluster name/VPC id. Returns null when the env has
 * no kubeconfig or it's not an EKS cluster (caller falls back to asking).
 */
async function deriveEksClusterName(projectId: string, envKey: string): Promise<string | null> {
  const env = await prisma.env.findFirst({
    where: { projectId, key: envKey },
    select: { kubeconfigRef: true },
  });
  if (!env?.kubeconfigRef) return null;
  try {
    const kc = decryptSecret(env.kubeconfigRef);
    return parseEksClusterRef(kc)?.clusterName ?? null;
  } catch {
    return null;
  }
}

/**
 * Confirm the EKS cluster actually exists in the project's connected AWS
 * account BEFORE we generate the HCL. Otherwise Terraform's `data
 * "aws_eks_cluster"` block fails at plan time with "couldn't find resource"
 * — an ugly, three-step-late way to discover a mismatch between the env's
 * stored kubeconfig (which the cluster name is derived from) and the AWS
 * account currently connected on the project. When they don't line up
 * (cluster deleted, kubeconfig pasted from a different account, wrong
 * region), tell the user upfront with actionable options.
 */
type PreflightResult =
  | { ok: true; region: string }
  | { ok: false; error: string };
async function preflightEksCluster(
  projectId: string,
  clusterName: string,
  region: string,
): Promise<PreflightResult> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true, region: true, accountId: true },
  });
  if (!cp) {
    return {
      ok: false,
      error: "No AWS account connected to this project. Connect one on the Cloud providers tab first.",
    };
  }
  const creds = await resolveAwsExecEnv(cp.id);
  if (!creds.ok) return { ok: false, error: `Could not resolve AWS credentials: ${creds.message}` };
  const effectiveRegion = region || creds.region;
  const { tmpdir } = await import("node:os");
  const res = await runStage({
    command: "aws",
    args: ["eks", "describe-cluster", "--name", clusterName, "--region", effectiveRegion, "--output", "json"],
    cwd: tmpdir(),
    env: { ...creds.env, AWS_REGION: effectiveRegion },
    timeoutMs: 15000,
  });
  if (res.exitCode === 0) return { ok: true, region: effectiveRegion };
  // ResourceNotFoundException is the specific case: cluster doesn't exist
  // under these creds in this region. Everything else (AccessDenied, network,
  // etc.) is a different problem — surface the stderr verbatim so the caller
  // can see what actually failed.
  if (/ResourceNotFoundException|No cluster found/i.test(res.stderr)) {
    return {
      ok: false,
      error:
        `The EKS cluster "${clusterName}" does not exist in the connected AWS account ${cp.accountId ?? "(unknown id)"} in region ${effectiveRegion}. ` +
        `That name was derived from the "${projectId ? "current env" : ""}"'s stored kubeconfig, but the cluster it points at either was deleted, is in a different AWS account than the one connected on the Cloud providers tab, or lives in a different region. ` +
        `Fix by one of: (a) re-connecting the correct cluster to this env (Environments tab → Connect cluster), (b) connecting the AWS account that actually owns the cluster, or (c) creating the EKS cluster first (aks-create / eks-create).`,
    };
  }
  return {
    ok: false,
    error: `aws eks describe-cluster failed (exit ${res.exitCode}) in ${effectiveRegion}: ${res.stderr.slice(-800)}`,
  };
}

/**
 * Confirm the requested RDS engine version actually exists in AWS RIGHT NOW,
 * BEFORE we emit HCL that will apply-fail with "Cannot find version <x> for
 * <engine>". The RDS version catalog rotates over time (AWS deprecates old
 * minors + adds new ones per region), so any hardcoded list in the form
 * eventually goes stale. This validator is the fresh source of truth: it
 * shells out to `aws rds describe-db-engine-versions`, and if the caller's
 * version isn't in the returned list it returns a friendly error listing the
 * newest-N valid versions in that region so the caller can retry with one.
 */
type VersionPreflightResult =
  | { ok: true }
  | { ok: false; error: string };
async function preflightRdsEngineVersion(
  projectId: string,
  engine: RdsEngine,
  region: string,
  requestedVersion: string,
): Promise<VersionPreflightResult> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
  });
  if (!cp) {
    // Same-project earlier gate already surfaces this; keep the check as
    // defense in depth so a caller that skips it doesn't get a confusing
    // "aws creds not resolved" error later.
    return { ok: false, error: "No AWS account connected to this project." };
  }
  const creds = await resolveAwsExecEnv(cp.id);
  if (!creds.ok) return { ok: false, error: `Could not resolve AWS credentials: ${creds.message}` };
  const { tmpdir } = await import("node:os");
  const res = await runStage({
    command: "aws",
    args: [
      "rds",
      "describe-db-engine-versions",
      "--engine",
      engine,
      "--region",
      region,
      "--query",
      "DBEngineVersions[].EngineVersion",
      "--output",
      "json",
    ],
    cwd: tmpdir(),
    env: { ...creds.env, AWS_REGION: region },
    timeoutMs: 15000,
    maxBufferBytes: 512 * 1024,
  });
  if (res.exitCode !== 0) {
    // Fail-OPEN on API errors — don't block the user from applying just
    // because the preflight itself couldn't run. Terraform will still catch
    // a genuinely-bad version at apply time; we're just trying to catch it
    // earlier when we can.
    return { ok: true };
  }
  let versions: string[] = [];
  try {
    versions = JSON.parse(res.stdout || "[]");
  } catch {
    return { ok: true };
  }
  if (!Array.isArray(versions) || versions.length === 0) return { ok: true };
  if (versions.includes(requestedVersion)) return { ok: true };
  // Case-insensitive match — AWS returns lower-case; hedge in case.
  if (versions.some((v) => v.toLowerCase() === requestedVersion.toLowerCase())) return { ok: true };

  // Suggest something useful: newest 8, and (when applicable) newest for the
  // SAME major version the user asked for (e.g. they said "17.2" but AWS has
  // 17.4/17.5 — offer those first).
  const major = requestedVersion.split(".")[0];
  const sameMajor = versions.filter((v) => v.startsWith(`${major}.`));
  const newest = [...versions].sort(rdsVersionSortDesc).slice(0, 8);
  const suggestion =
    sameMajor.length > 0
      ? `Currently valid ${major}.x versions in ${region}: ${sameMajor.sort(rdsVersionSortDesc).slice(0, 6).join(", ")}. Or from any major: ${newest.join(", ")}.`
      : `Currently valid ${engine} versions in ${region} (newest first): ${newest.join(", ")}.`;
  return {
    ok: false,
    error:
      `AWS RDS in ${region} does not have ${engine} version ${requestedVersion} available right now — this catalog rotates over time. ` +
      suggestion +
      ` Retry with one of those.`,
  };
}

/** Sort semver-ish RDS versions descending: [17.5, 17.4, 16.9, 16.8, ...]. */
function rdsVersionSortDesc(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s) || 0);
  const pb = b.split(".").map((s) => Number(s) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── generate_rds_terraform ────────────────────────────────────────────────

type GenInput = {
  name: string;
  region: string;
  envKey: string;
  engine: RdsEngine;
  engineVersion?: string;
  instanceClass?: string;
  allocatedStorage?: number;
  maxAllocatedStorage?: number;
  backupRetentionDays?: number;
  multiAz?: boolean;
  skipFinalSnapshot?: boolean;
  eksClusterName?: string;
  vpcId?: string;
  allowSgId?: string;
  dbUsername?: string;
  initialDbName?: string;
};

type GenOutput = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateRdsTerraformTool: Tool<GenInput, GenOutput> = {
  name: "generate_rds_terraform",
  description:
    "Generate Terraform for an AWS RDS (Postgres or MySQL) instance that lives " +
    "in the same VPC as the project's EKS cluster and only allows inbound from " +
    "the cluster's worker security group. NEVER hand-write RDS HCL — always " +
    "call this. Returns the .tf file set; pair with run_terraform(action='apply') " +
    "to actually provision. AFTER apply succeeds, read the outputs and call " +
    "create_rds_k8s_secret to expose DATABASE_URL to the app pods.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "DNS-safe DB identifier (lowercase, dashes; also becomes the initial db name).",
      },
      region: { type: "string", description: "AWS region, e.g. us-east-1." },
      envKey: {
        type: "string",
        description: "Env key (dev / staging / prod) — used for tagging + K8s Secret namespacing later.",
      },
      engine: {
        type: "string",
        enum: ["postgres", "mysql"],
        description: "Database engine.",
      },
      engineVersion: {
        type: "string",
        description: `Engine version — Postgres examples: ${RDS_POSTGRES_VERSIONS.join(", ")}. MySQL: ${RDS_MYSQL_VERSIONS.join(", ")}. Defaults to the latest listed here.`,
      },
      instanceClass: {
        type: "string",
        description: "RDS instance class (e.g. db.t4g.micro). Default db.t4g.micro for dev, db.t4g.medium for prod.",
      },
      allocatedStorage: { type: "number", description: `GB. Default ${RDS_DEFAULTS.allocatedStorage}.` },
      maxAllocatedStorage: { type: "number", description: `GB autoscale ceiling. Default ${RDS_DEFAULTS.maxAllocatedStorage}.` },
      backupRetentionDays: { type: "number", description: `Days of automated backups. Default ${RDS_DEFAULTS.backupRetentionDays}.` },
      multiAz: {
        type: "boolean",
        description: "Multi-AZ HA (2× cost, sub-minute failover). Default false; enable for prod.",
      },
      skipFinalSnapshot: {
        type: "boolean",
        description:
          "Skip the final snapshot on destroy AND disable deletion_protection. NEVER set true for prod — " +
          "an accidental terraform destroy would erase the DB with no recovery.",
      },
      eksClusterName: {
        type: "string",
        description:
          "Name of the EKS cluster this RDS should live alongside. OMIT THIS — the tool auto-derives it " +
          "from the env's own connected cluster (same as deploy_my_app does), so never ask the user for it. " +
          "Only pass it explicitly if the user names a DIFFERENT cluster than the one connected to envKey.",
      },
      vpcId: { type: "string", description: "Explicit VPC id — bypasses EKS lookup. Also requires allowSgId." },
      allowSgId: { type: "string", description: "Security group id whose inbound is whitelisted to the DB port." },
      dbUsername: { type: "string", description: `Master username. Default "${RDS_DEFAULTS.dbUsername}".` },
      initialDbName: { type: "string", description: "Initial database name. Defaults to `name` with dashes → underscores." },
    },
    required: ["name", "region", "envKey", "engine"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const engineVersion = input.engineVersion
      || (input.engine === "postgres" ? RDS_POSTGRES_VERSIONS[0] : RDS_MYSQL_VERSIONS[0]);
    const instanceClass = input.instanceClass
      || (input.envKey === "prod" ? "db.t4g.medium" : "db.t4g.micro");
    // NEVER ask the caller for a VPC/cluster name — derive it from the env's
    // own stored kubeconfig, same as deploy_my_app does. Only falls through
    // to the caller-supplied vpcId/allowSgId (or an explicit error) when the
    // env genuinely has no EKS cluster connected.
    let eksClusterName = input.eksClusterName;
    if (!eksClusterName && !input.vpcId) {
      eksClusterName = (await deriveEksClusterName(ctx.projectId, input.envKey)) ?? undefined;
    }
    if (!eksClusterName && !input.vpcId) {
      return {
        ok: false,
        error:
          `The "${input.envKey}" env has no EKS cluster connected (no kubeconfig on record, or it isn't an EKS cluster), ` +
          `so there's no VPC to place the RDS instance in. Connect an EKS cluster to this env first, then retry.`,
      };
    }
    // Preflight: confirm the derived cluster actually exists under the
    // project's connected AWS credentials before we emit HCL. Skips when the
    // caller went the explicit-vpcId route (they own that plumbing).
    if (eksClusterName && !input.vpcId) {
      const preflight = await preflightEksCluster(ctx.projectId, eksClusterName, input.region);
      if (!preflight.ok) return { ok: false, error: preflight.error };
    }
    // Preflight: confirm the requested engine version actually exists in
    // AWS's live catalog for this region. RDS versions rotate over time —
    // any hardcoded form default eventually goes stale. Catching it here
    // avoids an apply that succeeds halfway (SG + subnet group + password
    // created) and then fails on aws_db_instance leaving orphaned state.
    const versionPreflight = await preflightRdsEngineVersion(
      ctx.projectId,
      input.engine,
      input.region,
      engineVersion,
    );
    if (!versionPreflight.ok) return { ok: false, error: versionPreflight.error };
    try {
      const files = buildRdsTerraform({
        name: input.name,
        region: input.region,
        engine: input.engine,
        engineVersion,
        instanceClass,
        allocatedStorage: input.allocatedStorage,
        maxAllocatedStorage: input.maxAllocatedStorage,
        backupRetentionDays: input.backupRetentionDays,
        multiAz: input.multiAz ?? input.envKey === "prod",
        // Force snapshots on prod even if the caller was sloppy.
        skipFinalSnapshot: input.envKey === "prod" ? false : (input.skipFinalSnapshot ?? false),
        eksClusterName,
        vpcId: input.vpcId,
        allowSgId: input.allowSgId,
        dbUsername: input.dbUsername,
        initialDbName: input.initialDbName,
        env: input.envKey,
        tags: { CreatedBy: "deepagent-rds" },
      });
      return {
        ok: true,
        output: {
          files,
          stack: `rds-${input.name}`,
          summary: `${input.engine} ${engineVersion} · ${instanceClass} · ${input.envKey === "prod" ? "multi-AZ + snapshot on destroy" : "single-AZ + skip-final"} in ${input.region}, gated to the EKS cluster's SG.`,
          nextSteps: [
            "1. run_terraform(envKey, name:'rds-" + input.name + "-apply', action:'apply', files:<returned>, stack:'rds-" + input.name + "'). Prod applies queue an approval.",
            "2. Read the run's outputs (host, port, database, username, password, connection_string).",
            "3. create_rds_k8s_secret(envKey, namespace, secretName, host, port, database, username, password) to inject as DATABASE_URL.",
            "4. Patch the app Deployment to envFrom the Secret and roll it (kubectl set env or a helm upgrade).",
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate RDS Terraform." };
    }
  },
};

// ── create_rds_k8s_secret ─────────────────────────────────────────────────

type SecretInput = {
  envKey: string;
  namespace: string;
  secretName: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  engine?: RdsEngine;
  /** Whether to also store the encrypted DATABASE_URL in AppSecret for the app to read via secret_tools. */
  alsoStoreInAppSecret?: boolean;
  appSecretKey?: string;
};

type SecretOutput = {
  namespace: string;
  secretName: string;
  keysWritten: string[];
  appSecretKey: string | null;
  manifest: string;
  note: string;
};

export const createRdsK8sSecretTool: Tool<SecretInput, SecretOutput> = {
  name: "create_rds_k8s_secret",
  description:
    "Create (or update) a Kubernetes Secret in the app's namespace that holds " +
    "the RDS connection details as DATABASE_URL + individual DB_* keys. Use " +
    "AFTER generate_rds_terraform + run_terraform apply succeeds — pass the " +
    "values you read from the Terraform outputs. Optionally also stores the " +
    "URL in the project's AppSecret store (encrypted) so agent tools can read " +
    "it later without hitting the cluster. Returns the Secret YAML (for audit) " +
    "and the K8s apply command. The caller should THEN patch the app " +
    "Deployment to envFrom this Secret and roll pods.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose cluster the Secret gets applied to." },
      namespace: { type: "string", description: "K8s namespace the app runs in." },
      secretName: { type: "string", description: 'K8s Secret name, e.g. "<app>-db".' },
      host: { type: "string" },
      port: { type: "number" },
      database: { type: "string" },
      username: { type: "string" },
      password: { type: "string", description: "Master password (from Terraform output). Never printed in the agent's reply." },
      engine: { type: "string", enum: ["postgres", "mysql"], description: "Default: postgres." },
      alsoStoreInAppSecret: {
        type: "boolean",
        description: "If true, also encrypt+store DATABASE_URL in AppSecret so future tool calls can read it without hitting the cluster.",
      },
      appSecretKey: { type: "string", description: 'AppSecret key when storing. Default: "database_url".' },
    },
    required: ["envKey", "namespace", "secretName", "host", "port", "database", "username", "password"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // Reject obviously-fabricated inputs — a caller (the agent) that couldn't
    // actually read the Terraform outputs sometimes still calls this with
    // empty strings, "<host>"-style placeholders, or nonsense values. Better
    // to fail loudly here than persist junk into K8s + AppSecret and leave
    // the app pointing at nothing. Every field is required and must look
    // real. The password bound is deliberately loose (RDS master passwords
    // can be short), but zero-length is always wrong.
    const bad: string[] = [];
    const isPlaceholder = (s: string) => /^[<{]|^(none|placeholder|todo|xxx+|example)$/i.test(s.trim());
    for (const [k, v] of Object.entries({
      host: input.host,
      database: input.database,
      username: input.username,
      password: input.password,
      namespace: input.namespace,
      secretName: input.secretName,
    })) {
      if (!v || !String(v).trim()) bad.push(`${k} is empty`);
      else if (isPlaceholder(String(v))) bad.push(`${k}="${v}" looks like a placeholder`);
    }
    if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
      bad.push(`port=${input.port} is not a valid TCP port`);
    }
    if (bad.length > 0) {
      return {
        ok: false,
        error:
          `create_rds_k8s_secret refused: ${bad.join("; ")}. ` +
          `These values must come from the Terraform run's ACTUAL outputs (host/port/database/username/password). ` +
          `If terraform apply hasn't completed yet, wait for it — don't guess or fill in placeholders.`,
      };
    }
    const engine = input.engine ?? "postgres";
    const scheme = engine === "postgres" ? "postgres" : "mysql";
    const url = `${scheme}://${input.username}:${encodeURIComponent(input.password)}@${input.host}:${input.port}/${input.database}`;
    // Build the Secret YAML — data values are base64.
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const manifest = `apiVersion: v1
kind: Secret
metadata:
  name: ${input.secretName}
  namespace: ${input.namespace}
  labels:
    app.kubernetes.io/managed-by: deepagent
    deepagent.io/kind: rds-connection
type: Opaque
data:
  DATABASE_URL: ${b64(url)}
  DB_HOST: ${b64(input.host)}
  DB_PORT: ${b64(String(input.port))}
  DB_NAME: ${b64(input.database)}
  DB_USER: ${b64(input.username)}
  DB_PASSWORD: ${b64(input.password)}
`;

    let appSecretKey: string | null = null;
    if (input.alsoStoreInAppSecret) {
      appSecretKey = input.appSecretKey ?? "database_url";
      await prisma.appSecret.upsert({
        where: { projectId_key: { projectId: ctx.projectId, key: appSecretKey } },
        create: { projectId: ctx.projectId, key: appSecretKey, valueRef: encryptSecret(url) },
        update: { valueRef: encryptSecret(url) },
      });
    }

    return {
      ok: true,
      output: {
        namespace: input.namespace,
        secretName: input.secretName,
        keysWritten: ["DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"],
        appSecretKey,
        manifest,
        note:
          `Apply with apply_k8s_manifest(envKey:"${input.envKey}", yaml:<manifest>). ` +
          `Then patch the app Deployment: envFrom: [{ secretRef: { name: "${input.secretName}" } }] and roll pods.`,
      },
    };
  },
};

// ── connect_existing_rds ──────────────────────────────────────────────────

type ConnectInput = {
  envKey: string;
  namespace: string;
  secretName: string;
  connectionString: string;
  engine?: RdsEngine;
  alsoStoreInAppSecret?: boolean;
  appSecretKey?: string;
};

type ConnectOutput = {
  parsed: { host: string; port: number; database: string; username: string };
  namespace: string;
  secretName: string;
  manifest: string;
  appSecretKey: string | null;
  note: string;
};

export const connectExistingRdsTool: Tool<ConnectInput, ConnectOutput> = {
  name: "connect_existing_rds",
  description:
    "Take a pre-existing database's connection string (Postgres or MySQL URL) " +
    "and expose it to the app as a Kubernetes Secret + optional AppSecret. " +
    "Use for teams that already have an RDS (or any managed DB) and just " +
    "want to wire it up — no Terraform is generated or run. Validates the URL " +
    "shape but does NOT test connectivity from the cluster (do that via " +
    "get_kubernetes_logs after the first pod restart).",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string" },
      namespace: { type: "string" },
      secretName: { type: "string" },
      connectionString: {
        type: "string",
        description: "Full URL, e.g. postgres://user:pass@host:5432/db  or  mysql://user:pass@host:3306/db",
      },
      engine: { type: "string", enum: ["postgres", "mysql"], description: "Optional — inferred from the URL scheme if omitted." },
      alsoStoreInAppSecret: { type: "boolean" },
      appSecretKey: { type: "string" },
    },
    required: ["envKey", "namespace", "secretName", "connectionString"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    let parsed: URL;
    try {
      parsed = new URL(input.connectionString);
    } catch {
      return { ok: false, error: "Not a valid URL. Expected postgres://user:pass@host:port/db or mysql://..." };
    }
    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    const engine: RdsEngine = input.engine ?? (scheme.startsWith("postgres") ? "postgres" : scheme.startsWith("mysql") ? "mysql" : "postgres");
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : engine === "postgres" ? 5432 : 3306;
    const database = parsed.pathname.replace(/^\/+/, "");
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (!host || !database || !username) {
      return { ok: false, error: "Connection string is missing host, database, or username." };
    }

    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    const manifest = `apiVersion: v1
kind: Secret
metadata:
  name: ${input.secretName}
  namespace: ${input.namespace}
  labels:
    app.kubernetes.io/managed-by: deepagent
    deepagent.io/kind: db-connection
type: Opaque
data:
  DATABASE_URL: ${b64(input.connectionString)}
  DB_HOST: ${b64(host)}
  DB_PORT: ${b64(String(port))}
  DB_NAME: ${b64(database)}
  DB_USER: ${b64(username)}
  DB_PASSWORD: ${b64(password)}
`;

    let appSecretKey: string | null = null;
    if (input.alsoStoreInAppSecret) {
      appSecretKey = input.appSecretKey ?? "database_url";
      await prisma.appSecret.upsert({
        where: { projectId_key: { projectId: ctx.projectId, key: appSecretKey } },
        create: { projectId: ctx.projectId, key: appSecretKey, valueRef: encryptSecret(input.connectionString) },
        update: { valueRef: encryptSecret(input.connectionString) },
      });
    }

    return {
      ok: true,
      output: {
        parsed: { host, port, database, username },
        namespace: input.namespace,
        secretName: input.secretName,
        manifest,
        appSecretKey,
        note:
          `Apply with apply_k8s_manifest(envKey:"${input.envKey}", yaml:<manifest>). ` +
          `Then patch the app Deployment: envFrom: [{ secretRef: { name: "${input.secretName}" } }] and roll pods.`,
      },
    };
  },
};
