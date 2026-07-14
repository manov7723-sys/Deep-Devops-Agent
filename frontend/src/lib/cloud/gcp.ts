/**
 * GCP credential resolution for stored providers (OAuth). The provider row
 * holds an ENCRYPTED refresh token in `externalId` and the active project id in
 * `accountRef`. We mint access tokens on demand, rotating the refresh token if
 * Google issues a new one.
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";
import { refreshGcpToken } from "./gcp-oauth";

export type GcpTokenResult =
  { ok: true; accessToken: string; expiresIn: number } | { ok: false; error: string };

/** Get a usable access token for a stored GCP provider (OAuth refresh-token). */
export async function getGcpAccessToken(cloudProviderId: string): Promise<GcpTokenResult> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, externalId: true },
  });
  if (!cp || cp.kind !== "gcp") return { ok: false, error: "Not a GCP provider." };
  if (!cp.externalId) return { ok: false, error: "GCP provider has no stored credentials." };

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(cp.externalId);
  } catch {
    return {
      ok: false,
      error: "Could not decrypt the stored GCP credential. Reconnect the provider.",
    };
  }

  const r = await refreshGcpToken(refreshToken);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.tokens.refreshToken && r.tokens.refreshToken !== refreshToken) {
    await prisma.cloudProvider
      .update({
        where: { id: cloudProviderId },
        data: { externalId: encryptSecret(r.tokens.refreshToken) },
      })
      .catch(() => {});
  }
  return { ok: true, accessToken: r.tokens.accessToken, expiresIn: r.tokens.expiresIn };
}
