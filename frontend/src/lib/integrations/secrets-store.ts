/**
 * App secrets manager — encrypted key/value store per project, synced to the
 * cluster as a Kubernetes Secret so apps get their secrets at runtime WITHOUT
 * plaintext in Git. Values are stored encrypted and NEVER returned to the client
 * (only the keys + last-updated). A deployment consumes them via:
 *   envFrom:
 *     - secretRef:
 *         name: deepagent-app-secrets
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";
import { applyK8sManifestTool } from "@/lib/agent/tools/apply-k8s-manifest";

export const APP_SECRET_NAME = "deepagent-app-secrets";
/** Valid Kubernetes Secret data key. */
export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export type SecretKeyInfo = { key: string; updatedAt: string };

export async function listSecretKeys(projectId: string): Promise<SecretKeyInfo[]> {
  const rows = await prisma.appSecret.findMany({
    where: { projectId },
    orderBy: { key: "asc" },
    select: { key: true, updatedAt: true },
  });
  return rows.map((r) => ({ key: r.key, updatedAt: r.updatedAt.toISOString() }));
}

export async function setSecret(projectId: string, key: string, value: string): Promise<void> {
  const valueRef = encryptSecret(value);
  await prisma.appSecret.upsert({
    where: { projectId_key: { projectId, key } },
    create: { projectId, key, valueRef },
    update: { valueRef },
  });
}

export async function deleteSecret(projectId: string, key: string): Promise<void> {
  await prisma.appSecret.deleteMany({ where: { projectId, key } });
}

/** Server-only: decrypt all secrets for syncing. Never expose to the client. */
async function getDecryptedSecrets(projectId: string): Promise<Record<string, string>> {
  const rows = await prisma.appSecret.findMany({
    where: { projectId },
    select: { key: true, valueRef: true },
  });
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.key] = decryptSecret(r.valueRef);
    } catch {
      /* skip undecryptable */
    }
  }
  return out;
}

function buildSecretYaml(namespace: string, data: Record<string, string>): string {
  const lines = [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${APP_SECRET_NAME}`,
    `  namespace: ${namespace}`,
    "  labels:",
    "    app.kubernetes.io/managed-by: deepagent",
    "type: Opaque",
    "stringData:",
  ];
  for (const [k, v] of Object.entries(data)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  lines.push("");
  return lines.join("\n");
}

export type SyncResult =
  { ok: true; count: number; namespace: string } | { ok: false; error: string };

/** Push all the project's secrets to the env's cluster as one k8s Secret. */
export async function syncSecretsToCluster(
  ctx: { projectId: string; userId: string },
  envKey: string,
): Promise<SyncResult> {
  const secrets = await getDecryptedSecrets(ctx.projectId);
  const keys = Object.keys(secrets);
  if (keys.length === 0) return { ok: false, error: "No secrets to sync — add some first." };

  const env = await prisma.env.findFirst({
    where: { projectId: ctx.projectId, key: envKey },
    select: { id: true, namespace: true },
  });
  if (!env) return { ok: false, error: `Env "${envKey}" not found.` };
  const namespace = env.namespace || "default";

  const yaml = buildSecretYaml(namespace, secrets);
  const res = await applyK8sManifestTool.execute({ envKey, manifest: yaml, namespace }, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  if (res.output.exitCode !== 0)
    return {
      ok: false,
      error: (res.output.stderr || res.output.stdout || "kubectl apply failed").slice(-300),
    };
  return { ok: true, count: keys.length, namespace };
}
