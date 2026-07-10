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

/**
 * Normalize an endpoint to just its origin (scheme://host:port). Robust to a
 * pasted Proxmox *browser* URL, which carries a "#v1:0:…" fragment (the web
 * UI's view state) and sometimes a /api2/json path — none of which belong in
 * the API base. Everything after the host is dropped.
 */
export function normalizeProxmoxEndpoint(raw: string): string {
  let e = (raw || "").trim();
  if (!e) return "";
  if (!/^https?:\/\//i.test(e)) e = `https://${e}`;
  try {
    const u = new URL(e);
    return `${u.protocol}//${u.host}`; // origin only — drops path, query, and #fragment
  } catch {
    // Fallback: strip fragment/query/path/trailing slash by hand.
    return e.replace(/[#?].*$/, "").replace(/\/api2\/json.*$/i, "").replace(/\/+$/, "");
  }
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

export type ProxmoxTemplate = { vmid: number; name: string };
export type ProxmoxOptions = {
  nodes: string[];
  defaultNode: string;
  datastores: string[];
  bridges: string[];
  templates: ProxmoxTemplate[];
};

/**
 * Best-effort live inventory for the VM-creation box: the real node name(s),
 * plus the default node's storage pools, network bridges, and VM templates —
 * read straight from the Proxmox REST API. Every call is defensive: a failure
 * or a missing token permission yields an empty list, never a throw, so the box
 * still renders (falling back to its static defaults). The node list falls back
 * to the provider's stored default node so the box never offers a bogus node the
 * server doesn't actually have (which is what made a clone fail with "hostname
 * lookup 'pve' failed").
 */
export async function getProxmoxOptions(cloudProviderId: string): Promise<ProxmoxOptions> {
  const empty: ProxmoxOptions = { nodes: [], defaultNode: "", datastores: [], bridges: [], templates: [] };
  const creds = await getDecryptedProxmoxCreds(cloudProviderId);
  if (!creds.ok) return empty;
  const auth = proxmoxAuthHeader(creds.tokenId, creds.tokenSecret);

  // 1) Nodes — the critical bit for the clone to target a node that exists.
  let nodes: string[] = [];
  try {
    const res = await proxmoxGet(creds.endpoint, "/api2/json/nodes", auth);
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.body) as { data?: Array<{ node?: string }> };
      nodes = (j.data ?? []).map((n) => n.node).filter((n): n is string => !!n);
    }
  } catch {
    /* fall through to the stored default node */
  }
  if (!nodes.length && creds.node) nodes = [creds.node];
  const defaultNode =
    creds.node && nodes.includes(creds.node) ? creds.node : nodes[0] ?? creds.node ?? "";
  if (!defaultNode) return { ...empty, nodes };

  // 2) Storage pools that can hold VM images/disks on the default node.
  let datastores: string[] = [];
  try {
    const res = await proxmoxGet(creds.endpoint, `/api2/json/nodes/${encodeURIComponent(defaultNode)}/storage`, auth);
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.body) as { data?: Array<{ storage?: string; content?: string }> };
      datastores = (j.data ?? [])
        .filter((s) => !!s.storage && (!s.content || /images|rootdir/.test(s.content)))
        .map((s) => s.storage as string);
    }
  } catch {
    /* ignore — the box falls back to its static datastore list */
  }

  // 3) Linux bridges on the default node.
  let bridges: string[] = [];
  try {
    const res = await proxmoxGet(creds.endpoint, `/api2/json/nodes/${encodeURIComponent(defaultNode)}/network?type=bridge`, auth);
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.body) as { data?: Array<{ iface?: string }> };
      bridges = (j.data ?? []).map((b) => b.iface).filter((b): b is string => !!b);
    }
  } catch {
    /* ignore — the box falls back to its static bridge list */
  }

  // 4) VM templates on the default node (clone sources).
  let templates: ProxmoxTemplate[] = [];
  try {
    const res = await proxmoxGet(creds.endpoint, `/api2/json/nodes/${encodeURIComponent(defaultNode)}/qemu`, auth);
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.body) as { data?: Array<{ vmid?: number; name?: string; template?: number }> };
      templates = (j.data ?? [])
        .filter((v) => v.template === 1 && typeof v.vmid === "number")
        .map((v) => ({ vmid: v.vmid as number, name: v.name ?? "" }))
        .sort((a, b) => a.vmid - b.vmid);
    }
  } catch {
    /* ignore — the box lets the user pick ISO instead */
  }

  return { nodes, defaultNode, datastores, bridges, templates };
}
