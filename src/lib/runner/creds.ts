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
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { getAwsKeys } from "@/lib/cloud/vault";

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
  // The env's provider creds (Vault keys / role) take precedence when present.
  if (cloudProviderId) {
    const creds = await getDecryptedCloudCreds(cloudProviderId);
    if (creds.ok) Object.assign(out, creds.env);
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
  | { ok: false; code: "env_not_found" | "missing_kubeconfig" | "decrypt_failed"; message: string };

/**
 * Resolve an env's kubeconfig: load the encrypted blob, decrypt it, write to
 * a temp directory, return the path + cleanup. The caller invokes cleanup
 * after every stage that needed cluster access.
 */
export async function getKubeconfigForEnv(envId: string): Promise<KubeconfigResult> {
  const env = await prisma.env.findUnique({
    where: { id: envId },
    select: { id: true, kubeconfigRef: true, namespace: true },
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
  | { ok: true; env: Record<string, string>; kind: "aws" | "gcp" | "azure" }
  | { ok: false; code: "provider_not_found" | "decrypt_failed" | "kind_unsupported"; message: string };

/**
 * Decrypt a CloudProvider's credentials into the shape each provider's CLI
 * expects in env vars. Today CloudProvider stores roleArn + externalId for
 * AWS assume-role; long-lived access keys aren't on the model yet, so this
 * function is a forward-compatible stub. Phase 3 will add the key columns
 * and fill in the actual STS AssumeRole flow.
 *
 * The shape returned here is what the runner merges into `runStage({env})`.
 */
export async function getDecryptedCloudCreds(
  cloudProviderId: string,
): Promise<CloudCredsResult> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: {
      id: true, kind: true, region: true, roleArn: true,
      externalId: true, accountId: true, credVaultPath: true,
    },
  });
  if (!cp) {
    return { ok: false, code: "provider_not_found", message: "Cloud provider not found." };
  }

  const base: Record<string, string> = {};
  if (cp.region) base.AWS_REGION = cp.region;

  if (cp.kind === "aws") {
    // Long-lived access key + secret live in Vault; the runner reads them at
    // execution time. Terraform/kubectl pick up AWS_ACCESS_KEY_ID/SECRET from env.
    if (cp.credVaultPath) {
      try {
        const keys = await getAwsKeys(cp.id);
        if (keys) {
          base.AWS_ACCESS_KEY_ID = keys.accessKeyId;
          base.AWS_SECRET_ACCESS_KEY = keys.secretAccessKey;
          base.AWS_REGION = keys.region || base.AWS_REGION || cp.region;
          if (base.AWS_REGION) base.AWS_DEFAULT_REGION = base.AWS_REGION;
        }
      } catch (e) {
        return {
          ok: false,
          code: "decrypt_failed",
          message: `Could not read AWS keys from Vault: ${String(e)}`,
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
    return { ok: true, env: base, kind: "azure" };
  }
  return {
    ok: false,
    code: "kind_unsupported",
    message: `Cloud kind ${cp.kind} isn't supported by the runner yet.`,
  };
}
