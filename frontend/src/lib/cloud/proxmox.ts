/**
 * Proxmox VE connection via an API token. Given the host endpoint + API token
 * (token id like "user@realm!tokenname" + secret), we validate the credentials
 * by calling /api2/json/version. Proxmox servers almost always use a
 * self-signed TLS cert, so the check tolerates an untrusted cert
 * (rejectUnauthorized:false) — same as the Terraform provider does.
 *
 * The token secret is encrypted at rest (AES-256-GCM via encryptSecret) and
 * stored in CloudProvider.externalId.
 *
 * Field mapping on the CloudProvider row (kind="proxmox"):
 *   accountRef = API endpoint URL         roleArn  = API token id (user@realm!name)
 *   externalId = encrypted token secret   region   = default node name
 */
import { request as httpsRequest } from "node:https";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";

export type ProxmoxInput = {
  /** e.g. "https://pve.example.com:8006" (with or without a trailing /api2/json). */
  endpoint: string;
  /** "user@realm!tokenname", e.g. "root@pam!deepagent". */
  tokenId: string;
  tokenSecret: string;
};

/** Normalize an endpoint to a base origin (strip trailing slash + /api2/json, add https). */
export function normalizeProxmoxEndpoint(raw: string): string {
  let e = (raw || "").trim().replace(/\/+$/, "");
  e = e.replace(/\/api2\/json$/i, "");
  if (!/^https?:\/\//i.test(e)) e = `https://${e}`;
  return e;
}

function proxmoxAuthHeader(tokenId: string, tokenSecret: string): string {
  return `PVEAPIToken=${tokenId}=${tokenSecret}`;
}

/** Low-level GET against a Proxmox API path, tolerating a self-signed TLS cert. */
function proxmoxGet(
  base: string,
  path: string,
  authHeader: string,
  timeoutMs = 15000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(`${base}${path}`);
    } catch {
      reject(new Error(`Invalid endpoint URL: ${base}`));
      return;
    }
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 8006, // Proxmox's default API port
        path: url.pathname + url.search,
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
        rejectUnauthorized: false, // Proxmox commonly ships a self-signed cert
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Proxmox request timed out")));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

export type ProxmoxConnectResult = { ok: true; version: string } | { ok: false; error: string };

/** Validate the endpoint + token by calling /api2/json/version. */
export async function connectProxmox(input: ProxmoxInput): Promise<ProxmoxConnectResult> {
  const base = normalizeProxmoxEndpoint(input.endpoint);
  const tokenId = input.tokenId.trim();
  const secret = input.tokenSecret.trim();
  if (!base || !tokenId || !secret) {
    return { ok: false, error: "Proxmox needs the host URL, API token ID and token secret." };
  }
  if (!tokenId.includes("@") || !tokenId.includes("!")) {
    return { ok: false, error: 'API token ID must look like "user@realm!tokenname" (e.g. root@pam!deepagent).' };
  }

  let res: { status: number; body: string };
  try {
    res = await proxmoxGet(base, "/api2/json/version", proxmoxAuthHeader(tokenId, secret));
  } catch (err) {
    return { ok: false, error: `Couldn't reach Proxmox at ${base}: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (res.status === 401) {
    return { ok: false, error: "Proxmox rejected the API token (401). Check the token ID and secret, and that the token has permissions." };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `Proxmox returned ${res.status}. ${res.body.slice(0, 160)}` };
  }
  let version = "";
  try {
    const j = JSON.parse(res.body) as { data?: { version?: string; release?: string } };
    version = j.data?.version ? `${j.data.version}${j.data.release ? `-${j.data.release}` : ""}` : "";
  } catch {
    /* non-fatal — a 2xx already proves the token works */
  }
  return { ok: true, version };
}

/** Encrypt a token secret for storage in CloudProvider.externalId. */
export function encryptProxmoxSecret(tokenSecret: string): string {
  return encryptSecret(tokenSecret);
}

export type DecryptedProxmoxCreds =
  | { ok: true; endpoint: string; tokenId: string; tokenSecret: string; node: string }
  | { ok: false; error: string };

/** Load + decrypt a Proxmox provider's API-token credentials. */
export async function getDecryptedProxmoxCreds(cloudProviderId: string): Promise<DecryptedProxmoxCreds> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, accountRef: true, roleArn: true, externalId: true, region: true },
  });
  if (!cp) return { ok: false, error: "Cloud provider not found." };
  if (cp.kind !== "proxmox") return { ok: false, error: "This is not a Proxmox provider." };
  if (!cp.accountRef || !cp.roleArn || !cp.externalId) {
    return { ok: false, error: "Proxmox credentials are incomplete — reconnect the provider." };
  }
  let tokenSecret: string;
  try {
    tokenSecret = decryptSecret(cp.externalId);
  } catch {
    return { ok: false, error: "Could not decrypt the Proxmox token secret — reconnect the provider." };
  }
  return {
    ok: true,
    endpoint: normalizeProxmoxEndpoint(cp.accountRef),
    tokenId: cp.roleArn,
    tokenSecret,
    node: cp.region || "pve",
  };
}
