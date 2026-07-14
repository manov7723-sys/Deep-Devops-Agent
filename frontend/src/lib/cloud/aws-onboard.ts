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
      let assumedAccountId: string | null = accountIdFromRoleArn(args.roleArn);
      try {
        const parsed = JSON.parse(res.stdout) as {
          Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
          AssumedRoleUser?: { Arn?: string };
        };
        const c = parsed.Credentials;
        if (!c?.AccessKeyId || !c?.SecretAccessKey) {
          return {
            ok: false,
            code: "assume_failed",
            message: "AssumeRole returned no credentials.",
          };
        }
        const arn = parsed.AssumedRoleUser?.Arn ?? "";
        const m = arn.match(/^arn:aws:sts::(\d{12}):/);
        if (m) assumedAccountId = m[1];
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
        return { ok: false, code: "assume_failed", message: "Could not parse AssumeRole output." };
      }
    }

    // The binary isn't installed / not on PATH.
    if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
      return {
        ok: false,
        code: "cli_not_installed",
        message: "The `aws` CLI isn't on the server's PATH. Install it on the runner host.",
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
      source: "vault_keys" | "assumed_role" | "host";
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
 *   1. Per-account long-lived keys stored in Vault.
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

  // 1 — Long-lived keys from Vault — use directly.
  if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) {
    return {
      ok: true,
      region,
      source: "vault_keys",
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
