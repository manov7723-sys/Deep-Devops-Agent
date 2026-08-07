/**
 * Credential resolvers for the runner.
 *
 * Two responsibilities:
 *   1. Hand the runner a path to a fresh kubeconfig file on disk so kubectl
 *      and helm can authenticate against the env's cluster.
 *   2. Decrypt the env's cloud provider credentials and return them as a
 *      string map ready to merge into the child process env (AWS_*, GCP_*,
 *      AZURE_*).
 *
 * Tempfiles are written under the OS temp dir with random suffixes. Callers
 * MUST call the returned `cleanup()` function to delete them after the
 * stage completes; we don't auto-clean because some pipelines reuse the
 * same kubeconfig across many stages.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { getDecryptedAzureCreds } from "@/lib/cloud/azure";
import { getDecryptedProxmoxCreds } from "@/lib/cloud/proxmox";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";

const KUBE_EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/**
 * Build the environment for running `kubectl` against a connected cluster.
 *
 * Critical for EKS: the stored kubeconfig authenticates via an `aws eks
 * get-token` exec plugin, which needs the `aws` CLI on PATH, AWS credentials,
 * and HOME (for ~/.aws). We pass the host's AWS creds (local/Option-A keys live
 * in process.env) and then the env's provider creds on top. Without these,
 * kubectl fails with an auth error even though the cluster IS connected.
 */
export async function kubeExecEnv(
  kubeconfigPath: string,
  cloudProviderId: string | null,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    PATH: [process.env.PATH ?? "", ...KUBE_EXTRA_PATH].filter(Boolean).join(":"),
    KUBECONFIG: kubeconfigPath,
  };
  if (process.env.HOME) out.HOME = process.env.HOME;
  // Host AWS credentials (so the EKS exec plugin can authenticate).
  for (const k of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
  ]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  // The env's provider creds (stored keys / role) take precedence when present.
  // For AWS, resolveAwsExecEnv does the real STS AssumeRole exchange for
  // role-based providers — the raw getDecryptedCloudCreds only returns role
  // METADATA (AWS_ROLE_ARN/AWS_EXTERNAL_ID), which the `aws eks get-token`
  // exec plugin can't authenticate with, causing "security token invalid"
  // even though the cluster IS connected. Fall back to the raw resolver for
  // non-AWS providers (azure/gcp/proxmox) and as a last resort for AWS.
  if (cloudProviderId) {
    const aws = await resolveAwsExecEnv(cloudProviderId);
    if (aws.ok) {
      Object.assign(out, aws.env);
    } else {
      const creds = await getDecryptedCloudCreds(cloudProviderId);
      if (creds.ok) Object.assign(out, creds.env);
    }
  }
  return out;
}

export type KubeconfigHandle = {
  /** Absolute path the runner should pass via `--kubeconfig=` or `KUBECONFIG=`. */
  path: string;
  /** Async cleanup — removes the tempfile and its parent dir. Always call. */
  cleanup: () => Promise<void>;
};

export type KubeconfigResult =
  | { ok: true; handle: KubeconfigHandle; namespace: string }
  | {
      ok: false;
      code: "env_not_found" | "missing_kubeconfig" | "decrypt_failed" | "cluster_unreachable";
      message: string;
      /** Present when code === "cluster_unreachable" — the host that failed to resolve. */
      host?: string;
    };

/**
 * DNS-lookup cache for cluster API-server hostnames.
 *
 * WHY THIS EXISTS: getKubeconfigForEnv is called on EVERY kubectl-using request
 * — the env viewer alone can hit it several times a minute. Doing a DNS lookup
 * inline would add ~5ms on a hit and ~1-2s on a miss (resolver wait) to every
 * one of those calls. A 30-second TTL keyed by hostname keeps success paths
 * effectively free and still catches a deleted cluster within half a minute.
 *
 * NEGATIVE results get a shorter TTL (10s) so the UI recovers quickly once the
 * user reconnects to a new cluster — a longer negative cache would leave them
 * staring at "cluster gone" for 30s after the fix.
 */
const DNS_CACHE = new Map<string, { at: number; ok: boolean }>();
const DNS_TTL_OK_MS = 30_000;
const DNS_TTL_FAIL_MS = 10_000;

async function checkClusterReachable(
  kubeconfigYaml: string,
): Promise<{ ok: true } | { ok: false; host: string }> {
  const m = kubeconfigYaml.match(/^\s*server:\s*https?:\/\/([^:/\s]+)/m);
  if (!m) return { ok: true }; // couldn't extract — don't block; kubectl will surface a real error
  const host = m[1]!;
  const now = Date.now();
  const cached = DNS_CACHE.get(host);
  if (cached) {
    const ttl = cached.ok ? DNS_TTL_OK_MS : DNS_TTL_FAIL_MS;
    if (now - cached.at < ttl) return cached.ok ? { ok: true } : { ok: false, host };
  }
  try {
    await dnsLookup(host);
    DNS_CACHE.set(host, { at: now, ok: true });
    return { ok: true };
  } catch {
    DNS_CACHE.set(host, { at: now, ok: false });
    return { ok: false, host };
  }
}

/**
 * Resolve an env's kubeconfig: load the encrypted blob, decrypt it, write to
 * a temp directory, return the path + cleanup. The caller invokes cleanup
 * after every stage that needed cluster access.
 */
export async function getKubeconfigForEnv(envId: string): Promise<KubeconfigResult> {
  const env = await prisma.env.findUnique({
    where: { id: envId },
    select: { id: true, kubeconfigRef: true, namespace: true, cloudProviderId: true },
  });
  if (!env) {
    return { ok: false, code: "env_not_found", message: "Env not found." };
  }
  if (!env.kubeconfigRef) {
    return {
      ok: false,
      code: "missing_kubeconfig",
      message: "No kubeconfig wired for this env. Paste one in env settings first.",
    };
  }

  let plaintext: string;
  try {
    plaintext = decryptSecret(env.kubeconfigRef);
  } catch {
    return {
      ok: false,
      code: "decrypt_failed",
      message: "Could not decrypt stored kubeconfig. Re-paste it.",
    };
  }

  // GKE kubeconfigs embed a short-lived Google access token (~1h). Re-mint a
  // fresh one from the env's GCP provider on every use so the connection never
  // goes stale — keeps the app-managed GKE connection permanent without gcloud.
  if (env.cloudProviderId && /name:\s*gke\b/.test(plaintext) && /\btoken:\s*\S+/.test(plaintext)) {
    const cp = await prisma.cloudProvider.findUnique({
      where: { id: env.cloudProviderId },
      select: { kind: true },
    });
    if (cp?.kind === "gcp") {
      const tok = await getGcpAccessToken(env.cloudProviderId);
      if (tok.ok) plaintext = plaintext.replace(/\btoken:\s*\S+/, `token: ${tok.accessToken}`);
    }
  }

  // Pre-flight the cluster's API server address.
  //
  // Without this check, calling kubectl against a deleted cluster leaked the
  // raw stderr — `dial tcp: lookup XXX.eks.amazonaws.com: no such host` — to
  // whichever UI made the call, and the user had no way to tell "the network
  // is flaky" from "the cluster is gone" (2026-08). Failing here with an
  // actionable code means the 24 kubectl call sites already return a clean
  // "reconnect the cluster" message without each one having to interpret DNS
  // errors on its own.
  const reach = await checkClusterReachable(plaintext);
  if (!reach.ok) {
    return {
      ok: false,
      code: "cluster_unreachable",
      host: reach.host,
      message: `The cluster at ${reach.host} no longer resolves — it was likely deleted. Reconnect a cluster to this env on the Connections page.`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), `dda-kcfg-`));
  const path = join(dir, "kubeconfig");
  // Mode 0600 so other unix users on the host can't read it. The file lives
  // for the duration of a stage; cleanup deletes it.
  await writeFile(path, plaintext, { mode: 0o600 });

  return {
    ok: true,
    handle: {
      path,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    },
    namespace: env.namespace,
  };
}

export type CloudCredsResult =
  | { ok: true; env: Record<string, string>; kind: "aws" | "gcp" | "azure" | "proxmox" }
  | {
      ok: false;
      code: "provider_not_found" | "decrypt_failed" | "kind_unsupported";
      message: string;
    };

/**
 * Decrypt a CloudProvider's credentials into the shape each provider's CLI
 * expects in env vars. The shape returned here is what the runner merges into
 * `runStage({env})`.
 */
export async function getDecryptedCloudCreds(cloudProviderId: string): Promise<CloudCredsResult> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: {
      id: true,
      kind: true,
      region: true,
      roleArn: true,
      externalId: true,
      accountId: true,
      awsAccessKeyIdEnc: true,
      awsSecretAccessKeyEnc: true,
    },
  });
  if (!cp) {
    return { ok: false, code: "provider_not_found", message: "Cloud provider not found." };
  }

  const base: Record<string, string> = {};
  if (cp.region) base.AWS_REGION = cp.region;

  if (cp.kind === "aws") {
    // Long-lived access key + secret, AES-256-GCM encrypted at rest (same tier
    // as Azure's spClientSecretEnc). Terraform/kubectl pick up
    // AWS_ACCESS_KEY_ID/SECRET from env.
    if (cp.awsAccessKeyIdEnc && cp.awsSecretAccessKeyEnc) {
      try {
        base.AWS_ACCESS_KEY_ID = decryptSecret(cp.awsAccessKeyIdEnc);
        base.AWS_SECRET_ACCESS_KEY = decryptSecret(cp.awsSecretAccessKeyEnc);
        if (base.AWS_REGION) base.AWS_DEFAULT_REGION = base.AWS_REGION;
      } catch (e) {
        return {
          ok: false,
          code: "decrypt_failed",
          message: `Could not decrypt stored AWS keys: ${String(e)}`,
        };
      }
    }
    // STS AssumeRole metadata (used when no long-lived keys are stored).
    if (cp.roleArn) base.AWS_ROLE_ARN = cp.roleArn;
    if (cp.externalId) base.AWS_EXTERNAL_ID = cp.externalId;
    if (cp.accountId) base.AWS_ACCOUNT_ID = cp.accountId;
    return { ok: true, env: base, kind: "aws" };
  }
  if (cp.kind === "gcp") {
    return { ok: true, env: base, kind: "gcp" };
  }
  if (cp.kind === "azure") {
    // App-managed: feed the stored Service-Principal into Terraform's azurerm
    // provider via ARM_* env vars (no host `az login`). OAuth-connected Azure
    // providers store a refresh token instead of a secret, so this only
    // populates for SP connections; the env is returned either way.
    const az = await getDecryptedAzureCreds(cp.id);
    if (az.ok) {
      base.ARM_CLIENT_ID = az.clientId;
      base.ARM_CLIENT_SECRET = az.clientSecret;
      base.ARM_TENANT_ID = az.tenantId;
      base.ARM_SUBSCRIPTION_ID = az.subscriptionId;
    }
    return { ok: true, env: base, kind: "azure" };
  }
  if (cp.kind === "proxmox") {
    // Feed the stored API token into the bpg/proxmox Terraform provider via
    // PROXMOX_VE_* env vars (no secrets in the HCL). INSECURE=true because
    // Proxmox typically serves a self-signed cert. Fresh env object so the
    // AWS_REGION set above (from the node name) doesn't leak in.
    const px = await getDecryptedProxmoxCreds(cp.id);
    if (!px.ok) {
      return { ok: false, code: "decrypt_failed", message: px.error };
    }
    return {
      ok: true,
      kind: "proxmox",
      env: {
        PROXMOX_VE_ENDPOINT: px.endpoint,
        PROXMOX_VE_API_TOKEN: `${px.tokenId}=${px.tokenSecret}`,
        PROXMOX_VE_INSECURE: "true",
      },
    };
  }
  return {
    ok: false,
    code: "kind_unsupported",
    message: `Cloud kind ${cp.kind} isn't supported by the runner yet.`,
  };
}
