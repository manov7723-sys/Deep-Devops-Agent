import { prisma } from "@/lib/db/prisma";
import { getAzureAccessToken } from "@/lib/cloud/azure";

const ARM = "https://management.azure.com";

export type AzureCtx = { accessToken: string; subscriptionId: string };

/**
 * Resolve the project's Azure provider + a fresh ARM token (per-project
 * isolation). Returns a friendly error string when no Azure account is
 * connected or auth fails.
 */
export async function azureContext(projectId: string): Promise<{ ok: true; ctx: AzureCtx } | { ok: false; error: string }> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true, accountRef: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) {
    return { ok: false, error: "No Azure account is connected to this project. Connect one with 'Sign in with Microsoft' on the Cloud providers tab first." };
  }
  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) return { ok: false, error: `Could not authenticate to Azure: ${tok.error}` };
  return { ok: true, ctx: { accessToken: tok.accessToken, subscriptionId: cp.accountRef } };
}

/** GET an ARM path with the project's Azure token. */
export async function armGet(
  accessToken: string,
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${ARM}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  } catch (err) {
    return { ok: false, error: `Network error reaching Azure: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Azure returned ${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true, data: await res.json().catch(() => ({})) };
}
