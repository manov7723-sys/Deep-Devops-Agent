/**
 * AWS account onboarding — cross-account STS AssumeRole, the SaaS way.
 *
 * Port of the original Python backend's `onboard.py` flow:
 *   1. The PLATFORM (this app) dictates a per-customer ExternalId. It must be
 *      app-controlled and stable so a customer can't trick us into assuming a
 *      role we shouldn't (the "confused deputy" problem). We DON'T let the user
 *      type it — we generate it and SHOW it to them.
 *   2. We hand the user a ready-to-paste IAM trust policy that names our own
 *      AWS account as the trusted principal and pins our ExternalId.
 *   3. The user creates a role in THEIR account with that trust policy and gives
 *      us back only the role ARN.
 *   4. We `sts:AssumeRole` into their account using the ARN + our ExternalId.
 *
 * The original stored a random UUID in `.env` (single-tenant). Here we derive
 * the ExternalId deterministically per user via HMAC, so it's stable, unique
 * per customer, and needs no extra storage column. (ExternalId is not a secret
 * per AWS guidance — its job is uniqueness + app-control, not confidentiality.)
 */
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { runStage } from "@/lib/runner/exec";
import { runAwsViaMcp } from "@/lib/cloud/aws-via-mcp";
import { getDecryptedCloudCreds } from "@/lib/runner/creds";

/** PATH additions so the bundled `aws` CLI is found on dev + container hosts. */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/**
 * The platform's own AWS account ID — the principal that assumes the customer's
 * role. Shown inside the trust policy. Configure `PLATFORM_AWS_ACCOUNT_ID`
 * (falls back to the original backend's `YOUR_AWS_ACCOUNT_ID` for parity).
 */
export function getPlatformAccountId(): string {
  return (
    process.env.PLATFORM_AWS_ACCOUNT_ID?.trim() ||
    process.env.YOUR_AWS_ACCOUNT_ID?.trim() ||
    "YOUR_AWS_ACCOUNT_ID"
  );
}

/**
 * Deterministic, stable, opaque ExternalId for a user. Same user → same ID
 * forever (as long as the secret is stable), different users never collide.
 * Opaque so we don't leak the internal user UUID into the customer's AWS config.
 */
export function getUserExternalId(userId: string): string {
  const secret =
    process.env.AWS_EXTERNAL_ID_SECRET?.trim() ||
    process.env.APP_SECRET?.trim() ||
    "dda-external-id-v1";
  const digest = createHmac("sha256", secret).update(`aws-external-id:${userId}`).digest("hex");
  return `dda-${digest.slice(0, 32)}`;
}

export type AwsTrustPolicy = {
  Version: string;
  Statement: Array<{
    Effect: "Allow";
    Principal: { AWS: string };
    Action: "sts:AssumeRole";
    Condition: { StringEquals: { "sts:ExternalId": string } };
  }>;
};

/** Ready-to-paste IAM role trust policy pinning our account + ExternalId. */
export function buildTrustPolicy(externalId: string, platformAccountId: string): AwsTrustPolicy {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${platformAccountId}:root` },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": externalId } },
      },
    ],
  };
}

/** Pull the 12-digit account ID out of a role ARN (arn:aws:iam::<acct>:role/..). */
export function accountIdFromRoleArn(roleArn: string): string | null {
  const m = roleArn.match(/^arn:aws:iam::(\d{12}):role\//);
  return m ? m[1] : null;
}

/** Ready-to-use AWS credential env (temp session creds from AssumeRole). */
export type AwsCredEnv = {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION: string;
  AWS_DEFAULT_REGION: string;
};

export type AssumeRoleCredsResult =
  | { ok: true; env: AwsCredEnv; assumedAccountId: string | null }
  | {
      ok: false;
      code: "cli_not_installed" | "platform_creds_missing" | "assume_failed";
      message: string;
      stderr?: string;
    };

/**
 * Assume the customer's cross-account role with our ExternalId and return the
 * resulting temporary credentials as env vars. Shells out to the `aws` CLI
 * (same model as connect-cluster / terraform) so we don't pull in the AWS SDK.
 * Requires the platform's own AWS credentials on the runner host (env / instance
 * role) — that's the trusted principal allowed to assume the role.
 *
 * Mirrors the original `onboard.py:connect-aws` `sts.assume_role(...)` call.
 */
export async function assumeRoleCreds(args: {
  roleArn: string;
  externalId: string;
  region: string;
}): Promise<AssumeRoleCredsResult> {
  const cliArgs = [
    "sts", "assume-role",
    "--role-arn", args.roleArn,
    "--role-session-name", "dda-session",
    "--external-id", args.externalId,
    "--duration-seconds", "900",
    "--region", args.region,
    "--output", "json",
  ];

  // MCP-first. When the client registered an AWS MCP connector, the platform's
  // AssumeRole call runs through it instead of the local `aws` binary — the
  // whole reason the "install the CLI" error was blocking the console on the
  // deployed pod. CLI fallback below covers dev machines where MCP isn't wired
  // yet, and any callers that hit this before the operator has set up MCP.
  const mcp = await runAwsViaMcp(`aws ${cliArgs.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`);
  if (mcp.ok) {
    const parsed = parseAssumeRoleJson(mcp.stdout, args);
    if (parsed) return parsed;
    // MCP returned success with an unparseable body — surface as assume_failed,
    // not "no CLI", so the operator looks at the connector rather than the pod.
    return { ok: false, code: "assume_failed", message: `MCP returned an AssumeRole response we couldn't parse.` };
  }
  // Remember WHY MCP didn't serve this, so the CLI-fallback error below can
  // tell the truth. Reporting "no MCP connector is registered" when one IS
  // registered but failed sends the operator to the wrong page entirely.
  const mcpDetail =
    mcp.code === "unavailable"
      ? "no AWS MCP connector is registered"
      : `the AWS MCP connector failed (${mcp.message.slice(0, 200)})`;

  const workdir = await mkdtemp(join(tmpdir(), "dda-sts-"));
  try {
    // Pass through the platform's own AWS creds (the trusted principal) so the
    // CLI can call STS. We only forward the standard AWS_* knobs, never secrets
    // from elsewhere.
    const passEnv: Record<string, string> = {
      PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":"),
      AWS_REGION: args.region,
      AWS_DEFAULT_REGION: args.region,
    };
    for (const k of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_DEFAULT_PROFILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONFIG_FILE",
      "AWS_ROLE_ARN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ]) {
      const v = process.env[k];
      if (v) passEnv[k] = v;
    }

    const res = await runStage({
      command: "aws",
      args: [
        "sts",
        "assume-role",
        "--role-arn",
        args.roleArn,
        "--role-session-name",
        "dda-session",
        "--external-id",
        args.externalId,
        "--duration-seconds",
        "900",
        "--output",
        "json",
      ],
      cwd: workdir,
      env: passEnv,
      timeoutMs: 30_000,
    });

    if (res.exitCode === 0) {
      const parsed = parseAssumeRoleJson(res.stdout, args);
      if (parsed) return parsed;
      return { ok: false, code: "assume_failed", message: "Could not parse AssumeRole output." };
    }

    // The binary isn't installed / not on PATH. Point the operator at the MCP
    // path since that's what the deployed app is meant to use — telling them
    // to install `aws` on the pod would send them the wrong direction.
    if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
      return {
        ok: false,
        code: "cli_not_installed",
        message:
          `The AWS CLI isn't available on this host, and ${mcpDetail}. ` +
          "Register or fix an AWS MCP server on the Admin → MCP page (recommended), or install `aws` on the runner.",
        stderr: res.stderr.slice(-1_000),
      };
    }

    // No platform credentials to call STS with.
    const lower = res.stderr.toLowerCase();
    if (
      lower.includes("unable to locate credentials") ||
      lower.includes("no credentials") ||
      lower.includes("credentials not found")
    ) {
      return {
        ok: false,
        code: "platform_creds_missing",
        message:
          "The platform's own AWS credentials aren't configured on the server, so the role couldn't be assumed. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or an instance role) on the runner.",
        stderr: res.stderr.slice(-1_000),
      };
    }

    return {
      ok: false,
      code: "assume_failed",
      message: res.timedOut
        ? "STS AssumeRole timed out."
        : "AssumeRole was rejected. Check the role ARN and that its trust policy has our account + ExternalId.",
      stderr: res.stderr.slice(-1_500),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

export type AssumeRoleVerifyResult =
  | { ok: true; assumedAccountId: string | null }
  | {
      ok: false;
      code: "cli_not_installed" | "platform_creds_missing" | "assume_failed";
      message: string;
      stderr?: string;
    };

/** Best-effort live check that we can assume the role — thin wrapper over assumeRoleCreds. */
export async function verifyAssumeRole(args: {
  roleArn: string;
  externalId: string;
  region: string;
}): Promise<AssumeRoleVerifyResult> {
  const res = await assumeRoleCreds(args);
  if (res.ok) return { ok: true, assumedAccountId: res.assumedAccountId };
  return { ok: false, code: res.code, message: res.message, stderr: res.stderr };
}

export type ResolveExecEnvResult =
  | {
      ok: true;
      env: Record<string, string>;
      region: string;
      source: "stored_keys" | "assumed_role" | "host";
    }
  | { ok: false; message: string };

/** True when this deployment has a configured platform AWS account (SaaS mode). */
function platformConfigured(): boolean {
  return !!(process.env.PLATFORM_AWS_ACCOUNT_ID?.trim() || process.env.YOUR_AWS_ACCOUNT_ID?.trim());
}

/**
 * Build an exec env that lets the `aws` CLI use the SERVER HOST's own AWS
 * credentials (env vars, a profile, or ~/.aws/credentials). This is the
 * least-friction path for local / single-user use: the host's creds belong to
 * the account whose EC2 we're listing, so no cross-account hop is needed.
 *
 * Returns null when the host has no detectable AWS credentials.
 */
function hostAwsEnv(region: string): Record<string, string> | null {
  const hasEnvKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const hasProfile = !!(process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE);
  const sharedFile =
    process.env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials");
  const hasSharedFile = existsSync(sharedFile);
  if (!hasEnvKeys && !hasProfile && !hasSharedFile) return null;

  const out: Record<string, string> = {
    PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":"),
    HOME: process.env.HOME ?? homedir(),
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };
  // Pass through whatever the host uses so the CLI's default chain resolves.
  for (const k of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
  ]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Resolve ready-to-use AWS credential env for a connected CloudProvider so the
 * `aws` CLI can be invoked on its behalf. Priority:
 *   1. Per-account long-lived keys, AES-256-GCM encrypted at rest in CloudProvider.
 *   2. Cross-account STS AssumeRole — only when a platform AWS account is
 *      configured (i.e. a hosted SaaS deployment that can BE the trusted
 *      principal). Skipped for local installs since there's no platform identity.
 *   3. The server host's own AWS credentials (env / profile / ~/.aws) — the
 *      simplest path for local single-user use.
 */
export async function resolveAwsExecEnv(cloudProviderId: string): Promise<ResolveExecEnvResult> {
  const creds = await getDecryptedCloudCreds(cloudProviderId);
  if (!creds.ok) return { ok: false, message: creds.message };
  if (creds.kind !== "aws") return { ok: false, message: "This is not an AWS provider." };

  const e = creds.env;
  const region = e.AWS_REGION || e.AWS_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1";
  const pathEnv = [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":");

  // 1 — Long-lived stored keys — use directly.
  if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) {
    return {
      ok: true,
      region,
      source: "stored_keys",
      env: {
        PATH: pathEnv,
        AWS_ACCESS_KEY_ID: e.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: e.AWS_SECRET_ACCESS_KEY,
        ...(e.AWS_SESSION_TOKEN ? { AWS_SESSION_TOKEN: e.AWS_SESSION_TOKEN } : {}),
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
      },
    };
  }

  // 2 — Cross-account role (SaaS only: needs a platform identity to assume with).
  if (platformConfigured() && e.AWS_ROLE_ARN && e.AWS_EXTERNAL_ID) {
    const assumed = await assumeRoleCreds({
      roleArn: e.AWS_ROLE_ARN,
      externalId: e.AWS_EXTERNAL_ID,
      region,
    });
    if (assumed.ok)
      return { ok: true, region, source: "assumed_role", env: { PATH: pathEnv, ...assumed.env } };
    // Fall through to the host creds below rather than hard-failing.
  }

  // 3 — Host's own AWS credentials (local / single-user).
  const host = hostAwsEnv(region);
  if (host) return { ok: true, region, source: "host", env: host };

  return {
    ok: false,
    message:
      "No AWS credentials available. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the server's .env.local (or run `aws configure` on the host), then retry.",
  };
}

/**
 * Inspect an EKS cluster's node subnets to decide whether the cluster is on
 * public subnets, private subnets, or a mix. Used by deploy_my_app to pick
 * the right Service manifest annotations WITHOUT asking the user:
 *
 *   All public  → plain `type: LoadBalancer` (no annotations, Classic ELB —
 *                 works out of the box, no controller needed).
 *   Any private → `service.beta.kubernetes.io/aws-load-balancer-scheme:
 *                 internet-facing` annotation (needs AWS Load Balancer
 *                 Controller, but is REQUIRED — a private-subnet cluster
 *                 without this annotation strands the LB in the private
 *                 subnet with no public IP).
 *
 * Steps: aws eks describe-cluster → subnet ids →
 *        aws ec2 describe-subnets → MapPublicIpOnLaunch per subnet.
 *
 * Non-throwing: any failure returns { ok:false } so callers fall back to the
 * safe-but-heavier ALB default. Never blocks a deploy.
 */
export async function detectClusterSubnetType(
  cloudProviderId: string,
  region: string,
  clusterName: string,
): Promise<
  | { ok: true; kind: "all_public" | "has_private"; totalSubnets: number; privateCount: number }
  | { ok: false; message: string }
> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runStage } = await import("@/lib/runner/exec");

  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const env = { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };

  const workdir = await mkdtemp(join(tmpdir(), "dda-subnets-"));
  try {
    // 1 — Resolve the NODE GROUPS' subnets — NOT the cluster's
    //     resourcesVpcConfig.subnetIds. That field lists the CONTROL PLANE's
    //     ENI subnets, which on a standard EKS layout spans BOTH public and
    //     private subnets even when every worker node sits in a public one.
    //     Using it made this function report "has_private" for all-public
    //     clusters → deploy emitted internet-facing ALB annotations → the
    //     Service hung at EXTERNAL-IP <pending> forever because no AWS Load
    //     Balancer Controller was installed to reconcile them.
    //     `describe-nodegroup.subnets` is the authoritative answer for
    //     "where do the worker nodes actually live".
    const ngList = await runStage({
      command: "aws",
      args: [
        "eks",
        "list-nodegroups",
        "--cluster-name",
        clusterName,
        "--region",
        region,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      cwd: workdir,
      env,
      timeoutMs: 30_000,
    });
    if (ngList.exitCode !== 0) {
      return { ok: false, message: `list-nodegroups failed: ${ngList.stderr.slice(-300)}` };
    }
    const ngNames = (JSON.parse(ngList.stdout) as { nodegroups?: string[] }).nodegroups ?? [];
    if (ngNames.length === 0) {
      return { ok: false, message: "cluster has no managed node groups" };
    }

    const subnetIdSet = new Set<string>();
    for (const ng of ngNames) {
      const ngDesc = await runStage({
        command: "aws",
        args: [
          "eks",
          "describe-nodegroup",
          "--cluster-name",
          clusterName,
          "--nodegroup-name",
          ng,
          "--region",
          region,
          "--output",
          "json",
          "--no-cli-pager",
        ],
        cwd: workdir,
        env,
        timeoutMs: 30_000,
      });
      if (ngDesc.exitCode !== 0) continue; // best-effort per node group
      const subs =
        (JSON.parse(ngDesc.stdout) as { nodegroup?: { subnets?: string[] } }).nodegroup?.subnets ??
        [];
      for (const s of subs) subnetIdSet.add(s);
    }
    const subnetIds = [...subnetIdSet];
    if (subnetIds.length === 0) {
      return { ok: false, message: "no subnets resolved from the cluster's node groups" };
    }

    // 2 — Describe those subnets to read MapPublicIpOnLaunch.
    const subnets = await runStage({
      command: "aws",
      args: [
        "ec2",
        "describe-subnets",
        "--subnet-ids",
        ...subnetIds,
        "--region",
        region,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      cwd: workdir,
      env,
      timeoutMs: 30_000,
    });
    if (subnets.exitCode !== 0) {
      return { ok: false, message: `describe-subnets failed: ${subnets.stderr.slice(-300)}` };
    }
    const subnetsJson = JSON.parse(subnets.stdout) as {
      Subnets?: Array<{ MapPublicIpOnLaunch?: boolean }>;
    };
    const rows = subnetsJson.Subnets ?? [];
    const privateCount = rows.filter((s) => s.MapPublicIpOnLaunch === false).length;
    return {
      ok: true,
      kind: privateCount > 0 ? "has_private" : "all_public",
      totalSubnets: rows.length,
      privateCount,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Is the AWS Load Balancer Controller running on this cluster?
 *
 * Our default exposure pattern is Service type=ClusterIP + Ingress
 * (ingressClassName=alb), which ONLY works if this controller is present to
 * reconcile the Ingress into an actual ALB. Clusters built by our EKS
 * Terraform always have it; a hand-built or older cluster may not, and on
 * those an Ingress silently sits there doing nothing.
 *
 * Used by deploy_my_app to decide the fallback when the user expressed no
 * preference: controller present → "alb"; absent + all-public nodes →
 * "classic" (in-tree Classic ELB, needs no controller).
 *
 * Non-throwing: any failure returns false, which biases toward the
 * dependency-free Classic ELB path rather than a silently-dead Ingress.
 */
export async function detectAlbController(kubeconfigPath: string): Promise<boolean> {
  const { runStage } = await import("@/lib/runner/exec");
  const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    .filter(Boolean)
    .join(":");
  try {
    const res = await runStage({
      command: "kubectl",
      args: [
        "get",
        "deployment",
        "aws-load-balancer-controller",
        "-n",
        "kube-system",
        "-o",
        "jsonpath={.status.readyReplicas}",
      ],
      cwd: process.cwd(),
      env: { PATH, KUBECONFIG: kubeconfigPath },
      timeoutMs: 20_000,
    });
    if (res.exitCode !== 0) return false;
    return Number(res.stdout.trim() || "0") > 0;
  } catch {
    return false;
  }
}

/**
 * Does this cluster have the Prometheus Operator's ServiceMonitor CRD?
 *
 * Deploys emit a ServiceMonitor by default so the Observability page's
 * app-metrics cards fill in on their own. But a ServiceMonitor document on a
 * cluster WITHOUT the CRD makes `kubectl apply` fail outright:
 *
 *     no matches for kind "ServiceMonitor" in version "monitoring.coreos.com/v1"
 *
 * and because the manifest is applied as one multi-doc file, that failure takes
 * the whole deploy down with it. So we check first and omit the doc when the
 * CRD is absent — monitoring is a nice-to-have, shipping the app is not.
 *
 * Non-throwing: any failure returns false, which biases toward a deploy that
 * works without metrics rather than one that fails with them.
 */
export async function detectServiceMonitorCrd(kubeconfigPath: string): Promise<boolean> {
  const { runStage } = await import("@/lib/runner/exec");
  const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    .filter(Boolean)
    .join(":");
  try {
    const res = await runStage({
      command: "kubectl",
      args: ["get", "crd", "servicemonitors.monitoring.coreos.com", "-o", "name"],
      cwd: process.cwd(),
      env: { PATH, KUBECONFIG: kubeconfigPath },
      timeoutMs: 20_000,
    });
    return res.exitCode === 0 && res.stdout.includes("servicemonitors");
  } catch {
    return false;
  }
}

/**
 * Look up the IAM identity behind an env's stored AWS credentials.
 *
 * Uses `aws sts get-caller-identity` under the resolved exec env — same as
 * every other AWS tool call. Returns the caller's ARN + type so callers can
 * distinguish "an actual human's IAM user" from "a role DeepAgent assumed".
 *
 * Used by the EKS creation flow to auto-add the connected USER (if any) to
 * the new cluster's Access Entries — otherwise the customer signs into the
 * AWS console and hits "your principal doesn't have access to Kubernetes
 * objects" on a cluster DeepAgent's role created and admins invisibly.
 *
 * Non-throwing: any failure returns `{ ok: false }` and callers fall back to
 * not-adding-anything. This is a UX enhancement, never a blocker.
 */
export async function detectAwsCallerIdentity(
  cloudProviderId: string,
): Promise<
  | { ok: true; arn: string; accountId: string; kind: "user" | "role" | "root" | "other" }
  | { ok: false; message: string }
> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runStage } = await import("@/lib/runner/exec");

  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, message: resolved.message };

  const workdir = await mkdtemp(join(tmpdir(), "dda-sts-"));
  try {
    const res = await runStage({
      command: "aws",
      args: [
        "sts",
        "get-caller-identity",
        "--region",
        resolved.region,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      cwd: workdir,
      env: resolved.env,
      timeoutMs: 30_000,
    });
    if (res.exitCode !== 0) return { ok: false, message: `sts failed: ${res.stderr.slice(-400)}` };
    const j = JSON.parse(res.stdout) as { Arn?: string; Account?: string };
    if (!j.Arn || !j.Account) return { ok: false, message: "sts returned empty identity" };
    // Classify: :user/… = actual IAM user, :role/… or :assumed-role/… = a
    // role (already covered by enable_cluster_creator_admin_permissions),
    // :root = the account root (never add — huge blast radius).
    const kind = j.Arn.includes(":user/")
      ? "user"
      : j.Arn.endsWith(":root")
        ? "root"
        : j.Arn.includes(":role/") || j.Arn.includes(":assumed-role/")
          ? "role"
          : "other";
    return { ok: true, arn: j.Arn, accountId: j.Account, kind };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse an `aws sts assume-role --output json` response into the shape
 * assumeRoleCreds returns. Shared between the MCP path and the CLI fallback
 * so both produce byte-identical result envelopes. Returns null on any parse
 * failure so the caller can classify (assume_failed vs. cli_not_installed).
 */
function parseAssumeRoleJson(
  stdout: string,
  args: { roleArn: string; region: string },
): AssumeRoleCredsResult | null {
  try {
    const parsed = JSON.parse(stdout) as {
      Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
      AssumedRoleUser?: { Arn?: string };
    };
    const c = parsed.Credentials;
    if (!c?.AccessKeyId || !c?.SecretAccessKey) return null;
    // The assumed-role ARN is the authoritative account id — the role ARN was
    // user input and might be malformed. Fall back to that only if the STS
    // response doesn't include one.
    let assumedAccountId: string | null = accountIdFromRoleArn(args.roleArn);
    const m = (parsed.AssumedRoleUser?.Arn ?? "").match(/^arn:aws:sts::(\d{12}):/);
    if (m) assumedAccountId = m[1]!;
    return {
      ok: true,
      assumedAccountId,
      env: {
        AWS_ACCESS_KEY_ID: c.AccessKeyId,
        AWS_SECRET_ACCESS_KEY: c.SecretAccessKey,
        ...(c.SessionToken ? { AWS_SESSION_TOKEN: c.SessionToken } : {}),
        AWS_REGION: args.region,
        AWS_DEFAULT_REGION: args.region,
      },
    };
  } catch {
    return null;
  }
}
